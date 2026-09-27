async function envoyerNotificationDiscord(message, reponse, sessionId, score = null, intention = null) {
    try {
        if (!process.env.DISCORD_WEBHOOK_URL) {
            console.log("⚠️ Discord non configuré (DISCORD_WEBHOOK_URL manquante)");
            return;
        }

        const date = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

        let emoji_score = "😐";
        if (score !== null) {
            if (score >= 70) emoji_score = "🔥";
            else if (score >= 40) emoji_score = "⚡";
            else emoji_score = "❄️";
        }

        const champs = [
            {
                name: "👤 Visiteur",
                value: `\`${sessionId}\``,
                inline: true
            },
            {
                name: "📅 Date",
                value: date,
                inline: true
            }
        ];

        if (score !== null) {
            champs.push({
                name: `${emoji_score} Score IA`,
                value: `${score}/100`,
                inline: true
            });
        }

        if (intention) {
            champs.push({
                name: "🎯 Intention",
                value: intention,
                inline: true
            });
        }

        const payload = {
            username: "HATIMEDIA",
            avatar_url: "https://hatimedia.onrender.com/mon-logo.png",
            embeds: [
                {
                    title: "📩 Nouveau message sur HATIMEDIA",
                    color: 0x4ade80,
                    fields: champs,
                    description: `**💬 Message :**\n>>> ${message.slice(0, 500)}`,
                    timestamp: new Date().toISOString(),
                    footer: {
                        text: "HATIMEDIA • Notification automatique"
                    }
                }
            ]
        };

        const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Discord a répondu ${response.status}`);
        }

        console.log("✅ Notification Discord envoyée");
    } catch (error) {
        console.error("❌ Erreur Discord :", error.message);
    }
}

module.exports = { envoyerNotificationDiscord };