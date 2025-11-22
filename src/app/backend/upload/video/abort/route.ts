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

    const { sessionId, uploadId, key } = await request.json();

    if (!sessionId || !uploadId || !key) {
      return NextResponse.json(
        { error: 'sessionId, uploadId, and key are required' },
        { status: 400 }
      );
    }

    await abortMultipartUpload(key, uploadId);

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    console.error('[/backend/upload/video/abort] Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to abort video upload',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
