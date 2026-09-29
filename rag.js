const { Pool } = require("pg");
const OpenAI = require("openai");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://neondb_owner:npg_Mgj98WxFaJUY@ep-rapid-silence-b2r6id56-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require",
    ssl: { rejectUnauthorized: false }
});

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function rechercherDansBase(question, limite = 3) {
    try {
        // 1. Créer l'embedding de la question
        const response = await client.embeddings.create({
            model: "text-embedding-3-small",
            input: question
        });
        const vecteur = response.data[0].embedding;

        // 2. Rechercher les chunks les plus proches
        const vecteurStr = "[" + vecteur.join(",") + "]";
        const result = await pool.query(
            `SELECT source, content, 1 - (embedding <=> $1::vector) AS similarite
             FROM knowledge_base
             ORDER BY embedding <=> $1::vector
             LIMIT $2`,
            [vecteurStr, limite]
        );

        // 3. Filtrer par seuil de similarité (0.15 = 15%)
        const resultats = result.rows.filter(r => Number(r.similarite) > 0.15);

        console.log(`🔍 RAG : ${resultats.length} résultat(s) pertinent(s)`);
        resultats.forEach(r => console.log(`   → ${r.source} (similarité ${r.similarite.toFixed(3)})`));
        return resultats;
    } catch (error) {
        console.error("❌ Erreur RAG :", error.message);
        return [];
    }
}

async function getContexteRAG(question) {
    const resultats = await rechercherDansBase(question, 3);
    if (resultats.length === 0) return "";

    let contexte = "\n\n📚 Informations de la base de connaissances HATIMEDIA :\n";
    for (const r of resultats) {
        contexte += `\n[Source : ${r.source}]\n${r.content}\n`;
    }
    return contexte;
}

module.exports = { rechercherDansBase, getContexteRAG };