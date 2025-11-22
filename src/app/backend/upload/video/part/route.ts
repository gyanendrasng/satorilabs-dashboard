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
    const key = formData.get('key') as string;
    const partNumber = parseInt(formData.get('partNumber') as string);
    const chunk = formData.get('chunk') as File;

    if (!sessionId || !uploadId || !key || !partNumber || !chunk) {
      return NextResponse.json(
        { error: 'sessionId, uploadId, key, partNumber, and chunk are required' },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await chunk.arrayBuffer());
    const result = await uploadPart(key, uploadId, partNumber, buffer);

    // Remove quotes from ETag if present (S3 returns ETags with quotes)
    const rawETag = result.ETag;
    if (!rawETag) {
      throw new Error(`No ETag returned for part ${partNumber}`);
    }
    const cleanETag = rawETag.replace(/"/g, '');

    console.log(`Part ${partNumber} uploaded:`, {
      partNumber: result.PartNumber,
      originalEtag: rawETag,
      cleanETag,
      etagLength: cleanETag.length,
      hadQuotes: rawETag !== cleanETag,
    });

    return NextResponse.json({
      partNumber: result.PartNumber,
      etag: cleanETag,
    });
  } catch (error) {
    console.error('[/backend/upload/video/part] Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to upload video part',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
