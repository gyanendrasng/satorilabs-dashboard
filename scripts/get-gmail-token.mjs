#!/usr/bin/env node
/**
 * One-time script to get a Gmail OAuth refresh token using the credentials
 * already in .env (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).
 *
 * Usage:
 *   node --env-file=.env scripts/get-gmail-token.mjs
 *
 * Requirements:
 *   1. Your OAuth client (Google Cloud Console → APIs & Services → Credentials)
 *      must list `https://developers.google.com/oauthplayground` as an
 *      Authorized redirect URI.
 *   2. Gmail API must be enabled on the project.
 */

import { google } from 'googleapis';
import readline from 'node:readline/promises';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);

const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://mail.google.com/'],
  prompt: 'consent',
});

console.log('\n1. Open this URL in your browser:\n');
console.log(url);
console.log('\n2. Sign in with the Gmail account you want the dashboard to act as.');
console.log('3. After consent, the page redirects to the Playground with a "code" parameter in the URL.');
console.log('   Copy the value of `code` (everything after `code=`, before `&`).');
console.log('   It will look like: 4/0AeaY...\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const code = (await rl.question('Paste authorization code: ')).trim();
rl.close();

try {
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.error('\n⚠ No refresh_token returned. This usually means the account already granted before — revoke the app at https://myaccount.google.com/permissions and rerun.');
    process.exit(2);
  }
  console.log('\n✅ Success. Update your .env:\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
} catch (err) {
  console.error('\n❌ Error exchanging code:', err.message);
  if (err.message.includes('invalid_grant') || err.message.includes('redirect_uri_mismatch')) {
    console.error('\nCheck that:');
    console.error('  - The redirect URI `https://developers.google.com/oauthplayground` is allowed on your OAuth client');
    console.error('  - You pasted the FULL `code` value');
    console.error('  - The code is fresh (codes expire in a few minutes)');
  }
  process.exit(3);
}
