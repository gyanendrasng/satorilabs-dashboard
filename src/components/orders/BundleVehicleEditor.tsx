'use client';

import { useState } from 'react';
import { Truck, Edit, Save, X, Loader2 } from 'lucide-react';
import type { Bundle } from './types';

interface Props {
  bundle: Bundle;
  onSaved: () => void;
}

export function BundleVehicleEditor({ bundle, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    vehicleNumber: bundle.vehicleNumber ?? '',
    driverMobile: bundle.driverMobile ?? '',
    containerNumber: bundle.containerNumber ?? '',
  });

  const startEdit = () => {
    setForm({
      vehicleNumber: bundle.vehicleNumber ?? '',
      driverMobile: bundle.driverMobile ?? '',
      containerNumber: bundle.containerNumber ?? '',
    });
    setEditing(true);
  };

  const cancel = () => setEditing(false);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/backend/orders/bundles/${bundle.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleNumber: form.vehicleNumber,
          driverMobile: form.driverMobile,
          containerNumber: form.containerNumber,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to update bundle');
        return;
      }
      setEditing(false);
      onSaved();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const hasAny = bundle.vehicleNumber || bundle.driverMobile || bundle.containerNumber;

  return (
    <div className="border border-slate-700 rounded p-3 bg-slate-900/40">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Truck className="w-4 h-4 text-slate-300" />
          <span className="text-sm font-semibold text-slate-200">
            Bundle B{bundle.bundleNumber}
          </span>
          <span className="text-xs text-slate-500">{bundle.status}</span>
        </div>
        {!editing && (
          <button
            onClick={startEdit}
            className="px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 flex items-center gap-1"
          >
            <Edit className="w-3 h-3" />
            {hasAny ? 'Edit' : 'Add'}
          </button>
        )}
      </div>

      {!editing ? (
        hasAny ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-slate-300">
            <div>
              <div className="text-slate-500">Vehicle</div>
              <div>{bundle.vehicleNumber ?? '—'}</div>
            </div>
            <div>
              <div className="text-slate-500">Driver</div>
              <div>{bundle.driverMobile ?? '—'}</div>
            </div>
            <div>
              <div className="text-slate-500">Container</div>
              <div>{bundle.containerNumber ?? '—'}</div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500 italic">No vehicle details yet.</p>
        )
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Vehicle Number</label>
              <input
                type="text"
                value={form.vehicleNumber}
                onChange={(e) => setForm({ ...form, vehicleNumber: e.target.value })}
                className="w-full px-2 py-1 bg-slate-800 border border-slate-600 rounded text-sm"
                placeholder="GJ12AB1234"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Driver Mobile</label>
              <input
                type="text"
                value={form.driverMobile}
                onChange={(e) => setForm({ ...form, driverMobile: e.target.value })}
                className="w-full px-2 py-1 bg-slate-800 border border-slate-600 rounded text-sm"
                placeholder="9876543210"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Container Number</label>
              <input
                type="text"
                value={form.containerNumber}
                onChange={(e) => setForm({ ...form, containerNumber: e.target.value })}
                className="w-full px-2 py-1 bg-slate-800 border border-slate-600 rounded text-sm"
                placeholder="ABCD1234567"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={cancel}
              disabled={saving}
              className="px-3 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 flex items-center gap-1 disabled:opacity-50"
            >
              <X className="w-3 h-3" />
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-1 text-xs rounded bg-cyan-600 hover:bg-cyan-700 flex items-center gap-1 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
