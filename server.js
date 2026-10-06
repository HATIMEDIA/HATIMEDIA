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


app.use(express.urlencoded({ extended: true }));   // ← NOUVELLE LIGNE
app.use(express.static("public"));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const NEON_URL = "postgresql://neondb_owner:npg_Mgj98WxFaJUY@ep-rapid-silence-b2r6id56-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const pool = new Pool({ connectionString: NEON_URL, ssl: { rejectUnauthorized: false } });


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

        if (
            req.file.mimetype ===
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ) {
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
// INSCRIPTION
// ========================================

app.post("/api/register", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "Email et mot de passe obligatoires." });
        }

        const hash = await bcrypt.hash(password, 10);

        const result = await pool.query(
            `INSERT INTO users (email, password_hash)
             VALUES ($1, $2)
             RETURNING id, email`,
            [email, hash]
        );

        res.json({ ok: true, user: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur lors de l'inscription." });
    }
});

// ========================================
// CONNEXION
// ========================================

app.post("/api/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);

        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Identifiants incorrects." });
        }

        const user = result.rows[0];
        const ok = await bcrypt.compare(password, user.password_hash);

        if (!ok) {
            return res.status(401).json({ error: "Identifiants incorrects." });
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.json({ ok: true, token: token });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur lors de la connexion." });
    }
});

// ========================================
// VÉRIFICATION TOKEN
// ========================================

function verifierToken(req, res, next) {
    const auth = req.headers.authorization;

    if (!auth || !auth.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Token manquant." });
    }

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
// MÉMOIRE AUTOMATIQUE
// ========================================

async function enregistrerSouvenir(userId, memory, memoryType) {
    if (!memory || typeof memory !== "string") return;
    const texte = memory.trim();
    if (!texte) return;

    const type =
        typeof memoryType === "string" && memoryType.trim()
            ? memoryType.trim()
            : "other";

    const normaliser = (valeur) =>
        valeur
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .replace(/\s+/g, " ")
            .trim();

    const texteNormalise = normaliser(texte);

    const similaires = await pool.query(
        `SELECT id, memory, similarity(memory, $2) AS similarite
         FROM memories
         WHERE user_id = $1
         ORDER BY similarite DESC
         LIMIT 5`,
        [userId, texte]
    );

    for (const souvenir of similaires.rows) {
        if (normaliser(souvenir.memory) === texteNormalise) return;
    }

    for (const souvenir of similaires.rows) {
        if (Number(souvenir.similarite) >= 0.50) {
            const evolution = await determinerEvolutionSouvenir(souvenir.memory, texte);
            console.log("Décision évolution mémoire :", evolution);

            if (evolution && evolution.sameMemory === true) {
                const nouvelleMemoire = await formulerNouvelleMemoire(souvenir.memory, texte);
                console.log("Nouvelle mémoire proposée :", nouvelleMemoire);

                if (nouvelleMemoire && typeof nouvelleMemoire === "string" && nouvelleMemoire.trim()) {
                    await pool.query(
                        `UPDATE memories SET memory = $1 WHERE id = $2`,
                        [nouvelleMemoire.trim(), souvenir.id]
                    );
                    console.log("Mémoire évoluée en base :", souvenir.id);
                    return;
                }
            }
            console.log("Ce souvenir est différent : poursuite vers INSERT.");
        }
    }

    await pool.query(
        `INSERT INTO memories (user_id, memory, memory_type)
         VALUES ($1, $2, $3)`,
        [userId, texte, type]
    );
}

async function detecterSouvenir(message) {
    if (!message || typeof message !== "string") return null;

    const response = await client.responses.create({
        model: "gpt-5",
        instructions: `
Tu analyses le message d'un utilisateur pour déterminer
s'il contient une information personnelle durable que
HATIMEDIA devrait mémoriser.

Mémorise uniquement :
- les préférences durables ;
- les habitudes utiles ;
- les façons de travailler ;
- les objectifs durables ;
- les informations personnelles non sensibles utiles.

Ne mémorise pas :
- les questions ordinaires ;
- les demandes ponctuelles ;
- les informations sensibles ;
- les détails sans utilité future.

Catégories autorisées : "preference", "habit", "goal", "workflow", "personal", "other"

Réponds UNIQUEMENT avec un JSON valide :
{ "shouldRemember": true, "memory": "phrase courte", "memoryType": "preference" }
ou
{ "shouldRemember": false, "memory": "", "memoryType": "other" }
`,
        input: message
    });

    try {
        const resultat = JSON.parse(response.output_text);
        return {
            shouldRemember: resultat.shouldRemember === true,
            memory: typeof resultat.memory === "string" ? resultat.memory.trim() : "",
            memoryType: typeof resultat.memoryType === "string" ? resultat.memoryType.trim() : "other"
        };
    } catch (error) {
        console.error("Erreur analyse mémoire :", error);
        return null;
    }
}

async function determinerEvolutionSouvenir(ancienSouvenir, nouveauSouvenir) {
    if (!ancienSouvenir || typeof ancienSouvenir !== "string") return null;
    if (!nouveauSouvenir || typeof nouveauSouvenir !== "string") return null;

    const response = await client.responses.create({
        model: "gpt-5",
        instructions: `
Tu compares deux souvenirs personnels déjà détectés par HATIMEDIA.

sameMemory = true si le nouveau souvenir reformule, précise
ou actualise essentiellement la même information.
sameMemory = false sinon.

Réponds UNIQUEMENT avec un JSON valide : { "sameMemory": true } ou { "sameMemory": false }
`,
        input: `ANCIEN SOUVENIR :\n${ancienSouvenir}\n\nNOUVEAU SOUVENIR :\n${nouveauSouvenir}`
    });

    try {
        const resultat = JSON.parse(response.output_text);
        return { sameMemory: resultat.sameMemory === true };
    } catch (error) {
        console.error("Erreur décision évolution :", error);
        return null;
    }
}

async function formulerNouvelleMemoire(ancienSouvenir, nouveauSouvenir) {
    if (!ancienSouvenir || typeof ancienSouvenir !== "string") return null;
    if (!nouveauSouvenir || typeof nouveauSouvenir !== "string") return null;

    const response = await client.responses.create({
        model: "gpt-5",
        instructions: `
Tu fais évoluer une mémoire personnelle de HATIMEDIA.

Produis une formulation canonique, courte, claire, fidèle
à l'information la plus récente.

- écris à la troisième personne ;
- commence si possible par "L'utilisateur" ;
- réponds UNIQUEMENT avec un JSON valide : { "memory": "..." }
`,
        input: `ANCIEN SOUVENIR :\n${ancienSouvenir}\n\nNOUVEAU SOUVENIR :\n${nouveauSouvenir}`
    });

    try {
        const resultat = JSON.parse(response.output_text);
        if (!resultat.memory || typeof resultat.memory !== "string") return null;
        return resultat.memory.trim();
    } catch (error) {
        console.error("Erreur formulation mémoire :", error);
        return null;
    }
}

// ========================================
// MOTEUR DE DÉCISION — PERSONNALITÉ
// ========================================

async function determinerComportementHatimedia(message) {
    if (!message || typeof message !== "string") return null;

    const response = await client.responses.create({
        model: "gpt-5",
        instructions: `
Tu es le moteur de décision comportemental de HATIMEDIA.

Choisis UNE action : "ecouter", "parler", "proposer", "agir".

Règles :
- "agir" seulement si action réellement demandée.
- Ne transforme jamais une conversation en planning/checklist.
- Réponds UNIQUEMENT avec un JSON valide : { "action": "parler" }
`,
        input: message
    });

    try {
        const resultat = JSON.parse(response.output_text);
        const actions = ["ecouter", "parler", "proposer", "agir"];
        if (!actions.includes(resultat.action)) return "parler";
        return resultat.action;
    } catch (error) {
        console.error("Erreur moteur de décision :", error);
        return "parler";
    }
}

// ========================================
// OAUTH GMAIL
// ========================================

app.get("/oauth2callback", async (req, res) => {
    try {
        const code = req.query.code;
        if (!code) return res.status(400).send("❌ Code OAuth manquant.");

        const { oauth2Client } = require("./gmail");
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const tokenPath = require("path").join(__dirname, "gmail-token.json");
        require("fs").writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });

        console.log("✅ Jeton Gmail récupéré et enregistré.");

        res.send(`
            <h1>✅ Gmail autorisé pour HATIMEDIA</h1>
            <p>Le jeton Gmail a bien été récupéré.</p>
        `);
    } catch (error) {
        console.error("❌ Erreur OAuth Gmail :", error.response?.data || error.message);
        res.status(500).send("❌ Échec de l'autorisation Gmail.");
    }
});

