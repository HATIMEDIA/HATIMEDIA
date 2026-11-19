const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const OpenAI = require("openai");
require("dotenv").config();
const bcrypt = require("bcrypt");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const https = require("https");
const mammoth = require("mammoth");
const multer = require("multer");
const { choisirAgent, determinerAction, creerAction } = require("./orchestrateur");
const { preparerMessage, validerMessage, demanderConfirmation } = require("./outil-messagerie");

// Gmail désactivé sur Render (credentials.json en local uniquement)
// const { envoyerEmail } = require("./gmail");
let envoyerEmail = async () => { throw new Error("Gmail désactivé"); };

const { executerAction } = require("./moteur-actions");
const { analyserDemandeMessagerie, extraireContenuMessage } = require("./analyse-demande");
const { envoyerNotification } = require("./email");
const { envoyerNotificationDiscord } = require("./discord");
const { envoyerNotificationSlack } = require("./slack");
const { envoyerMessageWhatsApp } = require("./whatsapp");
const { rechercherDansBase, getContexteRAG } = require("./rag");

const {
    stripe,
    getAbonnement,
    creerSessionCheckout,
    activerPremium,
    desactiverPremium
} = require("./stripe");

const app = express();

// ⚠️ Capture du RAW BODY pour la signature Meta
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const NEON_URL = "postgresql://neondb_owner:npg_Mgj98WxFaJUY@ep-rapid-silence-b2r6id56-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const pool = new Pool({ connectionString: NEON_URL, ssl: { rejectUnauthorized: false } });

const medical = require("./medical")(app, client);
const { estQuestionMedicament, extraireNomMedicament, rechercherMedicament, formaterMedicamentsPourPrompt, estQuestionPraticien, chercherPraticien, formaterPraticiensPourPrompt, estQuestionRendezVous, appelerAnteos, analyserOrdonnance, estQuestionOrdonnance, evaluerUrgence } = medical;

// Page de chat publique (sans login)
app.get("/chat", (req, res) => {
    res.sendFile(require("path").join(__dirname, "public", "chat.html"));
});

// Page admin
app.get("/admin", (req, res) => {
    res.sendFile(require("path").join(__dirname, "public", "admin.html"));
});

// ========================================
// TESTS
// ========================================

app.get("/test", (req, res) => res.json({ ok: true }));

app.get("/db-test", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");
        res.json({ ok: true, database: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ========================================
// UPLOAD DOCUMENTS
// ========================================

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

app.post("/api/analyser-document", upload.single("document"), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ ok: false, error: "Aucun document reçu" });
    }

    const typesAcceptes = [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain"
    ];

    if (!typesAcceptes.includes(req.file.mimetype)) {
        return res.status(400).json({
            ok: false,
            error: "Format non accepté. Utilisez PDF, DOCX ou TXT."
        });
    }

    try {
        let texte = "";

        if (req.file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
            const resultat = await mammoth.extractRawText({ buffer: req.file.buffer });
            texte = resultat.value;
        } else if (req.file.mimetype === "text/plain") {
            texte = req.file.buffer.toString("utf8");
        } else if (req.file.mimetype === "application/pdf") {
            texte = "PDF reçu. Lecture du PDF à ajouter ensuite.";
        }

        console.log("DOCUMENT LU ✅", req.file.originalname, texte.length + " caractères");

        res.json({
            ok: true,
            message: "Document lu par HATIMEDIA ✅",
            filename: req.file.originalname,
            text: texte
        });
    } catch (error) {
        console.error("ERREUR LECTURE DOCUMENT ❌", error);
        res.status(500).json({ ok: false, error: "Impossible de lire le document" });
    }
});

// ========================================
// INSCRIPTION & CONNEXION
// ========================================

