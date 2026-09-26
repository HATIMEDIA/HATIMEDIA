const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

async function envoyerNotification(message, reponse, sessionId) {
    try {
        if (!process.env.RESEND_API_KEY) {
            console.log("⚠️ Email non configuré (RESEND_API_KEY manquante)");
            return;
        }

        const date = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

        await resend.emails.send({
            from: "HATIMEDIA <onboarding@resend.dev>",
            to: process.env.GMAIL_USER || "hatimedia31@gmail.com",
            subject: "📩 Nouveau message sur HATIMEDIA",
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #4ade80;">📩 Nouveau message reçu</h2>
                    <p><strong>Date :</strong> ${date}</p>
                    <p><strong>Visiteur :</strong> ${sessionId}</p>
                    <hr>
                    <h3>💬 Message :</h3>
                    <blockquote style="background: #f0f0f0; padding: 12px; border-left: 4px solid #4ade80;">
                        ${message}
                    </blockquote>
                    <h3>🤖 Réponse de HATIMEDIA :</h3>
                    <blockquote style="background: #e0f2fe; padding: 12px; border-left: 4px solid #38bdf8;">
                        ${reponse}
                    </blockquote>
                    <hr>
                    <p style="font-size: 12px; color: #999;">
                        Notification automatique de HATIMEDIA
                    </p>
                </div>
            `
        });

        console.log("✅ Notification email envoyée via Resend");
    } catch (error) {
        console.error("❌ Erreur envoi email :", error.message);
    }
}

module.exports = { envoyerNotification };