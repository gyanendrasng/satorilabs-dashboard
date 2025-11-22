import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { completeMultipartUpload } from '@/lib/s3';

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
      parts: parts.map(p => ({
        partNumber: p.partNumber,
        etag: p.etag,
        etagLength: p.etag?.length || 0,
        etagQuoted: p.etag?.startsWith('"') && p.etag?.endsWith('"')
      })),
    });

    // Validate parts array - ensure no gaps and all parts are present
    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const expectedParts = Array.from({ length: sortedParts.length }, (_, i) => i + 1);

    // Check for empty ETags
    for (const part of parts) {
      if (!part.etag || part.etag.trim() === '') {
        throw new Error(`Part ${part.partNumber} has empty ETag`);
      }
      if (part.etag.includes('"')) {
        throw new Error(`Part ${part.partNumber} ETag still contains quotes: ${part.etag}`);
      }
    }

    // Validate part numbering (should be 1, 2, 3, ...)
    for (let i = 0; i < sortedParts.length; i++) {
      if (sortedParts[i].partNumber !== i + 1) {
        throw new Error(`Invalid part numbering. Expected part ${i + 1}, got ${sortedParts[i].partNumber}. All parts: ${sortedParts.map(p => p.partNumber).join(', ')}`);
      }
    }

    // Transform parts to the format expected by AWS SDK
    const transformedParts = parts.map((p: { partNumber: number; etag: string }) => ({
      PartNumber: p.partNumber,
      ETag: p.etag,
    }));

    console.log('Calling completeMultipartUpload with:', {
      key,
      uploadId,
      partsForS3: transformedParts.sort((a, b) => a.PartNumber - b.PartNumber),
    });

    await completeMultipartUpload(key, uploadId, transformedParts);

    return NextResponse.json({
      success: true,
      key,
      sessionId,
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