app.post("/api/register", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Email et mot de passe obligatoires." });
        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`, [email, hash]);
        res.json({ ok: true, user: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de l'inscription." });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
        if (result.rows.length === 0) return res.status(401).json({ error: "Identifiants incorrects." });
        const user = result.rows[0];
        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: "Identifiants incorrects." });
        const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });
        res.json({ ok: true, token: token });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la connexion." });
    }
});

// ========================================
// VÉRIFICATION TOKEN
// ========================================

function verifierToken(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "Token manquant." });
    const token = auth.substring(7);
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: "Token invalide." });
    }
}

// ========================================
// MÉMOIRE & PERSONNALITÉ
// ========================================

async function detecterSouvenir(message) {
    if (!message) return null;
    const response = await client.responses.create({
        model: "gpt-5",
        instructions: `Tu analyses le message d'un utilisateur pour déterminer s'il contient une information personnelle durable. Réponds UNIQUEMENT avec un JSON valide : { "shouldRemember": true, "memory": "phrase courte", "memoryType": "preference" } ou { "shouldRemember": false, "memory": "", "memoryType": "other" }`,
        input: message
    });
    try { return JSON.parse(response.output_text); } catch (e) { return null; }
}

async function enregistrerSouvenir(userId, memory, memoryType) {
    if (!memory || typeof memory !== "string" || !memory.trim()) return;
    await pool.query(`INSERT INTO memories (user_id, memory, memory_type) VALUES ($1, $2, $3)`, [userId, memory.trim(), memoryType || "other"]);
}

// ========================================
// CHAT PRIVÉ (HATIMEDIA avec mémoire)
// ========================================

app.post("/api/chat", verifierToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const message = req.body.message;
        const conversationIdRecu = req.body.conversationId || null;

        if (!message) return res.status(400).json({ error: "Message vide." });

        const souvenir = await detecterSouvenir(message);
        if (souvenir && souvenir.shouldRemember) await enregistrerSouvenir(userId, souvenir.memory, souvenir.memoryType);

        let conversationId = null;
        if (conversationIdRecu) {
            const check = await pool.query(`SELECT id FROM conversations WHERE id = $1 AND user_id = $2`, [conversationIdRecu, userId]);
            if (check.rows.length > 0) conversationId = check.rows[0].id;
        }
        if (!conversationId) {
            const conv = await pool.query(`SELECT id FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]);
            if (conv.rows.length > 0) conversationId = conv.rows[0].id;
        }
        if (!conversationId) {
            const nouvelle = await pool.query(`INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id`, [userId, "Nouvelle conversation"]);
            conversationId = nouvelle.rows[0].id;
        }

        await pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`, [conversationId, "user", message]);
        const historique = await pool.query(`SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversationId]);
        const memoires = await pool.query(`SELECT memory FROM memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [userId]);
        const contexteMemoire = memoires.rows.length > 0 ? "\n\nMémoire :\n" + memoires.rows.map(m => "- " + m.memory).join("\n") : "";

        const response = await client.responses.create({
            model: "gpt-5",
            instructions: "Tu es HATIMEDIA, un assistant IA personnel. Tu es joyeux, intelligent et complice. Réponds à Hatime de manière naturelle et vivante." + contexteMemoire,
            input: historique.rows.slice(-6).map(m => ({ role: m.role, content: m.content }))
        });

        const reply = response.output_text;
        await pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`, [conversationId, "assistant", reply]);

        res.json({ reply: reply, conversationId: conversationId });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la communication." });
    }
});

// ========================================
// HISTORIQUE DES CONVERSATIONS
// ========================================

app.get("/api/conversations", verifierToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.id, c.title, c.created_at, (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message, (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count FROM conversations c WHERE c.user_id = $1 ORDER BY c.created_at DESC`, [req.user.userId]);
        res.json({ ok: true, conversations: result.rows });
    } catch (error) { res.status(500).json({ ok: false, error: "Erreur historique." }); }
});

app.post("/api/conversations", verifierToken, async (req, res) => {
    try {
        const result = await pool.query(`INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id, title, created_at`, [req.user.userId, "Nouvelle conversation"]);
        res.json({ ok: true, conversation: result.rows[0] });
    } catch (error) { res.status(500).json({ ok: false, error: "Erreur création conversation." }); }
});

app.delete("/api/conversations/:id", verifierToken, async (req, res) => {
    try {
        const convId = req.params.id;
        await pool.query(`DELETE FROM messages WHERE conversation_id = $1`, [convId]);
        await pool.query(`DELETE FROM conversations WHERE id = $1 AND user_id = $2`, [convId, req.user.userId]);
        res.json({ ok: true });
    } catch (error) { res.status(500).json({ ok: false, error: "Erreur suppression." }); }
});

app.get("/api/conversations/:id/messages", verifierToken, async (req, res) => {
    try {
        const conversationId = req.params.id;
        const check = await pool.query(`SELECT id FROM conversations WHERE id = $1 AND user_id = $2`, [conversationId, req.user.userId]);
        if (check.rows.length === 0) return res.status(404).json({ ok: false, error: "Conversation introuvable." });
        const result = await pool.query(`SELECT id, role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversationId]);
        res.json({ ok: true, messages: result.rows });
    } catch (error) { res.status(500).json({ ok: false, error: "Erreur messages." }); }
});

// ========================================
// MESSENGER WEBHOOK
// ========================================

const messenger = require("./messenger");
app.get("/webhook", messenger.verificationWebhook);
async function cerveauHatimedia(texte) {
    try {
        const response = await client.responses.create({
            model: "gpt-5",
            instructions: "Tu es HATIMEDIA sur Messenger. Réponds en français, chaleureuse et concise.",
            input: texte
        });
        return response.output_text;
    } catch (error) { return "Désolé, je n'ai pas pu répondre."; }
}
app.post("/webhook", messenger.creerReceptionWebhook(cerveauHatimedia));

// ========================================
// CHAT PUBLIC (sans login) - LE COEUR DU SYSTÈME
// ========================================

async function getOrCreateAnonymousUser(sessionId, clientId) {
    if (!sessionId) throw new Error("sessionId invalide");
    const propre = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    const email = `anon_${propre}@hatimedia.local`;
    const exist = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (exist.rows.length > 0) return exist.rows[0].id;
    const created = await pool.query(`INSERT INTO users (email, password_hash, client_id) VALUES ($1, $2, $3) RETURNING id`, [email, "ANONYMOUS_NO_LOGIN", clientId || null]);
    return created.rows[0].id;
}

