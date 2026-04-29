/**
 * Build the "Dispatch Approval Request" HTML email body that goes to the branch.
 *
 * Each SO section is wrapped in a real <form action="..." method="POST" target="_blank">
 * targeting DISPATCH_FORM_URL — when the branch hits Submit, Gmail shows its
 * "submitting to external page" warning, then the browser opens a new tab and
 * POSTs the checkboxes/inputs as application/x-www-form-urlencoded body.
 *
 * No JavaScript: email clients strip <script> and onclick handlers. Bulk
 * decisions are sent as a query param `bulk=approve|holdall|holdshortage`,
 * and the receiving server is expected to interpret that override regardless
 * of which individual checkboxes are ticked.
 *
 * Form field naming (so the receiver can parse query params):
 *   - po              = purchase order number (hidden)
 *   - so              = sales order number (hidden)
 *   - bulk            = 'approve' | 'holdall' | 'holdshortage' (optional)
 *   - approve         = repeated; each value is "<material>|<batch>"
 *   - hold            = repeated; each value is "<material>|<batch>"
 *   - qty_<material>  = optional custom quantity for that material
 */

const DEFAULT_FORM_URL = 'https://unconsultatory-dora-unmasculinely.ngrok-free.dev';

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

function renderMaterialCard(m: DispatchMaterial, idx: number): string {
  const requested = m.orderQuantity;
  const available = m.availableStock ?? requested;
  const isPartial = available > 0 && available < requested;
  const isOutOfStock = available <= 0;

  const cardStyle = isPartial
    ? 'padding:20px;background:#fffdf0;border:1px solid #facc15;border-radius:10px;'
    : isOutOfStock
      ? 'padding:20px;background:#fef2f2;border:1px solid #f87171;border-radius:10px;'
      : 'padding:20px;border:1px solid #dbe3ea;border-radius:10px;';

  const value = `${m.material}|${m.batch}`;
  const valueAttr = escapeHtml(value);
  const qtyName = `qty_${m.material}`;
  const perUnitKg = m.orderWeightKg !== null && requested > 0
    ? Number(m.orderWeightKg) / requested
    : 0;
  const perUnitAttr = perUnitKg > 0 ? perUnitKg.toFixed(4) : '0';

  const label = m.materialDescription
    ? `${escapeHtml(m.materialDescription)} <span style="color:#888;font-weight:normal;font-size:13px;">[${escapeHtml(m.material)} / ${escapeHtml(m.batch)}]</span>`
    : `${escapeHtml(m.material)} <span style="color:#888;font-weight:normal;font-size:13px;">[${escapeHtml(m.batch)}]</span>`;

  const stockLine = isPartial
    ? `Requested: <b>${requested}</b><br>Available: <b>${available}</b> (Partial Stock)`
    : isOutOfStock
      ? `Requested: <b>${requested}</b><br>Available: <b>0</b> (Out of Stock)`
      : `Requested: <b>${requested}</b> | Available: <b>${available}</b>`;

  const partialNote = isPartial
    ? `<p style="color:#92400e;">Checking this means dispatch available ${available} units unless lower qty entered.</p>`
    : '';

  const maxQty = isOutOfStock ? 0 : available;
  const customQtyLabel = isPartial
    ? `Custom Quantity (max ${available})`
    : isOutOfStock
      ? 'Custom Quantity'
      : 'Custom Quantity (optional)';
  const weightLine = m.orderWeightKg !== null
    ? `<p style="font-size:12px;color:#888;margin-top:4px;">Total weight (full qty): ${Number(m.orderWeightKg)} kg @ ${perUnitAttr} kg/unit</p>`
    : '';

  const holdId = idx === 0 && isPartial ? 'id="hold_partial"' : '';

  return `
<tr><td height="24"></td></tr>
<tr>
<td style="${cardStyle}">

<h3 style="margin-top:0;">
<label>
<input type="checkbox" class="materialCheck" name="approve" value="${valueAttr}" data-perunit="${perUnitAttr}" data-maxqty="${maxQty}" onchange="updateTotal(this)" ${isOutOfStock ? 'disabled' : ''}>
${label}
</label>
</h3>

<p>${stockLine}</p>
${partialNote}
${weightLine}

<table width="100%">
<tr>
<td width="50%">
${customQtyLabel}<br><br>
<input type="number" name="${escapeHtml(qtyName)}" min="1" max="${maxQty}" placeholder="${maxQty}" data-perunit="${perUnitAttr}" data-maxqty="${maxQty}" oninput="updateTotal(this)" style="width:90px;padding:8px;border:1px solid #ccc;" ${isOutOfStock ? 'disabled' : ''}>
</td>
<td>
<br>
<label>
<input type="checkbox" class="holdCheck" name="hold" value="${valueAttr}" onchange="updateTotal(this)" ${holdId}>
Hold Item
</label>
</td>
</tr>
</table>
</td>
</tr>`;
}

