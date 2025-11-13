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

    const { sessionId, uploadId, parts } = await request.json();

    if (!sessionId || !uploadId || !parts || !Array.isArray(parts)) {
      return NextResponse.json(
        { error: 'Missing required fields: sessionId, uploadId, parts' },
        { status: 400 }
      );
    }

    const key = `recordings/${sessionId}/recording.webm`;
    await completeMultipartUpload(
      key,
      uploadId,
      parts.map((p: { partNumber: number; etag: string }) => ({
        PartNumber: p.partNumber,
        ETag: p.etag,
      }))
    );

    return NextResponse.json({
      success: true,
      key,
    });
  } catch (error) {
    console.error('[/api/upload/recording/complete] Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to complete upload',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
