import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { completeMultipartUpload, generateSignedUrl } from '@/lib/s3';

interface UploadPart {
  partNumber: number;
  etag: string;
}

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { sessionId, uploadId, key, parts } = await request.json();

    if (!sessionId || !uploadId || !key || !parts) {
      return NextResponse.json(
        { error: 'sessionId, uploadId, key, and parts are required' },
        { status: 400 }
      );
    }

    // Debug logging
    console.log('Completing multipart upload:', {
      key,
      uploadId,
      partsCount: parts.length,
    });

    // Quick validation of parts
    const uploadParts = parts as UploadPart[];
    for (const part of uploadParts) {
      if (!part.etag || part.etag.trim() === '' || part.etag.includes('"')) {
        throw new Error(`Invalid ETag for part ${part.partNumber}`);
      }
    }

    // Transform parts to the format expected by AWS SDK
    const transformedParts = uploadParts.map((p) => ({
      PartNumber: p.partNumber,
      ETag: p.etag,
    }));

    await completeMultipartUpload(key, uploadId, transformedParts);

    // Generate signed URL for the uploaded video (valid for 24 hours)
    const signedUrl = await generateSignedUrl(key, 86400);
    console.log('Generated signed URL for video:', { key, sessionId });

    // Send to RunPod endpoint asynchronously (don't wait for it)
    const runpodUrl = process.env.RUNPOD_CAPTION_URL;
    if (runpodUrl) {
      // Fire and forget - don't await this
      fetch(runpodUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          job_id: sessionId,
          video_url: signedUrl,
        }),
      })
        .then((response) => {
          if (!response.ok) {
            console.error('Failed to send to RunPod:', {
              status: response.status,
              statusText: response.statusText,
            });
          } else {
            console.log('Successfully sent video to RunPod:', { sessionId });
          }
        })
        .catch((error) => {
          console.error('Error sending to RunPod:', error);
        });
    } else {
      console.warn(
        'RUNPOD_CAPTION_URL not configured, skipping RunPod notification'
      );
    }

    // Return immediately without waiting for RunPod
    return NextResponse.json({
      success: true,
      key,
      sessionId,
      signedUrl,
    });
  } catch (error) {
    console.error('[/backend/upload/video/complete] Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to complete video upload',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
