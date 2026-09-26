const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    },
    family: 4,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
});

async function envoyerNotification(message, reponse, sessionId) {
    try {
        if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
            console.log("⚠️ Email non configuré (variables manquantes)");
            return;
        }

        const date = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

        await transporter.sendMail({
            from: `"HATIMEDIA Notif" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER,
            subject: `📩 Nouveau message sur HATIMEDIA`,
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

        console.log("✅ Notification email envoyée");
    } catch (error) {
        console.error("❌ Erreur envoi email :", error.message);
    }
}

module.exports = { envoyerNotification };