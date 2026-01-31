/**
 * One-time script to get Gmail refresh token
 * Usage: node get-gmail-token.js
 */

const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = ['https://mail.google.com/'];
const CREDENTIALS_PATH = '../client_secret_486188196754-p9pok1aobg287o7dpnetjsp7sm10u824.apps.googleusercontent.com.json';

async function getRefreshToken() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } = credentials.web;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n1. Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Authorize with your Gmail account');
  console.log('3. Copy the authorization code from the URL and paste it below:\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('Enter the authorization code: ', async (code) => {
    rl.close();

    try {
      const { tokens } = await oauth2Client.getToken(code);
      console.log('\n✅ Success! Add this to your .env file:\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    } catch (error) {
      console.error('Error:', error.message);
    }
  });
}

getRefreshToken();
