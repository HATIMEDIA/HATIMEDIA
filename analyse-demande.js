function analyserDemandeMessagerie(message) {
    const texte = message.toLowerCase();

    let canal = null;
    let destinataire = null;

    if (
        texte.includes("email") ||
        texte.includes("mail") ||
        texte.includes("e-mail")
    ) {
        canal = "email";
    }

    if (texte.includes("messenger")) {
        canal = "messenger";
    }

    if (texte.includes("whatsapp")) {
        canal = "whatsapp";
    }

    const mots = message.trim().split(/\s+/);
    const indexA = mots.findIndex(mot => mot.toLowerCase() === "à");

    if (indexA !== -1 && mots[indexA + 1]) {
        destinataire = mots[indexA + 1].replace(/[,!?:;]+$/, "");
    }

    return {
        destinataire,
        contenu: message,
        canal
    };
}

async function extraireContenuMessage(message) {
    const OpenAI = require("openai");

    const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });

    const response = await client.responses.create({
        model: "gpt-5",
        instructions: `
Tu analyses une demande de messagerie.

Extrais uniquement le contenu que l'utilisateur souhaite envoyer au destinataire.

Ne garde pas :
- "Envoie un email à..."
- le nom du destinataire
- le nom du canal

Retourne uniquement le texte du message à envoyer.
`,
        input: message
    });

    return response.output_text.trim();
}


module.exports = {
    analyserDemandeMessagerie,
    extraireContenuMessage
};