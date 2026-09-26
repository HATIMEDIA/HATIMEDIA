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
const app = express();

// ⚠️ Capture du RAW BODY pour la signature Meta
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.static("public"));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const NEON_URL = "postgresql://neondb_owner:npg_Mgj98WxFaJUY@ep-rapid-silence-b2r6id56-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const pool = new Pool({ connectionString: NEON_URL, ssl: { rejectUnauthorized: false } });


// Page de chat publique (sans login)
app.get("/chat", (req, res) => {
    res.sendFile(require("path").join(__dirname, "public", "chat.html"));
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

async function getOrCreateAnonymousUser(sessionId) {
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
        `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
        [email, "ANONYMOUS_NO_LOGIN"]
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

        const response = await client.responses.create({
            model: "gpt-5",
            instructions:
                "Tu es HATIMEDIA, un assistant IA personnel. " +
                "Réponds en français de façon naturelle, chaleureuse, concise et amicale. " +
                "Va droit au but (2-4 phrases sauf demande explicite). " +
                "Tu peux utiliser des emojis avec parcimonie. " +
                "Sois vivant, complice et drôle quand c'est approprié. " +
                "Cette personne ne te connaît pas encore : sois accueillant.",
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
            `SELECT reaction_type, COUNT(*) AS nb
             FROM reactions
             WHERE message_id = $1
             GROUP BY reaction_type`,
            [messageId]
        );

        const comptes = {};
        for (const row of result.rows) {
            comptes[row.reaction_type] = parseInt(row.nb);
        }

        res.json({ ok: true, messageId, reactions: comptes });

    } catch (error) {
        console.error("❌ Erreur comptage réactions :", error);
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