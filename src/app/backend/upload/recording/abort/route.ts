import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { abortMultipartUpload } from '@/lib/s3';

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { sessionId, uploadId } = await request.json();

    if (!sessionId || !uploadId) {
      return NextResponse.json(
        { error: 'Missing required fields: sessionId, uploadId' },
        { status: 400 }
      );
    }

    const key = `recordings/${sessionId}/recording.webm`;
    await abortMultipartUpload(key, uploadId);

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    console.error('[/backend/upload/recording/abort] Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to abort upload',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

