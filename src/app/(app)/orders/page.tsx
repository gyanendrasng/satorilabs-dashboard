'use client';

import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { ChevronDown, ChevronRight, Plus, Pencil } from 'lucide-react';
import {
  PurchaseOrder,
  SalesOrder,
  LoadingSlipItem,
  groupItemsByLsNumber,
} from '@/components/orders/types';
import {
  DELIVERY_STATUS_OPTIONS,
  ACCOUNT_PAYABLE_STATUS_OPTIONS,
} from '@/components/orders/constants';

export default function OrdersPage() {
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Expanded states
  const [expandedPOs, setExpandedPOs] = useState<Set<string>>(new Set());
  const [expandedSOs, setExpandedSOs] = useState<Set<string>>(new Set());
  const [expandedLSs, setExpandedLSs] = useState<Set<string>>(new Set());

  // Dialog states
  const [poDialogOpen, setPODialogOpen] = useState(false);
  const [soDialogOpen, setSODialogOpen] = useState(false);
  const [itemDialogOpen, setItemDialogOpen] = useState(false);

  // Form states
  const [newPO, setNewPO] = useState({ customerName: '', poNumber: '' });
  const [newSO, setNewSO] = useState({
    poId: '',
    soNumber: '',
    vehicleNumber: '',
    transportId: '',
  });
  const [editingItem, setEditingItem] = useState<LoadingSlipItem | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch('/backend/orders');
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setPurchaseOrders(data.purchaseOrders);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch orders');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const togglePO = (id: string) => {
    setExpandedPOs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSO = (id: string) => {
    setExpandedSOs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleLS = (key: string) => {
    setExpandedLSs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleCreatePO = async () => {
    try {
      const res = await fetch('/backend/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newPO),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
      } else {
        setPODialogOpen(false);
        setNewPO({ customerName: '', poNumber: '' });
        fetchOrders();
      }
    } catch (err) {
      alert('Failed to create PO');
    }
  };

  const handleCreateSO = async () => {
    try {
      const res = await fetch(`/backend/orders/${newSO.poId}/sales-orders`, {
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
        setSODialogOpen(false);
        setNewSO({ poId: '', soNumber: '', vehicleNumber: '', transportId: '' });
        fetchOrders();
      }
    } catch (err) {
      alert('Failed to create SO');
    }
  };

  const handleUpdateItem = async () => {
    if (!editingItem) return;
    try {
      const res = await fetch(`/backend/orders/items/${editingItem.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plantInvoiceNumber: editingItem.plantInvoiceNumber,
          plantInvoiceDate: editingItem.plantInvoiceDate,
          invoiceQuantity: editingItem.invoiceQuantity,
          invoiceWeight: editingItem.invoiceWeight,
          receivedQuantity: editingItem.receivedQuantity,
          receivedWeight: editingItem.receivedWeight,
          lrNumber: editingItem.lrNumber,
          lrDate: editingItem.lrDate,
          vehicleNumber: editingItem.vehicleNumber,
          deliveryStatus: editingItem.deliveryStatus,
          accountPayableStatus: editingItem.accountPayableStatus,
        }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
      } else {
        setItemDialogOpen(false);
        setEditingItem(null);
        fetchOrders();
      }
    } catch (err) {
      alert('Failed to update item');
    }
  };

  const openAddSODialog = (poId: string) => {
    setNewSO({ poId, soNumber: '', vehicleNumber: '', transportId: '' });
    setSODialogOpen(true);
  };

  const openEditItemDialog = (item: LoadingSlipItem) => {
    setEditingItem({ ...item });
    setItemDialogOpen(true);
  };

  if (loading) {
    return <div className="container mx-auto py-10">Loading orders...</div>;
  }

  if (error) {
    return (
      <div className="container mx-auto py-10 text-red-600">Error: {error}</div>
    );
  }

  return (
    <div className="container mx-auto py-10">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold">Orders Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage Purchase Orders, Sales Orders, and Loading Slips
          </p>
        </div>
        <Button onClick={() => setPODialogOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          New PO
        </Button>
      </div>

      {purchaseOrders.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            No purchase orders yet. Click &quot;New PO&quot; to create one.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {purchaseOrders.map((po) => (
            <Card key={po.id}>
              <Collapsible
                open={expandedPOs.has(po.id)}
                onOpenChange={() => togglePO(po.id)}
              >
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {expandedPOs.has(po.id) ? (
                          <ChevronDown className="w-5 h-5" />
                        ) : (
                          <ChevronRight className="w-5 h-5" />
                        )}
                        <CardTitle className="text-lg">
                          {po.poNumber} | {po.customerName}
                        </CardTitle>
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {po.salesOrders.length} SO(s)
                      </span>
                    </div>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent>
                    <div className="flex justify-between items-center mb-4">
                      <span className="text-sm text-muted-foreground">
                        Sales Orders
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          openAddSODialog(po.id);
                        }}
                        disabled={po.salesOrders.length >= 4}
                      >
                        <Plus className="w-4 h-4 mr-1" />
                        Add SO
                      </Button>
                    </div>

                    {po.salesOrders.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-4 text-center">
                        No sales orders yet.
                      </p>
                    ) : (
                      <div className="space-y-3 pl-4 border-l-2 border-muted">
                        {po.salesOrders.map((so) => (
                          <SOSection
                            key={so.id}
                            so={so}
                            expanded={expandedSOs.has(so.id)}
                            onToggle={() => toggleSO(so.id)}
                            expandedLSs={expandedLSs}
                            onToggleLS={toggleLS}
                            onEditItem={openEditItemDialog}
                          />
                        ))}
                      </div>
                    )}
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          ))}
        </div>
      )}

      {/* Create PO Dialog */}
      <Dialog open={poDialogOpen} onOpenChange={setPODialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Purchase Order</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium">Customer Name *</label>
              <Input
                value={newPO.customerName}
                onChange={(e) =>
                  setNewPO({ ...newPO, customerName: e.target.value })
                }
                placeholder="Enter customer name"
              />
            </div>
            <div>
              <label className="text-sm font-medium">
                PO Number (optional)
              </label>
              <Input
                value={newPO.poNumber}
                onChange={(e) =>
                  setNewPO({ ...newPO, poNumber: e.target.value })
                }
                placeholder="Auto-generated if empty"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPODialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreatePO} disabled={!newPO.customerName}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create SO Dialog */}
      <Dialog open={soDialogOpen} onOpenChange={setSODialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Sales Order</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium">SO Number *</label>
              <Input
                value={newSO.soNumber}
                onChange={(e) =>
                  setNewSO({ ...newSO, soNumber: e.target.value })
                }
                placeholder="Enter SO number"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Vehicle Number</label>
              <Input
                value={newSO.vehicleNumber}
                onChange={(e) =>
                  setNewSO({ ...newSO, vehicleNumber: e.target.value })
                }
                placeholder="Optional"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Transport ID</label>
              <Input
                value={newSO.transportId}
                onChange={(e) =>
                  setNewSO({ ...newSO, transportId: e.target.value })
                }
                placeholder="Optional"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSODialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateSO} disabled={!newSO.soNumber}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Item Dialog */}
      <Dialog open={itemDialogOpen} onOpenChange={setItemDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Line Item</DialogTitle>
          </DialogHeader>
          {editingItem && (
            <div className="grid grid-cols-2 gap-4 py-4">
              <div>
                <label className="text-sm font-medium">Plant Invoice Number</label>
                <Input
                  value={editingItem.plantInvoiceNumber || ''}
                  onChange={(e) =>
                    setEditingItem({
                      ...editingItem,
                      plantInvoiceNumber: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <label className="text-sm font-medium">Plant Invoice Date</label>
                <Input
                  type="date"
                  value={
                    editingItem.plantInvoiceDate
                      ? new Date(editingItem.plantInvoiceDate)
                          .toISOString()
                          .split('T')[0]
                      : ''
                  }
                  onChange={(e) =>
                    setEditingItem({
                      ...editingItem,
                      plantInvoiceDate: e.target.value || null,
                    })
                  }
                />
              </div>
              <div>
                <label className="text-sm font-medium">Invoice Quantity</label>
                <Input
                  type="number"
                  value={editingItem.invoiceQuantity || ''}
                  onChange={(e) =>
                    setEditingItem({
                      ...editingItem,
                      invoiceQuantity: e.target.value
                        ? parseInt(e.target.value)
                        : null,
                    })
                  }
                />
              </div>
              <div>
                <label className="text-sm font-medium">Invoice Weight</label>
                <Input
                  type="number"
                  value={editingItem.invoiceWeight || ''}
                  onChange={(e) =>
                    setEditingItem({
                      ...editingItem,
                      invoiceWeight: e.target.value || null,
                    })
                  }
                />
              </div>
              <div>
                <label className="text-sm font-medium">Received Quantity</label>
                <Input
                  type="number"
                  value={editingItem.receivedQuantity || ''}
                  onChange={(e) =>
                    setEditingItem({
                      ...editingItem,
                      receivedQuantity: e.target.value
                        ? parseInt(e.target.value)
                        : null,
                    })
                  }
                />
              </div>
              <div>
                <label className="text-sm font-medium">Received Weight</label>
                <Input
                  type="number"
                  value={editingItem.receivedWeight || ''}
                  onChange={(e) =>
                    setEditingItem({
                      ...editingItem,
                      receivedWeight: e.target.value || null,
                    })
                  }
                />
              </div>
              <div>
                <label className="text-sm font-medium">LR Number</label>
                <Input
                  value={editingItem.lrNumber || ''}
                  onChange={(e) =>
                    setEditingItem({
                      ...editingItem,
                      lrNumber: e.target.value || null,
                    })
                  }
                />
              </div>
              <div>
                <label className="text-sm font-medium">LR Date</label>
                <Input
                  type="date"
                  value={
                    editingItem.lrDate
                      ? new Date(editingItem.lrDate).toISOString().split('T')[0]
                      : ''
                  }
                  onChange={(e) =>
                    setEditingItem({
                      ...editingItem,
                      lrDate: e.target.value || null,
                    })
                  }
                />
              </div>
              <div>
                <label className="text-sm font-medium">Vehicle Number</label>
                <Input
                  value={editingItem.vehicleNumber || ''}
                  onChange={(e) =>
                    setEditingItem({
                      ...editingItem,
                      vehicleNumber: e.target.value || null,
                    })
                  }
                />
              </div>
              <div>
                <label className="text-sm font-medium">Delivery Status</label>
                <Select
                  value={editingItem.deliveryStatus || ''}
                  onValueChange={(value) =>
                    setEditingItem({
                      ...editingItem,
                      deliveryStatus: value || null,
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {DELIVERY_STATUS_OPTIONS.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <label className="text-sm font-medium">
                  Account Payable Status
                </label>
                <Select
                  value={editingItem.accountPayableStatus || ''}
                  onValueChange={(value) =>
                    setEditingItem({
                      ...editingItem,
                      accountPayableStatus: value || null,
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_PAYABLE_STATUS_OPTIONS.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setItemDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUpdateItem}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// SO Section Component
function SOSection({
  so,
  expanded,
  onToggle,
  expandedLSs,
  onToggleLS,
  onEditItem,
}: {
  so: SalesOrder;
  expanded: boolean;
  onToggle: () => void;
  expandedLSs: Set<string>;
  onToggleLS: (key: string) => void;
  onEditItem: (item: LoadingSlipItem) => void;
}) {
  const itemsByLS = groupItemsByLsNumber(so.items);
  const lsNumbers = Array.from(itemsByLS.keys()).sort();

  return (
    <Collapsible open={expanded} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/50 cursor-pointer transition-colors">
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            <span className="font-medium">SO: {so.soNumber}</span>
            {so.vehicleNumber && (
              <span className="text-sm text-muted-foreground">
                | Vehicle: {so.vehicleNumber}
              </span>
            )}
          </div>
          <span className="text-sm text-muted-foreground">
            {lsNumbers.length} LS, {so.items.length} items
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 pl-4 space-y-2">
          {lsNumbers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No loading slips yet.
            </p>
          ) : (
            lsNumbers.map((lsNumber) => {
              const lsKey = `${so.id}-${lsNumber}`;
              const items = itemsByLS.get(lsNumber) || [];
              return (
                <LSGroup
                  key={lsKey}
                  lsNumber={lsNumber}
                  items={items}
                  expanded={expandedLSs.has(lsKey)}
                  onToggle={() => onToggleLS(lsKey)}
                  onEditItem={onEditItem}
                />
              );
            })
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// LS Group Component
function LSGroup({
  lsNumber,
  items,
  expanded,
  onToggle,
  onEditItem,
}: {
  lsNumber: string;
  items: LoadingSlipItem[];
  expanded: boolean;
  onToggle: () => void;
  onEditItem: (item: LoadingSlipItem) => void;
}) {
  return (
    <Collapsible open={expanded} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <div className="flex items-center justify-between p-2 rounded bg-muted/20 hover:bg-muted/40 cursor-pointer transition-colors">
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            <span className="text-sm font-medium">LS: {lsNumber}</span>
          </div>
          <span className="text-xs text-muted-foreground">
            {items.length} item(s)
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Material</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Order Qty</TableHead>
                <TableHead>Order Weight</TableHead>
                <TableHead>Delivery Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-mono text-xs">
                    {item.material}
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate" title={item.materialDescription || ''}>
                    {item.materialDescription || '-'}
                  </TableCell>
                  <TableCell>{item.orderQuantity || '-'}</TableCell>
                  <TableCell>{item.orderWeight || '-'}</TableCell>
                  <TableCell>
                    {item.deliveryStatus ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        {item.deliveryStatus}
                      </span>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onEditItem(item)}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
