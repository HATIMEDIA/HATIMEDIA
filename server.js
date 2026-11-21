const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const express = require("express");
const OpenAI = require("openai");
require("dotenv").config();
const bcrypt = require("bcrypt");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const mammoth = require("mammoth");
const multer = require("multer");
const { choisirAgent, determinerAction, creerAction } = require("./orchestrateur");
const { preparerMessage, validerMessage, demanderConfirmation } = require("./outil-messagerie");
const { executerAction } = require("./moteur-actions");
const { analyserDemandeMessagerie, extraireContenuMessage } = require("./analyse-demande");
const { envoyerNotification } = require("./email");
const { envoyerNotificationDiscord } = require("./discord");
const { envoyerNotificationSlack } = require("./slack");
const { rechercherDansBase, getContexteRAG } = require("./rag");
const { stripe, getAbonnement, creerSessionCheckout, activerPremium, desactiverPremium } = require("./stripe");

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new Pool({ connectionString: "postgresql://neondb_owner:npg_Mgj98WxFaJUY@ep-rapid-silence-b2r6id56-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require", ssl: { rejectUnauthorized: false } });
const medical = require("./medical")(app, client);
const { estQuestionMedicament, extraireNomMedicament, rechercherMedicament, formaterMedicamentsPourPrompt, estQuestionPraticien, chercherPraticien, formaterPraticiensPourPrompt, estQuestionRendezVous, appelerAnteos, analyserOrdonnance, estQuestionOrdonnance, evaluerUrgence } = medical;

app.get("/chat", (req, res) => res.sendFile(require("path").join(__dirname, "public", "chat.html")));
app.get("/admin", (req, res) => res.sendFile(require("path").join(__dirname, "public", "admin.html")));
app.get("/test", (req, res) => res.json({ ok: true }));

// AUTHENTIFICATION
app.post("/api/register", async (req, res) => { try { const hash = await bcrypt.hash(req.body.password, 10); const r = await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`, [req.body.email, hash]); res.json({ ok: true, user: r.rows[0] }); } catch (e) { res.status(500).json({ error: "Erreur" }); } });
app.post("/api/login", async (req, res) => { try { const r = await pool.query("SELECT * FROM users WHERE email = $1", [req.body.email]); if (!r.rows.length) return res.status(401).json({ error: "Erreur" }); const u = r.rows[0]; if (!(await bcrypt.compare(req.body.password, u.password_hash))) return res.status(401).json({ error: "Erreur" }); const t = jwt.sign({ userId: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: "7d" }); res.json({ ok: true, token: t }); } catch (e) { res.status(500).json({ error: "Erreur" }); } });
function verifierToken(req, res, next) { const a = req.headers.authorization; if (!a || !a.startsWith("Bearer ")) return res.status(401).json({ error: "Token" }); try { req.user = jwt.verify(a.substring(7), process.env.JWT_SECRET); next(); } catch (e) { return res.status(401).json({ error: "Token" }); } }

async function getOrCreateAnonymousUser(sessionId, clientId) { if (!sessionId) throw new Error("Session invalide"); const propre = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64); const email = `anon_${propre}@hatimedia.local`; const e = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]); if (e.rows.length) return e.rows[0].id; const c = await pool.query(`INSERT INTO users (email, password_hash, client_id) VALUES ($1, $2, $3) RETURNING id`, [email, "NO_LOGIN", clientId || null]); return c.rows[0].id; }

// CHAT PUBLIC
app.post("/api/chat-public", async (req, res) => {
    try {
        const message = (req.body.message || "").trim();
        const sessionId = req.body.sessionId;
        const conversationIdRecu = req.body.conversationId || null;
        if (!message || !sessionId) return res.status(400).json({ ok: false, error: "Paramètres manquants." });

        const userId = await getOrCreateAnonymousUser(sessionId);
        let conversationId = conversationIdRecu;
        if (!conversationId) {
            const c = await pool.query(`INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id`, [userId, "Chat public"]);
            conversationId = c.rows[0].id;
        }
        
        await pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`, [conversationId, "user", message]);
        const historique = await pool.query(`SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversationId]);

        let contexteInstruction = "", afficherCarte = false, villeCarte = "";
        
        if (estQuestionRendezVous(message)) {
            contexteInstruction = "\n\n🗓️ MODE RDV UNIQUEMENT. Ne pose AUCUNE question médicale. Demande: 1. Nom, 2. Email, 3. Spécialité, 4. Ville. À la fin, inclus : [MAKE_RDV: {\"nom\": \"...\", \"email\": \"...\", \"specialite\": \"...\", \"ville\": \"...\"}]\n";
            const v = ["paris", "toulouse", "marseille", "lyon"].find(x => message.toLowerCase().includes(x));
            if (v) { afficherCarte = true; villeCarte = v; }
        } else {
            const r = await getContexteRAG(message);
            const meds = estQuestionMedicament(message) ? await rechercherMedicament(extraireNomMedicament(message)) : null;
            const prat = estQuestionPraticien(message) ? await chercherPraticien("", ["paris", "toulouse", "marseille", "lyon"].find(x => message.toLowerCase().includes(x)) || "") : null;
            const ord = estQuestionOrdonnance(message) ? await analyserOrdonnance(message) : null;
            const triage = evaluerUrgence(message);
            
            contexteInstruction = (r ? "\nRAG:" + r : "") + 
                (meds ? formaterMedicamentsPourPrompt(meds) : "") + 
                (prat ? formaterPraticiensPourPrompt(prat) : "") + 
                (ord ? "\nOrdonnance:" + ord : "") +
                (triage.urgence ? "\n🚨 URGENCE: Dis d'appeler le 15." : triage.symptome ? "\n🩺 Symptômes: Conseille prudemment." : "");
            
            if (prat && ["paris", "toulouse", "marseille", "lyon"].find(x => message.toLowerCase().includes(x))) {
                afficherCarte = true; villeCarte = ["paris", "toulouse", "marseille", "lyon"].find(x => message.toLowerCase().includes(x));
            }
        }

        const response = await client.responses.create({
            model: "gpt-5",
            instructions: "Tu es HATIMEDIA, assistant médical (tu ne poses pas de diagnostic). " + contexteInstruction + "\nTermine toujours par un rappel de prudence. Réponds naturellement.",
            input: historique.rows.slice(-6).map(m => ({ role: m.role, content: m.content }))
        });
        const reply = response.output_text;
        let cleanReply = reply;

        const matchMake = reply.match(/\[MAKE_RDV:\s*(\{.*?\})\s*\]/s);
        if (matchMake) {
            cleanReply = reply.replace(matchMake[0], "").trim();
            if (process.env.MAKE_WEBHOOK_URL) {
                fetch(process.env.MAKE_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: matchMake[1] }).catch(() => {});
            }
        }

        const insertedMsg = await pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id`, [conversationId, "assistant", cleanReply]);
        
        envoyerNotificationDiscord(message, cleanReply, sessionId).catch(() => {});
        envoyerNotification(message, cleanReply, sessionId, estQuestionOrdonnance(message) ? "ordonnance" : "message").catch(() => {});

        res.json({ ok: true, reply: cleanReply, conversationId, messageId: insertedMsg.rows[0].id, carte: afficherCarte ? villeCarte : null });
    } catch (error) { res.status(500).json({ ok: false, error: "Erreur serveur." }); }
});

