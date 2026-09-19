const { AGENTS_HATIMEDIA } = require("./agents"); 
function listeAgents() { 
	return Object.entries(AGENTS_HATIMEDIA) .map(([id, agent]) => { 
		return `${id} : ${agent.nom} — ${agent.mission}`; 
	}) .join("\n"); 
} 

function choisirAgent(message) { 
	const texte = message.toLowerCase(); 
	if 
		( texte.includes("cherche") 
			|| texte.includes("recherche") 
			|| texte.includes("informations") 
			|| texte.includes("actualités") 
			|| texte.includes("actualité") ) { 
			return "recherche"; 
		} 

    	if   ( texte.includes("message") 
    		|| texte.includes("messagerie") 
    		|| texte.includes("envoie") ) { 
    		return "messagerie"; 
    } 
		if 
       ( texte.includes("devis") 
           || texte.includes("vente") 
           || texte.includes("commercial") ) { 
           return "commercial"; 
   }

	    if 
	   	    ( texte.includes("problème") 
		        || texte.includes("erreur") 
		        || texte.includes("aide") 
		        || texte.includes("support") ) { 
		       return "support"; 
       } 

       if 
    	    ( texte.includes("publie") 
    		    || texte.includes("publication") 
    		    || texte.includes("contenu") 
    		    || texte.includes("post") ) { 
    		    return "contenu"; 
    		} 


    return "assistant_personnel"; 
    } 

    function determinerAction(message, agent) {
    const texte = message.toLowerCase();

    if (agent === "messagerie") {
        if (
            texte.includes("envoie") ||
            texte.includes("envoyer") ||
            texte.includes("écris") ||
            texte.includes("écrire")
        ) {
            return "preparer_message";
        }

        return "gerer_messagerie";
    }

    if (agent === "recherche") {
        return "rechercher";
    }

    if (agent === "commercial") {
        return "gerer_commercial";
    }

    if (agent === "support") {
        return "traiter_support";
    }

    if (agent === "contenu") {
        return "creer_contenu";
    }

    return "conversation";
}

function creerAction(agent, action) {
    return {
        agent,
        action,
        statut: "a_preparer"
    };
}

 module.exports = {
    listeAgents,
    choisirAgent,
    determinerAction,
    creerAction
};
