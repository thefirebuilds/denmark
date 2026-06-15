const { google } = require("googleapis");

function getScopes() {
  return [
    process.env.GOOGLE_CALENDAR_SCOPES ||
      "https://www.googleapis.com/auth/calendar",
  ];
}

function getOAuthClient(redirectUri = "") {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri || undefined
  );
}

function getAuthUrl(state, redirectUri) {
  const oauth2Client = getOAuthClient(redirectUri);

  return oauth2Client.generateAuthUrl({
    access_type: process.env.GOOGLE_OAUTH_ACCESS_TYPE || "offline",
    prompt: process.env.GOOGLE_OAUTH_PROMPT || "consent",
    scope: getScopes(),
    state,
  });
}

async function exchangeCodeForTokens(code, redirectUri) {
  const oauth2Client = getOAuthClient(redirectUri);
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

module.exports = {
  getOAuthClient,
  getAuthUrl,
  exchangeCodeForTokens,
};