// ========================================
// CHAT HATIMEDIA
// ========================================

app.post("/api/chat", verifierToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const message = req.body.message;
        const conversationIdRecu = req.body.conversationId || null;

        const confirmationPositive = [
            "oui", "ok", "d'accord", "dac", "vas-y",
            "envoie-le", "envoye-le", "confirme", "je confirme"
        ].includes(message.trim().toLowerCase());

        if (confirmationPositive) {
            const actionEnAttente = await pool.query(
                `SELECT id, agent, action, payload
                 FROM pending_actions
                 WHERE user_id = $1 AND status = 'pending'
                 ORDER BY created_at DESC LIMIT 1`,
                [userId]
            );

            if (actionEnAttente.rows.length > 0) {
                const action = actionEnAttente.rows[0];
                const payload = typeof action.payload === "string"
                    ? JSON.parse(action.payload)
                    : action.payload;

                if (action.agent === "messagerie" && payload.canal === "email") {
                    console.log("📧 Exécution réelle de l'envoi Gmail...");

                    const resultatGmail = await envoyerEmail({
                        to: payload.destinataire,
                        subject: "Message envoyé par HATIMEDIA",
                        text: payload.contenu
                    });

                    await pool.query(
                        `UPDATE pending_actions SET status = 'executed' WHERE id = $1`,
                        [action.id]
                    );

                    console.log("✅ Email envoyé. ID :", resultatGmail.id);

                    return res.json({
                        reply: `✅ C'est fait. L'email a bien été envoyé à ${payload.destinataire}.`,
                        conversationId: conversationIdRecu,
                        confirmationMessagerie: null
                    });
                }

                await pool.query(
                    `UPDATE pending_actions SET status = 'confirmed' WHERE id = $1`,
                    [action.id]
                );

                console.log("✅ Confirmation reçue. Action :", action);

                if (action.agent === "messagerie") {
                    const resultatAction = await executerAction({
                        ...action,
                        payload: action.payload
                    });

                    if (!resultatAction.succes) throw new Error(resultatAction.erreur);

                    await pool.query(
                        `UPDATE pending_actions SET status = 'executed' WHERE id = $1`,
                        [action.id]
                    );

                    return res.json({
                        reply: `✅ C'est fait. L'email a bien été envoyé à ${resultatAction.destinataire}.`,
                        conversationId: conversationIdRecu,
                        confirmationMessagerie: null
                    });
                }

                return res.json({
                    reply: `Confirmation reçue. L'action ${action.action} est confirmée.`,
                    conversationId: conversationIdRecu,
                    confirmationMessagerie: null
                });
            }
            console.log("ℹ️ Confirmation reçue mais aucune action en attente.");
        }

        const agentChoisi = choisirAgent(message);
        console.log("🤖 Agent HATIMEDIA :", agentChoisi);

        const actionChoisie = determinerAction(message, agentChoisi);
        const actionHatimedia = creerAction(agentChoisi, actionChoisie);

        console.log("⚙️ Action HATIMEDIA :", actionHatimedia);

        let confirmationMessagerie = null;

        if (agentChoisi === "messagerie") {
            try {
                const demandeMessagerie = analyserDemandeMessagerie(message);
                const contenuMessage = await extraireContenuMessage(message);

                const messagePrepare = preparerMessage(
                    demandeMessagerie.destinataire,
                    contenuMessage,
                    demandeMessagerie.canal
                );

                const validationMessage = validerMessage(messagePrepare);

                if (validationMessage.valide) {
                    confirmationMessagerie = demanderConfirmation(messagePrepare);

                    await pool.query(
                        `INSERT INTO pending_actions
                         (user_id, agent, action, payload, status)
                         VALUES ($1, $2, $3, $4, 'pending')`,
                        [userId, agentChoisi, actionChoisie, JSON.stringify(messagePrepare)]
                    );

                    console.log("💾 Action messagerie enregistrée en attente.");
                }
            } catch (error) {
                console.error("⚠️ Erreur préparation messagerie :", error);
            }
        }

        if (confirmationMessagerie && confirmationMessagerie.confirmation_requise) {
            console.log("🔐 HATIMEDIA attend une confirmation avant toute exécution.");
        }

        let comportementHatimedia = "parler";
        if (message) {
            try {
                comportementHatimedia = await determinerComportementHatimedia(message);
                console.log("🧠 Comportement HATIMEDIA :", comportementHatimedia);
            } catch (error) {
                console.error("⚠️ Erreur moteur de décision :", error);
            }
        }

        if (message) {
            try {
                const souvenir = await detecterSouvenir(message);
                if (
                    souvenir &&
                    souvenir.shouldRemember === true &&
                    typeof souvenir.memory === "string" &&
                    souvenir.memory.trim()
                ) {
                    await enregistrerSouvenir(userId, souvenir.memory, souvenir.memoryType);
                }
            } catch (error) {
                console.error("⚠️ Erreur mémoire (chat conservé) :", error);
            }
        }

        if (!message) {
            return res.status(400).json({ error: "Message vide." });
        }

        let conversationId = null;

        if (conversationIdRecu) {
            const check = await pool.query(
                `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
                [conversationIdRecu, userId]
            );
            if (check.rows.length > 0) {
                conversationId = check.rows[0].id;
            }
        }

        if (!conversationId) {
            const conv = await pool.query(
                `SELECT id FROM conversations
                 WHERE user_id = $1
                 ORDER BY created_at DESC LIMIT 1`,
                [userId]
            );
            if (conv.rows.length > 0) {
                conversationId = conv.rows[0].id;
            }
        }

        if (!conversationId) {
            const nouvelle = await pool.query(
                `INSERT INTO conversations (user_id, title)
                 VALUES ($1, $2)
                 RETURNING id`,
                [userId, "Nouvelle conversation"]
            );
            conversationId = nouvelle.rows[0].id;
        }

        await pool.query(
            `INSERT INTO messages (conversation_id, role, content)
             VALUES ($1, $2, $3)`,
            [conversationId, "user", message]
        );

        await pool.query(
            `UPDATE conversations
             SET title = $1
             WHERE id = $2
               AND title IN ('Nouvelle conversation', 'Conversation HATIMEDIA')`,
            [
                message.length > 60 ? message.slice(0, 60) + "…" : message,
                conversationId
            ]
        );

        const historique = await pool.query(
            `SELECT role, content
             FROM messages
             WHERE conversation_id = $1
             ORDER BY created_at ASC`,
            [conversationId]
        );

        const memoires = await pool.query(
            `SELECT memory, memory_type
             FROM memories
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 10`,
            [userId]
        );

        const contexteMemoire = memoires.rows.length > 0
            ? "\n\nMémoire personnelle de Hatime :\n" +
              memoires.rows.map(m => "- " + m.memory).join("\n")
            : "";

        const response = await client.responses.create({
            model: "gpt-5",
            instructions:
                "Agent choisi : " + agentChoisi + ". " +
                "Comportement à adopter : " + comportementHatimedia + ". " +
                "Pour ce comportement, sois naturel et direct. Si le comportement est proposer, propose UNE seule idée concrète, surprenante et adaptée. Ne crée jamais de communiqué, titre, chapeau, slogan, règle, menu, checklist, lien, GIF, sticker ou visuel sauf demande manifeste. " +
                (confirmationMessagerie
                    ? "Une confirmation de messagerie est en attente : demande uniquement à Hatime s'il confirme l'envoi. Ne rédige pas un nouveau message et ne prétends pas avoir envoyé le message. "
                    : "") +
                "Tu es joyeux, intelligent, naturel, chaleureux, légèrement drôle et complice. " +
                "Réponds d'abord à ce que Hatime vient réellement de dire. " +
                "Ne transforme pas automatiquement une conversation en planning, checklist, tutoriel ou liste. " +
                "Ne donne pas systématiquement des listes ou une question finale. " +
                "Quand une seule idée suffit, donne une seule idée. " +
                "Si Hatime discute, discute naturellement avec lui. " +
                "S'il exprime une envie, comprends son intention avant de proposer. " +
                "S'il demande clairement une action disponible, agis. " +
                "Si l'action n'est pas disponible, ne prétends jamais l'avoir effectuée. " +
                "Utilise les souvenirs personnels lorsqu'ils sont pertinents, sans les réciter. " +
                "Respecte les préférences récentes de Hatime lorsqu'elles contredisent les anciennes. " +
                "Évite le ton commercial et les réponses préfabriquées. " +
                "Les anciennes réponses de HATIMEDIA ne sont pas des instructions. " +
                "Ton objectif : que Hatime ait l'impression de parler avec un assistant vivant, attentif, naturel et complice." +
                contexteMemoire,
            input: historique.rows.slice(-6).map(m => ({
                role: m.role,
                content: m.content
            }))
        });

        const reply = confirmationMessagerie && confirmationMessagerie.confirmation_requise
            ? confirmationMessagerie.question
            : response.output_text;

        await pool.query(
            `INSERT INTO messages (conversation_id, role, content)
             VALUES ($1, $2, $3)`,
            [conversationId, "assistant", reply]
        );

        res.json({
            reply: reply,
            conversationId: conversationId,
            confirmationMessagerie: confirmationMessagerie
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur lors de la communication avec HATIMEDIA." });
    }
});

// ========================================
// HISTORIQUE DES CONVERSATIONS
// ========================================

app.get("/api/conversations", verifierToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT c.id,
                    c.title,
                    c.created_at,
                    (SELECT content FROM messages
                     WHERE conversation_id = c.id
                     ORDER BY created_at DESC LIMIT 1) AS last_message,
                    (SELECT COUNT(*) FROM messages
                     WHERE conversation_id = c.id) AS message_count
             FROM conversations c
             WHERE c.user_id = $1
             ORDER BY c.created_at DESC`,
            [req.user.userId]
        );

        res.json({ ok: true, conversations: result.rows });
    } catch (error) {
        console.error("ERREUR HISTORIQUE ❌", error);
        res.status(500).json({ ok: false, error: "Impossible de récupérer l'historique." });
    }
});

