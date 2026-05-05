import { NextResponse } from 'next/server';
import { enqueueWork, pumpQueue } from '@/lib/work-queue';

/**
 * GET /backend/cron/daily-mb51
 *
 * Vercel cron at 05:30 UTC = 11:00 IST. Fires MB51 on auto-gui2 to pull
 * today's goods-receipt rows for plant 7651. auto-gui2 then POSTs the parsed
 * rows to /backend/material-receipts/upload, which runs FCFS reactivation.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Posting date in IST. The cron itself fires at 11am IST so "now" in IST
  // is today's production day. UTC offset for IST is +5:30.
  const nowIstMs = Date.now() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(nowIstMs);
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = ist.getUTCFullYear();
  const postingDate = `${dd}.${mm}.${yyyy}`;

  const instruction = `VPN is conected and SAP is logged in. Just go ahead and run the SAP Transaction MB51 for date ${postingDate}.`;

  try {
    const work = await enqueueWork({
      step: 'mb51',
      payload: {
        instruction,
        transaction_code: 'MB51',
        meta: { posting_date: postingDate },
      },
    });
    await pumpQueue();
    console.log(`[Cron/MB51] Enqueued work ${work.id} for posting date ${postingDate}`);
    return NextResponse.json({ enqueued: true, workId: work.id, postingDate });
  } catch (err) {
    console.error('[Cron/MB51] Failed to enqueue:', err);
    return NextResponse.json(
      {
        enqueued: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
