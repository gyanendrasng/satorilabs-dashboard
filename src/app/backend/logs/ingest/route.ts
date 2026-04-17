import { NextResponse } from 'next/server';
import { logStore } from '@/lib/log-store';

// POST — receives logs from auto_gui2 WebhookLogHandler (LOG_WEBHOOK_URL)
export async function POST(request: Request) {
  try {
    const body = await request.json();

    logStore.push({
      timestamp: body.timestamp || new Date().toISOString(),
      level: body.level || 'INFO',
      message: body.message || '',
      logger: body.logger,
      receivedAt: Date.now(),
      source: 'log',
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
}
