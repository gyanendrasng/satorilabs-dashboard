/**
 * Build the dispatch recommendation email body that goes to the branch.
 *
 * Plain prose (HTML-styled but no form, no JS, no checkboxes). One section
 * per SO; per-material bullet lines describing stock availability and the
 * recommended action. Branch reads, replies in plain text, and the existing
 * /email/branch-reply LLM parses their reply.
 */

export interface DispatchMaterial {
  material: string;
  materialDescription: string | null;
  batch: string;
  orderQuantity: number;
  availableStock: number | null;
  orderWeightKg: number | null;
}

export interface DispatchSoSection {
  soNumber: string;
  materials: DispatchMaterial[];
}

function escapeHtml(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function proseLineFor(m: DispatchMaterial): string {
  const requested = m.orderQuantity;
  const available = m.availableStock ?? requested;
  const labelBase = m.materialDescription ?? m.material;
  const label = m.materialDescription
    ? `${escapeHtml(labelBase)} <span style="color:#888;font-weight:normal;">[${escapeHtml(m.material)}]</span>`
    : `<b>${escapeHtml(labelBase)}</b>`;

  if (available <= 0) {
    return `<li><b>${label}:</b> Currently out of stock. You may choose to wait for replenishment or ignore this material to process the rest of the order.</li>`;
  }

  if (available < requested) {
    return `<li><b>${label}:</b> At the moment, we are not in a position to supply the entire quantity requested (${requested} units) as the total free stock across batches is ${available} units. We can offer the available quantity from Batch ${escapeHtml(m.batch)}. Alternatively, you may choose to wait until the entire stock is replenished after production or ignore this material to process the rest of the order.</li>`;
  }

  return `<li><b>${label}:</b> Stock is confirmed available. Proceed with ${requested} units from Batch ${escapeHtml(m.batch)}.</li>`;
}

function renderSoSection(section: DispatchSoSection): string {
  if (section.materials.length === 0) {
    return `
<h2 style="margin-top:32px;">Sales Order ${escapeHtml(section.soNumber)}</h2>
<p style="color:#555;">No materials returned for this sales order.</p>`;
  }

  const bullets = section.materials.map(proseLineFor).join('\n');
  return `
<h2 style="margin-top:32px;">Sales Order ${escapeHtml(section.soNumber)}</h2>
<p style="color:#222;line-height:1.7;">
I have reviewed the stock availability for Sales Order ${escapeHtml(section.soNumber)}. Here is the dispatch recommendation:
</p>
<ul style="line-height:1.8;color:#222;">
${bullets}
</ul>`;
}

export function buildDispatchApprovalHtml(
  poNumber: string,
  sections: DispatchSoSection[],
  // capacity is accepted for API compatibility but no longer rendered (no form)
  _capacityTonnes: number = 31,
  _formUrl?: string
): string {
  void _capacityTonnes;
  void _formUrl;

  const sectionsHtml = sections.map(renderSoSection).join('\n');
  const intro = sections.length > 1
    ? `<p style="color:#222;">Dear Sales Team,</p>
<p style="color:#222;line-height:1.7;">Please find below the dispatch recommendation for Purchase Order <b>${escapeHtml(poNumber)}</b> covering ${sections.length} sales order(s):</p>`
    : `<p style="color:#222;">Dear Sales Team,</p>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Dispatch Recommendation - ${escapeHtml(poNumber)}</title>
</head>
<body style="margin:0;background:#f4f6f8;font-family:Arial,sans-serif;">
<table width="100%" style="padding:30px;background:#f4f6f8;">
<tr>
<td align="center">
<table width="760" cellpadding="0" cellspacing="0" style="background:#fff;padding:32px;border-radius:12px;">
<tr>
<td style="color:#222;line-height:1.6;">

${intro}

${sectionsHtml}

<p style="color:#222;margin-top:32px;">Best regards,<br><b>Sales Order Dispatch Co-ordinator</b></p>

</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}
