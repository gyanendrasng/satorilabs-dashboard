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
  PromptInputActionMenuItem,
  PromptInputActionAddAttachments,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  SendHorizontalIcon,
  ArrowLeft,
  Edit2,
  Check,
  X,
  Video,
  Upload,
  X as XIcon,
} from 'lucide-react';

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

  // Video upload state
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [selectedVideo, setSelectedVideo] = useState<File | null>(null);
  const [uploadedVideoKey, setUploadedVideoKey] = useState<string | null>(null);

  // Video upload refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoUploadIdRef = useRef<string | null>(null);
  const videoUploadKeyRef = useRef<string | null>(null);
  const partNumberRef = useRef<number>(1);
  const uploadedPartsRef = useRef<Array<{ partNumber: number; etag: string }>>(
    []
  );
  const pendingUploadsRef = useRef<Set<Promise<void>>>(new Set());

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
    const hasVideo = selectedVideo || uploadedVideoKey;
    if (!userText && (!files || files.length === 0) && !hasVideo) return;
    if (isLoading || !session) return;

    setError(null);
    setIsLoading(true);

    let videoKey = uploadedVideoKey;

    // Upload video if selected but not yet uploaded
    if (selectedVideo && !uploadedVideoKey) {
      videoKey = await uploadVideo(selectedVideo);
      if (!videoKey) {
        setIsLoading(false);
        return; // Upload failed, don't send message
      }
    }

    // Add user message immediately
    const userMsgId = crypto.randomUUID();
    let messageContent = userText;
    if (videoKey) {
      messageContent += `\n\n[Video uploaded: ${
        selectedVideo?.name || 'video'
      }]`;
    }

    const userMessage: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: messageContent,
    };
    setMessages((prev) => [...prev, userMessage]);

    // Clear video after sending
    clearVideo();

    // Add placeholder assistant message
    const assistantMsgId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
    };
    setMessages((prev) => [...prev, assistantMessage]);

    try {
      // Submit message to API with video attachment
      const requestBody: {
        chatId: string;
        message: string;
        videoKey?: string;
      } = {
        chatId: session.id,
        message: userText,
      };

      if (videoKey) {
        requestBody.videoKey = videoKey;
      }

      const response = await fetch('/backend/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
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

  // Video upload functions
  const handleVideoSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.type.startsWith('video/')) {
      setSelectedVideo(file);
      setError(null);
    } else {
      setError('Please select a valid video file');
    }
  };

  const uploadVideo = async (file: File) => {
    if (!session) return null;

    try {
      setIsUploadingVideo(true);
      setUploadProgress(0);

      // Initialize multipart upload
      const initResponse = await fetch('/backend/upload/video/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: session.id,
          filename: file.name,
          contentType: file.type,
        }),
      });

      if (!initResponse.ok) {
        throw new Error('Failed to initialize video upload');
      }

      const initData = await initResponse.json();
      const uploadId = initData.uploadId;
      const key = initData.key;
      videoUploadIdRef.current = uploadId;
      videoUploadKeyRef.current = key;

      partNumberRef.current = 1;
      uploadedPartsRef.current = [];
      pendingUploadsRef.current.clear();

      const chunkSize = 5 * 1024 * 1024; // 5MB chunks
      const totalChunks = Math.ceil(file.size / chunkSize);
      let uploadedChunks = 0;

      console.log(
        `Starting upload of ${file.size} bytes in ${totalChunks} chunks`
      );

      // Upload file in chunks
      for (let start = 0; start < file.size; start += chunkSize) {
        const end = Math.min(start + chunkSize, file.size);
        const chunk = file.slice(start, end);
        const currentPartNumber = partNumberRef.current;

        console.log(
          `Preparing chunk ${currentPartNumber}: bytes ${start}-${end} (${chunk.size} bytes)`
        );

        const uploadPromise = (async () => {
          try {
            const formData = new FormData();
            formData.append('sessionId', session.id);
            formData.append('uploadId', uploadId);
            formData.append('key', videoUploadKeyRef.current!);
            formData.append('partNumber', currentPartNumber.toString());
            formData.append('chunk', chunk);

            const uploadResponse = await fetch('/backend/upload/video/part', {
              method: 'POST',
              body: formData,
            });

            if (uploadResponse.ok) {
              const partData = await uploadResponse.json();
              console.log(
                `Chunk ${currentPartNumber} uploaded successfully:`,
                partData
              );
              uploadedPartsRef.current.push({
                partNumber: partData.partNumber,
                etag: partData.etag,
              });
              uploadedChunks++;
              setUploadProgress((uploadedChunks / totalChunks) * 100);
            } else {
              const errorText = await uploadResponse.text();
              console.error(
                `Chunk ${currentPartNumber} upload failed:`,
                errorText
              );
              throw new Error(
                `Upload failed: ${uploadResponse.statusText} - ${errorText}`
              );
            }
          } catch (chunkErr) {
            console.error(
              `Error uploading chunk ${currentPartNumber}:`,
              chunkErr
            );
            throw chunkErr;
          }
        })();

        pendingUploadsRef.current.add(uploadPromise);
        uploadPromise.finally(() => {
          pendingUploadsRef.current.delete(uploadPromise);
        });

        partNumberRef.current += 1;
      }

      // Wait for all uploads to complete
      console.log('Waiting for all uploads to complete...');
      await Promise.all(Array.from(pendingUploadsRef.current));
      console.log(
        `All uploads completed. Parts collected: ${uploadedPartsRef.current.length}`
      );

      // Complete multipart upload
      console.log(
        'Sending complete request with parts:',
        uploadedPartsRef.current
      );
      const completeResponse = await fetch('/backend/upload/video/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: session.id,
          uploadId: uploadId,
          key: videoUploadKeyRef.current,
          parts: uploadedPartsRef.current,
        }),
      });

      if (!completeResponse.ok) {
        throw new Error('Failed to complete video upload');
      }

      const completeData = await completeResponse.json();
      setUploadedVideoKey(completeData.key);
      setUploadProgress(100);

      return completeData.key;
    } catch (error) {
      console.error('Video upload error:', error);
      setError(
        `Video upload failed: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );

      // Abort upload if it was started
      if (videoUploadIdRef.current) {
        try {
          await fetch('/backend/upload/video/abort', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              sessionId: session.id,
              uploadId: videoUploadIdRef.current,
              key: videoUploadKeyRef.current,
            }),
          });
        } catch {}
      }

      return null;
    } finally {
      setIsUploadingVideo(false);
      videoUploadIdRef.current = null;
      videoUploadKeyRef.current = null;
      pendingUploadsRef.current.clear();
    }
  };

  const clearVideo = () => {
    setSelectedVideo(null);
    setUploadedVideoKey(null);
    setUploadProgress(0);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
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
                    <Message key={m.id} from={m.role as 'user' | 'assistant'}>
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
              {/* Video upload progress */}
              {isUploadingVideo && (
                <div className="mb-2 p-3 bg-muted rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Upload className="size-4 animate-pulse" />
                    <span className="text-sm font-medium">
                      Uploading video...
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        // Cancel upload logic would go here
                        setError('Upload cancelled');
                        setIsUploadingVideo(false);
                      }}
                      className="ml-auto h-6 w-6 p-0"
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </div>
                  <Progress value={uploadProgress} className="h-2" />
                  <p className="text-xs text-muted-foreground mt-1">
                    {uploadProgress.toFixed(0)}% complete
                  </p>
                </div>
              )}

              {/* Selected video preview */}
              {selectedVideo && !isUploadingVideo && (
                <div className="mb-2 p-3 bg-muted rounded-lg">
                  <div className="flex items-center gap-2">
                    <Video className="size-4" />
                    <span className="text-sm font-medium truncate">
                      {selectedVideo.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      ({(selectedVideo.size / (1024 * 1024)).toFixed(1)} MB)
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={clearVideo}
                      className="ml-auto h-6 w-6 p-0"
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </div>
                </div>
              )}

              <PromptInput onSubmit={handleSubmit}>
                <PromptInputBody className="items-end gap-2">
                  <PromptInputTools>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="video/*"
                      onChange={handleVideoSelect}
                      className="hidden"
                      id="video-upload"
                    />
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger />
                      <PromptInputActionMenuContent>
                        <PromptInputActionAddAttachments />
                        <PromptInputActionMenuItem
                          onSelect={(e) => {
                            e.preventDefault();
                            document.getElementById('video-upload')?.click();
                          }}
                        >
                          <Video className="mr-2 size-4" />
                          Upload Video
                        </PromptInputActionMenuItem>
                      </PromptInputActionMenuContent>
                    </PromptInputActionMenu>
                  </PromptInputTools>
                  <PromptInputTextarea
                    className="px-3"
                    placeholder="Type a message..."
                    disabled={isLoading}
                  />
                  <PromptInputSubmit disabled={isLoading || isUploadingVideo}>
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