function renderSoSection(poNumber: string, section: DispatchSoSection, formUrl: string, capacityTonnes: number): string {
  const materials = section.materials.length > 0
    ? section.materials.map((m, i) => renderMaterialCard(m, i)).join('\n')
    : `<tr><td height="24"></td></tr><tr><td style="padding:20px;border:1px solid #dbe3ea;border-radius:10px;color:#888;">No materials returned for this sales order.</td></tr>`;

  return `
<tr>
<td>
<form action="${escapeHtml(formUrl)}" method="POST" target="_blank" style="margin:0;padding:0;">
<input type="hidden" name="po" value="${escapeHtml(poNumber)}">
<input type="hidden" name="so" value="${escapeHtml(section.soNumber)}">

<h2 style="margin-top:0;">Dispatch Approval Request – Sales Order ${escapeHtml(section.soNumber)}</h2>
<p style="color:#555;line-height:1.7;">
Select materials to dispatch. Checking a material approves available stock.
Optional quantity can override approved quantity.
</p>

<table width="100%" cellpadding="0" cellspacing="0">

<tr><td height="20"></td></tr>

<tr>
<td style="padding:22px;border:1px solid #d6dbe1;border-radius:10px;background:#fafafa;">
<h3 style="margin-top:0;">Bulk Decision (Select One)</h3>
<label style="display:block;margin-bottom:14px;">
<input type="radio" name="bulk" value="approve" onclick="bulkAction('approve', this)">
Approve All Available Materials
</label>
<label style="display:block;margin-bottom:14px;">
<input type="radio" name="bulk" value="holdall" onclick="bulkAction('holdall', this)">
Hold Entire Order
</label>
<label style="display:block;">
<input type="radio" name="bulk" value="holdshortage" onclick="bulkAction('holdshortage', this)">
Hold Only Unavailable / Shortage Items
</label>
</td>
</tr>

${materials}

<tr><td height="20"></td></tr>

<!-- CAPACITY GAUGE (live in Gmail web; static placeholder elsewhere) -->
<tr>
<td>
<div data-grandtotal="1" style="padding:18px 22px;border:1px solid #d6dbe1;border-radius:10px;background:#f9fafb;text-align:center;">
<p data-grandtotal-label="1" style="margin:0;font-size:15px;color:#111;">Total: <b>0 / ${capacityTonnes} tonnes</b> — no materials approved</p>
<p style="margin:6px 0 0;font-size:12px;color:#666;">Truck capacity ${capacityTonnes} t. Updates as you tick approve checkboxes (Gmail web).</p>
</div>
</td>
</tr>

<tr><td height="30"></td></tr>

<tr>
<td align="center">
<button type="submit" style="background:#111827;color:#fff;padding:15px 30px;border:none;border-radius:8px;font-weight:bold;cursor:pointer;">
Submit Dispatch Decision – SO ${escapeHtml(section.soNumber)}
</button>
</td>
</tr>

</table>
</form>
</td>
</tr>

<tr><td height="40"></td></tr>`;
}

