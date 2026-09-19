require("dotenv").config();

const OpenAI = require("openai");

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

async function determinerEvolutionSouvenir(ancienSouvenir, nouveauSouvenir) {

    const response = await client.responses.create({
        model: "gpt-5",

        instructions: `
Tu compares deux souvenirs personnels.

Réponds UNIQUEMENT avec un JSON valide :

{
  "sameMemory": true
}

ou :

{
  "sameMemory": false
}

sameMemory = true si le nouveau souvenir reformule,
précise ou actualise essentiellement la même information.

sameMemory = false s'il apporte une information différente.
`,

        input: `
ANCIEN :
${ancienSouvenir}

NOUVEAU :
${nouveauSouvenir}
`
    });

    return JSON.parse(response.output_text);
}

(async () => {

    const ancien =
        "L'utilisateur préfère travailler avec HATIMEDIA étape par étape.";

    const nouveau =
        "L'utilisateur aime travailler avec HATIMEDIA.";

    const resultat =
        await determinerEvolutionSouvenir(ancien, nouveau);

    console.log(resultat);

})();
