'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Plus, Trash2, RotateCcw, Undo2, Loader2, Search, Save } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────
type DbRow = {
  id: string;
  material: string;
  plant: string;
  materialDescription: string | null;
  vertical: string | null;
  freeStock: number;
  syncedAt: string;
};

type EditRow = {
  key: string; // stable client key
  isNew: boolean;
  markedDelete: boolean;
  // Original identity for existing rows (used to key updates/deletes).
  origMaterial: string;
  origPlant: string;
  // Editable values (freeStock kept as string for the input).
  material: string;
  plant: string;
  materialDescription: string;
  vertical: string;
  freeStock: string;
};

type Change =
  | {
      op: 'add';
      material: string;
      plant: string;
      freeStock: number;
      materialDescription: string | null;
      vertical: string | null;
    }
  | {
      op: 'update';
      material: string;
      plant: string;
      fields: {
        freeStock?: number;
        materialDescription?: string | null;
        vertical?: string | null;
      };
    }
  | { op: 'delete'; material: string; plant: string };

type Baseline = {
  freeStock: number;
  materialDescription: string | null;
  vertical: string | null;
};

let keySeq = 0;
const nextKey = () => `r${++keySeq}`;
const nn = (s: string): string | null => (s.trim() === '' ? null : s.trim());
const toRow = (db: DbRow): EditRow => ({
  key: nextKey(),
  isNew: false,
  markedDelete: false,
  origMaterial: db.material,
  origPlant: db.plant,
  material: db.material,
  plant: db.plant,
  materialDescription: db.materialDescription ?? '',
  vertical: db.vertical ?? '',
  freeStock: String(db.freeStock),
});

