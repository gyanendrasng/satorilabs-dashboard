import { NextResponse } from 'next/server';
import { logStore } from '@/lib/log-store';

// POST — receives status messages from auto_gui2 StatusService (STATUS_WEBHOOK_URL)
export async function POST(request: Request) {
  try {
    const body = await request.json();

    const stepInfo = body.step && body.total_steps ? ` [${body.step}/${body.total_steps}]` : '';
    const agentInfo = body.agent ? ` (${body.agent})` : '';
    console.log(
      `\x1b[92m[StatusIngest]\x1b[0m ${body.type || 'unknown'}${stepInfo}${agentInfo} | ${body.message || '<empty>'}`
    );

    // Map status type to log level for unified display
    const levelMap: Record<string, string> = {
      info: 'INFO',
      action: 'INFO',
      waiting: 'INFO',
      success: 'INFO',
      error: 'ERROR',
      milestone: 'INFO',
    };

    logStore.push({
      timestamp: body.timestamp || new Date().toISOString(),
      level: levelMap[body.type] || 'INFO',
      message: body.message || '',
      receivedAt: Date.now(),
      source: 'status',
      statusType: body.type,
      step: body.step,
      totalSteps: body.total_steps,
      agent: body.agent,
      details: body.details,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`\x1b[91m[StatusIngest]\x1b[0m Failed to parse payload:`, err);
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
}
