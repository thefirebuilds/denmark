const { google } = require("googleapis");

function getScopes() {
  return [
    process.env.GOOGLE_CALENDAR_SCOPES ||
      "https://www.googleapis.com/auth/calendar",
  ];
}

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(state) {
  const oauth2Client = getOAuthClient();

  return oauth2Client.generateAuthUrl({
    access_type: process.env.GOOGLE_OAUTH_ACCESS_TYPE || "offline",
    prompt: process.env.GOOGLE_OAUTH_PROMPT || "consent",
    scope: getScopes(),
    state,
  });
}

async function exchangeCodeForTokens(code) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

module.exports = {
  getOAuthClient,
  getAuthUrl,
  exchangeCodeForTokens,
};