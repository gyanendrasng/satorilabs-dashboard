'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  Message,
  MessageAvatar,
  MessageContent,
} from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputProvider,
  PromptInputTools,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionAddAttachments,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SendHorizontalIcon, ArrowLeft, Edit2, Check, X } from 'lucide-react';

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
}

interface TrainingSession {
  id: string;
  title: string;
  lastMessageAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messages: ChatMessage[];
}

interface TrainingChatProps {
  session: TrainingSession | null;
  onBack: () => void;
  onUpdateTitle?: (sessionId: string, newTitle: string) => void;
}

export function TrainingChat({
  session,
  onBack,
  onUpdateTitle,
}: TrainingChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const pollingRef = useRef<boolean>(false);

  // Load messages when session changes
  useEffect(() => {
    if (session) {
      setMessages(session.messages);
      setEditedTitle(session.title);
    } else {
      setMessages([]);
    }
  }, [session]);

  // Long polling for response
  async function pollForResponse(responseId: string, assistantMsgId: string) {
    pollingRef.current = true;
    let lastChunkIndex = 0;
    let accumulatedText = '';

    while (pollingRef.current) {
      try {
        const response = await fetch(
          `/backend/chat/poll?responseId=${encodeURIComponent(
            responseId
          )}&lastChunkIndex=${lastChunkIndex}`
        );

        if (!response.ok) {
          throw new Error('Polling failed');
        }

        const data = await response.json();

        // Update the assistant message with new chunks
        if (data.chunks && data.chunks.length > 0) {
          const newText = data.chunks.join(' ');
          accumulatedText =
            data.fullResponse || accumulatedText + ' ' + newText;

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? { ...msg, content: accumulatedText }
                : msg
            )
          );

          lastChunkIndex = data.currentIndex;
        }

        // Check if complete
        if (data.complete) {
          pollingRef.current = false;
          setIsLoading(false);
          break;
        }

        // Check for errors
        if (data.status === 'error') {
          setError(data.error || 'Response generation failed');
          pollingRef.current = false;
          setIsLoading(false);
          break;
        }

        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (err) {
        console.error('Polling error:', err);
        setError('Failed to receive response');
        pollingRef.current = false;
        setIsLoading(false);
        break;
      }
    }
  }

  // Handle message submission
  async function handleSubmit({ text, files }: PromptInputMessage) {
    const userText = (text || '').trim();
    if (!userText && (!files || files.length === 0)) return;
    if (isLoading || !session) return;

    setError(null);
    setIsLoading(true);

    // Add user message immediately
    const userMsgId = crypto.randomUUID();
    const userMessage: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: userText,
    };
    setMessages((prev) => [...prev, userMessage]);

    // Add placeholder assistant message
    const assistantMsgId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
    };
    setMessages((prev) => [...prev, assistantMessage]);

    try {
      // Submit message to API
      const response = await fetch('/backend/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chatId: session.id,
          message: userText,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to send message');
      }

      const data = await response.json();

      // Start polling for response
      if (data.responseId) {
        await pollForResponse(data.responseId, assistantMsgId);
      }
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : 'Failed to send message';
      setError(errorMsg);
      setIsLoading(false);

      // Remove the placeholder assistant message on error
      setMessages((prev) => prev.filter((msg) => msg.id !== assistantMsgId));
    }
  }

  // Handle title editing
  const handleTitleSave = async () => {
    if (!session || editedTitle === session.title) {
      setIsEditingTitle(false);
      return;
    }

    try {
      const response = await fetch(`/backend/chat/${session.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: editedTitle }),
      });

      if (response.ok) {
        onUpdateTitle?.(session.id, editedTitle);
      }
    } catch (error) {
      console.error('Failed to update title:', error);
      setEditedTitle(session.title);
    } finally {
      setIsEditingTitle(false);
    }
  };

  // Stop polling when component unmounts
  useEffect(() => {
    return () => {
      pollingRef.current = false;
    };
  }, []);

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Select a training session or create a new one to begin
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>

          <div className="flex-1">
            {isEditingTitle ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editedTitle}
                  onChange={(e) => setEditedTitle(e.target.value)}
                  className="h-8"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleTitleSave();
                    if (e.key === 'Escape') {
                      setEditedTitle(session.title);
                      setIsEditingTitle(false);
                    }
                  }}
                />
                <Button size="sm" variant="ghost" onClick={handleTitleSave}>
                  <Check className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditedTitle(session.title);
                    setIsEditingTitle(false);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{session.title}</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsEditingTitle(true)}
                >
                  <Edit2 className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        </div>

        {isLoading && (
          <p className="text-xs text-muted-foreground mt-1">
            Generating response...
          </p>
        )}
      </div>

      {/* Chat Content */}
      <div className="flex-1 overflow-hidden">
        <PromptInputProvider>
          <div className="flex flex-col h-full">
            <Conversation>
              {messages.length === 0 ? (
                <ConversationEmptyState title="Start your training session">
                  <p className="text-muted-foreground text-sm">
                    Ask questions and get guidance for your training workflow.
                  </p>
                </ConversationEmptyState>
              ) : (
                <ConversationContent>
                  {messages.map((m) => (
                    <Message key={m.id} from={m.role as any}>
                      <MessageAvatar
                        src={m.role === 'user' ? '/vercel.svg' : '/next.svg'}
                        name={m.role === 'user' ? 'You' : 'Assistant'}
                      />
                      <MessageContent>
                        {m.content ||
                          (m.role === 'assistant' && isLoading ? (
                            <span className="text-muted-foreground italic">
                              Thinking...
                            </span>
                          ) : (
                            m.content
                          ))}
                      </MessageContent>
                    </Message>
                  ))}
                  {error && (
                    <div className="px-4 py-2 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 rounded-md text-red-600 dark:text-red-400 text-sm">
                      <strong>Error:</strong> {error}
                    </div>
                  )}
                </ConversationContent>
              )}
              <ConversationScrollButton />
            </Conversation>

            <div className="border-t p-2">
              <PromptInput onSubmit={handleSubmit}>
                <PromptInputBody className="items-end gap-2">
                  <PromptInputTools>
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger />
                      <PromptInputActionMenuContent>
                        <PromptInputActionAddAttachments />
                      </PromptInputActionMenuContent>
                    </PromptInputActionMenu>
                  </PromptInputTools>
                  <PromptInputTextarea
                    className="px-3"
                    placeholder="Type a message..."
                    disabled={isLoading}
                  />
                  <PromptInputSubmit disabled={isLoading}>
                    <SendHorizontalIcon className="size-4" />
                  </PromptInputSubmit>
                </PromptInputBody>
              </PromptInput>
            </div>
          </div>
        </PromptInputProvider>
      </div>
    </div>
  );
}
