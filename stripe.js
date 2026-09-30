const Stripe = require("stripe");
const { Pool } = require("pg");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const NEON_URL = "postgresql://neondb_owner:npg_Mgj98WxFaJUY@ep-rapid-silence-b2r6id56-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const pool = new Pool({
    connectionString: NEON_URL,
    ssl: { rejectUnauthorized: false }
});

async function getAbonnement(userId) {
    const result = await pool.query(
        `SELECT plan, status FROM subscribers WHERE user_id = $1`,
        [userId]
    );
    if (result.rows.length === 0) {
        return { plan: "free", status: "active" };
    }
    return result.rows[0];
}

async function creerSessionCheckout(userId, email, successUrl, cancelUrl) {
    // Vérifier si déjà abonné
    const abo = await getAbonnement(userId);
    if (abo.plan === "premium" && abo.status === "active") {
        throw new Error("Vous êtes déjà Premium.");
    }

    const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [
            {
                price: process.env.STRIPE_PRICE_ID,
                quantity: 1
            }
        ],
        customer_email: email,
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
            userId: String(userId)
        }
    });

    return session;
}

async function activerPremium(userId, stripeCustomerId, stripeSubscriptionId) {
    await pool.query(
        `INSERT INTO subscribers (user_id, stripe_customer_id, stripe_subscription_id, plan, status, updated_at)
         VALUES ($1, $2, $3, 'premium', 'active', NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET stripe_customer_id = EXCLUDED.stripe_customer_id,
             stripe_subscription_id = EXCLUDED.stripe_subscription_id,
             plan = 'premium',
             status = 'active',
             updated_at = NOW()`,
        [userId, stripeCustomerId, stripeSubscriptionId]
    );
    console.log(`✅ Utilisateur ${userId} passé en Premium`);
}

async function desactiverPremium(userId) {
    await pool.query(
        `UPDATE subscribers SET plan = 'free', status = 'cancelled', updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
    );
    console.log(`⛔ Utilisateur ${userId} repassé en Free`);
}

module.exports = {
    stripe,
    getAbonnement,
    creerSessionCheckout,
    activerPremium,
    desactiverPremium
};