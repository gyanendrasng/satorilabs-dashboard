import { NextResponse } from 'next/server';
import { checkForReplies } from '@/lib/email-reply-checker';

/**
 * GET /api/cron/check-emails
 *
 * Cron endpoint to check for email replies and process them.
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

    console.log('[Cron] Starting email reply check...');

    const result = await checkForReplies();

    console.log(`[Cron] Email check complete. Processed: ${result.processed}, Errors: ${result.errors.length}`);

    return NextResponse.json({
      success: true,
      processed: result.processed,
      errors: result.errors,
      logs: result.logs,
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
