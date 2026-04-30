import { NextResponse } from 'next/server';
import {
  checkForReplies,
  checkWorkflowTimers,
  checkForNewEmails,
  checkStaleVisibility,
  checkWaitRechecks,
} from '@/lib/email-reply-checker';
import { pumpQueue } from '@/lib/work-queue';

/**
 * GET /api/cron/check-emails
 *
 * Cron endpoint to check for email replies and process them.
 * Also checks workflow timers for pending reminders.
 * Runs every 5 minutes via Vercel Cron.
 */
export async function GET(request: Request) {
  try {
    // Optional: Verify cron secret for security
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = request.headers.get('authorization');
      if (authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    console.log('[Cron] Starting email reply check and timer check...');

    // Run all checks
    const newEmailResult = await checkForNewEmails();
    const replyResult = await checkForReplies();
    const timerResult = await checkWorkflowTimers();
    const staleResult = await checkStaleVisibility();
    const waitResult = await checkWaitRechecks();

    // Always pump the queue at the end of every cron tick — idempotent.
    // If a row is already firing it's a no-op; otherwise the oldest queued
    // row is fired. This is what lets manually-reset 'queued' rows advance
    // without needing a fresh enqueue or step-status callback.
    const pumped = await pumpQueue();
    if (pumped) {
      console.log(
        `[Cron] Pumped queue → fired work ${pumped.id} (${pumped.step}, SO ${pumped.salesOrderId ?? 'n/a'})`
      );
    }

    const allLogs = [
      ...newEmailResult.logs,
      ...replyResult.logs,
      ...timerResult.logs,
      ...staleResult.logs,
      ...waitResult.logs,
    ];
    const allErrors = [
      ...newEmailResult.errors,
      ...replyResult.errors,
      ...timerResult.errors,
      ...staleResult.errors,
      ...waitResult.errors,
    ];

    console.log(
      `[Cron] Complete. New: ${newEmailResult.triggered}, Replies: ${replyResult.processed}, Reminders: ${timerResult.reminders_sent}, Stale: ${staleResult.recovered}, Combined: ${staleResult.combinedSent}, Rechecks: ${waitResult.rechecked}, Errors: ${allErrors.length}`
    );

    return NextResponse.json({
      success: true,
      new_emails_triggered: newEmailResult.triggered,
      processed: replyResult.processed,
      reminders_sent: timerResult.reminders_sent,
      stale_recovered: staleResult.recovered,
      combined_emails_sent: staleResult.combinedSent,
      wait_rechecks: waitResult.rechecked,
      errors: allErrors,
      logs: allLogs,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Email check failed:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// Also support POST for flexibility
export async function POST(request: Request) {
  return GET(request);
}
