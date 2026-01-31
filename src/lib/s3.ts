import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Initialize S3 client with support for both AWS S3 and S3-compatible storage
export function getS3Client() {
  const config: {
    region: string;
    credentials?: {
      accessKeyId: string;
      secretAccessKey: string;
    };
    endpoint?: string;
    forcePathStyle?: boolean;
  } = {
    region: process.env.S3_REGION || 'us-east-1',
  };

  if (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    };
  }

  // Support for S3-compatible storage (e.g., MinIO, DigitalOcean Spaces)
  if (process.env.S3_ENDPOINT) {
    config.endpoint = process.env.S3_ENDPOINT;
  }

  if (process.env.S3_FORCE_PATH_STYLE === 'true') {
    config.forcePathStyle = true;
  }

  return new S3Client(config);
}

// Upload a single object to S3
export async function uploadToS3(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType?: string
): Promise<void> {
  const client = getS3Client();
  const bucket = process.env.S3_BUCKET;

  if (!bucket) {
    throw new Error('S3_BUCKET environment variable is not set');
  }

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  });

  await client.send(command);
}

// Initialize multipart upload for streaming
export async function createMultipartUpload(
  key: string,
  contentType?: string
): Promise<string> {
  const client = getS3Client();
  const bucket = process.env.S3_BUCKET;

  if (!bucket) {
    throw new Error('S3_BUCKET environment variable is not set');
  }

  const command = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType || 'video/webm',
  });

  const response = await client.send(command);
  if (!response.UploadId) {
    throw new Error('Failed to create multipart upload');
  }

  return response.UploadId;
}

// Upload a part of multipart upload
export async function uploadPart(
  key: string,
  uploadId: string,
  partNumber: number,
  body: Buffer | Uint8Array
): Promise<{ ETag: string; PartNumber: number }> {
  const client = getS3Client();
  const bucket = process.env.S3_BUCKET;

  if (!bucket) {
    throw new Error('S3_BUCKET environment variable is not set');
  }

  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
    Body: body,
  });

  const response = await client.send(command);
  if (!response.ETag) {
    throw new Error(`Failed to upload part ${partNumber}`);
  }

  return {
    ETag: response.ETag,
    PartNumber: partNumber,
  };
}

// Complete multipart upload
export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: { ETag: string; PartNumber: number }[]
): Promise<void> {
  const client = getS3Client();
  const bucket = process.env.S3_BUCKET;

  if (!bucket) {
    throw new Error('S3_BUCKET environment variable is not set');
  }

  const command = new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber),
    },
  });

  await client.send(command);
}

// Abort multipart upload (cleanup on error)
export async function abortMultipartUpload(
  key: string,
  uploadId: string
): Promise<void> {
  const client = getS3Client();
  const bucket = process.env.S3_BUCKET;

  if (!bucket) {
    throw new Error('S3_BUCKET environment variable is not set');
  }

  const command = new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
  });

  await client.send(command);
}

// Upload click timestamps as JSON
export async function uploadClickTimestamps(
  sessionId: string,
  clicks: Array<{ x: number; y: number; t: number; timestamp: number }>
): Promise<void> {
  const key = `recordings/${sessionId}/clicks.json`;
  const body = JSON.stringify(clicks, null, 2);

  await uploadToS3(key, body, 'application/json');
}

// Generate a signed URL for accessing an S3 object
export async function generateSignedUrl(
  key: string,
  expiresIn: number = 3600 // Default 1 hour
): Promise<string> {
  const client = getS3Client();
  const bucket = process.env.S3_BUCKET;

  if (!bucket) {
    throw new Error('S3_BUCKET environment variable is not set');
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return await getSignedUrl(client, command, { expiresIn });
}

// Download an object from S3
export async function downloadFromS3(key: string): Promise<Buffer> {
  const client = getS3Client();
  const bucket = process.env.S3_BUCKET;

  if (!bucket) {
    throw new Error('S3_BUCKET environment variable is not set');
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const response = await client.send(command);
  const byteArray = await response.Body?.transformToByteArray();

  if (!byteArray) {
    throw new Error(`Failed to download ${key}`);
  }

  return Buffer.from(byteArray);
}