app.post("/api/chat-public", async (req, res) => {
    try {
        const message = (req.body.message || "").trim();
        const sessionId = req.body.sessionId;
        const conversationIdRecu = req.body.conversationId || null;

        if (!message) return res.status(400).json({ ok: false, error: "Message vide." });
        if (!sessionId) return res.status(400).json({ ok: false, error: "Session manquante." });

        const userId = await getOrCreateAnonymousUser(sessionId);
        let conversationId = null;

        if (conversationIdRecu) {
            const check = await pool.query(`SELECT id FROM conversations WHERE id = $1 AND user_id = $2`, [conversationIdRecu, userId]);
            if (check.rows.length > 0) conversationId = check.rows[0].id;
        }
        if (!conversationId) {
            const conv = await pool.query(`SELECT id FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]);
            if (conv.rows.length > 0) conversationId = conv.rows[0].id;
        }
        if (!conversationId) {
            const nouvelle = await pool.query(`INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id`, [userId, "Chat public"]);
            conversationId = nouvelle.rows[0].id;
        }

        await pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`, [conversationId, "user", message]);
        await pool.query(`UPDATE conversations SET title = $1 WHERE id = $2 AND title IN ('Chat public', 'Nouvelle conversation')`, [message.length > 60 ? message.slice(0, 60) + "…" : message, conversationId]);

        const historique = await pool.query(`SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversationId]);

        // --- 1. RÉCUPÉRATION DES CONTEXTES ---
        const contexteRAG = await getContexteRAG(message);

        let contexteMedicament = "";
        if (estQuestionMedicament(message)) {
            const nomMed = extraireNomMedicament(message);
            const meds = await rechercherMedicament(nomMed);
            contexteMedicament = formaterMedicamentsPourPrompt(meds);
        }

        let contextePraticien = "";
        if (estQuestionPraticien(message)) {
            const m = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const ville = ["paris", "marseille", "lyon", "toulouse", "nice", "nantes", "bordeaux", "lille", "rennes", "strasbourg"].find(v => m.includes(v)) || "";
            const specialite = ["generaliste", "cardio", "dermato", "ophtalmo", "pediatre", "gyneco", "dentiste", "kine"].find(s => m.includes(s)) || "";
            const textePraticiens = await chercherPraticien(specialite, ville);
            contextePraticien = formaterPraticiensPourPrompt(textePraticiens);
        }

        let contexteOrdonnance = "";
        if (estQuestionOrdonnance(message)) {
            const analyse = await analyserOrdonnance(message);
            contexteOrdonnance = "\n\n📋 ANALYSE D'ORDONNANCE :\n" + analyse + "\n";
        }

        let contexteRendezVous = "";
        if (estQuestionRendezVous(message)) {
            contexteRendezVous = "\n\n🗓️ RDV : Demande Nom, Date de naissance, Email, Spécialité, Ville. À la fin, inclus EXACTEMENT ce bloc (caché) : [MAKE_RDV: {\"nom\": \"...\", \"dob\": \"...\", \"email\": \"...\", \"specialite\": \"...\", \"ville\": \"...\"}]\n";
        }

        let contexteTriage = "";
        const triage = evaluerUrgence(message);
        if (triage.urgence) {
            contexteTriage = "\n\n🚨 ALERTE ROUGE : L'utilisateur décrit des symptômes potentiellement vitaux. Tu DOIS lui dire d'appeler immédiatement le 15 (SAMU) ou le 112.\n";
        } else if (triage.symptome) {
            contexteTriage = "\n\n🩺 ORIENTATION : L'utilisateur décrit des symptômes. Rappelle que tu n'es pas médecin, donne des conseils de bon sens.\n";
        }

        // --- 2. RÉPONSE DE L'IA ---
        const response = await client.responses.create({
            model: "gpt-5",
            instructions: "Tu es HATIMEDIA, un assistant IA spécialisé dans la santé. Réponds en français de façon naturelle et professionnelle. " +
                "\n\nRÈGLES :\n1. Tu n'es PAS un médecin. Pas de diagnostic. Pas de prescription.\n2. Urgence grave -> Appeler le 15.\n3. Rappel de prudence à la fin.\n4. Ne donne pas de posologie exacte.\n" +
                "\n\nPROTOCOLE PRÉ-CONSULTATION :\nPose les questions UNE PAR UNE : Âge/Sexe ? Symptôme/Durée ? Antécédents ? Médicaments ? Puis génère un 'COMPTE-RENDU DE PRÉ-CONSULTATION' structuré.\n" +
                (contexteRAG ? "\n\n📚 RAG :\n" + contexteRAG : "") +
                contexteMedicament + contexteTriage + contextePraticien + contexteRendezVous + contexteOrdonnance +
                "\n\nRéponds maintenant à la question.",
            input
