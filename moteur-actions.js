const { envoyerEmail } = require("./gmail");

async function executerAction(action) {
    if (!action) {
        throw new Error("Action HATIMEDIA manquante.");
    }

    const payload =
        typeof action.payload === "string"
            ? JSON.parse(action.payload)
            : action.payload;

    if (
        action.agent === "messagerie" &&
        payload?.canal === "email"
    ) {
        const resultat = await envoyerEmail({
            to: payload.destinataire,
            subject: payload.subject || "Message envoyé par HATIMEDIA",
            text: payload.contenu
        });

        return {
            succes: true,
            agent: "messagerie",
            action: "envoyer_email",
            service: "gmail",
            messageId: resultat.id,
            destinataire: payload.destinataire
        };
    }

    return {
        succes: false,
        agent: action.agent,
        action: action.action,
        erreur: "Aucun exécuteur disponible pour cette action."
    };
}

module.exports = {
    executerAction
};
