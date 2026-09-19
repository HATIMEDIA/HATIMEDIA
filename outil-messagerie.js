function preparerMessage(destinataire, contenu, canal) {
    return {
        destinataire,
        contenu,
        canal,
        statut: "pret"
    };
}


function validerMessage(message) {
    if (!message.destinataire) {
        return { valide: false, raison: "Destinataire manquant" };
    }

    if (!message.contenu) {
        return { valide: false, raison: "Contenu manquant" };
    }

    if (!message.canal) {
        return { valide: false, raison: "Canal manquant" };
    }

    return { valide: true, raison: null };
}

function demanderConfirmation(message) {
    return {
        confirmation_requise: true,
        question: `Voulez-vous envoyer ce message à ${message.destinataire} par ${message.canal} ?`,
        message
    };
}

module.exports = {
    preparerMessage,
    validerMessage,
    demanderConfirmation
};