import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { createMultipartUpload } from '@/lib/s3';

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { sessionId, filename, contentType } = await request.json();

    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 }
      );
    }

    if (!filename || typeof filename !== 'string') {
      return NextResponse.json(
        { error: 'filename is required' },
        { status: 400 }
      );
    }

    // Generate unique key for the video
    const timestamp = Date.now();
    const key = `videos/${sessionId}/${timestamp}-${filename}`;

    const uploadId = await createMultipartUpload(key, contentType || 'video/mp4');

    return NextResponse.json({
      uploadId,
      key,
      sessionId,
    });
  } catch (error) {
    console.error('[/backend/upload/video/init] Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to initialize upload',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}


