// messenger.js — Intégration Messenger HATIMEDIA
// Vérification de signature + anti-doublons + file d'attente

const crypto = require("crypto");
const https = require("https");
const NodeCache = require("node-cache");

const APP_SECRET = process.env.META_APP_SECRET;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GRAPH_API_VERSION = "v26.0";

// Cache anti-doublon (10 min)
const messageCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// File d'attente
const queue = [];
let isProcessing = false;

// ----------------------------------------
// 1. Vérification de signature Meta
// ----------------------------------------
function verifierSignature(rawBody, signature) {
    if (!signature || !APP_SECRET) return false;

    const attendue = crypto
        .createHmac("sha256", APP_SECRET)
        .update(rawBody, "utf8")
        .digest("hex");

    const recue = signature.replace("sha256=", "");

    const bufA = Buffer.from(attendue, "utf8");
    const bufR = Buffer.from(recue, "utf8");

    if (bufA.length !== bufR.length) return false;
    return crypto.timingSafeEqual(bufA, bufR);
}

// ----------------------------------------
// 2. Anti-doublon
// ----------------------------------------
function estDejaTraite(messageId) {
    if (!messageId) return false;
    if (messageCache.get(messageId)) {
        console.log("🔄 Doublon ignoré :", messageId);
        return true;
    }
    messageCache.set(messageId, true);
    return false;
}

// ----------------------------------------
// 3. Envoi vers Messenger
// ----------------------------------------
function envoyerMessageMessenger(recipientId, texte) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            recipient: { id: recipientId },
            messaging_type: "RESPONSE",
            message: { text: texte }
        });

        const options = {
            hostname: "graph.facebook.com",
            path: `/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let body = "";
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log("📤 Message envoyé à Messenger :", recipientId);
                    resolve(body);
                } else {
                    console.error("❌ Erreur envoi Messenger :", res.statusCode, body);
                    reject(new Error(body));
                }
            });
        });

        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

// ----------------------------------------
// 4. File d'attente
// ----------------------------------------
function ajouterALaFile(tache) {
    queue.push(tache);
    traiterLaFile();
}

async function traiterLaFile() {
    if (isProcessing) return;
    if (queue.length === 0) return;

    isProcessing = true;
    const tache = queue.shift();

    try {
        await tache();
    } catch (error) {
        console.error("❌ Erreur file :", error);
    }

    isProcessing = false;
    if (queue.length > 0) setImmediate(traiterLaFile);
}

// ----------------------------------------
// 5. Traitement d'un message
// ----------------------------------------
async function traiterMessage(senderId, texte, callbackIA) {
    console.log("👤 Message Messenger de", senderId, ":", texte);

    try {
        const reponse = await callbackIA(texte, {
            canal: "messenger",
            expediteur: senderId
        });

        if (!reponse) return;
        await envoyerMessageMessenger(senderId, reponse);

    } catch (error) {
        console.error("❌ Erreur traitement :", error);
        try {
            await envoyerMessageMessenger(
                senderId,
                "Désolé, une erreur est survenue. Réessayez. 🤖"
            );
        } catch (e) {
            console.error("❌ Envoi erreur impossible :", e);
        }
    }
}

// ----------------------------------------
// 6. Handlers Express
// ----------------------------------------
function verificationWebhook(req, res) {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("✅ WEBHOOK MESSENGER VÉRIFIÉ");
        return res.status(200).send(challenge);
    }
    console.log("❌ ÉCHEC VÉRIFICATION WEBHOOK");
    return res.sendStatus(403);
}

function creerReceptionWebhook(callbackIA) {
    return async function (req, res) {
        console.log("📩 WEBHOOK MESSENGER REÇU");

        // Signature
        const signature = req.headers["x-hub-signature-256"];
        if (APP_SECRET && req.rawBody && !verifierSignature(req.rawBody, signature)) {
            console.error("❌ SIGNATURE INVALIDE");
            return res.sendStatus(401);
        }

        // Réponse immédiate à Meta (avant timeout)
        res.sendStatus(200);

        // Traitement asynchrone
        try {
            if (req.body.object !== "page") return;

            for (const entry of req.body.entry || []) {
                for (const event of entry.messaging || []) {
                    const senderId = event.sender?.id;
                    const texte = event.message?.text;
                    const messageId = event.message?.mid;

                    if (!senderId || !texte) continue;
                    if (event.message?.is_echo) continue;
                    if (estDejaTraite(messageId)) continue;

                    ajouterALaFile(() =>
                        traiterMessage(senderId, texte, callbackIA)
                    );
                }
            }
        } catch (error) {
            console.error("❌ Erreur webhook :", error);
        }
    };
}

module.exports = {
    verificationWebhook,
    creerReceptionWebhook,
    verifierSignature,
    envoyerMessageMessenger,
    ajouterALaFile
};