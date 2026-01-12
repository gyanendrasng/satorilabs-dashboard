'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChevronDown, ChevronRight, Plus, Pencil, Check, X } from 'lucide-react';
import { PurchaseOrder, SalesOrder } from './types';

interface SOManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SOManagementDialog({ open, onOpenChange }: SOManagementDialogProps) {
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedPOs, setExpandedPOs] = useState<Set<string>>(new Set());

  // Add SO form state
  const [addingToPoId, setAddingToPoId] = useState<string | null>(null);
  const [newSO, setNewSO] = useState({
    soNumber: '',
    vehicleNumber: '',
    transportId: '',
  });

  // Edit SO state
  const [editingSoId, setEditingSoId] = useState<string | null>(null);
  const [editSO, setEditSO] = useState({
    soNumber: '',
    vehicleNumber: '',
    transportId: '',
  });

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/backend/orders');
      const data = await res.json();
      if (!data.error) {
        setPurchaseOrders(data.purchaseOrders);
        // Auto-expand all POs
        setExpandedPOs(new Set(data.purchaseOrders.map((po: PurchaseOrder) => po.id)));
      }
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchOrders();
    }
  }, [open, fetchOrders]);

  const togglePO = (id: string) => {
    setExpandedPOs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAddSO = async (poId: string) => {
    if (!newSO.soNumber.trim()) {
      alert('SO Number is required');
      return;
    }

    try {
      const res = await fetch(`/backend/orders/${poId}/sales-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          soNumber: newSO.soNumber,
          vehicleNumber: newSO.vehicleNumber || null,
          transportId: newSO.transportId || null,
        }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
      } else {
        setAddingToPoId(null);
        setNewSO({ soNumber: '', vehicleNumber: '', transportId: '' });
        fetchOrders();
      }
    } catch (err) {
      alert('Failed to add SO');
    }
  };

  const startEditSO = (so: SalesOrder) => {
    setEditingSoId(so.id);
    setEditSO({
      soNumber: so.soNumber,
      vehicleNumber: so.vehicleNumber || '',
      transportId: so.transportId || '',
    });
  };

  const cancelEditSO = () => {
    setEditingSoId(null);
    setEditSO({ soNumber: '', vehicleNumber: '', transportId: '' });
  };

  const handleUpdateSO = async (soId: string) => {
    if (!editSO.soNumber.trim()) {
      alert('SO Number is required');
      return;
    }

    try {
      const res = await fetch(`/backend/orders/sales-orders/${soId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          soNumber: editSO.soNumber,
          vehicleNumber: editSO.vehicleNumber || null,
          transportId: editSO.transportId || null,
        }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
      } else {
        cancelEditSO();
        fetchOrders();
      }
    } catch (err) {
      alert('Failed to update SO');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Sales Orders</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-muted-foreground">
            Loading...
          </div>
        ) : purchaseOrders.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            No purchase orders found. Create one in the Orders page first.
          </div>
        ) : (
          <div className="space-y-3">
            {purchaseOrders.map((po) => (
              <div
                key={po.id}
                className="border rounded-lg overflow-hidden"
              >
                <Collapsible
                  open={expandedPOs.has(po.id)}
                  onOpenChange={() => togglePO(po.id)}
                >
                  <CollapsibleTrigger asChild>
                    <div className="flex items-center justify-between p-3 bg-muted/30 hover:bg-muted/50 cursor-pointer transition-colors">
                      <div className="flex items-center gap-2">
                        {expandedPOs.has(po.id) ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                        <span className="font-medium">
                          PO: {po.poNumber}
                        </span>
                        <span className="text-muted-foreground">|</span>
                        <span className="text-sm text-muted-foreground">
                          {po.customerName}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {po.salesOrders.length}/4 SO
                      </span>
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="p-3 space-y-2 bg-background">
                      {po.salesOrders.map((so) => (
                        <div
                          key={so.id}
                          className="flex items-center gap-2 p-2 rounded bg-muted/20"
                        >
                          {editingSoId === so.id ? (
                            // Edit mode
                            <>
                              <Input
                                value={editSO.soNumber}
                                onChange={(e) =>
                                  setEditSO({ ...editSO, soNumber: e.target.value })
                                }
                                placeholder="SO Number"
                                className="w-28 h-8"
                              />
                              <Input
                                value={editSO.vehicleNumber}
                                onChange={(e) =>
                                  setEditSO({ ...editSO, vehicleNumber: e.target.value })
                                }
                                placeholder="Vehicle"
                                className="w-28 h-8"
                              />
                              <Input
                                value={editSO.transportId}
                                onChange={(e) =>
                                  setEditSO({ ...editSO, transportId: e.target.value })
                                }
                                placeholder="Transport ID"
                                className="w-28 h-8"
                              />
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleUpdateSO(so.id)}
                                className="h-8 w-8 p-0"
                              >
                                <Check className="w-4 h-4 text-green-600" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={cancelEditSO}
                                className="h-8 w-8 p-0"
                              >
                                <X className="w-4 h-4 text-red-600" />
                              </Button>
                            </>
                          ) : (
                            // View mode
                            <>
                              <span className="font-medium">SO: {so.soNumber}</span>
                              {so.vehicleNumber && (
                                <span className="text-sm text-muted-foreground">
                                  | Vehicle: {so.vehicleNumber}
                                </span>
                              )}
                              {so.transportId && (
                                <span className="text-sm text-muted-foreground">
                                  | Transport: {so.transportId}
                                </span>
                              )}
                              <span className="text-xs text-muted-foreground ml-auto">
                                {so.items.length} items
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => startEditSO(so)}
                                className="h-8 w-8 p-0"
                              >
                                <Pencil className="w-4 h-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      ))}

                      {/* Add SO Form */}
                      {addingToPoId === po.id ? (
                        <div className="flex items-center gap-2 p-2 rounded border border-dashed">
                          <Input
                            value={newSO.soNumber}
                            onChange={(e) =>
                              setNewSO({ ...newSO, soNumber: e.target.value })
                            }
                            placeholder="SO Number *"
                            className="w-28 h-8"
                          />
                          <Input
                            value={newSO.vehicleNumber}
                            onChange={(e) =>
                              setNewSO({ ...newSO, vehicleNumber: e.target.value })
                            }
                            placeholder="Vehicle"
                            className="w-28 h-8"
                          />
                          <Input
                            value={newSO.transportId}
                            onChange={(e) =>
                              setNewSO({ ...newSO, transportId: e.target.value })
                            }
                            placeholder="Transport ID"
                            className="w-28 h-8"
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleAddSO(po.id)}
                            className="h-8 w-8 p-0"
                          >
                            <Check className="w-4 h-4 text-green-600" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setAddingToPoId(null);
                              setNewSO({ soNumber: '', vehicleNumber: '', transportId: '' });
                            }}
                            className="h-8 w-8 p-0"
                          >
                            <X className="w-4 h-4 text-red-600" />
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setAddingToPoId(po.id)}
                          disabled={po.salesOrders.length >= 4}
                          className="w-full"
                        >
                          <Plus className="w-4 h-4 mr-1" />
                          Add SO
                          {po.salesOrders.length >= 4 && ' (Max reached)'}
                        </Button>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
