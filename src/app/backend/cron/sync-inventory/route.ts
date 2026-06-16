import { NextResponse } from 'next/server';
import { syncInventoryFromAutoGui } from '@/lib/inventory-sync';

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const logs: string[] = [];
  const log = (s: string) => {
    logs.push(s);
    console.log(s);
  };

  const result = await syncInventoryFromAutoGui({ log });
  return NextResponse.json({ ok: true, ...result, logs });
}