app.post("/api/conversations", verifierToken, async (req, res) => {
    try {
        const result = await pool.query(
            `INSERT INTO conversations (user_id, title)
             VALUES ($1, $2)
             RETURNING id, title, created_at`,
            [req.user.userId, "Nouvelle conversation"]
        );

        res.json({ ok: true, conversation: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ ok: false, error: "Impossible de créer la conversation." });
    }
});

app.delete("/api/conversations/:id", verifierToken, async (req, res) => {
    try {
        const convId = req.params.id;

        const check = await pool.query(
            `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
            [convId, req.user.userId]
        );

        if (check.rows.length === 0) {
            return res.status(404).json({ ok: false, error: "Conversation introuvable." });
        }

        await pool.query(`DELETE FROM messages WHERE conversation_id = $1`, [convId]);
        await pool.query(`DELETE FROM conversations WHERE id = $1`, [convId]);

        res.json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ ok: false, error: "Impossible de supprimer la conversation." });
    }
});

app.get("/api/conversations/:id/messages", verifierToken, async (req, res) => {
    try {
        const conversationId = req.params.id;

        const check = await pool.query(
            `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
            [conversationId, req.user.userId]
        );

        if (check.rows.length === 0) {
            return res.status(404).json({ ok: false, error: "Conversation introuvable." });
        }

        const result = await pool.query(
            `SELECT id, role, content, created_at
             FROM messages
             WHERE conversation_id = $1
             ORDER BY created_at ASC`,
            [conversationId]
        );

        res.json({ ok: true, messages: result.rows });
    } catch (error) {
        console.error("ERREUR MESSAGES ❌", error);
        res.status(500).json({ ok: false, error: "Impossible de récupérer les messages." });
    }
});

