async function envoyerNotificationSlack(message, reponse, sessionId) {
    try {
        if (!process.env.SLACK_WEBHOOK_URL) {
            console.log("⚠️ Slack non configuré (SLACK_WEBHOOK_URL manquante)");
            return;
        }

        const date = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

        const payload = {
            blocks: [
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: "📩 Nouveau message sur HATIMEDIA",
                        emoji: true
                    }
                },
                {
                    type: "section",
                    fields: [
                        {
                            type: "mrkdwn",
                            text: `*👤 Visiteur :*\n\`${sessionId}\``
                        },
                        {
                            type: "mrkdwn",
                            text: `*📅 Date :*\n${date}`
                        }
                    ]
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*💬 Message :*\n> ${message.slice(0, 500)}`
                    }
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*🤖 Réponse de HATIMEDIA :*\n> ${reponse.slice(0, 500)}`
                    }
                },
                {
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: "HATIMEDIA • Notification automatique"
                        }
                    ]
                }
            ]
        };

        const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Slack a répondu ${response.status}`);
        }

        console.log("✅ Notification Slack envoyée");
    } catch (error) {
        console.error("❌ Erreur Slack :", error.message);
    }
}

module.exports = { envoyerNotificationSlack };