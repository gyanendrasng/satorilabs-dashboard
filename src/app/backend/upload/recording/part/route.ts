import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { uploadPart } from '@/lib/s3';

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const sessionId = formData.get('sessionId') as string;
    const uploadId = formData.get('uploadId') as string;
    const partNumber = parseInt(formData.get('partNumber') as string, 10);
    const chunk = formData.get('chunk') as File;

    if (!sessionId || !uploadId || !partNumber || !chunk) {
      return NextResponse.json(
        {
          error:
            'Missing required fields: sessionId, uploadId, partNumber, chunk',
        },
        { status: 400 }
      );
    }

    const key = `recordings/${sessionId}/recording.webm`;
    const chunkBuffer = Buffer.from(await chunk.arrayBuffer());

    const part = await uploadPart(key, uploadId, partNumber, chunkBuffer);

    return NextResponse.json({
      partNumber: part.PartNumber,
      etag: part.ETag,
    });
  } catch (error) {
    console.error('[/backend/upload/recording/part] Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to upload part',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

