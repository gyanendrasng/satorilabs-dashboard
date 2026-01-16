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
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SendHorizontalIcon,
  Edit2,
  Check,
  X,
  Package,
} from 'lucide-react';
import { SOManagementDialog } from '@/components/orders/SOManagementDialog';

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
}

interface WorkSession {
  id: string;
  title: string;
  mode?: string;
  lastMessageAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messages: ChatMessage[];
}

interface WorkChatProps {
  session: WorkSession | null;
  onUpdateTitle?: (sessionId: string, newTitle: string) => void;
}

export function WorkChat({ session, onUpdateTitle }: WorkChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const [soDialogOpen, setSODialogOpen] = useState(false);
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

  // Poll for new messages every 2 seconds
  useEffect(() => {
    if (!session) return;

    const fetchMessages = async () => {
      try {
        const response = await fetch(`/backend/chat/${session.id}`);
        if (response.ok) {
          const data = await response.json();
          if (data.chat && data.chat.messages) {
            setMessages(data.chat.messages);
          }
        }
      } catch (err) {
        console.error('Failed to fetch messages:', err);
      }
    };

    fetchMessages();
    const intervalId = setInterval(fetchMessages, 2000);

    return () => {
      clearInterval(intervalId);
    };
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

        if (data.complete) {
          pollingRef.current = false;
          setIsLoading(false);
          break;
        }

        if (data.status === 'error') {
          setError(data.error || 'Response generation failed');
          pollingRef.current = false;
          setIsLoading(false);
          break;
        }

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
  async function handleSubmit({ text }: PromptInputMessage) {
    const userText = (text || '').trim();
    if (!userText) return;
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
      const response = await fetch('/backend/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chatId: session.id,
          message: userText,
          mode: 'work',
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to send message');
      }

      const data = await response.json();

      if (data.responseId) {
        await pollForResponse(data.responseId, assistantMsgId);
      }
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : 'Failed to send message';
      setError(errorMsg);
      setIsLoading(false);
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
      <div className="flex items-center justify-center h-full text-slate-400">
        Loading work chat...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-slate-800/30">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            {isEditingTitle ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editedTitle}
                  onChange={(e) => setEditedTitle(e.target.value)}
                  className="h-8 bg-slate-900/50 border-slate-600 text-slate-100"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleTitleSave();
                    if (e.key === 'Escape') {
                      setEditedTitle(session.title);
                      setIsEditingTitle(false);
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleTitleSave}
                  className="text-slate-300 hover:text-white hover:bg-slate-700"
                >
                  <Check className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditedTitle(session.title);
                    setIsEditingTitle(false);
                  }}
                  className="text-slate-300 hover:text-white hover:bg-slate-700"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-slate-100">
                  {session.title}
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsEditingTitle(true)}
                  className="text-slate-300 hover:text-white hover:bg-slate-700"
                >
                  <Edit2 className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>

          {/* SO Management Button in Header */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSODialogOpen(true)}
            className="text-slate-300 hover:text-white hover:bg-slate-700"
            title="Manage Sales Orders"
          >
            <Package className="h-4 w-4 mr-1" />
            Orders
          </Button>
        </div>

        {isLoading && (
          <p className="text-xs text-cyan-400 mt-1">Generating response...</p>
        )}
      </div>

      {/* Chat Content */}
      <div className="flex-1 overflow-hidden">
        <PromptInputProvider>
          <div className="flex flex-col h-full">
            <Conversation className="bg-transparent">
              {messages.length === 0 ? (
                <ConversationEmptyState
                  title="Start your work session"
                  className="text-slate-100"
                >
                  <p className="text-slate-400 text-sm">
                    Ask questions and get assistance with your work.
                  </p>
                </ConversationEmptyState>
              ) : (
                <ConversationContent>
                  {messages.map((m) => (
                    <Message key={m.id} from={m.role as 'user' | 'assistant'}>
                      <MessageAvatar
                        src={m.role === 'user' ? '/vercel.svg' : '/next.svg'}
                        name={m.role === 'user' ? 'You' : 'Assistant'}
                      />
                      <MessageContent>
                        {m.content ||
                          (m.role === 'assistant' && isLoading ? (
                            <span className="text-slate-400 italic">
                              Thinking...
                            </span>
                          ) : (
                            m.content
                          ))}
                      </MessageContent>
                    </Message>
                  ))}
                  {error && (
                    <div className="px-4 py-2 bg-red-900/30 border border-red-700/50 rounded-md text-red-300 text-sm">
                      <strong>Error:</strong> {error}
                    </div>
                  )}
                </ConversationContent>
              )}
              <ConversationScrollButton />
            </Conversation>

            <div className="border-t border-slate-700 p-2">
              <PromptInput
                onSubmit={handleSubmit}
                className="[&_[data-slot=input-group]]:bg-slate-900/50 [&_[data-slot=input-group]]:border-slate-700"
              >
                <PromptInputBody className="items-end gap-2">
                  <PromptInputTextarea
                    className="px-3 bg-transparent text-slate-100 placeholder:text-slate-500"
                    placeholder="Type a message..."
                    disabled={isLoading}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSODialogOpen(true)}
                    title="Manage Sales Orders"
                    className="text-slate-400 hover:text-white hover:bg-slate-700"
                  >
                    <Package className="size-4" />
                  </Button>
                  <PromptInputSubmit
                    disabled={isLoading}
                    className="bg-cyan-600 hover:bg-cyan-700 text-white"
                  >
                    <SendHorizontalIcon className="size-4" />
                  </PromptInputSubmit>
                </PromptInputBody>
              </PromptInput>
            </div>
          </div>
        </PromptInputProvider>
      </div>

      {/* SO Management Dialog */}
      <SOManagementDialog open={soDialogOpen} onOpenChange={setSODialogOpen} />
    </div>
  );
}
