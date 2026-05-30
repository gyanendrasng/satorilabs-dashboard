import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { ChatPayload } from '@/lib/work-queue';

/**
 * GET /backend/work-queue
 *
 * Lists active and recent work-queue items for the Queue tab. Active items
 * (`queued`, `firing`) come first; a small tail of recently finished rows
 * gives context. `queued` items are cancellable; everything else is not.
 */
export async function GET() {
  const rows = await prisma.workQueue.findMany({
    where: { state: { in: ['queued', 'firing', 'done', 'failed', 'cancelled'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { salesOrder: { select: { soNumber: true } } },
  });

  const items = rows.map((row) => {
    let soNumber: string | null = row.salesOrder?.soNumber ?? null;
    if (!soNumber) {
      try {
        const payload = JSON.parse(row.payload) as ChatPayload;
        soNumber = (payload.meta?.so_number as string | undefined) ?? payload.so_number ?? null;
      } catch {
        soNumber = null;
      }
    }
    return {
      id: row.id,
      step: row.step,
      state: row.state,
      soNumber,
      attemptCount: row.attemptCount,
      error: row.error,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      cancellable: row.state === 'queued',
    };
  });

  // Active first (queued/firing), then most-recently finished.
  const active = items.filter((i) => i.state === 'queued' || i.state === 'firing');
  const finished = items
    .filter((i) => i.state !== 'queued' && i.state !== 'firing')
    .sort((a, b) => +new Date(b.finishedAt ?? b.createdAt) - +new Date(a.finishedAt ?? a.createdAt))
    .slice(0, 20);

  return NextResponse.json({ items: [...active, ...finished] });
}
