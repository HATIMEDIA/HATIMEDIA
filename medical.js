module.exports = function(app, client) {
    // ===== HELPERS MÉDICAMENT =====
    const MOTS_CLES_MEDICAMENT = [
        "medicament", "doliprane", "paracetamol", "ibuprofene", "aspirine",
        "efferalgan", "spasfon", "posologie", "dosage", "dose",
        "contre-indication", "effet secondaire", "effets secondaires",
        "ordonnance", "prescription", "comprime", "gelule", "sirop",
        "antibiotique", "antidouleur", "anti-douleur", "anti-inflammatoire",
        "medoc", "notice"
    ];

    function estQuestionMedicament(message) {
        if (!message || typeof message !== "string") return false;
        const m = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return MOTS_CLES_MEDICAMENT.some(mot => m.includes(mot));
    }

    function extraireNomMedicament(message) {
        if (!message) return "";
        return message.replace(/^(c'est quoi|c est quoi|quelle est|quel est|donne moi|donne-moi|parle moi de|parle-moi de|info sur|infos sur|recherche|cherche)\s+/i, "").replace(/\s*\?+$/g, "").trim().split(/\s+/).slice(0, 4).join(" ");
    }

    async function rechercherMedicament(query) {
        if (!query) return null;
        try {
            const apiUrl = `https://medicaments-api.giygas.dev/v1/medicaments?search=${encodeURIComponent(query)}`;
            const response = await fetch(apiUrl, { headers: { "Accept": "application/json", "User-Agent": "HATIMEDIA/1.0" } });
            if (!response.ok) return null;
            return await response.json();
        } catch (error) {
            console.error("Erreur recherche médicament :", error.message);
            return null;
        }
    }

    function formaterMedicamentsPourPrompt(data) {
        if (!data || !Array.isArray(data) || data.length === 0) return "";
        let texte = "\n\n💊 DONNÉES MÉDICAMENTS (BDPM) :\n";
        for (const med of data.slice(0, 5)) {
            texte += `- ${med.elementPharmaceutique || "Inconnu"}`;
            if (med.formePharmaceutique) texte += ` (${med.formePharmaceutique})`;
            if (med.voiesAdministration && med.voiesAdministration.length > 0) texte += ` — voie : ${med.voiesAdministration.join(", ")}`;
            if (med.statusAutorisation) texte += ` — ${med.statusAutorisation}`;
            if (med.cis) texte += ` [CIS: ${med.cis}]`;
            texte += "\n";
        }
        texte += "\nUtilise ces données. N'invente JAMAIS de posologie.\n";
        return texte;
    }

    // ===== HELPERS PRATICIEN =====
    const MOTS_CLES_PRATICIEN = [
        "medecin", "docteur", "praticien", "specialiste", "generaliste",
        "cardio", "dermato", "ophtalmo", "pediatre", "gyneco", "dentiste",
        "kine", "osteo", "psy", "psychiatre", "psychologue",
        "rendez-vous", "rendez vous", "rdv", "consultation", "cabinet"
    ];

    function estQuestionPraticien(message) {
        if (!message || typeof message !== "string") return false;
        const m = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return MOTS_CLES_PRATICIEN.some(mot => m.includes(mot));
    }

    async function chercherPraticien(specialite, ville) {
        try {
            const argumentsMCP = { specialite: specialite || "" };
            if (ville) {
                const v = ville.toLowerCase().trim();
                argumentsMCP.ville = v;
                if (/^\d{5}$/.test(v)) {
                    argumentsMCP.code_postal = v;
                    argumentsMCP.departement = v.substring(0, 2);
                } else {
                    const depts = {
                        "paris": "75", "marseille": "13", "lyon": "69", "toulouse": "31", "nice": "06", 
                        "nantes": "44", "bordeaux": "33", "lille": "59", "rennes": "35", "strasbourg": "67", 
                        "montpellier": "34", "grenoble": "38", "dijon": "21", "angers": "49", "reims": "51", 
                        "le havre": "76", "saint-etienne": "42", "toulon": "83", "le mans": "72", "aix-en-provence": "13", 
                        "brest": "29", "limoges": "87", "tours": "37", "amiens": "80", "metz": "57", "besancon": "25",
                        "perpignan": "66", "orleans": "45", "rouen": "76", "caen": "14", "nancy": "54", "clermont-ferrand": "63"
                    };
                    if (depts[v]) argumentsMCP.departement = depts[v];
                }
            }
            console.log("🔍 Recherche praticien - params :", JSON.stringify(argumentsMCP));
            const payload = {
                jsonrpc: "2.0", id: 1, method: "tools/call",
                params: { name: "search_praticiens", arguments: argumentsMCP }
            };
            const response = await fetch("https://monsuivimedical.fr/mcp", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
            });
            if (!response.ok) return null;
            const data = await response.json();
            return data.result && data.result.content && data.result.content[0] ? data.result.content[0].text : null;
        } catch (error) {
            console.error("Erreur recherche praticien :", error.message);
            return null;
        }
    }

    function formaterPraticiensPourPrompt(texteResultat) {
        if (!texteResultat) return "";
        let data;
        try { data = typeof texteResultat === "string" ? JSON.parse(texteResultat) : texteResultat; } catch (e) { return ""; }
        const liste = (data && Array.isArray(data.praticiens)) ? data.praticiens : [];
        const avecAdresse = liste.filter(p => p.adresse && p.commune);
        if (avecAdresse.length === 0) return "\n\n🩺 PRATICIENS : aucun praticien avec adresse trouvé. Dis-le honnêtement.\n";
        let texte = "\n\n🩺 PRATICIENS TROUVÉS (RPPS) :\n";
        for (const p of avecAdresse.slice(0, 5)) {
            texte += `- ${p.civilite || ""} ${p.nom} — ${p.specialite}`;
            if (p.adresse) texte += ` — ${p.adresse}`;
            if (p.telephone) texte += ` — Tél : ${p.telephone}`;
            texte += "\n";
        }
        texte += "\nLISTE ces praticiens. Ne demande pas de précisions si tu as des résultats.\n";
        return texte;
    }

    // ===== ROUTES DE TEST =====
    app.get("/api/node-version", (req, res) => res.json({ version: process.version, fetch: typeof fetch === "function" }));

    app.get("/api/medicament/recherche", async (req, res) => {
        try {
            if (!req.query.q) return res.status(400).json({ ok: false, error: "q manquant" });
            const data = await rechercherMedicament(req.query.q);
            res.json({ ok: true, recherche: req.query.q, resultats: data });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    app.get("/api/praticien/recherche", async (req, res) => {
        try {
            const resultat = await chercherPraticien(req.query.specialite || "", req.query.ville || "");
            res.json({ ok: true, specialite: req.query.specialite, ville: req.query.ville, resultat });
        } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // ===== HELPERS ANTEO (PRISE DE RDV) =====
    const MOTS_CLES_RDV = [
        "rendez-vous", "rendez vous", "rdv", "réserver", "reserver", 
        "consultation", "disponibilité", "disponibilité", "créneau", "creneau",
        "prendre un rdv", "voir un medecin", "voir un médecin"
    ];

    function estQuestionRendezVous(message) {
        if (!message || typeof message !== "string") return false;
        const m = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return MOTS_CLES_RDV.some(mot => m.includes(mot));
    }

    async function appelerAnteos(toolName, args) {
        const cle = process.env.ANTEOS_API_KEY;
        if (!cle) {
            console.error("❌ ANTEOS_API_KEY manquante (test en cours).");
            return "La clé API Anteos n'est pas encore configurée. Je ne peux pas chercher de créneaux pour le moment.";
        }

        const payload = {
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: toolName, arguments: args }
        };

        try {
            const response = await fetch("https://anteoshealth.com/mcp", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${cle}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) return `Erreur Anteos (${response.status})`;
            const data = await response.json();
            return data.result?.content?.[0]?.text || "Aucune donnée reçue d'Anteos.";
        } catch (error) {
            console.error("❌ Anteos erreur :", error.message);
            return "Impossible de contacter Anteos pour le moment.";
        }
    }

        // ===== ANALYSE D'ORDONNANCE =====
    async function analyserOrdonnance(texteOrdonnance) {
        if (!texteOrdonnance) return "Aucun texte fourni.";
        try {
            const response = await client.responses.create({
                model: "gpt-5",
                instructions: "Tu es un pharmacien. Extrais les noms des médicaments de ce texte d'ordonnance. Réponds UNIQUEMENT par un tableau JSON de chaînes de caractères. Exemple: [\"Doliprane 1000mg\", \"Amoxicilline\"]. N'inclus aucun autre texte.",
                input: texteOrdonnance
            });

            let medicaments = [];
            try {
                medicaments = JSON.parse(response.output_text);
            } catch (e) {
                return "❌ Impossible de lire l'ordonnance correctement.";
            }

            if (!Array.isArray(medicaments) || medicaments.length === 0) {
                return "📋 Aucun médicament trouvé dans l'ordonnance.";
            }

            let resultatFinal = "📋 **Analyse de votre ordonnance :**\n\n";
            for (const med of medicaments.slice(0, 5)) {
                const data = await rechercherMedicament(med);
                resultatFinal += `💊 **${med}**\n`;
                if (data && Array.isArray(data) && data.length > 0) {
                    resultatFinal += formaterMedicamentsPourPrompt(data) + "\n";
                } else {
                    resultatFinal += "- Information non trouvée dans la base officielle.\n\n";
                }
            }
            return resultatFinal;

        } catch (error) {
            console.error("Erreur analyse ordonnance :", error);
            return "❌ Erreur lors de l'analyse de l'ordonnance.";
        }
    }

    // Route de test pour l'ordonnance
    app.post("/api/ordonnance/analyser", async (req, res) => {
        try {
            const texte = req.body.texte;
            if (!texte) return res.status(400).json({ ok: false, error: "Texte manquant" });
            const resultat = await analyserOrdonnance(texte);
            res.json({ ok: true, analyse: resultat });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    
    // ===== EXPORT POUR SERVER.JS =====
    return {
        estQuestionMedicament, extraireNomMedicament, rechercherMedicament, formaterMedicamentsPourPrompt,
        estQuestionPraticien, chercherPraticien, formaterPraticiensPourPrompt, estQuestionRendezVous, appelerAnteos
    };
};
