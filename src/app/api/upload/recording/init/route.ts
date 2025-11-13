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

    const { sessionId } = await request.json();

    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 }
      );
    }

    const key = `recordings/${sessionId}/recording.webm`;
    const uploadId = await createMultipartUpload(key, 'video/webm');

    return NextResponse.json({
      uploadId,
      key,
    });
  } catch (error) {
    console.error('[/api/upload/recording/init] Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to initialize upload',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
