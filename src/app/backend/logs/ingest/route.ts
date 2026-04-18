import { NextResponse } from 'next/server';
import { logStore } from '@/lib/log-store';

// POST — receives logs from auto_gui2 WebhookLogHandler (LOG_WEBHOOK_URL)
export async function POST(request: Request) {
  try {
    const body = await request.json();

    console.log(
      `\x1b[94m[LogIngest]\x1b[0m ${body.level || 'INFO'} | ${body.logger || 'unknown'} | ${body.message || '<empty>'}`
    );

    logStore.push({
      timestamp: body.timestamp || new Date().toISOString(),
      level: body.level || 'INFO',
      message: body.message || '',
      logger: body.logger,
      receivedAt: Date.now(),
      source: 'log',
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`\x1b[91m[LogIngest]\x1b[0m Failed to parse payload:`, err);
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
}
