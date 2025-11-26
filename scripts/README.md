# Scripts

## Generate Signed URL

This script generates a signed URL for accessing files in your S3 bucket.

### Usage

#### Using npm script:
```bash
npm run signed-url <filename> [expiration-seconds]
```

#### Using node directly:
```bash
node scripts/generate-signed-url.js <filename> [expiration-seconds]
```

### Examples

Generate a signed URL for a recording (default 1 hour expiration):
```bash
npm run signed-url recordings/session-123/video.webm
```

Generate a signed URL with custom expiration (2 hours = 7200 seconds):
```bash
npm run signed-url recordings/session-123/video.webm 7200
```

Generate a signed URL for clicks data:
```bash
npm run signed-url recordings/session-123/clicks.json
```

### Parameters

- `filename` (required): The S3 key/path of the file in your bucket
- `expiration-seconds` (optional): How long the URL should be valid in seconds (default: 3600 = 1 hour)

### Environment Variables

The script uses the following environment variables from your `.env` file:

- `S3_BUCKET`: Your S3 bucket name
- `S3_REGION`: AWS region (default: us-east-1)
- `S3_ACCESS_KEY_ID`: Your S3 access key
- `S3_SECRET_ACCESS_KEY`: Your S3 secret key
- `S3_ENDPOINT`: (Optional) For S3-compatible storage like Cloudflare R2
- `S3_FORCE_PATH_STYLE`: (Optional) Set to 'true' for path-style URLs

## Using in Code

You can also generate signed URLs programmatically in your application:

```typescript
import { generateSignedUrl } from '@/lib/s3';

// Generate a signed URL (default 1 hour)
const url = await generateSignedUrl('recordings/session-123/video.webm');

// Generate a signed URL with custom expiration (2 hours)
const url = await generateSignedUrl('recordings/session-123/video.webm', 7200);

// Use in an API route
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');

  const videoUrl = await generateSignedUrl(`recordings/${sessionId}/video.webm`);

  return Response.json({ url: videoUrl });
}
```
