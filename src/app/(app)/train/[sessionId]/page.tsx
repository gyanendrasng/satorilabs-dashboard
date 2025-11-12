'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { TrainingChat } from '@/components/training/TrainingChat';
import { Button } from '@/components/ui/button';
import { CircleDot, Square, Loader2 } from 'lucide-react';

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

interface TrainingSession {
  id: string;
  title: string;
  lastMessageAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messages: ChatMessage[];
}

type CreateConnectionResponse = {
  token: string;
  connection: { identifier?: string; id?: string } | string;
  created?: boolean;
  error?: string;
};

export default function TrainingSessionPage() {
  const router = useRouter();
  const params = useParams();
  const sessionId = params.sessionId as string;

  // Experimental Region Capture types
  type CropTrack = MediaStreamTrack & {
    cropTo?: (target: unknown) => Promise<void>;
  };
  type CropTargetStatic =
    | { fromElement(el: Element): Promise<unknown> }
    | undefined;

  const [session, setSession] = useState<TrainingSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ----------------------------
  // Guacamole connection
  // ----------------------------
  const [status, setStatus] = useState<string>('Initializing...');
  const [token, setToken] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);

  const guacBase = useMemo(() => {
    return process.env.NEXT_PUBLIC_GUAC_BASE_URL?.replace(/\/$/, '') || '';
  }, []);

  // Load session data
  useEffect(() => {
    async function loadSession() {
      try {
        setIsLoading(true);
        const response = await fetch(`/api/chat/${sessionId}`);
        
        if (!response.ok) {
          if (response.status === 404) {
            setError('Training session not found');
          } else {
            throw new Error('Failed to load session');
          }
          return;
        }

        const data = await response.json();
        setSession(data.chat);
      } catch (err) {
        console.error('Failed to load session:', err);
        setError('Failed to load training session');
      } finally {
        setIsLoading(false);
      }
    }

    if (sessionId) {
      loadSession();
    }
  }, [sessionId]);

  // Initialize Guacamole connection
  useEffect(() => {
    let cancelled = false;
    let created = false;
    async function run() {
      try {
        setStatus('Creating connection via server...');
        const resp = await fetch('/backend/guacamole/create-connection', {
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
        fetch('/backend/guacamole/delete-connection', {
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

  const handleBack = () => {
    router.push('/train');
  };

  const handleUpdateTitle = async (sessionId: string, newTitle: string) => {
    // Update local state
    if (session) {
      setSession({ ...session, title: newTitle });
    }
  };

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

  async function startRecording() {
    try {
      setDownloadUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });

      const tryCaptureIframeStream = async (): Promise<MediaStream | null> => {
        const iframe = iframeRef.current;
        if (!iframe) return null;
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!doc) return null;

          const canvas = doc.querySelector('canvas') as HTMLCanvasElement | null;
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
          return null;
        }
      };

      const didEnterFullscreen = false;
      let shouldCropToIframe = false;
      let stream = await tryCaptureIframeStream();

      if (!stream) {
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
          const anyNavigator = navigator as unknown as {
            mediaDevices?: {
              getDisplayMedia?: (c: unknown) => Promise<MediaStream>;
            };
            getDisplayMedia?: (c: unknown) => Promise<MediaStream>;
          };

          if (anyNavigator.mediaDevices?.getDisplayMedia) {
            stream = await anyNavigator.mediaDevices.getDisplayMedia.call(
              anyNavigator.mediaDevices,
              displayConstraints as unknown as MediaStreamConstraints
            );
          } else if (anyNavigator.getDisplayMedia) {
            stream = await anyNavigator.getDisplayMedia.call(
              navigator,
              displayConstraints as unknown as MediaStreamConstraints
            );
          } else {
            const insecure =
              typeof window !== 'undefined' &&
              window.location.protocol !== 'https:' &&
              window.location.hostname !== 'localhost';
            setStatus(
              insecure
                ? 'Screen capture requires HTTPS (or localhost). Please use a secure origin.'
                : 'Screen capture API is not supported in this browser. Try the latest Chrome/Edge on desktop.'
            );
            setIsRecording(false);
            return;
          }
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

        try {
          const iframeEl = iframeRef.current;
          const videoTrack = stream.getVideoTracks()[0] as CropTrack | undefined;
          const cropTargetStatic: CropTargetStatic = (
            window as unknown as {
              CropTarget?: { fromElement(el: Element): Promise<unknown> };
            }
          ).CropTarget;
          if (iframeEl && videoTrack?.cropTo && cropTargetStatic?.fromElement) {
            const target = await cropTargetStatic.fromElement(iframeEl);
            await videoTrack.cropTo(target);
          }
        } catch {}
      }

      try {
        const vt = stream.getVideoTracks()[0];
        const settings = vt.getSettings();

        const iframeEl = iframeRef.current;
        const iframeRect = iframeEl?.getBoundingClientRect();

        let targetWidth = (settings.width || iframeEl?.clientWidth || 1280) as number;
        let targetHeight = (settings.height || iframeEl?.clientHeight || 720) as number;

        if (shouldCropToIframe && iframeRect) {
          targetWidth = Math.max(1, Math.round(iframeRect.width));
          targetHeight = Math.max(1, Math.round(iframeRect.height));
        }

        const videoEl = document.createElement('video');
        videoEl.srcObject = stream;
        videoEl.muted = true;
        videoEl.playsInline = true;
        void videoEl.play().catch(() => {});

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');

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
              clickRipplesRef.current.push({ x, y, t: performance.now() });
            };
            doc.addEventListener('pointerdown', handler, { capture: true });
            removeIframeClickListenerRef.current = () => {
              doc.removeEventListener('pointerdown', handler, {
                capture: true,
              } as unknown as EventListenerOptions);
            };
          }
        } catch {}

        const drawFrame = () => {
          if (!ctx) return;
          ctx.clearRect(0, 0, targetWidth, targetHeight);
          try {
            if (shouldCropToIframe && iframeRef.current) {
              const rect = iframeRef.current.getBoundingClientRect();
              const sourceW = (settings.width || window.innerWidth) as number;
              const sourceH = (settings.height || window.innerHeight) as number;
              const scaleX = sourceW / window.innerWidth;
              const scaleY = sourceH / window.innerHeight;

              const sx = Math.max(0, Math.round(rect.left * scaleX));
              const sy = Math.max(0, Math.round(rect.top * scaleY));
              const sWidth = Math.max(1, Math.round(rect.width * scaleX));
              const sHeight = Math.max(1, Math.round(rect.height * scaleY));

              ctx.drawImage(videoEl, sx, sy, sWidth, sHeight, 0, 0, targetWidth, targetHeight);
            } else {
              ctx.drawImage(videoEl, 0, 0, targetWidth, targetHeight);
            }
          } catch {}

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
              ctx.strokeStyle = `rgba(59,130,246,${alpha})`;
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
      } catch {}

      streamRef.current = stream;

      const chunks: BlobPart[] = [];
      const mimeCandidates = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
      const selectedMime = mimeCandidates.find((t) => MediaRecorder.isTypeSupported(t));
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
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (didEnterFullscreen && document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        }
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
    } catch {}
  }

  if (isLoading) {
    return (
      <div className="container mx-auto py-6">
        <div className="flex items-center justify-center h-[600px]">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground">Loading training session...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto py-6">
        <div className="flex items-center justify-center h-[600px]">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="text-destructive text-xl font-semibold">{error}</div>
            <button
              onClick={handleBack}
              className="text-sm text-primary underline underline-offset-4"
            >
              Return to training sessions
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Chat Interface */}
        <div className={`flex flex-col rounded-lg border ${isRecording ? 'hidden' : ''}`}>
          <TrainingChat
            session={session}
            onBack={handleBack}
            onUpdateTitle={handleUpdateTitle}
          />
        </div>

        {/* Right: VM Screen */}
        <div
          className={`flex flex-col rounded-lg border ${isRecording ? 'col-span-2' : ''}`}
          ref={vmContainerRef}
        >
          <div className="px-4 py-3 border-b flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">VM Screen</h2>
              <p className="text-muted-foreground text-sm">{status}</p>
            </div>
            <div className="flex items-center gap-2">
              {!isRecording ? (
                <Button size="sm" onClick={startRecording} aria-label="Start recording">
                  <CircleDot className="size-4" />
                  <span className="hidden sm:inline ml-2">Record</span>
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={stopRecording}
                  aria-label="Stop recording"
                >
                  <Square className="size-4" />
                  <span className="hidden sm:inline ml-2">Stop</span>
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
                height={isRecording ? 800 : 600}
                style={{ border: 'none' }}
                allow="display-capture; fullscreen; microphone; camera; clipboard-write"
                allowFullScreen
              />
            ) : (
              <div
                className="w-full bg-gray-50 border-t rounded-b flex items-center justify-center text-gray-500"
                style={{ height: isRecording ? '800px' : '600px' }}
              >
                Waiting for connection...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}