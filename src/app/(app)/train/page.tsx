'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
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
import { SendHorizontalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CircleDot, Square } from 'lucide-react';

type ChatRole = UIMessage['role'];
type ChatMessage = { id: string; role: ChatRole; text: string };

type CreateConnectionResponse = {
  token: string;
  connection: { identifier?: string; id?: string } | string;
  created?: boolean;
  error?: string;
};

export default function TrainPage() {
  // Experimental Region Capture types
  type CropTrack = MediaStreamTrack & {
    cropTo?: (target: unknown) => Promise<void>;
  };
  type CropTargetStatic =
    | { fromElement(el: Element): Promise<unknown> }
    | undefined;
  // ----------------------------
  // Guacamole connection (right)
  // ----------------------------
  const [status, setStatus] = useState<string>('Initializing...');
  const [token, setToken] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);

  const guacBase = useMemo(() => {
    return process.env.NEXT_PUBLIC_GUAC_BASE_URL?.replace(/\/$/, '') || '';
  }, []);

  useEffect(() => {
    let cancelled = false;
    let created = false;
    async function run() {
      try {
        setStatus('Creating connection via server...');
        const resp = await fetch('/api/guacamole/create-connection', {
          method: 'POST',
        });
        const data: CreateConnectionResponse = await resp.json();
        if (!resp.ok || data.error) {
          throw new Error(data.error || resp.statusText);
        }
        if (cancelled) return;
        setToken(data.token);
        const id =
          typeof data.connection === 'string'
            ? data.connection
            : data.connection.identifier || data.connection.id || null;
        setConnectionId(id);
        created = Boolean(data.created);
        setStatus('Ready');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(`Error: ${message}`);
      }
    }
    run();
    return () => {
      cancelled = true;
      if (created && connectionId) {
        fetch('/api/guacamole/delete-connection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: connectionId }),
        }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const iframeSrc =
    token && connectionId
      ? `${guacBase}/#/client/${encodeURIComponent(
          connectionId
        )}?token=${encodeURIComponent(token)}`
      : null;

  // ----------------------------
  // Chat state (left)
  // ----------------------------
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // ----------------------------
  // Recording state / controls
  // ----------------------------
  const [isRecording, setIsRecording] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const vmContainerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const clickRipplesRef = useRef<{ x: number; y: number; t: number }[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const removeIframeClickListenerRef = useRef<(() => void) | null>(null);

  function handleSubmit({ text, files }: PromptInputMessage) {
    const userText = (text || '').trim();
    if (!userText && (!files || files.length === 0)) return;

    const next: ChatMessage[] = [
      ...messages,
      { id: crypto.randomUUID(), role: 'user', text: userText },
    ];
    setMessages(next);

    // Simple placeholder assistant reply
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: 'Thanks! The training assistant is not connected to a model yet.',
        },
      ]);
    }, 300);
  }

  async function startRecording() {
    try {
      setDownloadUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });

      // First try: capture the same-origin iframe directly (e.g., Guacamole canvas + audio)
      const tryCaptureIframeStream = async (): Promise<MediaStream | null> => {
        const iframe = iframeRef.current;
        if (!iframe) return null;
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!doc) return null;

          // Prefer capturing a canvas (common for Guacamole rendering)
          const canvas = doc.querySelector(
            'canvas'
          ) as HTMLCanvasElement | null;
          const audioEl = doc.querySelector('audio, video') as
            | (HTMLMediaElement & { captureStream?: () => MediaStream })
            | null;

          let videoStream: MediaStream | null = null;
          if (canvas && typeof canvas.captureStream === 'function') {
            videoStream = canvas.captureStream(30);
          }

          let audioStream: MediaStream | null = null;
          if (audioEl && typeof audioEl.captureStream === 'function') {
            audioStream = audioEl.captureStream();
          }

          if (!videoStream && !audioStream) return null;

          const combined = new MediaStream();
          if (videoStream) {
            videoStream.getVideoTracks().forEach((t) => combined.addTrack(t));
          }
          if (audioStream) {
            audioStream.getAudioTracks().forEach((t) => combined.addTrack(t));
          }
          return combined;
        } catch {
          // Cross-origin access or unsupported; fall back
          return null;
        }
      };

      const didEnterFullscreen = false;
      let shouldCropToIframe = false;
      let stream = await tryCaptureIframeStream();

      if (!stream) {
        // If embedded, ensure the parent iframe allows display-capture
        try {
          const inIframe = window.top !== window.self;
          const policy = (
            document as unknown as {
              permissionsPolicy?: { allowsFeature: (f: string) => boolean };
            }
          ).permissionsPolicy;
          const displayCaptureAllowed = policy
            ? policy.allowsFeature('display-capture')
            : true;
          if (inIframe && !displayCaptureAllowed) {
            setStatus(
              'Screen capture blocked by embedding permissions. The parent iframe must include allow="display-capture; fullscreen".'
            );
          }
        } catch {}

        // Fallback: capture the tab and crop to the iframe region
        const displayConstraints = {
          video: {
            frameRate: 30,
            preferCurrentTab: true,
            selfBrowserSurface: 'include',
            displaySurface: 'browser',
            surfaceSwitching: 'exclude',
            monitorTypeSurfaces: 'exclude',
            logicalSurface: true,
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            systemAudio: 'exclude',
          },
        } as const;
        try {
          stream = await navigator.mediaDevices.getDisplayMedia(
            displayConstraints as unknown as MediaStreamConstraints
          );
          // We captured the whole tab; we'll software-crop to the iframe below
          shouldCropToIframe = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setStatus(
            `Screen capture not started: ${
              message || 'Permission denied or blocked.'
            }`
          );
          setIsRecording(false);
          return;
        }

        // Try to crop the captured tab to only the VM iframe (Region Capture)
        try {
          const iframeEl = iframeRef.current;
          const videoTrack = stream.getVideoTracks()[0] as
            | CropTrack
            | undefined;
          const cropTargetStatic: CropTargetStatic = (
            window as unknown as {
              CropTarget?: { fromElement(el: Element): Promise<unknown> };
            }
          ).CropTarget;
          if (iframeEl && videoTrack?.cropTo && cropTargetStatic?.fromElement) {
            const target = await cropTargetStatic.fromElement(iframeEl);
            await videoTrack.cropTo(target);
          }
        } catch {
          // Ignore if region capture is unsupported
        }

        // We'll exit fullscreen in onstop only if we entered it here
      }

      // Composite the video with overlays (click indicators), and crop if needed
      try {
        const vt = stream.getVideoTracks()[0];
        const settings = vt.getSettings();

        const iframeEl = iframeRef.current;
        const iframeRect = iframeEl?.getBoundingClientRect();

        let targetWidth = (settings.width ||
          iframeEl?.clientWidth ||
          1280) as number;
        let targetHeight = (settings.height ||
          iframeEl?.clientHeight ||
          720) as number;

        if (shouldCropToIframe && iframeRect) {
          targetWidth = Math.max(1, Math.round(iframeRect.width));
          targetHeight = Math.max(1, Math.round(iframeRect.height));
        }

        const videoEl = document.createElement('video');
        videoEl.srcObject = stream;
        videoEl.muted = true;
        videoEl.playsInline = true;
        // Start playback; ignore failures (autoplay might be blocked but drawing will still work once ready)
        void videoEl.play().catch(() => {});

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');

        // Listen for clicks inside the iframe to create ripples
        try {
          const iframe = iframeRef.current;
          const win = iframe?.contentWindow || null;
          const doc = iframe?.contentDocument || win?.document || null;
          if (doc && win) {
            const handler = (e: MouseEvent) => {
              const vw = win.innerWidth || targetWidth;
              const vh = win.innerHeight || targetHeight;
              const x = (e.clientX / vw) * targetWidth;
              const y = (e.clientY / vh) * targetHeight;
              console.log('[iframe] click', {
                clientX: e.clientX,
                clientY: e.clientY,
                pageX: e.pageX,
                pageY: e.pageY,
                normalized: { x, y },
                time: new Date().toISOString(),
              });
              clickRipplesRef.current.push({ x, y, t: performance.now() });
            };
            doc.addEventListener('pointerdown', handler, { capture: true });
            removeIframeClickListenerRef.current = () => {
              doc.removeEventListener('pointerdown', handler, {
                capture: true,
              } as unknown as EventListenerOptions);
            };
          }
        } catch {
          // Ignore listener attachment errors (e.g., unexpected cross-origin)
        }

        const drawFrame = () => {
          if (!ctx) return;
          // Draw the base video frame (cropped to iframe if needed)
          ctx.clearRect(0, 0, targetWidth, targetHeight);
          try {
            if (shouldCropToIframe && iframeRef.current) {
              const rect = iframeRef.current.getBoundingClientRect();
              // Map from viewport pixels to captured video pixels
              const sourceW = (settings.width || window.innerWidth) as number;
              const sourceH = (settings.height || window.innerHeight) as number;
              const scaleX = sourceW / window.innerWidth;
              const scaleY = sourceH / window.innerHeight;

              const sx = Math.max(0, Math.round(rect.left * scaleX));
              const sy = Math.max(0, Math.round(rect.top * scaleY));
              const sWidth = Math.max(1, Math.round(rect.width * scaleX));
              const sHeight = Math.max(1, Math.round(rect.height * scaleY));

              ctx.drawImage(
                videoEl,
                sx,
                sy,
                sWidth,
                sHeight,
                0,
                0,
                targetWidth,
                targetHeight
              );
            } else {
              ctx.drawImage(videoEl, 0, 0, targetWidth, targetHeight);
            }
          } catch {
            // ignore draw errors while video warms up
          }

          // Draw ripples
          const now = performance.now();
          const lifespanMs = 600;
          const ripples = clickRipplesRef.current;
          const remaining: typeof ripples = [];
          for (let i = 0; i < ripples.length; i++) {
            const r = ripples[i];
            const age = now - r.t;
            if (age < lifespanMs) {
              const p = age / lifespanMs;
              const alpha = 1 - p;
              const radius = 12 + p * 28;
              ctx.beginPath();
              ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(59,130,246,${alpha})`; // Tailwind blue-500 color
              ctx.lineWidth = 3;
              ctx.stroke();
              remaining.push(r);
            }
          }
          clickRipplesRef.current = remaining;

          rafIdRef.current = requestAnimationFrame(drawFrame);
        };
        rafIdRef.current = requestAnimationFrame(drawFrame);

        const compositeVideo = canvas.captureStream(30);
        const output = new MediaStream([
          ...compositeVideo.getVideoTracks(),
          ...stream.getAudioTracks(),
        ]);
        stream = output;
      } catch {
        // If compositing fails, proceed with raw stream
      }

      streamRef.current = stream;

      const chunks: BlobPart[] = [];
      const mimeCandidates = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
      const selectedMime = mimeCandidates.find((t) =>
        MediaRecorder.isTypeSupported(t)
      );
      const mediaRecorder = new MediaRecorder(
        stream,
        selectedMime ? { mimeType: selectedMime } : undefined
      );
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: selectedMime || 'video/webm' });
        const url = URL.createObjectURL(blob);
        setDownloadUrl(url);
        setIsRecording(false);
        // Stop all tracks
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        // Exit fullscreen only if we requested it in this function
        if (didEnterFullscreen && document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        }
        // Cleanup click overlay loop and listener
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        if (removeIframeClickListenerRef.current) {
          try {
            removeIframeClickListenerRef.current();
          } catch {}
          removeIframeClickListenerRef.current = null;
        }
        clickRipplesRef.current = [];
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Recording failed to start: ${message || 'Unknown error'}`);
      setIsRecording(false);
      // Best-effort exit from fullscreen if active
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        }
      } catch {}
    }
  }

  function stopRecording() {
    try {
      mediaRecorderRef.current?.stop();
    } catch {
      // ignore
    }
  }

  return (
    <div className="container mx-auto py-6">
      <div className="grid grid-cols-1 lg:grid-cols-10 gap-6">
        {/* Left: Chat */}
        <div
          className={
            'flex flex-col rounded-lg border lg:col-span-3 ' +
            (isRecording ? 'hidden' : '')
          }
        >
          <div className="px-4 py-3 border-b">
            <h2 className="text-lg font-semibold">Training Assistant</h2>
          </div>

          <div className="flex min-h-[600px] flex-1">
            <PromptInputProvider>
              <div className="flex w-full flex-col">
                <Conversation>
                  {messages.length === 0 ? (
                    <ConversationEmptyState title="Start chatting">
                      <p className="text-muted-foreground text-sm">
                        Ask questions and control the training workflow.
                      </p>
                    </ConversationEmptyState>
                  ) : (
                    <ConversationContent>
                      {messages.map((m) => (
                        <Message key={m.id} from={m.role}>
                          <MessageAvatar
                            src={
                              m.role === 'user' ? '/vercel.svg' : '/next.svg'
                            }
                            name={m.role === 'user' ? 'You' : 'AI'}
                          />
                          <MessageContent>{m.text}</MessageContent>
                        </Message>
                      ))}
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
                      />
                      <PromptInputSubmit>
                        <SendHorizontalIcon className="size-4" />
                      </PromptInputSubmit>
                    </PromptInputBody>
                  </PromptInput>
                </div>
              </div>
            </PromptInputProvider>
          </div>
        </div>

        {/* Right: VM screen */}
        <div
          className={
            'flex flex-col rounded-lg border ' +
            (isRecording ? 'lg:col-span-10' : 'lg:col-span-7')
          }
          ref={vmContainerRef}
        >
          <div className="px-4 py-3 border-b flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">VM Screen</h2>
              <p className="text-muted-foreground text-sm">{status}</p>
            </div>
            <div className="flex items-center gap-2">
              {!isRecording ? (
                <Button
                  size="sm"
                  onClick={startRecording}
                  aria-label="Start recording"
                >
                  <CircleDot className="size-4" />
                  Record
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={stopRecording}
                  aria-label="Stop recording"
                >
                  <Square className="size-4" />
                  Stop
                </Button>
              )}
              {downloadUrl ? (
                <a
                  href={downloadUrl}
                  download={`training-recording-${new Date().toISOString()}.webm`}
                  className="text-sm text-primary underline underline-offset-4"
                >
                  Download
                </a>
              ) : null}
            </div>
          </div>
          <div className="flex-1">
            {!guacBase ? (
              <div className="flex h-[600px] items-center justify-center text-red-600">
                Missing NEXT_PUBLIC_GUAC_BASE_URL
              </div>
            ) : iframeSrc ? (
              <iframe
                ref={iframeRef}
                src={iframeSrc}
                width="100%"
                height={800}
                style={{ border: 'none' }}
                allow="display-capture; fullscreen; microphone; camera; clipboard-write"
                allowFullScreen
              />
            ) : (
              <div className="w-full h-[800px] bg-gray-50 border-t rounded-b flex items-center justify-center text-gray-500">
                Waiting for connection...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
