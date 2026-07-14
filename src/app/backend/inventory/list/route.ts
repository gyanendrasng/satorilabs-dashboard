import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * Read-only listing for the manual inventory-snapshot editor UI
 * (src/app/(app)/inventory). Returns every free-stock row the stock pre-check
 * reads, ordered by (material, plant) for a stable grid.
 */
export async function GET() {
  try {
    const rows = await prisma.inventorySnapshot.findMany({
      orderBy: [{ material: 'asc' }, { plant: 'asc' }],
    });
    return NextResponse.json({ rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
