// One-time YouTube OAuth setup. Run this once per channel to mint a refresh
// token, then paste it into .env.local as YOUTUBE_REFRESH_TOKEN.
//
// Prereqs (Google Cloud Console):
//   1. Enable "YouTube Data API v3" on your project.
//   2. OAuth consent screen: External, add the youtube.upload scope, add the
//      Google account that owns the target channel as a test user.
//   3. Credentials -> Create OAuth client ID -> Application type "Desktop app".
//   4. Put the client ID/secret in .env.local as YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET.
//
// Usage:
//   bun scripts/youtube-authorize.ts
// It opens a localhost server, prints a URL to open in your browser, and
// once you approve access it prints the refresh token to save.
import { createServer } from "node:http";
import { google } from "googleapis";
import { config } from "../src/config";

const PORT = 53682;
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload"];

if (!config.youtubeClientId || !config.youtubeClientSecret) {
  console.error(
    "Missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in .env.local — set those first."
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  config.youtubeClientId,
  config.youtubeClientSecret,
  config.youtubeRedirectUri
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // forces a refresh_token even on repeat runs
  scope: SCOPES,
});

console.log("\nOpen this URL, sign in with the account that owns the YouTube channel, and approve:\n");
console.log(authUrl + "\n");
console.log(`Waiting for the redirect back to ${config.youtubeRedirectUri} ...\n`);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400).end(`Authorization failed: ${error}`);
      console.error(`❌ Authorization failed: ${error}`);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(400).end("Missing ?code param");
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      "<h2>Authorized.</h2> You can close this tab and go back to the terminal."
    );

    console.log("✅ Authorized. Add this to server/.env.local:\n");
    console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    if (!tokens.refresh_token) {
      console.warn(
        "⚠️  No refresh_token returned — this happens if you've already granted access before. " +
          "Revoke access at https://myaccount.google.com/permissions and re-run this script."
      );
    }
    server.close();
    process.exit(0);
  } catch (err) {
    console.error("❌ Token exchange failed:", err);
    res.writeHead(500).end("Token exchange failed, see terminal.");
    server.close();
    process.exit(1);
  }
});

server.listen(PORT);
