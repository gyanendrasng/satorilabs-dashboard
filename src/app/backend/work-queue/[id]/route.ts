import { NextResponse } from 'next/server';
import { cancelWork } from '@/lib/work-queue';

/**
 * DELETE /backend/work-queue/:id
 *
 * Cancels a still-queued work item. Returns 409 if the item has already been
 * fired (it's being worked on and can't be pulled back) or 404 if not found.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await cancelWork(id);

  if (result.cancelled) {
    return NextResponse.json({ ok: true, id });
  }
  if (result.reason === 'not_found') {
    return NextResponse.json({ ok: false, error: 'Work item not found' }, { status: 404 });
  }
  return NextResponse.json(
    { ok: false, error: 'Already firing — being worked on and cannot be cancelled' },
    { status: 409 },
  );
}
