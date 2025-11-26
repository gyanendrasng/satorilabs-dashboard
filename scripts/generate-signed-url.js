#!/usr/bin/env node

/**
 * Script to generate a signed URL for an S3 object
 *
 * Usage:
 *   node scripts/generate-signed-url.js <filename> [expiration-seconds]
 *
 * Examples:
 *   node scripts/generate-signed-url.js recordings/session-123/video.webm
 *   node scripts/generate-signed-url.js recordings/session-123/video.webm 7200
 *
 * Or with npm script:
 *   npm run signed-url recordings/session-123/video.webm
 */

require('dotenv').config({ path: '.env' });
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Error: Please provide a filename');
  console.error('');
  console.error('Usage:');
  console.error('  node scripts/generate-signed-url.js <filename> [expiration-seconds]');
  console.error('');
  console.error('Examples:');
  console.error('  node scripts/generate-signed-url.js recordings/session-123/video.webm');
  console.error('  node scripts/generate-signed-url.js recordings/session-123/video.webm 7200');
  process.exit(1);
}

const filename = args[0];
const expirationSeconds = args[1] ? parseInt(args[1]) : 3600; // Default 1 hour

// Validate expiration
if (isNaN(expirationSeconds) || expirationSeconds <= 0) {
  console.error('Error: Expiration must be a positive number');
  process.exit(1);
}

// Initialize S3 client
function getS3Client() {
  const config = {
    region: process.env.S3_REGION || 'us-east-1',
  };

  if (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    };
  }

  if (process.env.S3_ENDPOINT) {
    config.endpoint = process.env.S3_ENDPOINT;
  }

  if (process.env.S3_FORCE_PATH_STYLE === 'true') {
    config.forcePathStyle = true;
  }

  return new S3Client(config);
}

async function generateSignedUrl(key, expiresIn) {
  const bucket = process.env.S3_BUCKET;

  if (!bucket) {
    throw new Error('S3_BUCKET environment variable is not set');
  }

  const client = getS3Client();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const signedUrl = await getSignedUrl(client, command, {
    expiresIn: expiresIn,
  });

  return signedUrl;
}

// Main execution
(async () => {
  try {
    console.log(`Generating signed URL for: ${filename}`);
    console.log(`Expiration: ${expirationSeconds} seconds (${Math.floor(expirationSeconds / 60)} minutes)`);
    console.log('');

    const signedUrl = await generateSignedUrl(filename, expirationSeconds);

    console.log('Signed URL:');
    console.log(signedUrl);
    console.log('');
    console.log(`This URL will expire in ${Math.floor(expirationSeconds / 60)} minutes`);
  } catch (error) {
    console.error('Error generating signed URL:', error.message);
    process.exit(1);
  }
})();