export function buildDispatchApprovalHtml(
  poNumber: string,
  sections: DispatchSoSection[],
  capacityTonnes: number = 31,
  formUrl: string = process.env.DISPATCH_FORM_URL || DEFAULT_FORM_URL
): string {
  const head = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Dispatch Approval - ${escapeHtml(poNumber)}</title>
</head>
<body style="margin:0;background:#f4f6f8;font-family:Arial,sans-serif;">

<script>
const CAPACITY_TONNES = ${capacityTonnes};

function formOf(el){ return el.closest("form"); }

function updateTotal(srcEl){
  const form = formOf(srcEl);
  if(!form) return;
  const approves = form.querySelectorAll(".materialCheck");
  let totalKg = 0;
  let approvedCount = 0;
  approves.forEach(cb => {
    if(!cb.checked) return;
    approvedCount++;
    const perUnit = parseFloat(cb.dataset.perunit || "0");
    const maxQty = parseFloat(cb.dataset.maxqty || "0");
    const qtyInput = form.querySelector('input[name="qty_' + cb.value.split("|")[0] + '"]');
    let qty = maxQty;
    if(qtyInput && qtyInput.value.trim() !== ""){
      const v = parseFloat(qtyInput.value);
      if(!isNaN(v) && v > 0) qty = v;
    }
    totalKg += qty * perUnit;
  });
  const tonnes = totalKg / 1000;
  const tonnesStr = tonnes.toFixed(2).replace(/\\.00$/, "");
  const box = form.querySelector('[data-grandtotal="1"]');
  const label = form.querySelector('[data-grandtotal-label="1"]');
  if(!box || !label) return;
  if(approvedCount === 0){
    label.innerHTML = "Total: <b>0 / " + CAPACITY_TONNES + " tonnes</b> — no materials approved";
    box.style.background = "#f9fafb";
    box.style.borderColor = "#d6dbe1";
    return;
  }
  let msg = "Total: <b>" + tonnesStr + " / " + CAPACITY_TONNES + " tonnes</b> across " + approvedCount + " material(s)";
  if(tonnes > CAPACITY_TONNES){
    box.style.background = "#fef2f2";
    box.style.borderColor = "#f87171";
    msg += " ⚠ Over capacity by " + (tonnes - CAPACITY_TONNES).toFixed(2).replace(/\\.00$/, "") + " t";
  } else if(tonnes > CAPACITY_TONNES * 0.9){
    box.style.background = "#fffdf0";
    box.style.borderColor = "#facc15";
  } else {
    box.style.background = "#ecfdf5";
    box.style.borderColor = "#34d399";
  }
  label.innerHTML = msg;
}

function bulkAction(val, srcEl){
  const form = srcEl ? formOf(srcEl) : null;
  const root = form || document;
  const materials = root.querySelectorAll(".materialCheck");
  const holds = root.querySelectorAll(".holdCheck");
  materials.forEach(c => { if(!c.disabled) c.checked = false; });
  holds.forEach(c => c.checked = false);
  if(val === "approve"){ materials.forEach(c => { if(!c.disabled) c.checked = true; }); }
  if(val === "holdall"){ holds.forEach(c => c.checked = true); }
  if(val === "holdshortage"){
    const p = root.querySelector("#hold_partial");
    if(p) p.checked = true;
  }
  if(form) updateTotal(form.querySelector(".materialCheck") || form);
}
</script>

<table width="100%" style="padding:30px;background:#f4f6f8;">
<tr>
<td align="center">

<table width="760" cellpadding="0" cellspacing="0" style="background:#fff;padding:32px;border-radius:12px;">

<tr>
<td>
<h1 style="margin-top:0;">Purchase Order ${escapeHtml(poNumber)}</h1>
<p style="color:#555;">${sections.length} sales order(s) included. Submit each Sales Order independently.</p>
</td>
</tr>
<tr><td height="30"></td></tr>
`;

  const body = sections.map((s) => renderSoSection(poNumber, s, formUrl, capacityTonnes)).join('\n');

  const tail = `
<tr>
<td style="background:#f9fafb;padding:20px;border-radius:10px;">
<h3 style="margin-top:0;">Selection Rules</h3>
<ul style="line-height:1.8;color:#555;">
<li>Checking a material approves available quantity.</li>
<li>Custom quantity overrides full approval.</li>
<li>Partial stock selection implies accepting available stock.</li>
<li>Approve All selects all materials automatically.</li>
<li>Hold Entire Order holds every line item automatically.</li>
<li>Hold Unavailable only holds shortage materials automatically.</li>
</ul>
</td>
</tr>

<tr><td height="30"></td></tr>

<tr>
<td style="color:#555;">
Best regards,<br>
<b>Sales Order Dispatch Coordinator</b>
</td>
</tr>

</table>

</td>
</tr>
</table>

</body>
</html>`;

  return head + body + tail;
}
