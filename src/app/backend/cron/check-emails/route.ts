import { NextResponse } from 'next/server';
import { checkForReplies, checkWorkflowTimers, checkForNewEmails } from '@/lib/email-reply-checker';

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

    // Run all three checks
    const newEmailResult = await checkForNewEmails();
    const replyResult = await checkForReplies();
    const timerResult = await checkWorkflowTimers();

    const allLogs = [...newEmailResult.logs, ...replyResult.logs, ...timerResult.logs];
    const allErrors = [...newEmailResult.errors, ...replyResult.errors, ...timerResult.errors];

    console.log(
      `[Cron] Complete. New emails: ${newEmailResult.triggered}, Replies: ${replyResult.processed}, Reminders: ${timerResult.reminders_sent}, Errors: ${allErrors.length}`
    );

    return NextResponse.json({
      success: true,
      new_emails_triggered: newEmailResult.triggered,
      processed: replyResult.processed,
      reminders_sent: timerResult.reminders_sent,
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
