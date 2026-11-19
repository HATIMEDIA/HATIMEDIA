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
                      input: historique.rows.slice(-6).map(m => ({ role: m.role, content: m.content }))
        });

        const reply = response.output_text;

        // --- INTERCEPTION POUR MAKE (GOOGLE CALENDAR) ---
        let cleanReply = reply;
        const matchMake = reply.match(/\[MAKE_RDV:\s*(\{.*?\})\s*\]/s);
        if (matchMake) {
            cleanReply = reply.replace(matchMake[0], "").trim(); 
            if (process.env.MAKE_WEBHOOK_URL) {
                fetch(process.env.MAKE_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: matchMake[1] })
                    .then(() => console.log("✅ RDV envoyé à Make")).catch(err => console.error("❌ Erreur Make:", err));
            }
        }

        const insertedMsg = await pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id`, [conversationId, "assistant", cleanReply]);
        envoyerNotificationSlack(message, cleanReply, sessionId).catch(() => {});
        envoyerNotificationDiscord(message, cleanReply, sessionId).catch(() => {});
        const typeNotif = estQuestionOrdonnance(message) ? "ordonnance" : "message";
        envoyerNotification(message, cleanReply, sessionId, typeNotif).catch(() => {});

        let afficherCarte = false;
        let villeCarte = "";
        if (estQuestionPraticien(message)) {
            const v = ["paris", "toulouse", "marseille", "lyon", "bordeaux", "lille", "nantes", "nice"].find(v => message.toLowerCase().includes(v));
            if (v) { afficherCarte = true; villeCarte = v; }
        }

        res.json({ ok: true, reply: cleanReply, conversationId, messageId: insertedMsg.rows[0].id, carte: afficherCarte ? villeCarte : null });

    } catch (error) {
        console.error("❌ Erreur chat public :", error);
        res.status(500).json({ ok: false, error: "Erreur serveur." });
    }
});

app.get("/api/chat-public/historique/:sessionId", async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const userId = await getOrCreateAnonymousUser(sessionId);
        const conv = await pool.query(`SELECT id FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]);
        if (conv.rows.length === 0) return res.json({ ok: true, messages: [], conversationId: null });
        const msgs = await pool.query(`SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`, [conv.rows[0].id]);
        res.json({ ok: true, conversationId: conv.rows[0].id, messages: msgs.rows });
    } catch (error) { res.status(500).json({ ok: false, error: "Erreur serveur." }); }
});

// ========================================
// RÉACTIONS & RAG
// ========================================

app.post("/api/react", async (req, res) => {
    try {
        const { messageId, reaction, sessionId } = req.body;
        const exist = await pool.query(`SELECT id, reaction_type FROM reactions WHERE message_id = $1 AND session_id = $2`, [messageId, sessionId]);
        if (exist.rows.length > 0) {
            if (exist.rows[0].reaction_type === reaction) {
                await pool.query(`DELETE FROM reactions WHERE id = $1`, [exist.rows[0].id]);
                return res.json({ ok: true, action: "removed" });
            }
            await pool.query(`UPDATE reactions SET reaction_type = $1 WHERE id = $2`, [reaction, exist.rows[0].id]);
            return res.json({ ok: true, action: "updated" });
        }
        await pool.query(`INSERT INTO reactions (message_id, reaction_type, session_id) VALUES ($1, $2, $3)`, [messageId, reaction, sessionId]);
        res.json({ ok: true, action: "created" });
    } catch (error) { res.status(500).json({ ok: false, error: "Erreur serveur." }); }
});

app.get("/api/reactions/:messageId", async (req, res) => {
    try {
        const result = await pool.query(`SELECT reaction_type, session_id FROM reactions WHERE message_id = $1`, [req.params.messageId]);
        const comptes = {}; const par_emoji = {};
        for (const row of result.rows) {
            comptes[row.reaction_type] = (comptes[row.reaction_type] || 0) + 1;
            if (!par_emoji[row.reaction_type]) par_emoji[row.reaction_type] = [];
            par_emoji[row.reaction_type].push((row.session_id || "").substring(0, 20));
        }
        res.json({ ok: true, reactions: comptes, details: par_emoji });
    } catch (error) { res.status(500).json({ ok: false, error: "Erreur serveur." }); }
});

