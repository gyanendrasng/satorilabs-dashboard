#!/usr/bin/env node
/**
 * One-off fix for SO 3260671 — branch reply was misread as release_part with
 * only COLABA. Resets dispatchQuantity for all 10 Material rows and rebuilds
 * the dispatch_confirmation email's plan JSON so a resend will include
 * everything. Then optionally hits the resend endpoint.
 *
 *   node scripts/fix-dispatch-3260671.mjs              # writes DB only
 *   RESEND=1 node scripts/fix-dispatch-3260671.mjs     # also fires resend
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SO_NUMBER = process.argv[2] || '3260671';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';

const so = await prisma.salesOrder.findFirst({
  where: { soNumber: SO_NUMBER },
  include: { purchaseOrder: { include: { customer: true } } },
});
if (!so) throw new Error(`SO ${SO_NUMBER} not found`);

console.log(`SO ${SO_NUMBER} → PO ${so.purchaseOrder.poNumber}`);

// 1. Set dispatchQuantity for all rows = order qty clamped at available stock.
//    Anything with availableStock=0 stays at 0 (won't be in the plan).
const materials = await prisma.material.findMany({ where: { salesOrderId: so.id } });
const now = new Date();
for (const m of materials) {
  const cap = m.availableStock ?? m.orderQuantity;
  const qty = Math.max(0, Math.min(m.orderQuantity, cap));
  await prisma.material.update({
    where: { id: m.id },
    data: { dispatchQuantity: qty, releasedAt: qty > 0 ? now : null },
  });
}

// 2. Rebuild plan items from rows that ended up with dispatchQuantity > 0
const eligible = await prisma.material.findMany({
  where: { salesOrderId: so.id, dispatchQuantity: { gt: 0 } },
  orderBy: { material: 'asc' },
});

const items = eligible.map((m) => {
  const fullWeight = m.orderWeightKg ? Number(m.orderWeightKg) : 0;
  const perUnit = m.orderQuantity > 0 ? fullWeight / m.orderQuantity : 0;
  return {
    material_code: m.material,
    batch: m.batch,
    quantity: m.dispatchQuantity,
    weight_kg: perUnit * m.dispatchQuantity,
  };
});
const totalWeightKg = items.reduce((s, i) => s + i.weight_kg, 0);
const totalTonnes = totalWeightKg / 1000;
const capacityTonnes = so.purchaseOrder.customer?.weightage
  ? Number(so.purchaseOrder.customer.weightage)
  : 45;

const meta = {
  plans: [
    {
      soNumber: SO_NUMBER,
      salesOrderId: so.id,
      items,
      totalWeightKg,
    },
  ],
  twoVehicles: totalTonnes > capacityTonnes,
  totalTonnes,
  capacityTonnes,
};

console.log(`Plan: ${items.length} items, ${totalTonnes.toFixed(2)} t / ${capacityTonnes} t`);

// 3. Update existing dispatch_confirmation email's relatedMaterials JSON
const dc = await prisma.email.findFirst({
  where: { purchaseOrderId: so.purchaseOrderId, emailType: 'dispatch_confirmation' },
  orderBy: { sentAt: 'desc' },
});
if (!dc) {
  console.error('No dispatch_confirmation email found. Hit /backend/dev/resend-dispatch-confirmation will 404. Aborting JSON write.');
  process.exit(1);
}
await prisma.email.update({
  where: { id: dc.id },
  data: { relatedMaterials: JSON.stringify(meta) },
});
console.log(`Updated dispatch_confirmation row ${dc.id} with fresh plan`);

await prisma.$disconnect();

// 4. Optionally re-send
if (process.env.RESEND === '1') {
  const res = await fetch(`${DASHBOARD_URL}/backend/dev/resend-dispatch-confirmation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poNumber: so.purchaseOrder.poNumber }),
  });
  const json = await res.json();
  console.log(`Resend response (${res.status}):`, JSON.stringify(json, null, 2));
} else {
  console.log('Done. To resend the email run:');
  console.log(`  curl -X POST ${DASHBOARD_URL}/backend/dev/resend-dispatch-confirmation -H "Content-Type: application/json" -d '{"poNumber":"${so.purchaseOrder.poNumber}"}'`);
}
