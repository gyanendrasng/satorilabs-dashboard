import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { uploadClickTimestamps } from '@/lib/s3';

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { sessionId, clicks } = await request.json();

    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 }
      );
    }

    if (!clicks || !Array.isArray(clicks)) {
      return NextResponse.json(
        { error: 'clicks must be an array' },
        { status: 400 }
      );
    }

    // Validate click structure
    for (const click of clicks) {
      if (
        typeof click.x !== 'number' ||
        typeof click.y !== 'number' ||
        typeof click.t !== 'number' ||
        typeof click.timestamp !== 'number'
      ) {
        return NextResponse.json(
          {
            error:
              'Invalid click format. Each click must have x, y, t, and timestamp',
          },
          { status: 400 }
        );
      }
    }

    await uploadClickTimestamps(sessionId, clicks);

    return NextResponse.json({
      success: true,
      uploaded: clicks.length,
    });
  } catch (error) {
    console.error('[/api/upload/clicks] Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to upload click timestamps',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
