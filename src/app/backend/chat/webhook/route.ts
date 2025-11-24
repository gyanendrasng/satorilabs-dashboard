import { NextResponse } from 'next/server';
import { generateDummyResponse, responseStore } from '@/lib/response-store';
import { prisma } from '@/lib/prisma';

// Dummy API key - in production, this should be stored in environment variables
const DUMMY_API_KEY = process.env.WEBHOOK_API_KEY || 'dummy-webhook-api-key-12345';

function validateApiKey(request: Request): boolean {
  // Check for API key in Authorization header (Bearer token)
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const apiKey = authHeader.substring(7);
    return apiKey === DUMMY_API_KEY;
  }

  // Check for API key in X-API-Key header
  const apiKeyHeader = request.headers.get('X-API-Key');
  if (apiKeyHeader) {
    return apiKeyHeader === DUMMY_API_KEY;
  }

  return false;
}

export async function POST(request: Request) {
  try {
    console.log('[/backend/chat/webhook] POST request received');

    // Validate API key
    if (!validateApiKey(request)) {
      console.log('[/backend/chat/webhook] Invalid API key');
      return NextResponse.json(
        { error: 'Unauthorized - Invalid API key' },
        { status: 401 }
      );
    }

    console.log('[/backend/chat/webhook] API key validated');

    const { id, message } = await request.json();

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 }
      );
    }

    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { error: 'id is required (chatId or training session id)' },
        { status: 400 }
      );
    }

    // Find chat by ID (training sessions are also chats)
    const chat = await prisma.chat.findUnique({
      where: {
        id: id,
      },
    });

    if (!chat) {
      return NextResponse.json(
        { error: 'Chat or training session not found' },
        { status: 404 }
      );
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

    // Prepare response payload
    const responsePayload = {
      chatId: chat.id,
      messageId: userMsg.id,
      responseId,
      message: 'Response generation started',
      timestamp: new Date().toISOString(),
    };

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
    return NextResponse.json(responsePayload);
  } catch (error) {
    console.error('[/backend/chat/webhook] Error:', error);
    console.error(
      '[/backend/chat/webhook] Error stack:',
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