// ========================================
// WEBHOOK META / MESSENGER (NOUVEAU)
// ========================================

const messenger = require("./messenger");

// Handler GET — Vérification Meta
app.get("/webhook", messenger.verificationWebhook);

// Cerveau HATIMEDIA pour Messenger
async function cerveauHatimedia(texte, contexte) {
    console.log("🤖 Cerveau HATIMEDIA (Messenger) :", texte);

    try {
        const response = await client.responses.create({
            model: "gpt-5",
            instructions:
                "Tu es HATIMEDIA, un assistant IA personnel sur Messenger. " +
                "Réponds en français, de manière naturelle, chaleureuse et concise. " +
                "Va droit au but (2-3 phrases max sauf demande explicite). " +
                "Tu es joyeux, intelligent et complice.",
            input: texte
        });
        return response.output_text;
    } catch (error) {
        console.error("❌ Erreur cerveau Messenger :", error);
        return "Désolé, je n'ai pas pu répondre. Réessaie. 🤖";
    }
}

// Handler POST — Réception messages
app.post("/webhook", messenger.creerReceptionWebhook(cerveauHatimedia));


// ========================================
// CHAT PUBLIC (sans login)
// ========================================

async function getOrCreateAnonymousUser(sessionId, clientId) {
    if (!sessionId || typeof sessionId !== "string") {
        throw new Error("sessionId invalide");
    }
    const propre = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    const email = `anon_${propre}@hatimedia.local`;

    const exist = await pool.query(
        `SELECT id FROM users WHERE email = $1`,
        [email]
    );
    if (exist.rows.length > 0) return exist.rows[0].id;

    const created = await pool.query(
        `INSERT INTO users (email, password_hash, client_id) VALUES ($1, $2, $3) RETURNING id`,
        [email, "ANONYMOUS_NO_LOGIN", clientId || null]
    );
    return created.rows[0].id;
}

