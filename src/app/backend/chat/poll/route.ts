import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { responseStore } from '@/lib/response-store';
import { prisma } from '@/lib/prisma';

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const responseId = searchParams.get('responseId');
    const lastChunkIndex = parseInt(searchParams.get('lastChunkIndex') || '0');

    if (!responseId) {
      return NextResponse.json(
        { error: 'responseId is required' },
        { status: 400 }
      );
    }

    // Extract chatId from responseId
    const chatId = responseId.split('-')[0];

    // Verify chat belongs to user
    const chat = await prisma.chat.findFirst({
      where: {
        id: chatId,
        userId: session.user.id,
      },
    });

    if (!chat) {
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
    }

    const responseData = responseStore.get(responseId);
    console.log(`[/backend/chat/poll] responseId: ${responseId}, status: ${responseData?.status || 'not found'}`);

    if (!responseData) {
      // Response not in store yet - return pending status instead of 404
      // This handles race conditions where poll arrives before responseStore is set
      console.log(`[/backend/chat/poll] Response not in store, returning pending`);
      return NextResponse.json({
        status: 'pending',
        chunks: [],
        fullResponse: '',
        currentIndex: 0,
        complete: false,
      });
    }

    // Get new chunks since lastChunkIndex
    const newChunks = responseData.chunks.slice(lastChunkIndex);

    // If response is complete and we have the full response, save to database
    if (responseData.status === 'complete' && responseData.fullResponse) {
      // Check if assistant message already exists
      const existingMessage = await prisma.chatMessage.findFirst({
        where: {
          chatId: chat.id,
          role: 'assistant',
          content: responseData.fullResponse,
        },
      });

      if (!existingMessage) {
        await prisma.chatMessage.create({
          data: {
            chatId: chat.id,
            role: 'assistant',
            content: responseData.fullResponse,
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
      }
    }

    return NextResponse.json({
      status: responseData.status,
      chunks: newChunks,
      fullResponse: responseData.fullResponse,
      currentIndex: responseData.chunks.length,
      error: responseData.error,
      complete: responseData.status === 'complete',
    });
  } catch (error) {
    console.error('Poll API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

