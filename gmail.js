const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const credentialsPath = path.join(__dirname, "credentials.json");

const credentials = JSON.parse(
    fs.readFileSync(credentialsPath, "utf8")
);

const config = credentials.web || credentials.installed;

const oauth2Client = new google.auth.OAuth2(
    config.client_id,
    config.client_secret,
    config.redirect_uris[0]
);

const SCOPES = [
    "https://www.googleapis.com/auth/gmail.send"
];

function obtenirUrlAutorisation() {
    return oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent"
    });
}

module.exports = {
    oauth2Client,
    obtenirUrlAutorisation,
    envoyerEmail
};

function chargerJetonGmail() {
    const tokenPath = path.join(__dirname, "gmail-token.json");

    if (!fs.existsSync(tokenPath)) {
        return false;
    }

    const tokens = JSON.parse(
        fs.readFileSync(tokenPath, "utf8")
    );

    oauth2Client.setCredentials(tokens);

    return true;
}

function encoderBase64Url(texte) {
    return Buffer.from(texte, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

async function envoyerEmail({ to, subject, text }) {
    chargerJetonGmail();

    if (
        !oauth2Client.credentials.refresh_token &&
        !oauth2Client.credentials.access_token
    ) {
        throw new Error("Gmail n'est pas autorisé.");
    }

    const gmail = google.gmail({
        version: "v1",
        auth: oauth2Client
    });

    const message = [
        "From: me",
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        text
    ].join("\r\n");

    const response = await gmail.users.messages.send({
        userId: "me",
        requestBody: {
            raw: encoderBase64Url(message)
        }
    });

    return response.data;
}