app.post("/api/chat-public", async (req, res) => {
    try {
        const message = (req.body.message || "").trim();
        const sessionId = req.body.sessionId;
        const conversationIdRecu = req.body.conversationId || null;

        if (!message) {
            return res.status(400).json({ ok: false, error: "Message vide." });
        }
        if (message.length > 2000) {
            return res.status(400).json({ ok: false, error: "Message trop long." });
        }
        if (!sessionId) {
            return res.status(400).json({ ok: false, error: "Session manquante." });
        }

        const userId = await getOrCreateAnonymousUser(sessionId);

        let conversationId = null;

        if (conversationIdRecu) {
            const check = await pool.query(
                `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
                [conversationIdRecu, userId]
            );
            if (check.rows.length > 0) conversationId = check.rows[0].id;
        }

        if (!conversationId) {
            const conv = await pool.query(
                `SELECT id FROM conversations WHERE user_id = $1
                 ORDER BY created_at DESC LIMIT 1`,
                [userId]
            );
            if (conv.rows.length > 0) conversationId = conv.rows[0].id;
        }

        if (!conversationId) {
            const nouvelle = await pool.query(
                `INSERT INTO conversations (user_id, title)
                 VALUES ($1, $2) RETURNING id`,
                [userId, "Chat public"]
            );
            conversationId = nouvelle.rows[0].id;
        }

        await pool.query(
            `INSERT INTO messages (conversation_id, role, content)
             VALUES ($1, $2, $3)`,
            [conversationId, "user", message]
        );

        await pool.query(
            `UPDATE conversations SET title = $1
             WHERE id = $2 AND title IN ('Chat public', 'Nouvelle conversation')`,
            [message.length > 60 ? message.slice(0, 60) + "…" : message, conversationId]
        );

        const historique = await pool.query(
            `SELECT role, content FROM messages
             WHERE conversation_id = $1 ORDER BY created_at ASC`,
            [conversationId]
        );

        const contexteRAG = await getContexteRAG(message);

        const response = await client.responses.create({
            model: "gpt-5",
            instructions:
                "Tu es HATIMEDIA, un assistant IA personnel créé par Hatime Hamadi. " +
                "Réponds en français de façon naturelle, chaleureuse et professionnelle. " +
                "\n\nRÈGLES IMPORTANTES :\n" +
                "1. Va droit au but (2-4 phrases sauf demande explicite).\n" +
                "2. Si la réponse se trouve dans la 'Base de connaissances' ci-dessous, utilise-la en PRIORITÉ et cite l'info exacte.\n" +
                "3. Si tu ne sais pas, dis-le honnêtement. N'invente JAMAIS.\n" +
                "4. Ne prétends JAMAIS avoir fait une action que tu n'as pas faite.\n" +
                "5. Ne répète pas la question avant de répondre.\n" +
                "6. Utilise le tutoiement (tu), pas le vouvoiement.\n" +
                "7. Termine par une question SEULEMENT si c'est pertinent.\n" +
                "8. Si la personne parle en anglais ou autre langue, réponds dans la même langue.\n" +
                "\nPERSONNALITÉ :\n" +
                "- Tu es joyeux, intelligent, naturel, chaleureux et légèrement drôle.\n" +
                "- Tu t'adaptes au ton de ton interlocuteur.\n" +
                "- Tu ne fais pas de listes à puces sauf si c'est utile.\n" +
                "- Tu utilises 1 emoji maximum par message." +
                (contexteRAG ? "\n\n📚 BASE DE CONNAISSANCES :\n" + contexteRAG : "") +
                "\n\nRéponds maintenant à la question.",
            input: historique.rows.slice(-6).map(m => ({
                role: m.role,
                content: m.content
            }))
        });
        const reply = response.output_text;

        const insertedMsg = await pool.query(
            `INSERT INTO messages (conversation_id, role, content)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [conversationId, "assistant", reply]
        );


                // Notification Slack
        envoyerNotificationSlack(message, reply, sessionId).catch(err =>
            console.error("Erreur Slack :", err)
        );



        // Notification Discord
        envoyerNotificationDiscord(message, reply, sessionId).catch(err =>
            console.error("Erreur Discord :", err)
        );


        // Envoyer notification email
        envoyerNotification(message, reply, sessionId).catch(err =>
            console.error("Erreur notif :", err)
        );
        res.json({ ok: true, reply, conversationId, messageId: insertedMsg.rows[0].id });

    } catch (error) {
        console.error("❌ Erreur chat public :", error);
        res.status(500).json({ ok: false, error: "Erreur serveur." });
    }
});

app.get("/api/chat-public/historique/:sessionId", async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const userId = await getOrCreateAnonymousUser(sessionId);

        const conv = await pool.query(
            `SELECT id FROM conversations WHERE user_id = $1
             ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );

        if (conv.rows.length === 0) {
            return res.json({ ok: true, messages: [], conversationId: null });
        }

        const conversationId = conv.rows[0].id;
        const msgs = await pool.query(
            `SELECT role, content FROM messages
             WHERE conversation_id = $1 ORDER BY created_at ASC`,
            [conversationId]
        );

        res.json({
            ok: true,
            conversationId,
            messages: msgs.rows
        });
    } catch (error) {
        console.error("❌ Erreur historique public :", error);
        res.status(500).json({ ok: false, error: "Erreur serveur." });
    }
});


// ========================================
// RÉACTIONS AUX MESSAGES
// ========================================

app.post("/api/react", async (req, res) => {
    try {
        const { messageId, reaction, sessionId } = req.body;

        if (!messageId || !reaction || !sessionId) {
            return res.status(400).json({ ok: false, error: "Paramètres manquants." });
        }

        const autorisees = ["👍", "❤️", "😂", "😍", "🎉", "🔥", "👏"];
        if (!autorisees.includes(reaction)) {
            return res.status(400).json({ ok: false, error: "Réaction invalide." });
        }

        const exist = await pool.query(
            `SELECT id, reaction_type FROM reactions
             WHERE message_id = $1 AND session_id = $2`,
            [messageId, sessionId]
        );

        if (exist.rows.length > 0) {
            if (exist.rows[0].reaction_type === reaction) {
                await pool.query(
                    `DELETE FROM reactions WHERE id = $1`,
                    [exist.rows[0].id]
                );
                return res.json({ ok: true, action: "removed" });
            }
            await pool.query(
                `UPDATE reactions SET reaction_type = $1 WHERE id = $2`,
                [reaction, exist.rows[0].id]
            );
            return res.json({ ok: true, action: "updated" });
        }

        await pool.query(
            `INSERT INTO reactions (message_id, reaction_type, session_id)
             VALUES ($1, $2, $3)`,
            [messageId, reaction, sessionId]
        );
        res.json({ ok: true, action: "created" });

    } catch (error) {
        console.error("❌ Erreur réaction :", error);
        res.status(500).json({ ok: false, error: "Erreur serveur." });
    }
});


// ========================================
// COMPTER LES RÉACTIONS D'UN MESSAGE
// ========================================

app.get("/api/reactions/:messageId", async (req, res) => {
    try {
        const messageId = parseInt(req.params.messageId);

        if (!messageId) {
            return res.status(400).json({ ok: false, error: "messageId invalide." });
        }

        const result = await pool.query(
            `SELECT reaction_type, session_id FROM reactions
             WHERE message_id = $1
             ORDER BY created_at ASC`,
            [messageId]
        );

        const comptes = {};
        const par_emoji = {};

        for (const row of result.rows) {
            const emoji = row.reaction_type;
            const sess = (row.session_id || "").substring(0, 20);
            comptes[emoji] = (comptes[emoji] || 0) + 1;
            if (!par_emoji[emoji]) par_emoji[emoji] = [];
            par_emoji[emoji].push(sess);
        }

        res.json({ ok: true, messageId, reactions: comptes, details: par_emoji });

    } catch (error) {
        console.error("❌ Erreur comptage réactions :", error);
        res.status(500).json({ ok: false, error: "Erreur serveur." });
    }
});


// ========================================
// RECHERCHE RAG (base de connaissances)
// ========================================

app.get("/api/rag-test", async (req, res) => {
    try {
        const question = req.query.q || "test";
        const resultats = await rechercherDansBase(question, 3);
        res.json({ ok: true, question, resultats });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});



// ========================================
// WEBHOOK WHATSAPP (Twilio)
// ========================================

app.post("/webhook-whatsapp", async (req, res) => {
    try {
        const messageBody = (req.body.Body || "").trim();
        const expediteur = req.body.From;
        const sessionIdWa = "wa_" + expediteur.replace(/[^0-9]/g, "").slice(-10);

        console.log("📱 WhatsApp reçu de", expediteur, ":", messageBody);

        if (!messageBody) {
            return res.status(200).send("<Response></Response>");
        }

        // Réutilise la logique du chat public
        const userId = await getOrCreateAnonymousUser(sessionIdWa);

        let conversationId = null;
        const conv = await pool.query(
            `SELECT id FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );
        if (conv.rows.length > 0) conversationId = conv.rows[0].id;

        if (!conversationId) {
            const nouvelle = await pool.query(
                `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
                [userId, "Chat WhatsApp"]
            );
            conversationId = nouvelle.rows[0].id;
        }

        await pool.query(
            `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
            [conversationId, "user", messageBody]
        );

        const historique = await pool.query(
            `SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
            [conversationId]
        );

        const response = await client.responses.create({
            model: "gpt-5",
            instructions:
                "Tu es HATIMEDIA, un assistant IA personnel sur WhatsApp. " +
                "Réponds en français de façon naturelle, chaleureuse, concise et amicale. " +
                "Va droit au but (2-4 phrases sauf demande explicite). " +
                "Cette personne te contacte par WhatsApp : sois accueillant.",
            input: historique.rows.slice(-6).map(m => ({
                role: m.role,
                content: m.content
            }))
        });

        const reply = response.output_text;

        await pool.query(
            `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
            [conversationId, "assistant", reply]
        );

               // Notifications Discord + Email
        envoyerNotificationDiscord(messageBody, reply, sessionIdWa).catch(() => {});
        envoyerNotification(messageBody, reply, sessionIdWa).catch(() => {});

        // Répondre via TwiML (Twilio envoie automatiquement sur WhatsApp)
        const replySafe = reply
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

           res.status(200).contentType("text/xml").send(
            `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${replySafe}</Message></Response>`
        );
    } catch (error) {
        console.error("❌ Erreur webhook WhatsApp :", error);
        res.status(200).send("<Response></Response>");
    }
});


