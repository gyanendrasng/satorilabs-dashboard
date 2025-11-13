import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET - List all chats for the authenticated user
export async function GET(request: Request) {
  try {
    console.log('[/backend/chats] GET request received');

    const session = await auth.api.getSession({
      headers: request.headers,
    });

    console.log(
      '[/backend/chats] Session:',
      session ? 'authenticated' : 'not authenticated'
    );

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const chats = await prisma.chat.findMany({
      where: {
        userId: session.user.id,
      },
      orderBy: {
        updatedAt: 'desc',
      },
      include: {
        messages: {
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });

    return NextResponse.json({ chats });
  } catch (error) {
    console.error('[/backend/chats] Error:', error);
    console.error(
      '[/backend/chats] Error stack:',
      error instanceof Error ? error.stack : 'No stack'
    );
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// POST - Create a new chat
export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { title } = await request.json();

    const chat = await prisma.chat.create({
      data: {
        userId: session.user.id,
        title: title || 'New Chat',
      },
    });

    return NextResponse.json({ chat });
  } catch (error) {
    console.error('Create chat error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

