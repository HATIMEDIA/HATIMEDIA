module.exports = function(app, client) {
    const MOTS_CLES_MEDICAMENT = ["medicament", "doliprane", "paracetamol", "ibuprofene", "aspirine", "efferalgan", "spasfon", "posologie", "dosage", "dose", "contre-indication", "effet secondaire", "ordonnance", "prescription", "comprime", "gelule", "sirop", "antibiotique", "antidouleur", "anti-douleur", "anti-inflammatoire", "medoc", "notice"];
    function estQuestionMedicament(m) { if (!m) return false; const s = m.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); return MOTS_CLES_MEDICAMENT.some(k => s.includes(k)); }
    function extraireNomMedicament(m) { if (!m) return ""; return m.replace(/^(c'est quoi|c est quoi|quelle est|quel est|donne moi|donne-moi|parle moi de|parle-moi de|info sur|infos sur|recherche|cherche)\s+/i, "").replace(/\s*\?+$/g, "").trim().split(/\s+/).slice(0, 4).join(" "); }
    async function rechercherMedicament(q) { if (!q) return null; try { const r = await fetch(`https://medicaments-api.giygas.dev/v1/medicaments?search=${encodeURIComponent(q)}`, { headers: { "Accept": "application/json", "User-Agent": "HATIMEDIA/1.0" } }); return r.ok ? await r.json() : null; } catch (e) { return null; } }
    function formaterMedicamentsPourPrompt(d) { if (!d || !Array.isArray(d) || !d.length) return ""; let t = "\n\n💊 DONNÉES MÉDICAMENTS (BDPM) :\n"; for (const m of d.slice(0, 5)) { t += `- ${m.elementPharmaceutique || "?"}`; if (m.formePharmaceutique) t += ` (${m.formePharmaceutique})`; if (m.voiesAdministration?.length) t += ` — ${m.voiesAdministration.join(", ")}`; if (m.statusAutorisation) t += ` — ${m.statusAutorisation}`; if (m.cis) t += ` [CIS:${m.cis}]`; t += "\n"; } t += "\nN'invente JAMAIS de posologie.\n"; return t; }

    const MOTS_CLES_PRATICIEN = ["medecin", "docteur", "praticien", "specialiste", "generaliste", "cardio", "dermato", "ophtalmo", "pediatre", "gyneco", "dentiste", "kine", "osteo", "psy", "psychiatre", "psychologue", "rendez-vous", "rendez vous", "rdv", "consultation", "cabinet"];
    function estQuestionPraticien(m) { if (!m) return false; const s = m.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); return MOTS_CLES_PRATICIEN.some(k => s.includes(k)); }
    async function chercherPraticien(specialite, ville) {
        try {
            const args = { specialite: specialite || "" };
            if (ville) {
                const v = ville.toLowerCase().trim(); args.ville = v;
                if (/^\d{5}$/.test(v)) { args.code_postal = v; args.departement = v.substring(0, 2); } 
                else {
                    const depts = { "paris": "75", "marseille": "13", "lyon": "69", "toulouse": "31", "nice": "06", "nantes": "44", "bordeaux": "33", "lille": "59", "rennes": "35", "strasbourg": "67", "montpellier": "34", "grenoble": "38", "dijon": "21", "angers": "49", "reims": "51", "le havre": "76", "saint-etienne": "42", "toulon": "83", "le mans": "72", "aix-en-provence": "13", "brest": "29", "limoges": "87", "tours": "37", "amiens": "80", "metz": "57", "besancon": "25", "perpignan": "66", "orleans": "45", "rouen": "76", "caen": "14", "nancy": "54", "clermont-ferrand": "63" };
                    if (depts[v]) args.departement = depts[v];
                }
            }
            const payload = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_praticiens", arguments: args } };
            const r = await fetch("https://monsuivimedical.fr/mcp", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }, body: JSON.stringify(payload) });
            if (!r.ok) return null;
            const d = await r.json();
            return d.result?.content?.[0]?.text || null;
        } catch (e) { return null; }
    }
    function formaterPraticiensPourPrompt(txt) { if (!txt) return ""; let d; try { d = typeof txt === "string" ? JSON.parse(txt) : txt; } catch (e) { return ""; } const l = (d && Array.isArray(d.praticiens)) ? d.praticiens : []; const a = l.filter(p => p.adresse && p.commune); if (!a.length) return "\n\n🩺 PRATICIENS : aucun praticien avec adresse trouvé.\n"; let t = "\n\n🩺 PRATICIENS TROUVÉS :\n"; for (const p of a.slice(0, 5)) { t += `- ${p.civilite || ""} ${p.nom} — ${p.specialite} — ${p.adresse} — ${p.telephone || "Tél non renseigné"}\n`; } t += "\nLISTE ces praticiens.\n"; return t; }

    const MOTS_CLES_RDV = ["rendez-vous", "rendez vous", "rdv", "réserver", "reserver", "consultation", "disponibilité", "créneau", "creneau", "prendre un rdv", "voir un medecin", "voir un médecin"];
    function estQuestionRendezVous(m) { if (!m) return false; const s = m.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); return MOTS_CLES_RDV.some(k => s.includes(k)); }
    async function appelerAnteos(toolName, args) { const cle = process.env.ANTEOS_API_KEY; if (!cle) return "Clé Anteos non configurée."; const payload = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }; try { const r = await fetch("https://anteoshealth.com/mcp", { method: "POST", headers: { "Authorization": `Bearer ${cle}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) }); if (!r.ok) return `Erreur Anteos`; const d = await r.json(); return d.result?.content?.[0]?.text || "Aucune donnée."; } catch (e) { return "Erreur Anteos."; } }

    async function analyserOrdonnance(txt) { if (!txt) return "Aucun texte."; try { const res = await client.responses.create({ model: "gpt-5", instructions: "Extrais UNIQUEMENT le nom de base des médicaments. Réponds par un tableau JSON. Ex: [\"Doliprane\"]", input: txt }); let meds = []; try { meds = JSON.parse(res.output_text); } catch (e) { return "❌ Lecture impossible."; } if (!Array.isArray(meds) || !meds.length) return "📋 Aucun médicament trouvé."; let final = "📋 **Ordonnance :**\n\n"; for (const m of meds.slice(0, 5)) { const data = await rechercherMedicament(m); final += `💊 **${m}**\n`; if (data && Array.isArray(data) && data.length) final += formaterMedicamentsPourPrompt(data) + "\n"; else final += "- Introuvable.\n\n"; } return final; } catch (e) { return "❌ Erreur analyse."; } }
    function estQuestionOrdonnance(m) { if (!m) return false; const s = m.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); return s.includes("ordonnance") || s.includes("prescription") || s.includes("traitement"); }

    const SIGNES_VITAUX_GRAVES = ["douleur thoracique", "douleur poitrine", "bras gauche", "infarctus", "difficulté à respirer", "difficulte a respirer", "étouffe", "etouffe", "paralysie", "parle plus", "bouche tordue", "avc", "saigne beaucoup", "hémorragie", "hemorragie", "sang abondant", "inconscient", "évanoui", "evanoui", "convulsion", "suicide", "suicidaire"];
    const MOTS_SYMPTOMES = ["mal", "douleur", "fievre", "fièvre", "tousse", "toux", "nausee", "nausée", "vomi", "diarrhee", "diarrhée", "bobo", "blessé", "blesse", "fatigue", "migraine", "ventre", "tete", "tête", "gorge", "nez"];
    function evaluerUrgence(m) { if (!m) return { urgence: false, symptome: false }; const s = m.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); return { urgence: SIGNES_VITAUX_GRAVES.some(k => s.includes(k)), symptome: MOTS_SYMPTOMES.some(k => s.includes(k)) }; }

    return { estQuestionMedicament, extraireNomMedicament, rechercherMedicament, formaterMedicamentsPourPrompt, estQuestionPraticien, chercherPraticien, formaterPraticiensPourPrompt, estQuestionRendezVous, appelerAnteos, analyserOrdonnance, estQuestionOrdonnance, evaluerUrgence };
};
