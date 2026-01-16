import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET - Get or create the user's work chat
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Find existing work chat for this user (get the oldest one to be consistent)
    let chat = await prisma.chat.findFirst({
      where: {
        userId: session.user.id,
        mode: 'work',
      },
      orderBy: {
        createdAt: 'asc',
      },
      include: {
        messages: {
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });

    // Create if not exists
    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          userId: session.user.id,
          title: 'Work Chat',
          mode: 'work',
        },
        include: {
          messages: true,
        },
      });
    } else if (chat.title === 'New Training Session') {
      // Rename old work chats that have the default training title
      chat = await prisma.chat.update({
        where: { id: chat.id },
        data: { title: 'Work Chat' },
        include: {
          messages: {
            orderBy: {
              createdAt: 'asc',
            },
          },
        },
      });
    }

    return NextResponse.json({ chat });
  } catch (error) {
    console.error('[/backend/work-chat] GET Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
