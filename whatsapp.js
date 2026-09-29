const twilio = require("twilio");

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

async function envoyerMessageWhatsApp(numeroDestinataire, contenu) {
    try {
        if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
            console.log("⚠️ WhatsApp non configuré (variables manquantes)");
            return;
        }

        const message = await client.messages.create({
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: `whatsapp:${numeroDestinataire}`,
            body: contenu
        });

        console.log("✅ Message WhatsApp envoyé :", message.sid);
        return message;
    } catch (error) {
        console.error("❌ Erreur WhatsApp :", error.message);
    }
}

module.exports = { envoyerMessageWhatsApp };