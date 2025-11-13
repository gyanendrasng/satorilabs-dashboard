import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { generateDummyResponse, responseStore } from '@/lib/response-store';
import { prisma } from '@/lib/prisma';

export async function POST(request: Request) {
  try {
    console.log('[/backend/chat] POST request received');

    const session = await auth.api.getSession({
      headers: request.headers,
    });

    console.log(
      '[/backend/chat] Session:',
      session ? 'authenticated' : 'not authenticated'
    );

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { chatId, message } = await request.json();

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 }
      );
    }

    let chat;

    // If chatId provided, verify it belongs to user
    if (chatId) {
      chat = await prisma.chat.findFirst({
        where: {
          id: chatId,
          userId: session.user.id,
        },
      });

      if (!chat) {
        return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
      }
    } else {
      // Create new chat
      chat = await prisma.chat.create({
        data: {
          userId: session.user.id,
          title: message.slice(0, 50) + (message.length > 50 ? '...' : ''),
        },
      });
    }

    // Save user message
    const userMsg = await prisma.chatMessage.create({
      data: {
        chatId: chat.id,
        role: 'user',
        content: message,
      },
    });

    // Update lastMessageAt on the chat
    await prisma.chat.update({
      where: {
        id: chat.id,
      },
      data: {
        lastMessageAt: new Date(),
      },
    });

    // Generate unique response ID
    const responseId = `${chat.id}-${Date.now()}`;

    // Start generating response asynchronously
    generateDummyResponse(responseId, message).catch((err) => {
      const current = responseStore.get(responseId);
      if (current) {
        current.status = 'error';
        current.error = err.message || 'Generation failed';
        responseStore.set(responseId, current);
      }
    });

    // Return immediately with response ID for polling
    return NextResponse.json({
      chatId: chat.id,
      messageId: userMsg.id,
      responseId,
      message: 'Response generation started',
    });
  } catch (error) {
    console.error('[/backend/chat] Error:', error);
    console.error(
      '[/backend/chat] Error stack:',
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