export function InventoryEditor() {
  const [rows, setRows] = useState<EditRow[]>([]);
  const [baseline, setBaseline] = useState<Map<string, Baseline>>(new Map());
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  // Inverse of the last applied batch — drives the single-level "Undo".
  const [lastInverse, setLastInverse] = useState<Change[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/backend/inventory/list');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      const dbRows: DbRow[] = data.rows;
      setRows(dbRows.map(toRow));
      setBaseline(
        new Map(
          dbRows.map((r) => [
            `${r.material}|${r.plant}`,
            {
              freeStock: r.freeStock,
              materialDescription: r.materialDescription,
              vertical: r.vertical,
            } as Baseline,
          ]),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── Row edits ──────────────────────────────────────────────────────────
  const patch = (key: string, p: Partial<EditRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
    setStatus(null);
  };
  const addRow = () => {
    setRows((rs) => [
      {
        key: nextKey(),
        isNew: true,
        markedDelete: false,
        origMaterial: '',
        origPlant: '',
        material: '',
        plant: '',
        materialDescription: '',
        vertical: '',
        freeStock: '',
      },
      ...rs,
    ]);
    setFilter('');
    setStatus(null);
  };
  const removeRow = (key: string) => {
    setRows((rs) => {
      const r = rs.find((x) => x.key === key);
      if (r?.isNew) return rs.filter((x) => x.key !== key); // drop unsaved new row outright
      return rs.map((x) => (x.key === key ? { ...x, markedDelete: !x.markedDelete } : x));
    });
    setStatus(null);
  };

  // ── Diff (vs baseline) ───────────────────────────────────────────────────
  const changes = useMemo<Change[]>(() => {
    const out: Change[] = [];
    for (const r of rows) {
      if (r.isNew) {
        if (r.markedDelete) continue;
        const material = r.material.trim();
        const plant = r.plant.trim();
        if (!material || !plant || r.freeStock.trim() === '') continue;
        const fs = Number(r.freeStock);
        if (!Number.isInteger(fs) || fs < 0) continue;
        out.push({
          op: 'add',
          material,
          plant,
          freeStock: fs,
          materialDescription: nn(r.materialDescription),
          vertical: nn(r.vertical),
        });
      } else {
        const base = baseline.get(`${r.origMaterial}|${r.origPlant}`);
        if (!base) continue;
        if (r.markedDelete) {
          out.push({ op: 'delete', material: r.origMaterial, plant: r.origPlant });
          continue;
        }
        const fields: Record<string, unknown> = {};
        const fs = Number(r.freeStock);
        if (Number.isInteger(fs) && fs >= 0 && fs !== base.freeStock) fields.freeStock = fs;
        if (nn(r.materialDescription) !== base.materialDescription)
          fields.materialDescription = nn(r.materialDescription);
        if (nn(r.vertical) !== base.vertical) fields.vertical = nn(r.vertical);
        if (Object.keys(fields).length > 0)
          out.push({ op: 'update', material: r.origMaterial, plant: r.origPlant, fields });
      }
    }
    return out;
  }, [rows, baseline]);

  // Validation surfaced before the user can review (incomplete/duplicate adds).
  const validationError = useMemo<string | null>(() => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.markedDelete) continue;
      const material = (r.isNew ? r.material : r.origMaterial).trim();
      const plant = (r.isNew ? r.plant : r.origPlant).trim();
      if (r.isNew) {
        const blank =
          !material &&
          !plant &&
          r.materialDescription.trim() === '' &&
          r.vertical.trim() === '' &&
          r.freeStock.trim() === '';
        if (blank) continue; // an untouched blank new row is ignored, not an error
        if (!material || !plant) return 'New rows need both a material code and a plant.';
        if (r.freeStock.trim() === '' || !Number.isInteger(Number(r.freeStock)) || Number(r.freeStock) < 0)
          return `Free stock for ${material} @ ${plant} must be a whole number ≥ 0.`;
      }
      const id = `${material}|${plant}`;
      if (seen.has(id)) return `Duplicate row for ${material} @ ${plant}.`;
      seen.add(id);
    }
    return null;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.isNew ||
        r.material.toLowerCase().includes(q) ||
        r.plant.toLowerCase().includes(q) ||
        (r.materialDescription ?? '').toLowerCase().includes(q) ||
        (r.vertical ?? '').toLowerCase().includes(q),
    );
  }, [rows, filter]);

  // ── Apply / Undo ───────────────────────────────────────────────────────
  const apply = async (batch: Change[], isUndo: boolean) => {
    setApplying(true);
    setError(null);
    try {
      const res = await fetch('/backend/inventory/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: batch }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setReviewOpen(false);
      if (isUndo) {
        setLastInverse(null);
        setStatus(`Reverted ${batch.length} change${batch.length === 1 ? '' : 's'}.`);
      } else {
        setLastInverse(data.inverse as Change[]);
        setStatus(
          `Applied ${batch.length} change${batch.length === 1 ? '' : 's'}. You can undo this batch.`,
        );
      }
      await load(); // refresh grid + baseline
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const dirtyCount = changes.length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Inventory free-stock</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Manual editor for the stock pre-check table. Edits apply immediately; the
                15-minute auto-sync can overwrite a row if auto_gui2 reports it again.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {lastInverse && (
                <Button variant="outline" onClick={() => apply(lastInverse, true)} disabled={applying}>
                  <Undo2 className="h-4 w-4" /> Undo last apply
                </Button>
              )}
              <Button variant="outline" onClick={load} disabled={loading || applying}>
                <RotateCcw className="h-4 w-4" /> Reload
              </Button>
              <Button variant="outline" onClick={addRow} disabled={loading}>
                <Plus className="h-4 w-4" /> Add row
              </Button>
              <Button
                onClick={() => setReviewOpen(true)}
                disabled={loading || applying || dirtyCount === 0 || !!validationError}
              >
                <Save className="h-4 w-4" /> Review &amp; save{dirtyCount > 0 ? ` (${dirtyCount})` : ''}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative w-72 max-w-full">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Filter material / plant / vertical…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <span className="text-sm text-muted-foreground">{rows.length} row(s)</span>
          </div>

          {validationError && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {validationError}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          {status && (
            <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {status}
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[20%]">Material</TableHead>
                    <TableHead className="w-[10%]">Plant</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="w-[12%]">Vertical</TableHead>
                    <TableHead className="w-[12%]">Free stock</TableHead>
                    <TableHead className="w-[60px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                        No rows. Use “Add row” to create one.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtered.map((r) => {
                      const del = r.markedDelete;
                      return (
                        <TableRow key={r.key} className={del ? 'opacity-50' : undefined}>
                          <TableCell>
                            {r.isNew ? (
                              <Input
                                value={r.material}
                                placeholder="Material code"
                                onChange={(e) => patch(r.key, { material: e.target.value })}
                              />
                            ) : (
                              <span className={del ? 'line-through' : 'font-mono text-sm'}>
                                {r.material}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            {r.isNew ? (
                              <Input
                                value={r.plant}
                                placeholder="Plant"
                                onChange={(e) => patch(r.key, { plant: e.target.value })}
                              />
                            ) : (
                              <span className={del ? 'line-through' : 'text-sm'}>{r.plant}</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Input
                              value={r.materialDescription}
                              placeholder="—"
                              disabled={del}
                              onChange={(e) => patch(r.key, { materialDescription: e.target.value })}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={r.vertical}
                              placeholder="—"
                              disabled={del}
                              onChange={(e) => patch(r.key, { vertical: e.target.value })}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              value={r.freeStock}
                              placeholder="0"
                              disabled={del}
                              onChange={(e) => patch(r.key, { freeStock: e.target.value })}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              {r.isNew && <Badge variant="secondary">new</Badge>}
                              <Button
                                variant="ghost"
                                size="icon"
                                title={del ? 'Keep row' : r.isNew ? 'Remove row' : 'Mark for deletion'}
                                onClick={() => removeRow(r.key)}
                              >
                                {del ? <RotateCcw className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirmation: show exactly what will change before committing. */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Confirm {dirtyCount} change{dirtyCount === 1 ? '' : 's'} to inventory
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[55vh] overflow-y-auto space-y-1.5 text-sm">
            {changes.map((c, i) => (
              <ChangeLine key={i} change={c} baseline={baseline} />
            ))}
            {dirtyCount === 0 && <p className="text-muted-foreground">No changes.</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewOpen(false)} disabled={applying}>
              Cancel
            </Button>
            <Button onClick={() => apply(changes, false)} disabled={applying || dirtyCount === 0}>
              {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Apply {dirtyCount} change{dirtyCount === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Per-change confirmation line (old → new) ─────────────────────────────────
function ChangeLine({ change, baseline }: { change: Change; baseline: Map<string, Baseline> }) {
  const label = `${change.material} @ ${change.plant}`;
  if (change.op === 'add') {
    return (
      <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1">
        <Badge variant="secondary" className="mr-2 bg-emerald-600 text-white">ADD</Badge>
        <span className="font-mono">{label}</span> — free stock <b>{change.freeStock}</b>
        {change.vertical ? `, vertical ${change.vertical}` : ''}
        {change.materialDescription ? `, “${change.materialDescription}”` : ''}
      </div>
    );
  }
  if (change.op === 'delete') {
    const b = baseline.get(`${change.material}|${change.plant}`);
    return (
      <div className="rounded border border-red-200 bg-red-50 px-2 py-1">
        <Badge variant="secondary" className="mr-2 bg-red-600 text-white">DELETE</Badge>
        <span className="font-mono">{label}</span>
        {b ? <span className="text-muted-foreground"> — was free stock {b.freeStock}</span> : ''}
      </div>
    );
  }
  // update
  const b = baseline.get(`${change.material}|${change.plant}`);
  const parts: string[] = [];
  if (change.fields.freeStock !== undefined)
    parts.push(`free stock ${b?.freeStock ?? '?'} → ${change.fields.freeStock}`);
  if (change.fields.materialDescription !== undefined)
    parts.push(`description “${b?.materialDescription ?? '—'}” → “${change.fields.materialDescription ?? '—'}”`);
  if (change.fields.vertical !== undefined)
    parts.push(`vertical “${b?.vertical ?? '—'}” → “${change.fields.vertical ?? '—'}”`);
  return (
    <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1">
      <Badge variant="secondary" className="mr-2 bg-amber-600 text-white">UPDATE</Badge>
      <span className="font-mono">{label}</span> — {parts.join('; ')}
    </div>
  );
}
