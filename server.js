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
        
        // DÉTECTION DU MODE RDV
        const isRdv = estQuestionRendezVous(message) || historique.rows.some(m => m.content.includes("RDV") || m.content.includes("rendez-vous"));

        if (isRdv) {
            contexteInstruction = "\n\n🗓️ MODE RENDEZ-VOUS ACTIF.\n" +
                "⚠️ INTERDICTION de poser des questions médicales.\n" +
                "Tu es un secrétaire. Vérifie dans l'historique si l'utilisateur t'a donné ces 4 infos :\n" +
                "1. Nom\n2. Email\n3. Spécialité\n4. Ville\n" +
                "S'il manque une info, demande-la poliment.\n" +
                "SI TU AS LES 4 INFOS, réponds 'Votre demande de rendez-vous est transmise.' (Ne génère pas de bloc caché, le serveur s'en occupe).\n";
            
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
            
            if (prat) {
                const v = ["paris", "toulouse", "marseille", "lyon"].find(x => message.toLowerCase().includes(x));
                if (v) { afficherCarte = true; villeCarte = v; }
            }
        }

        const response = await client.responses.create({
            model: "gpt-5",
            instructions: "Tu es HATIMEDIA. " + contexteInstruction + "\nTermine par un rappel de prudence si c'est médical.",
            input: historique.rows.slice(-6).map(m => ({ role: m.role, content: m.content }))
        });
        
        const reply = response.output_text;

        // EXTRACTION FORCÉE POUR GOOGLE CALENDAR
        if (isRdv) {
            try {
                const histStr = historique.rows.map(m => m.content).join("\n");
                if (histStr.toLowerCase().includes("paris") || histStr.toLowerCase().includes("toulouse") || histStr.toLowerCase().includes("gmail.com")) {
                    const extractRes = await client.responses.create({
                        model: "gpt-5",
                        instructions: 'Extrais le nom, l\'email, la spécialité et la ville depuis le texte. Réponds UNIQUEMENT en JSON valide: {"nom":"...", "email":"...", "specialite":"...", "ville":"..."}',
                        input: histStr
                    });
                    const rdvData = JSON.parse(extractRes.output_text.replace(/```json/g, '').replace(/```/g, '').trim());
                    
                    if (rdvData.nom && rdvData.email && rdvData.ville) {
                        if (process.env.MAKE_WEBHOOK_URL) {
                            fetch(process.env.MAKE_WEBHOOK_URL, { 
                                method: "POST", 
                                headers: { "Content-Type": "application/json" }, 
                                body: JSON.stringify(rdvData) 
                            }).then(() => console.log("✅ RDV envoyé à Google Calendar"))
                              .catch(err => console.error("❌ Erreur Google Calendar:", err));
                        }
                    }
                }
            } catch (e) { console.error("Erreur extraction RDV:", e); }
        }

        const insertedMsg = await pool.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id`, [conversationId, "assistant", reply]);
        
        envoyerNotificationDiscord(message, reply, sessionId).catch(() => {});
        envoyerNotification(message, reply, sessionId, estQuestionOrdonnance(message) ? "ordonnance" : "message").catch(() => {});

        res.json({ ok: true, reply: reply, conversationId, messageId: insertedMsg.rows[0].id, carte: afficherCarte ? villeCarte : null });
    } catch (error) { 
        console.error(error);
        res.status(500).json({ ok: false, error: "Erreur serveur." }); 
    }
});

// ========================================
// RECHERCHE AVANCÉE DE PRATICIENS (API FHIR ANS)
// ========================================

app.get("/api/praticien/recherche-avancee", async (req, res) => {
    try {
        const { specialite, ville } = req.query;
        if (!specialite && !ville) {
            return res.status(400).json({ ok: false, error: "Spécifiez une spécialité ou une ville." });
        }

        // L'API FHIR de l'ANS se trouve à cette adresse (exemple, à vérifier)
        const baseUrl = "https://interop.esante.gouv.fr/ig/fhir/annuaire";
        
        // On construit la requête pour chercher des praticiens
        let searchUrl = `${baseUrl}/Practitioner?`;
        if (specialite) searchUrl += `specialty=${encodeURIComponent(specialite)}&`;
        if (ville) searchUrl += `address-city=${encodeURIComponent(ville)}&`;
        
        // On demande les 10 premiers résultats
        searchUrl = searchUrl.slice(0, -1) + "&_count=10";

        const response = await fetch(searchUrl, {
            headers: { "Accept": "application/fhir+json" }
        });

        if (!response.ok) {
            return res.status(response.status).json({ ok: false, error: "Erreur de l'API Annuaire Santé." });
        }

        const bundle = await response.json();
        
        // On formate les résultats pour le front-end
        const praticiens = (bundle.entry || []).map(item => {
            const p = item.resource;
            const name = p.name?.[0]?.text || "Nom non renseigné";
            const specialty = p.specialty?.[0]?.coding?.[0]?.display || "Spécialité inconnue";
            const address = p.address?.[0]?.text || "Adresse non renseignée";
            return { nom: name, specialite: specialty, adresse: address };
        });

        res.json({ ok: true, praticiens });
    } catch (error) {
        console.error("❌ Erreur recherche avancée:", error);
        res.status(500).json({ ok: false, error: "Erreur serveur." });
    }
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

// ========================================
// ANNUAIRE SANTÉ (Page + API)
// ========================================

app.get("/annuaire", (req, res) => {
    res.sendFile(require("path").join(__dirname, "public", "annuaire.html"));
});

app.get("/api/annuaire", async (req, res) => {
    try {
        const specialite = req.query.specialite || "generaliste";
        const ville = req.query.ville || "paris";
        
        // On utilise la fonction qui marche déjà dans medical.js
        const resultat = await chercherPraticien(specialite, ville);
        
        let praticiens = [];
        if (resultat) {
            try {
                const parsed = JSON.parse(resultat);
                praticiens = parsed.praticiens || [];
            } catch(e) {}
        }
        
        res.json({ ok: true, praticiens });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ========================================
// RENDEZ-VOUS (Annuaire -> Dashboard)
// ========================================

app.post("/api/rdv/reserver", async (req, res) => {
    try {
        const { doctor_name, doctor_specialty, doctor_address, patient_name, patient_email, date } = req.body;
        
        await pool.query(
            `INSERT INTO appointments (doctor_name, doctor_specialty, doctor_address, patient_name, patient_email, appointment_date)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [doctor_name, doctor_specialty, doctor_address, patient_name, patient_email, date]
        );

        // Envoi de l'email au médecin (Option B)
        try {
            const { Resend } = require("resend");
            const resend = new Resend(process.env.RESEND_API_KEY);
            await resend.emails.send({
                from: "HATIMEDIA <onboarding@resend.dev>",
                to: "hatimedia31@gmail.com", // Votre email de médecin ici
                subject: `🚨 Nouveau RDV : ${patient_name}`,
                html: `<h3>Nouveau rendez-vous pris</h3>
                       <p><b>Patient :</b> ${patient_name} (${patient_email})</p>
                       <p><b>Date :</b> ${new Date(date).toLocaleString('fr-FR')}</p>
                       <p><b>Avec :</b> ${doctor_name} (${doctor_specialty})</p>`
            });
        } catch (mailErr) { console.error("Erreur email médecin:", mailErr); }

        // Notification Discord
        envoyerNotificationDiscord(`📅 RDV: ${patient_name} - ${date}`, "Annuaire", "rdv").catch(() => {});

        res.json({ ok: true, message: "Rendez-vous enregistré !" });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ ok: false, error: e.message }); 
    }
});

app.get("/api/rdv/liste", async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM appointments ORDER BY appointment_date ASC`);
        res.json({ ok: true, rdvs: result.rows });
    } catch (e) { 
        res.status(500).json({ ok: false, error: e.message }); 
    }
});

app.get("/mes-rdvs", (req, res) => {
    res.sendFile(require("path").join(__dirname, "public", "mes-rdvs.html"));
});

app.delete("/api/rdv/annuler/:id", async (req, res) => {
    try {
        const result = await pool.query(`DELETE FROM appointments WHERE id = $1 RETURNING id`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "RDV introuvable" });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Serveur démarré sur le port " + PORT));