app.get("/api/rag-test", async (req, res) => {
    try { res.json({ ok: true, resultats: await rechercherDansBase(req.query.q || "test", 3) }); } 
    catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

// ========================================
// WEBHOOK WHATSAPP (Meta Cloud API)
// ========================================

app.get("/webhook-whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === "hatimedia2026") res.status(200).send(challenge);
    else res.sendStatus(403);
});

app.post("/webhook-whatsapp", async (req, res) => {
    try {
        res.sendStatus(200);
        if (req.body.object && req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
            const phone_number_id = req.body.entry[0].changes[0].value.metadata.phone_number_id;
            const from = req.body.entry[0].changes[0].value.messages[0].from; 
            const msg_body = req.body.entry[0].changes[0].value.messages[0].text.body;

            const sessionIdWa = "wa_" + from;
            const userId = await getOrCreateAnonymousUser(sessionIdWa);
            let conversationId = (await pool.query(`SELECT id FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0]?.id;

            if (!conversationId) {
                conversationId = (await pool.query(`INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id`, [userId, "Chat WhatsApp"])).rows[0].id;
            }

            await pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`, [conversationId, "user", msg_body]);
            const historique = await pool.query(`SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversationId]);

            const response = await client.responses.create({
                model: "gpt-5",
                instructions: "Tu es HATIMEDIA sur WhatsApp. Réponds en français, chaleureuse et concise.",
                input: historique.rows.slice(-6).map(m => ({ role: m.role, content: m.content }))
            });
            const reply = response.output_text;

            await pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`, [conversationId, "assistant", reply]);

            const token = process.env.META_WHATSAPP_TOKEN;
            await fetch(`https://graph.facebook.com/v18.0/${phone_number_id}/messages`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ messaging_product: "whatsapp", to: from, text: { body: reply } })
            });
        }
    } catch (error) { console.error("❌ Erreur WhatsApp:", error); }
});

// ========================================
// STRIPE, ADMIN, CONTACT, VISION, DASHBOARD (Routes essentielles)
// ========================================