// ========================================
// PARTAGE DE CONVERSATION
// ========================================

app.get("/share/:sessionId", async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const userId = await getOrCreateAnonymousUser(sessionId);

        // Récupérer la conversation
        const conv = await pool.query(
            `SELECT id, title, created_at FROM conversations
             WHERE user_id = $1
             ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );

        if (conv.rows.length === 0) {
            return res.status(404).send("Conversation introuvable");
        }

        const conversationId = conv.rows[0].id;
        const titre = conv.rows[0].title || "Conversation";

        // Récupérer les messages
        const msgs = await pool.query(
            `SELECT role, content, created_at FROM messages
             WHERE conversation_id = $1 ORDER BY created_at ASC`,
            [conversationId]
        );

        // Construire les bulles HTML
        let bulles = "";
        for (const m of msgs.rows) {
            const icone = m.role === "user" ? "🧑" : "🤖";
            const classe = m.role === "user" ? "user" : "assistant";
            const date = new Date(m.created_at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
            const contenu = (m.content || "")
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");

            bulles += `
                <div class="msg ${classe}">
                    <div class="avatar">${icone}</div>
                    <div>
                        <div class="bubble">${contenu}</div>
                        <div class="time">${date}</div>
                    </div>
                </div>
            `;
        }

        const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${titre} — HATIMEDIA</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: linear-gradient(135deg, #f0f2f7 0%, #e0e5ee 100%); min-height: 100dvh; padding: 20px; }
  .chat { max-width: 800px; margin: 0 auto; }
  .conv-header { text-align: center; margin-bottom: 30px; padding: 20px; background: rgba(255,255,255,.9); border-radius: 16px; box-shadow: 0 4px 15px rgba(0,0,0,0.08); }
  .conv-header h2 { font-size: 22px; color: #111827; margin-bottom: 8px; }
  .conv-header p { color: #6b7280; font-size: 13px; }
  .btn-back { display: inline-block; margin-bottom: 16px; padding: 10px 20px; background: #2563eb; color: #fff; border-radius: 10px; text-decoration: none; font-size: 14px; font-weight: 600; }
  .btn-back:hover { background: #1d4ed8; }
  .msg { margin-bottom: 16px; display: flex; gap: 12px; align-items: flex-start; }
  .msg.user { flex-direction: row-reverse; }
  .msg .bubble { max-width: 75%; padding: 12px 16px; border-radius: 14px; line-height: 1.5; font-size: 14px; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user .bubble { background: linear-gradient(135deg, #4ade80, #22d3ee); color: #0a0e1a; border-top-right-radius: 4px; }
  .msg.assistant .bubble { background: #fff; color: #1f2937; border-top-left-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
  .msg .avatar { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; background: #e5e7eb; }
  .msg .time { font-size: 11px; color: #9ca3af; margin-top: 4px; }
  .footer { text-align: center; color: #9ca3af; font-size: 12px; margin-top: 30px; }
</style>
</head>
<body>
<div class="chat">
  <div class="conv-header">
    <a href="https://hatimedia.onrender.com/chat" class="btn-back">← Discuter avec HATIMEDIA</a>
    <h2>💬 ${titre}</h2>
    <p>${msgs.rows.length} messages — Partagé depuis HATIMEDIA</p>
  </div>
  <div>${bulles}</div>
  <p class="footer">HATIMEDIA — Conversation partagée</p>
</div>
</body>
</html>`;

        res.send(html);
    } catch (error) {
        console.error("❌ Erreur partage :", error);
        res.status(500).send("Erreur serveur");
    }
});