app.get("/api/chat-public/historique/:sessionId", async (req, res) => { try { const userId = await getOrCreateAnonymousUser(req.params.sessionId); const conv = await pool.query(`SELECT id FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]); if (!conv.rows.length) return res.json({ ok: true, messages: [] }); const msgs = await pool.query(`SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`, [conv.rows[0].id]); res.json({ ok: true, conversationId: conv.rows[0].id, messages: msgs.rows }); } catch (e) { res.status(500).json({ ok: false }); } });

// VISION IA
app.post("/api/chat-vision", async (req, res) => {
    try {
        const { image, message } = req.body;
        const response = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: "Analyse l'image médicale, sois prudent." }, { role: "user", content: [{ type: "text", text: message }, { type: "image_url", image_url: { url: image } }] }],
            max_tokens: 500
        });
        res.json({ ok: true, reply: response.choices[0].message.content });
    } catch (error) { res.status(500).json({ ok: false, error: "Erreur vision." }); }
});

// DASHBOARD MEDECIN
app.get("/dashboard", (req, res) => res.sendFile(require("path").join(__dirname, "public", "dashboard.html")));
app.get("/api/dashboard/pre-consultations", async (req, res) => {
    try {
        const result = await pool.query(`SELECT m.content, m.created_at, c.user_id FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE m.role = 'assistant' AND m.content LIKE '%Compte-rendu%' ORDER BY m.created_at DESC LIMIT 50`);
        res.json({ ok: true, bilans: result.rows.map(r => ({ contenu: r.content, date: r.created_at, sessionId: "sess_" + r.user_id })) });
    } catch (e) { res.status(500).json({ ok: false }); }
});

// NOTIFICATIONS WEBHOOKS & AUTRES
app.post("/api/react", async (req, res) => { try { const { messageId, reaction, sessionId } = req.body; const e = await pool.query(`SELECT id FROM reactions WHERE message_id = $1 AND session_id = $2`, [messageId, sessionId]); if (e.rows.length) await pool.query(`UPDATE reactions SET reaction_type = $1 WHERE id = $2`, [reaction, e.rows[0].id]); else await pool.query(`INSERT INTO reactions (message_id, reaction_type, session_id) VALUES ($1, $2, $3)`, [messageId, reaction, sessionId]); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false }); } });
app.get("/api/reactions/:messageId", async (req, res) => { try { const r = await pool.query(`SELECT reaction_type, session_id FROM reactions WHERE message_id = $1`, [req.params.messageId]); const c = {}; r.rows.forEach(x => c[x.reaction_type] = (c[x.reaction_type] || 0) + 1); res.json({ ok: true, reactions: c }); } catch (e) { res.status(500).json({ ok: false }); } });
app.post("/webhook-whatsapp", async (req, res) => { res.sendStatus(200); /* Logique WhatsApp simplifiée */ });

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Serveur démarré sur le port " + PORT));
