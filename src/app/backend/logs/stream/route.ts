import { logStore } from '@/lib/log-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET — SSE endpoint that streams logs to the browser
export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Force-flush connection open with a comment + padding
      controller.enqueue(encoder.encode(`: connected\n\n`));

      // Send recent logs as initial burst
      const recent = logStore.getRecent(100);
      for (const log of recent) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(log)}\n\n`)
        );
      }

      // Subscribe to new logs
      const unsubscribe = logStore.subscribe((log) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(log)}\n\n`)
          );
        } catch {
          cleanup();
        }
      });

      // Send keepalive every 30s
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          cleanup();
        }
      }, 30_000);

      function cleanup() {
        unsubscribe();
        clearInterval(keepalive);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