// ========================================
// STRIPE — PAIEMENT & ABONNEMENT
// ========================================

// Créer une session de paiement
app.post("/api/stripe/checkout", async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) {
            return res.status(400).json({ ok: false, error: "Session manquante." });
        }

        const userId = await getOrCreateAnonymousUser(sessionId);

        const userInfo = await pool.query(
            `SELECT email FROM users WHERE id = $1`,
            [userId]
        );
        const email = userInfo.rows[0]?.email || "client@hatimedia.local";

        const session = await creerSessionCheckout(
            userId,
            email,
            "https://hatimedia.onrender.com/premium-success?session_id={CHECKOUT_SESSION_ID}",
            "https://hatimedia.onrender.com/chat"
        );

        res.json({ ok: true, url: session.url });
    } catch (error) {
        console.error("❌ Erreur Stripe checkout :", error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Vérifier mon abonnement
app.get("/api/stripe/status/:sessionId", async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const userId = await getOrCreateAnonymousUser(sessionId);
        const abo = await getAbonnement(userId);
        res.json({ ok: true, ...abo });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Webhook Stripe (paiement confirmé)
app.post("/webhook-stripe", async (req, res) => {
    try {
        // Le raw body est capturé par express.json({verify: ...}) en haut du fichier
        const rawBody = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);
        const event = JSON.parse(rawBody);

        console.log("💳 Webhook Stripe reçu :", event.type);

        if (event.type === "checkout.session.completed") {
            const session = event.data.object;
            const userId = parseInt(session.metadata?.userId);
            if (userId) {
                await activerPremium(userId, session.customer, session.subscription);
                console.log(`✅ Premium activé pour user ${userId}`);
            }
        } else if (
            event.type === "customer.subscription.deleted" ||
            event.type === "customer.subscription.updated"
        ) {
            const sub = event.data.object;
            const userId = parseInt(sub.metadata?.userId);
            if (userId && sub.status !== "active") {
                await desactiverPremium(userId);
            }
        }

        res.json({ received: true });
    } catch (error) {
        console.error("❌ Erreur webhook Stripe :", error.message);
        res.status(400).json({ error: error.message });
    }
});
// Page de succès après paiement
app.get("/premium-success", async (req, res) => {
    const sessionId = req.query.session_id || "";
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bienvenue en Premium !</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: linear-gradient(135deg, #4ade80, #38bdf8); min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { background: #fff; padding: 40px; border-radius: 20px; text-align: center; max-width: 500px; box-shadow: 0 20px 60px rgba(0,0,0,0.15); }
  h1 { color: #10b981; font-size: 28px; margin-bottom: 15px; }
  p { color: #64748b; font-size: 15px; line-height: 1.6; margin-bottom: 20px; }
  .emoji { font-size: 60px; margin-bottom: 20px; }
  a { display: inline-block; background: #10b981; color: #fff; padding: 14px 28px; border-radius: 12px; text-decoration: none; font-weight: 600; }
  a:hover { background: #059669; }
</style>
</head>
<body>
  <div class="card">
    <div class="emoji">🎉</div>
    <h1>Bienvenue dans HATIMEDIA Premium !</h1>
    <p>Votre abonnement est actif. Vous avez maintenant accès à :</p>
    <p>✅ Messages illimités<br>✅ RAG (base de connaissances)<br>✅ CRM complet<br>✅ WhatsApp<br>✅ Multi-utilisateurs</p>
    <a href="/chat">Retour au chat →</a>
  </div>
</body>
</html>`);
});


// ========================================
// PAGE CONTACT
// ========================================

app.get("/contact", (req, res) => {
    res.sendFile(require("path").join(__dirname, "public", "contact.html"));
});

app.post("/api/contact", async (req, res) => {
    try {
        const { nom, email, message } = req.body;

        if (!nom || !email || !message) {
            return res.status(400).json({ ok: false, error: "Tous les champs sont obligatoires." });
        }

        // Envoyer notification par email
        const { Resend } = require("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);

        await resend.emails.send({
            from: "HATIMEDIA Contact <onboarding@resend.dev>",
            to: "hatimedia@hotmail.com",
            subject: `📧 Nouveau contact : ${nom}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px;">
                    <h2 style="color: #4ade80;">📧 Nouveau message de contact</h2>
                    <p><strong>Nom :</strong> ${nom}</p>
                    <p><strong>Email :</strong> ${email}</p>
                    <hr>
                    <h3>Message :</h3>
                    <blockquote style="background: #f0f0f0; padding: 12px; border-left: 4px solid #4ade80;">
                        ${message}
                    </blockquote>
                </div>
            `
        });

        console.log("📧 Contact reçu :", nom, email);

        res.json({ ok: true });
    } catch (error) {
        console.error("❌ Erreur contact :", error);
        res.status(500).json({ ok: false, error: "Impossible d'envoyer le message." });
    }
});


// ========================================
// ADMIN CLIENTS (multi-tenant)
// ========================================

// Créer un client
app.post("/api/admin/clients", async (req, res) => {
    try {
        const { slug, name, email, logo_url, primary_color, secondary_color, welcome_message, system_prompt } = req.body;

        if (!slug || !name) {
            return res.status(400).json({ ok: false, error: "Slug et name obligatoires." });
        }

        // Nettoyer le slug
        const slugPropre = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");

        const result = await pool.query(
            `INSERT INTO clients (slug, name, email, logo_url, primary_color, secondary_color, welcome_message, system_prompt)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [slugPropre, name, email, logo_url, primary_color, secondary_color, welcome_message, system_prompt]
        );

        res.json({ ok: true, client: result.rows[0] });
    } catch (error) {
        console.error("Erreur création client :", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Lister tous les clients
app.get("/api/admin/clients", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, slug, name, email, plan, status, created_at FROM clients ORDER BY created_at DESC`
        );
        res.json({ ok: true, clients: result.rows });
    } catch (error) {
        console.error("Erreur liste clients :", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Modifier un client
app.put("/api/admin/clients/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, logo_url, primary_color, secondary_color, welcome_message, system_prompt, plan, status } = req.body;

        const result = await pool.query(
            `UPDATE clients SET
                name = COALESCE($1, name),
                email = COALESCE($2, email),
                logo_url = COALESCE($3, logo_url),
                primary_color = COALESCE($4, primary_color),
                secondary_color = COALESCE($5, secondary_color),
                welcome_message = COALESCE($6, welcome_message),
                system_prompt = COALESCE($7, system_prompt),
                plan = COALESCE($8, plan),
                status = COALESCE($9, status),
                updated_at = NOW()
             WHERE id = $10
             RETURNING *`,
            [name, email, logo_url, primary_color, secondary_color, welcome_message, system_prompt, plan, status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: "Client introuvable." });
        }

        res.json({ ok: true, client: result.rows[0] });
    } catch (error) {
        console.error("Erreur modification client :", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Supprimer un client
app.delete("/api/admin/clients/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`DELETE FROM clients WHERE id = $1 RETURNING id`, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: "Client introuvable." });
        }

        res.json({ ok: true });
    } catch (error) {
        console.error("Erreur suppression client :", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Récupérer un client par slug (PUBLIC - pour la page chat)
app.get("/api/client/:slug", async (req, res) => {
    try {
        const { slug } = req.params;
        const result = await pool.query(
            `SELECT id, slug, name, logo_url, primary_color, secondary_color, welcome_message, plan, status
             FROM clients WHERE slug = $1 AND status = 'active'`,
            [slug]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: "Client introuvable." });
        }

        res.json({ ok: true, client: result.rows[0] });
    } catch (error) {
        console.error("Erreur récupération client :", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});


// ========================================
// PAGE CHAT CLIENT (multi-tenant)
// ========================================

app.get("/c/:slug", (req, res) => {
    res.sendFile(require("path").join(__dirname, "public", "chat-client.html"));
});

// Chat pour un client spécifique
app.post("/api/chat-client", async (req, res) => {
    try {
        const message = (req.body.message || "").trim();
        const sessionId = req.body.sessionId;
        const conversationIdRecu = req.body.conversationId || null;
        const slug = req.body.slug;

        if (!message || !sessionId || !slug) {
            return res.status(400).json({ ok: false, error: "Paramètres manquants." });
        }

        // Récupérer le client
        const clientResult = await pool.query(
            `SELECT id, name, system_prompt, primary_color FROM clients WHERE slug = $1 AND status = 'active'`,
            [slug]
        );

        if (clientResult.rows.length === 0) {
            return res.status(404).json({ ok: false, error: "Client introuvable." });
        }

        const client = clientResult.rows[0];
        const clientId = client.id;

        // Créer/récupérer user
        const userId = await getOrCreateAnonymousUser(sessionId, clientId);

        // Résoudre la conversation
        let conversationId = null;

        if (conversationIdRecu) {
            const check = await pool.query(
                `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
                [conversationIdRecu, userId]
            );
            if (check.rows.length > 0) conversationId = check.rows[0].id;
        }

        if (!conversationId) {
            const nouvelle = await pool.query(
                `INSERT INTO conversations (user_id, title, client_id)
                 VALUES ($1, $2, $3) RETURNING id`,
                [userId, "Chat client", clientId]
            );
            conversationId = nouvelle.rows[0].id;
        }

        // Sauvegarder le message
        await pool.query(
            `INSERT INTO messages (conversation_id, role, content, client_id)
             VALUES ($1, $2, $3, $4)`,
            [conversationId, "user", message, clientId]
        );

        // Historique
        const historique = await pool.query(
            `SELECT role, content FROM messages
             WHERE conversation_id = $1 ORDER BY created_at ASC`,
            [conversationId]
        );

        // RAG filtré par client
        let contexteRAG = "";
        try {
            const ragResult = await pool.query(
                `SELECT content FROM knowledge_base
                 WHERE client_id = $1 OR client_id IS NULL
                 LIMIT 5`,
                [clientId]
            );
            if (ragResult.rows.length > 0) {
                contexteRAG = "\n\n📚 Base de connaissances :\n" +
                    ragResult.rows.map(r => r.content).join("\n\n");
            }
        } catch (e) {
            console.error("Erreur RAG client :", e);
        }

        // Réponse IA
        const systemPrompt = client.system_prompt ||
            "Tu es un assistant IA amical et professionnel. Réponds en français de façon naturelle et concise.";

        const response = await client.responses.create({
            model: "gpt-5",
            instructions: systemPrompt + contexteRAG,
            input: historique.rows.slice(-6).map(m => ({
                role: m.role,
                content: m.content
            }))
        });

        const reply = response.output_text;

        await pool.query(
            `INSERT INTO messages (conversation_id, role, content, client_id)
             VALUES ($1, $2, $3, $4)`,
            [conversationId, "assistant", reply, clientId]
        );

        // Notification
        envoyerNotificationDiscord(message, reply, sessionId + " [" + client.name + "]").catch(() => {});
        envoyerNotificationSlack(message, reply, sessionId + " [" + client.name + "]").catch(() => {});

        res.json({ ok: true, reply, conversationId });
    } catch (error) {
        console.error("❌ Erreur chat client :", error);
        res.status(500).json({ ok: false, error: "Erreur serveur." });
    }
});



// ========================================
// DÉMARRAGE DU SERVEUR
// ========================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log("Serveur démarré sur le port " + PORT);
});