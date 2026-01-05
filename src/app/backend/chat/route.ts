import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { generateDummyResponse, responseStore } from '@/lib/response-store';
import { prisma } from '@/lib/prisma';

const CAPTION_ENDPOINT =
  process.env.RUNPOD_CAPTION_URL || 'http://localhost:8000/caption';
const CHAT_ENDPOINT =
  process.env.RUNPOD_CHAT_URL || 'http://localhost:8000/chat';
const WORK_ENDPOINT = 'http://20.244.42.146:5000/run-python-script';

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

    const { chatId, message, mode, videoKey } = await request.json();

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

    // Update lastMessageAt and mode on the chat
    await prisma.chat.update({
      where: {
        id: chat.id,
      },
      data: {
        lastMessageAt: new Date(),
        mode: mode || 'training',
      } as any,
    });

    // Generate unique response ID
    const responseId = `${chat.id}-${Date.now()}`;

    // Determine which endpoint to use based on mode and video presence
    let endpointUrl: string;
    let externalRequestBody: any = {
      job_id: responseId,
      message: message,
    };

    if (mode === 'training') {
      if (videoKey) {
        // Training mode with video: send to caption endpoint
        endpointUrl = CAPTION_ENDPOINT;
        externalRequestBody.video_url = videoKey;
      } else {
        // Training mode without video: send to chat endpoint
        endpointUrl = CHAT_ENDPOINT;
      }
    } else if (mode === 'work') {
      // Work mode: send to python script execution endpoint (synchronous)
      // Initialize responseStore for polling
      console.log(
        `[/backend/chat] Work mode - setting responseStore for ${responseId}`
      );
      responseStore.set(responseId, {
        status: 'generating',
        chunks: [],
        fullResponse: '',
      });

      // Make synchronous call to work endpoint and handle response directly
      console.log(
        `[/backend/chat] Calling work endpoint: ${WORK_ENDPOINT} with task: ${message}`
      );
      fetch(WORK_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ task: message }),
      })
        .then(async (response) => {
          console.log(
            `[/backend/chat] Work endpoint response status: ${response.status}`
          );
          if (!response.ok) {
            throw new Error(`Work endpoint returned ${response.status}`);
          }
          const data = await response.json();
          console.log(`[/backend/chat] Work endpoint data:`, data);
          // Extract response message from the work endpoint
          const responseMessage =
            data.output || data.result || data.message || JSON.stringify(data);

          // Store the response
          responseStore.set(responseId, {
            status: 'complete',
            chunks: [responseMessage],
            fullResponse: responseMessage,
          });

          console.log(
            `[/backend/chat] Work mode response received for ${responseId}: ${responseMessage.substring(
              0,
              100
            )}...`
          );
        })
        .catch((err) => {
          console.error('[/backend/chat] Failed to call work endpoint:', err);
          responseStore.set(responseId, {
            status: 'error',
            chunks: [],
            fullResponse: '',
            error: err.message || 'Work endpoint call failed',
          });
        });

      // Return immediately with response ID for polling
      return NextResponse.json({
        chatId: chat.id,
        messageId: userMsg.id,
        responseId,
        message: 'Response generation started',
      });
    } else {
      // Default to chat endpoint for other modes
      endpointUrl = CHAT_ENDPOINT;
    }

    // Start generating response asynchronously by calling external API
    fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(externalRequestBody),
    }).catch((err) => {
      console.error('Failed to call external API:', err);
      const current = responseStore.get(responseId);
      if (current) {
        current.status = 'error';
        current.error = err.message || 'External API call failed';
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