app.post("/api/stripe/checkout", async (req, res) => {
    try {
        const { sessionId } = req.body;
        const userId = await getOrCreateAnonymousUser(sessionId);
        const userInfo = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
        const email = userInfo.rows[0]?.email || "client@hatimedia.local";
        const session = await creerSessionCheckout(userId, email, "https://hatimedia.onrender.com/premium-success?session_id={CHECKOUT_SESSION_ID}", "https://hatimedia.onrender.com/chat");
        res.json({ ok: true, url: session.url });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.get("/api/stripe/status/:sessionId", async (req, res) => {
    try {
        const userId = await getOrCreateAnonymousUser(req.params.sessionId);
        res.json({ ok: true, ...(await getAbonnement(userId)) });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.post("/webhook-stripe", async (req, res) => {
    try {
        const event = JSON.parse(req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body));
        if (event.type === "checkout.session.completed") {
            const session = event.data.object;
            const userId = parseInt(session.metadata?.userId);
            const clientId = parseInt(session.metadata?.clientId);
            if (userId) await activerPremium(userId, session.customer, session.subscription);
            if (clientId) await pool.query(`UPDATE clients SET plan = 'premium', status = 'active', stripe_customer_id = $1, stripe_subscription_id = $2, updated_at = NOW() WHERE id = $3`, [session.customer, session.subscription, clientId]);
        } else if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
            const sub = event.data.object;
            const userId = parseInt(sub.metadata?.userId);
            const clientId = parseInt(sub.metadata?.clientId);
            if (userId && sub.status !== "active") await desactiverPremium(userId);
            if (clientId && sub.status !== "active") await pool.query(`UPDATE clients SET plan = 'free', updated_at = NOW() WHERE id = $1`, [clientId]);
        }
        res.json({ received: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get("/premium-success", (req, res) => { res.send("<h1>Merci ! Votre abonnement Premium est actif.</h1><a href='/chat'>Retour au chat</a>"); });

app.get("/contact", (req, res) => { res.sendFile(require("path").join(__dirname, "public", "contact.html")); });

app.post("/api/contact", async (req, res) => {
    try {
        const { nom, email, message } = req.body;
        const { Resend } = require("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({ from: "HATIMEDIA <onboarding@resend.dev>", to: "hatimedia@hotmail.com", subject: `📧 Contact: ${nom}`, html: `<p><b>Nom:</b> ${nom}</p><p><b>Email:</b> ${email}</p><p>${message}</p>` });
        res.json({ ok: true });
    } catch (error) { res.status(500).json({ ok: false, error: "Impossible d'envoyer." }); }
});

app.post("/api/admin/clients", async (req, res) => {
    try {
        const { slug, name, email, logo_url, primary_color, secondary_color, welcome_message, system_prompt } = req.body;
        const result = await pool.query(`INSERT INTO clients (slug, name, email, logo_url, primary_color, secondary_color, welcome_message, system_prompt) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [slug.toLowerCase().replace(/[^a-z0-9-]/g, "-"), name, email, logo_url, primary_color, secondary_color, welcome_message, system_prompt]);
        res.json({ ok: true, client: result.rows[0] });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.get("/api/admin/clients", async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, slug, name, email, plan, status, created_at FROM clients ORDER BY created_at DESC`);
        res.json({ ok: true, clients: result.rows });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.put("/api/admin/clients/:id", async (req, res) => {
    try {
        const { name, email, logo_url, primary_color, secondary_color, welcome_message, system_prompt, plan, status } = req.body;
        const result = await pool.query(`UPDATE clients SET name = COALESCE($1, name), email = COALESCE($2, email), logo_url = COALESCE($3, logo_url), primary_color = COALESCE($4, primary_color), secondary_color = COALESCE($5, secondary_color), welcome_message = COALESCE($6, welcome_message), system_prompt = COALESCE($7, system_prompt), plan = COALESCE($8, plan), status = COALESCE($9, status), updated_at = NOW() WHERE id = $10 RETURNING *`, [name, email, logo_url, primary_color, secondary_color, welcome_message, system_prompt, plan, status, req.params.id]);
        res.json({ ok: true, client: result.rows[0] });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.delete("/api/admin/clients/:id", async (req, res) => {
    try {
        const result = await pool.query(`DELETE FROM clients WHERE id = $1 RETURNING id`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "Client introuvable." });
        res.json({ ok: true });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.get("/api/client/:slug", async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, slug, name, logo_url, primary_color, secondary_color, welcome_message, plan, status FROM clients WHERE slug = $1 AND status = 'active'`, [req.params.slug]);
        if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "Client introuvable." });
        res.json({ ok: true, client: result.rows[0] });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.get("/c/:slug", (req, res) => { res.sendFile(require("path").join(__dirname, "public", "chat-client.html")); });

app.post("/api/chat-client", async (req, res) => {
    try {
        const { message, sessionId, conversationIdRecu, slug } = req.body;
        const clientResult = await pool.query(`SELECT id, name, system_prompt, primary_color FROM clients WHERE slug = $1 AND status = 'active'`, [slug]);
        if (clientResult.rows.length === 0) return res.status(404).json({ ok: false, error: "Client introuvable." });
        const clientData = clientResult.rows[0];
        const clientId = clientData.id;
        const userId = await getOrCreateAnonymousUser(sessionId, clientId);
        let conversationId = conversationIdRecu || (await pool.query(`INSERT INTO conversations (user_id, title, client_id) VALUES ($1, $2, $3) RETURNING id`, [userId, "Chat client", clientId])).rows[0].id;
        await pool.query(`INSERT INTO messages (conversation_id, role, content, client_id) VALUES ($1, $2, $3, $4)`, [conversationId, "user", message, clientId]);
        const historique = await pool.query(`SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversationId]);
        let contexteRAG = "";
        try { const ragResult = await pool.query(`SELECT content FROM knowledge_base WHERE client_id = $1 LIMIT 5`, [clientId]); if (ragResult.rows.length > 0) contexteRAG = "\n\n📚 Base de connaissances :\n" + ragResult.rows.map(r => r.content).join("\n\n"); } catch (e) {}
        let contexteMedicament = "";
        if (estQuestionMedicament(message)) { const meds = await rechercherMedicament(extraireNomMedicament(message)); contexteMedicament = formaterMedicamentsPourPrompt(meds); }
        const response = await client.responses.create({ model: "gpt-5", instructions: (clientData.system_prompt || "Tu es un assistant IA amical.") + contexteRAG + contexteMedicament, input: historique.rows.slice(-6).map(m => ({ role: m.role, content: m.content })) });
        const reply = response.output_text;
        await pool.query(`INSERT INTO messages (conversation_id, role, content, client_id) VALUES ($1, $2, $3, $4)`, [conversationId, "assistant", reply, clientId]);
        res.json({ ok: true, reply, conversationId });
    } catch (error) { res.status(500).json({ ok: false, error: "Erreur serveur." }); }
});

app.get("/super-admin", (req, res) => { res.sendFile(require("path").join(__dirname, "public", "super-admin.html")); });

app.get("/api/super-admin/clients", verifierToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.id, c.slug, c.name, c.email, c.plan, c.status, c.created_at, c.primary_color, c.secondary_color, (SELECT COUNT(*) FROM conversations WHERE client_id = c.id) AS nb_conversations, (SELECT COUNT(*) FROM messages WHERE client_id = c.id) AS nb_messages, (SELECT COUNT(*) FROM users WHERE client_id = c.id) AS nb_users FROM clients c ORDER BY c.created_at DESC`);
        res.json({ ok: true, clients: result.rows });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.get("/api/super-admin/clients/:id", verifierToken, async (req, res) => {
    try {
        const clientResult = await pool.query(`SELECT * FROM clients WHERE id = $1`, [req.params.id]);
        if (clientResult.rows.length === 0) return res.status(404).json({ ok: false, error: "Client introuvable." });
        const convsResult = await pool.query(`SELECT c.id, c.title, c.created_at, (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS nb_messages, (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message FROM conversations c WHERE c.client_id = $1 ORDER BY c.created_at DESC LIMIT 10`, [req.params.id]);
        res.json({ ok: true, client: clientResult.rows[0], conversations: convsResult.rows });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.put("/api/super-admin/clients/:id", verifierToken, async (req, res) => {
    try {
        const { name, email, primary_color, secondary_color, welcome_message, system_prompt, plan, status } = req.body;
        const result = await pool.query(`UPDATE clients SET name = COALESCE($1, name), email = COALESCE($2, email), primary_color = COALESCE($3, primary_color), secondary_color = COALESCE($4, secondary_color), welcome_message = COALESCE($5, welcome_message), system_prompt = COALESCE($6, system_prompt), plan = COALESCE($7, plan), status = COALESCE($8, status), updated_at = NOW() WHERE id = $9 RETURNING *`, [name, email, primary_color, secondary_color, welcome_message, system_prompt, plan, status, req.params.id]);
        res.json({ ok: true, client: result.rows[0] });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.post("/api/stripe/client-checkout", async (req, res) => {
    try {
        const clientResult = await pool.query(`SELECT id, name, email, plan FROM clients WHERE slug = $1 AND status = 'active'`, [req.body.slug]);
        if (clientResult.rows.length === 0) return res.status(404).json({ ok: false, error: "Client introuvable." });
        const clientData = clientResult.rows[0];
        if (clientData.plan === "premium") return res.status(400).json({ ok: false, error: "Déjà Premium." });
        const session = await stripe.checkout.sessions.create({ mode: "subscription", payment_method_types: ["card"], line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }], customer_email: clientData.email || undefined, success_url: "https://hatimedia.onrender.com/super-admin?premium=ok", cancel_url: "https://hatimedia.onrender.com/super-admin", metadata: { clientId: String(clientData.id), clientSlug: req.body.slug } });
        res.json({ ok: true, url: session.url });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.get("/api/stripe/client-status/:slug", async (req, res) => {
    try {
        const result = await pool.query(`SELECT plan, status FROM clients WHERE slug = $1`, [req.params.slug]);
        if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "Client introuvable." });
        res.json({ ok: true, ...result.rows[0] });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.get("/api/node-version", (req, res) => { res.json({ version: process.version, fetchDisponible: typeof fetch === "function" }); });

app.get("/api/medicament/recherche", async (req, res) => {
    try {
        if (!req.query.q) return res.status(400).json({ ok: false, error: "q manquant" });
        if (typeof fetch !== "function") return res.status(500).json({ ok: false, error: "fetch indisponible" });
        const response = await fetch(`https://medicaments-api.giygas.dev/v1/medicaments?search=${encodeURIComponent(req.query.q)}`, { headers: { "Accept": "application/json", "User-Agent": "HATIMEDIA/1.0" } });
        if (!response.ok) return res.status(response.status).json({ ok: false, error: "Erreur API externe" });
        res.json({ ok: true, recherche: req.query.q, resultats: await response.json() });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.get("/api/praticien/recherche", async (req, res) => {
    try {
        const resultat = await chercherPraticien(req.query.specialite || "", req.query.ville || "");
        res.json({ ok: true, specialite: req.query.specialite, ville: req.query.ville, resultat });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});

app.post("/api/chat-vision", async (req, res) => {
    try {
        const { image, message } = req.body;
        if (!image) return res.status(400).json({ error: "Aucune image reçue." });
        const response = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: "Tu es HATIMEDIA, un assistant médical. Analyse l'image fournie. Ne pose pas de diagnostic, renvoie vers un médecin si nécessaire." }, { role: "user", content: [{ type: "text", text: message || "Analyse cette image." }, { type: "image_url", image_url: { url: image } }] }],
            max_tokens: 500
        });
        res.json({ ok: true, reply: response.choices[0].message.content });
    } catch (error) { res.status(500).json({ ok: false, error: "Impossible d'analyser l'image." }); }
});

app.get("/dashboard", (req, res) => { res.sendFile(require("path").join(__dirname, "public", "dashboard.html")); });

app.get("/api/dashboard/pre-consultations", async (req, res) => {
    try {
        const result = await pool.query(`SELECT m.content, m.created_at, c.user_id FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE m.role = 'assistant' AND m.content LIKE '%Compte-rendu de pré-consultation%' ORDER BY m.created_at DESC LIMIT 50`);
        res.json({ ok: true, bilans: result.rows.map(r => ({ contenu: r.content, date: r.created_at, sessionId: "sess_" + r.user_id })) });
    } catch (error) { res.status(500).json({ ok: false, error: "Impossible de charger le tableau de bord." }); }
});

// ========================================
// DÉMARRAGE DU SERVEUR
// ========================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log("Serveur démarré sur le port " + PORT);
});
