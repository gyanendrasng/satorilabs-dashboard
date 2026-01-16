'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { WorkChat } from '@/components/work/WorkChat';
import {
  Monitor,
  Eye,
  EyeOff,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Loader2,
  Play,
  Pause,
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  Package,
  ChevronDown,
  ChevronRight,
  Edit,
  Plus,
  Save,
  X,
  MessageSquare,
  Layers,
  Bot,
} from 'lucide-react';
import { PurchaseOrder, SalesOrder, LoadingSlipItem, Invoice, groupItemsByLsNumber } from '@/components/orders/types';

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
}

interface WorkSession {
  id: string;
  title: string;
  mode?: string;
  lastMessageAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messages: ChatMessage[];
}

type CreateConnectionResponse = {
  token: string;
  connection: { identifier?: string; id?: string } | string;
  created?: boolean;
  error?: string;
};

export default function WorkPage() {
  // Active tab state
  const [activeTab, setActiveTab] = useState<'hierarchy' | 'chat' | 'screen'>('hierarchy');

  // Chat state
  const [chat, setChat] = useState<WorkSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Orders state
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [expandedPOs, setExpandedPOs] = useState<Set<string>>(new Set());
  const [expandedSOs, setExpandedSOs] = useState<Set<string>>(new Set());

  // Modal state
  const [showInputModal, setShowInputModal] = useState(false);
  const [inputType, setInputType] = useState<'new-po' | 'new-so' | 'so-details' | 'shipment-details'>('new-po');
  const [selectedPO, setSelectedPO] = useState<PurchaseOrder | null>(null);
  const [selectedSO, setSelectedSO] = useState<SalesOrder | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);

  // Form state for new PO
  const [newPOForm, setNewPOForm] = useState({ customerName: '', poNumber: '' });

  // Track multiple SOs being added to new PO
  const [newPOSOs, setNewPOSOs] = useState<Array<{
    id: number;
    customerName: string;
    soNumbers: string[]; // Changed to array for multiple SO numbers
    weight: string;
    containerType: string;
    deliveryLocations: string;
    vehicleNumber: string;
    driverMobile: string;
    containerNumber: string;
    sealNumber: string;
    specialInstructions: string;
  }>>([{
    id: 1,
    customerName: '',
    soNumbers: [''], // Array with one empty string
    weight: '',
    containerType: '',
    deliveryLocations: '',
    vehicleNumber: '',
    driverMobile: '',
    containerNumber: '',
    sealNumber: '',
    specialInstructions: '',
  }]);

  // Form state for new SO
  const [newSOForm, setNewSOForm] = useState({
    soNumber: '',
    vehicleNumber: '',
    transportId: '',
    driverMobile: '',
    containerNumber: '',
    sealNumber: '',
    weight: '',
    containerType: '',
    deliveryLocations: '',
    specialInstructions: '',
  });

  // Form state for SO details
  const [soDetailsForm, setSODetailsForm] = useState({
    vehicleNumber: '',
    transportId: '',
    driverMobile: '',
    containerNumber: '',
    sealNumber: '',
    weight: '',
    containerType: '',
    deliveryLocations: '',
    specialInstructions: '',
  });

  // Form state for shipment details
  const [shipmentForm, setShipmentForm] = useState({
    lrNumber: '',
    lrDate: '',
    vehicleNumber: '',
    shipmentType: '',
    plantCode: '',
    notes: '',
  });

  // VM screen state
  const [showVmScreen, setShowVmScreen] = useState(true);
  const [screenZoom, setScreenZoom] = useState(100);

  // Guacamole connection
  const [status, setStatus] = useState<string>('Initializing...');
  const [token, setToken] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const connectionIdRef = useRef<string | null>(null);
  const createdRef = useRef<boolean>(false);

  const guacBase = useMemo(() => {
    return process.env.NEXT_PUBLIC_GUAC_BASE_URL?.replace(/\/$/, '') || '';
  }, []);

  // Fetch orders
  const fetchOrders = useCallback(async () => {
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
      setOrdersLoading(false);
    }
  }, []);

  // Fetch work chat
  useEffect(() => {
    async function fetchWorkChat() {
      try {
        const response = await fetch('/backend/work-chat');
        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('Please sign in to access Work Station');
          }
          throw new Error('Failed to load work chat');
        }
        const data = await response.json();
        setChat(data.chat);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    }

    fetchWorkChat();
    fetchOrders();
  }, [fetchOrders]);

  // Initialize Guacamole connection
  useEffect(() => {
    let cancelled = false;

    async function initConnection() {
      try {
        setStatus('Creating connection...');
        const resp = await fetch('/backend/guacamole/create-connection', {
          method: 'POST',
        });
        const data: CreateConnectionResponse = await resp.json();

        if (!resp.ok || data.error) {
          throw new Error(data.error || resp.statusText);
        }

        if (cancelled) return;

        setToken(data.token);
        const id =
          typeof data.connection === 'string'
            ? data.connection
            : data.connection.identifier || data.connection.id || null;
        setConnectionId(id);
        connectionIdRef.current = id;
        createdRef.current = Boolean(data.created);
        setStatus('Ready');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(`Error: ${message}`);
      }
    }

    initConnection();

    return () => {
      cancelled = true;
      if (createdRef.current && connectionIdRef.current) {
        fetch('/backend/guacamole/delete-connection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: connectionIdRef.current }),
        }).catch(() => {});
      }
    };
  }, []);

  const iframeSrc =
    token && connectionId
      ? `${guacBase}/#/client/${encodeURIComponent(
          connectionId
        )}?token=${encodeURIComponent(token)}`
      : null;

  const handleUpdateTitle = (sessionId: string, newTitle: string) => {
    if (chat && chat.id === sessionId) {
      setChat({ ...chat, title: newTitle });
    }
  };

  // Toggle functions
  const togglePO = (poId: string) => {
    setExpandedPOs((prev) => {
      const next = new Set(prev);
      if (next.has(poId)) next.delete(poId);
      else next.add(poId);
      return next;
    });
  };

  const toggleSO = (soId: string) => {
    setExpandedSOs((prev) => {
      const next = new Set(prev);
      if (next.has(soId)) next.delete(soId);
      else next.add(soId);
      return next;
    });
  };

  // Check if invoice shipment details can be provided
  const canProvideShipmentDetails = (so: SalesOrder) => {
    const allLSCompleted = so.items.every((ls) => ls.status === 'completed');
    const soCompleted = so.status === 'completed';
    const invoiceCreated = so.invoice && so.invoice.status === 'created';
    const noShipmentYet = !so.lrNumber;
    return allLSCompleted && soCompleted && invoiceCreated && noShipmentYet;
  };

  // Open modals
  const openNewPOModal = () => {
    setInputType('new-po');
    setNewPOForm({ customerName: '', poNumber: '' });
    setNewPOSOs([{
      id: 1,
      customerName: '',
      soNumbers: [''],
      weight: '',
      containerType: '',
      deliveryLocations: '',
      vehicleNumber: '',
      driverMobile: '',
      containerNumber: '',
      sealNumber: '',
      specialInstructions: '',
    }]);
    setShowInputModal(true);
  };

  const openNewSOModal = (po: PurchaseOrder) => {
    setInputType('new-so');
    setSelectedPO(po);
    setNewSOForm({
      soNumber: '',
      vehicleNumber: '',
      transportId: '',
      driverMobile: '',
      containerNumber: '',
      sealNumber: '',
      weight: '',
      containerType: '',
      deliveryLocations: '',
      specialInstructions: '',
    });
    setShowInputModal(true);
  };

  const openSODetailsModal = (so: SalesOrder) => {
    setInputType('so-details');
    setSelectedSO(so);
    setSODetailsForm({
      vehicleNumber: so.vehicleNumber || '',
      transportId: so.transportId || '',
      driverMobile: so.driverMobile || '',
      containerNumber: so.containerNumber || '',
      sealNumber: so.sealNumber || '',
      weight: so.weight || '',
      containerType: so.containerType || '',
      deliveryLocations: so.deliveryLocations || '',
      specialInstructions: so.specialInstructions || '',
    });
    setShowInputModal(true);
  };

  const openShipmentModal = (so: SalesOrder) => {
    if (!so.invoice) return;
    setInputType('shipment-details');
    setSelectedSO(so);
    setSelectedInvoice(so.invoice);
    setShipmentForm({
      lrNumber: so.lrNumber || '',
      lrDate: so.lrDate ? so.lrDate.split('T')[0] : '',
      vehicleNumber: so.vehicleNumber || '',
      shipmentType: so.invoice.shipmentType || '',
      plantCode: so.invoice.plantCode || '',
      notes: so.invoice.notes || '',
    });
    setShowInputModal(true);
  };

  // Handle form submissions
  const handleCreatePO = async () => {
    // Check if at least one SO has required fields (at least one SO number and customer name)
    const validSOs = newPOSOs.filter(so => so.soNumbers.some(num => num.trim()) && so.customerName);
    if (validSOs.length === 0) return;

    try {
      // Create PO first
      const poRes = await fetch('/backend/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: validSOs[0].customerName, // Use first SO's customer name for PO
          poNumber: newPOForm.poNumber || undefined,
        }),
      });

      if (poRes.ok) {
        const poData = await poRes.json();
        const poId = poData.purchaseOrder.id;

        // Create all SOs for this PO - each SO number becomes a separate SO
        for (const so of validSOs) {
          for (const soNumber of so.soNumbers) {
            if (soNumber.trim()) {
              await fetch(`/backend/orders/${poId}/sales-orders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  soNumber: soNumber.trim(),
                  vehicleNumber: so.vehicleNumber || undefined,
                  driverMobile: so.driverMobile || undefined,
                  containerNumber: so.containerNumber || undefined,
                  sealNumber: so.sealNumber || undefined,
                  weight: so.weight || undefined,
                  containerType: so.containerType || undefined,
                  deliveryLocations: so.deliveryLocations || undefined,
                  specialInstructions: so.specialInstructions || undefined,
                }),
              });
            }
          }
        }

        setShowInputModal(false);
        setNewPOSOs([{
          id: 1,
          customerName: '',
          soNumbers: [''],
          weight: '',
          containerType: '',
          deliveryLocations: '',
          vehicleNumber: '',
          driverMobile: '',
          containerNumber: '',
          sealNumber: '',
          specialInstructions: '',
        }]);
        fetchOrders();
      }
    } catch (err) {
      console.error('Failed to create PO:', err);
    }
  };

  const handleCreateSO = async () => {
    if (!selectedPO || !newSOForm.soNumber) return;
    try {
      const res = await fetch(`/backend/orders/${selectedPO.id}/sales-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          soNumber: newSOForm.soNumber,
          vehicleNumber: newSOForm.vehicleNumber || undefined,
          transportId: newSOForm.transportId || undefined,
          driverMobile: newSOForm.driverMobile || undefined,
          containerNumber: newSOForm.containerNumber || undefined,
          sealNumber: newSOForm.sealNumber || undefined,
          weight: newSOForm.weight || undefined,
          containerType: newSOForm.containerType || undefined,
          deliveryLocations: newSOForm.deliveryLocations || undefined,
          specialInstructions: newSOForm.specialInstructions || undefined,
        }),
      });
      if (res.ok) {
        setShowInputModal(false);
        setSelectedPO(null);
        fetchOrders();
      }
    } catch (err) {
      console.error('Failed to create SO:', err);
    }
  };

  const handleUpdateSO = async () => {
    if (!selectedSO) return;
    try {
      const res = await fetch(`/backend/orders/sales-orders/${selectedSO.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...soDetailsForm,
          status: 'in-progress',
          requiresInput: false,
        }),
      });
      if (res.ok) {
        setShowInputModal(false);
        fetchOrders();
      }
    } catch (err) {
      console.error('Failed to update SO:', err);
    }
  };

  const handleUpdateShipment = async () => {
    if (!selectedInvoice) return;
    try {
      const res = await fetch(`/backend/orders/invoices/${selectedInvoice.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...shipmentForm,
          status: 'shipped',
        }),
      });
      if (res.ok) {
        setShowInputModal(false);
        fetchOrders();
      }
    } catch (err) {
      console.error('Failed to update shipment:', err);
    }
  };

  // Status badge component
  const getStatusBadge = (status: string, requiresInput = false) => {
    if (requiresInput) {
      return (
        <span className="px-2 py-1 bg-orange-600 text-white text-xs rounded-full flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          Input Required
        </span>
      );
    }

    const configs: Record<string, { bg: string; text: string; icon: typeof CheckCircle2 }> = {
      completed: { bg: 'bg-emerald-600', text: 'Completed', icon: CheckCircle2 },
      'in-progress': { bg: 'bg-blue-600', text: 'In Progress', icon: Clock },
      pending: { bg: 'bg-slate-600', text: 'Pending', icon: Clock },
      created: { bg: 'bg-purple-600', text: 'Created', icon: FileText },
      shipped: { bg: 'bg-emerald-600', text: 'Shipped', icon: CheckCircle2 },
      'pending-input': { bg: 'bg-orange-600', text: 'Needs Input', icon: AlertCircle },
    };

    const config = configs[status] || configs['pending'];
    const Icon = config.icon;

    return (
      <span className={`px-2 py-1 ${config.bg} text-white text-xs rounded-full flex items-center gap-1`}>
        <Icon className="w-3 h-3" />
        {config.text}
      </span>
    );
  };

  // Calculate stats
  const totalSOs = purchaseOrders.reduce((acc, po) => acc + po.salesOrders.length, 0);
  const totalInvoices = purchaseOrders.reduce(
    (acc, po) => acc + po.salesOrders.filter((so) => so.invoice).length,
    0
  );
  const pendingInputs = purchaseOrders.reduce(
    (acc, po) => acc + po.salesOrders.filter((so) => so.requiresInput).length,
    0
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          <p className="text-slate-400">Loading work station...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <div className="text-red-400 text-xl font-semibold">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-slate-100 pb-16">
      {/* Header */}
      <div className="border-b border-slate-700 bg-slate-800/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-[1920px] mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
                SAP Workflow Automation
              </h1>
              <p className="text-slate-400 text-sm mt-1">
                Purchase Order → Sales Order → Loading Sheet → Invoice Management
              </p>
            </div>
            <div className="flex gap-3">
              <button className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 rounded-lg font-medium transition-all flex items-center gap-2 shadow-lg">
                <Play className="w-4 h-4" />
                Start Workflow
              </button>
              <button className="px-5 py-2.5 bg-slate-700 hover:bg-slate-600 rounded-lg font-medium transition-all flex items-center gap-2">
                <Pause className="w-4 h-4" />
                Pause
              </button>
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="mt-4 flex gap-2 border-b border-slate-700">
            <button
              onClick={() => setActiveTab('hierarchy')}
              className={`px-4 py-2 flex items-center gap-2 border-b-2 transition-colors ${
                activeTab === 'hierarchy'
                  ? 'border-cyan-500 text-cyan-400 bg-slate-700/30'
                  : 'border-transparent text-slate-400 hover:text-slate-300'
              }`}
            >
              <Layers className="w-4 h-4" />
              <span className="font-medium">Order Hierarchy</span>
            </button>
            <button
              onClick={() => setActiveTab('chat')}
              className={`px-4 py-2 flex items-center gap-2 border-b-2 transition-colors ${
                activeTab === 'chat'
                  ? 'border-cyan-500 text-cyan-400 bg-slate-700/30'
                  : 'border-transparent text-slate-400 hover:text-slate-300'
              }`}
            >
              <MessageSquare className="w-4 h-4" />
              <span className="font-medium">Agent Chat</span>
            </button>
            <button
              onClick={() => setActiveTab('screen')}
              className={`px-4 py-2 flex items-center gap-2 border-b-2 transition-colors ${
                activeTab === 'screen'
                  ? 'border-cyan-500 text-cyan-400 bg-slate-700/30'
                  : 'border-transparent text-slate-400 hover:text-slate-300'
              }`}
            >
              <Monitor className="w-4 h-4" />
              <span className="font-medium">Agent Screen</span>
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="max-w-[1920px] mx-auto p-6">
        {/* Order Hierarchy Tab */}
        {activeTab === 'hierarchy' && (
          <div
            className="bg-slate-800/50 backdrop-blur rounded-xl border border-slate-700 shadow-xl p-6"
            style={{ minHeight: 'calc(100vh - 340px)' }}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Package className="w-5 h-5 text-cyan-400" />
                Order Hierarchy View
              </h2>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-4 text-sm text-slate-400">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-emerald-600 rounded"></div>
                    <span>PO Level</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-cyan-600 rounded"></div>
                    <span>SO Level</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-slate-600 rounded"></div>
                    <span>LS Level</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-purple-600 rounded"></div>
                    <span>Invoice</span>
                  </div>
                </div>
                <button
                  onClick={openNewPOModal}
                  className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm flex items-center gap-2 font-medium"
                >
                  <Plus className="w-4 h-4" />
                  New PO
                </button>
              </div>
            </div>

            {ordersLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
              </div>
            ) : purchaseOrders.length === 0 ? (
              <div className="text-center py-20 text-slate-400">
                <Package className="w-16 h-16 mx-auto mb-4 opacity-50" />
                <p>No purchase orders yet. Click &quot;New PO&quot; to create one.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {purchaseOrders.map((po) => (
                  <div key={po.id} className="border border-slate-700 rounded-lg overflow-hidden">
                    {/* PO Level */}
                    <div
                      className="bg-emerald-900/30 border-l-4 border-emerald-500 p-4 cursor-pointer hover:bg-emerald-900/40 transition-colors"
                      onClick={() => togglePO(po.id)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {expandedPOs.has(po.id) ? (
                            <ChevronDown className="w-5 h-5" />
                          ) : (
                            <ChevronRight className="w-5 h-5" />
                          )}
                          <div>
                            <div className="flex items-center gap-3">
                              <span className="font-semibold text-lg">{po.poNumber}</span>
                              {getStatusBadge(po.status)}
                              <span className="text-xs bg-slate-700 px-2 py-1 rounded">
                                Stage {po.stage}/6
                              </span>
                            </div>
                            <p className="text-xs text-slate-400 mt-1">
                              {po.customerName} - Purchase Order
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-slate-400">
                          <span>{po.salesOrders.length} Sales Orders</span>
                          <span>-</span>
                          <span>
                            {po.salesOrders.reduce((acc, so) => acc + so.items.length, 0)} Items
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* SO Level */}
                    {expandedPOs.has(po.id) && (
                      <div className="bg-slate-800/50 p-4 space-y-3">
                        {/* Add SO Button */}
                        <div className="flex justify-end mb-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openNewSOModal(po);
                            }}
                            className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-700 rounded text-sm flex items-center gap-1.5 font-medium transition-colors"
                          >
                            <Plus className="w-4 h-4" />
                            Add SO
                          </button>
                        </div>
                        {po.salesOrders.length === 0 ? (
                          <p className="text-sm text-slate-400 text-center py-4">
                            No sales orders yet. Click &quot;Add SO&quot; to create one.
                          </p>
                        ) : (
                          po.salesOrders.map((so) => {
                            const itemsByLS = groupItemsByLsNumber(so.items);
                            const lsNumbers = Array.from(itemsByLS.keys()).sort();

                            return (
                              <div
                                key={so.id}
                                className="border border-slate-600 rounded-lg overflow-hidden"
                              >
                                <div
                                  className="bg-cyan-900/30 border-l-4 border-cyan-500 p-3 cursor-pointer hover:bg-cyan-900/40 transition-colors"
                                  onClick={() => toggleSO(so.id)}
                                >
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3 flex-1">
                                      {expandedSOs.has(so.id) ? (
                                        <ChevronDown className="w-4 h-4" />
                                      ) : (
                                        <ChevronRight className="w-4 h-4" />
                                      )}
                                      <div className="flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <span className="font-semibold text-base">
                                            {so.soNumber}
                                          </span>
                                          {getStatusBadge(so.status, so.requiresInput)}
                                          <span className="text-xs text-slate-400">
                                            {lsNumbers.length} LS - {so.items.length} Items
                                          </span>
                                        </div>
                                        <p className="text-xs text-slate-400 mt-0.5">Sales Order</p>
                                      </div>
                                    </div>
                                    {so.requiresInput && so.items.length > 0 && so.items.every(item => item.status === 'completed') && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          openSODetailsModal(so);
                                        }}
                                        className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 rounded text-sm flex items-center gap-1.5 ml-2"
                                      >
                                        <Edit className="w-3.5 h-3.5" />
                                        Provide Input
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {/* LS and Invoice Level */}
                                {expandedSOs.has(so.id) && (
                                  <div className="bg-slate-900/50 p-4">
                                    <div className="grid grid-cols-2 gap-4">
                                      {/* Loading Sheets Column */}
                                      <div>
                                        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-700">
                                          <FileText className="w-4 h-4 text-slate-400" />
                                          <h4 className="text-sm font-semibold text-slate-300">
                                            Loading Sheets ({lsNumbers.length})
                                          </h4>
                                        </div>
                                        <div className="space-y-2 max-h-60 overflow-y-auto">
                                          {lsNumbers.map((lsNumber) => {
                                            const items = itemsByLS.get(lsNumber) || [];
                                            const allCompleted = items.every(
                                              (i) => i.status === 'completed'
                                            );
                                            const lsStatus = allCompleted
                                              ? 'completed'
                                              : items.some((i) => i.status === 'in-progress')
                                              ? 'in-progress'
                                              : 'pending';

                                            return (
                                              <div
                                                key={lsNumber}
                                                className="bg-slate-800/70 p-3 rounded border border-slate-700"
                                              >
                                                <div className="flex items-center justify-between">
                                                  <div className="flex items-center gap-2">
                                                    <FileText className="w-4 h-4 text-slate-400" />
                                                    <span className="text-sm font-medium">
                                                      {lsNumber}
                                                    </span>
                                                    <span className="text-xs text-slate-500">
                                                      ({items.length} items)
                                                    </span>
                                                  </div>
                                                  {getStatusBadge(lsStatus)}
                                                </div>
                                              </div>
                                            );
                                          })}
                                          {lsNumbers.length === 0 && (
                                            <p className="text-sm text-slate-500 text-center py-4">
                                              No loading sheets
                                            </p>
                                          )}
                                        </div>
                                      </div>

                                      {/* Invoice Column */}
                                      <div>
                                        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-700">
                                          <Package className="w-4 h-4 text-purple-400" />
                                          <h4 className="text-sm font-semibold text-slate-300">
                                            Invoice
                                          </h4>
                                        </div>
                                        {so.invoice ? (
                                          <div className="bg-purple-900/20 border border-purple-700/50 p-3 rounded">
                                            <div className="flex items-center justify-between mb-2">
                                              <div className="flex items-center gap-2">
                                                <Package className="w-4 h-4 text-purple-400" />
                                                <span className="text-sm font-medium">
                                                  {so.invoice.invoiceNumber}
                                                </span>
                                              </div>
                                              {getStatusBadge(so.invoice.status)}
                                            </div>
                                            {so.invoice.amount && (
                                              <div className="flex items-center justify-between text-sm mb-2">
                                                <span className="text-slate-400">Amount:</span>
                                                <span className="font-semibold text-purple-300">
                                                  {so.invoice.amount}
                                                </span>
                                              </div>
                                            )}
                                            {so.invoice.obdNumber && (
                                              <div className="flex items-center justify-between text-sm mb-2">
                                                <span className="text-slate-400">OBD:</span>
                                                <span className="text-slate-300">
                                                  {so.invoice.obdNumber}
                                                </span>
                                              </div>
                                            )}
                                            {canProvideShipmentDetails(so) && (
                                              <button
                                                onClick={() => openShipmentModal(so)}
                                                className="w-full mt-2 px-3 py-2 bg-orange-600 hover:bg-orange-700 rounded text-sm flex items-center justify-center gap-1.5"
                                              >
                                                <Edit className="w-3.5 h-3.5" />
                                                Provide Shipment Details
                                              </button>
                                            )}
                                            {so.lrNumber && (
                                              <div className="mt-2 pt-2 border-t border-purple-700/50 text-xs text-slate-400">
                                                <p>LR: {so.lrNumber}</p>
                                                {so.vehicleNumber && (
                                                  <p>Vehicle: {so.vehicleNumber}</p>
                                                )}
                                              </div>
                                            )}
                                          </div>
                                        ) : (
                                          <div className="bg-slate-800/50 border border-slate-700 p-4 rounded text-center">
                                            <Package className="w-8 h-8 mx-auto mb-2 text-slate-600" />
                                            <p className="text-sm text-slate-500">
                                              Invoice not created yet
                                            </p>
                                            <p className="text-xs text-slate-600 mt-1">
                                              Will be created at Stage 4
                                            </p>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Agent Chat Tab */}
        {activeTab === 'chat' && (
          <div
            className="bg-slate-800/50 backdrop-blur rounded-xl border border-slate-700 shadow-xl flex flex-col"
            style={{ height: 'calc(100vh - 340px)' }}
          >
            <WorkChat session={chat} onUpdateTitle={handleUpdateTitle} />
          </div>
        )}

        {/* Agent Screen Tab */}
        {activeTab === 'screen' && (
          <div
            className="bg-slate-800/50 backdrop-blur rounded-xl border border-slate-700 shadow-xl overflow-hidden"
            style={{ minHeight: 'calc(100vh - 340px)' }}
          >
            <div className="flex items-center justify-between p-4 border-b border-slate-700">
              <div className="flex items-center gap-3">
                <Monitor className="w-5 h-5 text-cyan-400" />
                <div>
                  <h2 className="font-semibold text-lg">Agent Screen View</h2>
                  <p className="text-xs text-slate-400">{status}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 bg-slate-900/50 rounded-lg p-1">
                  <button
                    onClick={() => setScreenZoom(Math.max(50, screenZoom - 10))}
                    className="p-2 hover:bg-slate-700 rounded transition-colors"
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <span className="px-3 text-sm font-medium">{screenZoom}%</span>
                  <button
                    onClick={() => setScreenZoom(Math.min(150, screenZoom + 10))}
                    className="p-2 hover:bg-slate-700 rounded transition-colors"
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                </div>
                <button
                  onClick={() => setScreenZoom(100)}
                  className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowVmScreen(!showVmScreen)}
                  className={`p-2 rounded-lg transition-colors ${
                    showVmScreen ? 'bg-cyan-600' : 'hover:bg-slate-700'
                  }`}
                >
                  {showVmScreen ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {showVmScreen && (
              <div className="p-6 bg-slate-900 overflow-auto">
                <div
                  className="bg-slate-800 rounded-lg overflow-hidden shadow-2xl mx-auto transition-transform"
                  style={{
                    transform: `scale(${screenZoom / 100})`,
                    transformOrigin: 'top center',
                    maxWidth: '1400px',
                  }}
                >
                  {!guacBase ? (
                    <div className="flex h-[600px] items-center justify-center text-red-400">
                      Missing NEXT_PUBLIC_GUAC_BASE_URL
                    </div>
                  ) : iframeSrc ? (
                    <iframe
                      src={iframeSrc}
                      width="100%"
                      height={650}
                      style={{ border: 'none' }}
                      allow="display-capture; fullscreen; microphone; camera; clipboard-write"
                      allowFullScreen
                    />
                  ) : (
                    <div
                      className="w-full bg-slate-800 flex items-center justify-center text-slate-500"
                      style={{ height: '650px' }}
                    >
                      <div className="flex flex-col items-center gap-3">
                        <Loader2 className="w-6 h-6 animate-spin text-cyan-400" />
                        <span>Waiting for connection...</span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-4 flex items-center justify-center gap-3 text-sm text-slate-400">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-cyan-500 rounded-full animate-pulse"></div>
                    <span>Agent is working on SAP automation</span>
                  </div>
                </div>
              </div>
            )}

            {!showVmScreen && (
              <div className="flex-1 flex items-center justify-center text-slate-400 py-20">
                <div className="text-center">
                  <EyeOff className="w-12 h-12 mx-auto mb-3 opacity-70" />
                  <p className="text-slate-300">Screen hidden</p>
                  <button
                    onClick={() => setShowVmScreen(true)}
                    className="mt-2 text-cyan-400 hover:text-cyan-300"
                  >
                    Click to show
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input Modal */}
      {showInputModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-6">
          <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-auto">
            <div className="flex items-center justify-between p-6 border-b border-slate-700 sticky top-0 bg-slate-800 z-10">
              <div>
                <h2 className="text-xl font-semibold">
                  {inputType === 'new-po'
                    ? 'Create New Purchase Order'
                    : inputType === 'new-so'
                    ? 'Add Sales Order'
                    : inputType === 'so-details'
                    ? 'Sales Order Details Required'
                    : 'Shipment Details Required'}
                </h2>
                <p className="text-sm text-slate-400 mt-1">
                  {inputType === 'new-po'
                    ? 'Enter PO details and add multiple Sales Orders'
                    : inputType === 'new-so'
                    ? `Add a new Sales Order to ${selectedPO?.poNumber || 'PO'}`
                    : inputType === 'so-details'
                    ? `Provide details for ${selectedSO?.soNumber} to continue workflow`
                    : `Provide shipment details for invoice ${selectedInvoice?.invoiceNumber}`}
                </p>
              </div>
              <button
                onClick={() => setShowInputModal(false)}
                className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6">
              {inputType === 'new-po' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">PO Number *</label>
                    <input
                      type="text"
                      value={newPOForm.poNumber}
                      onChange={(e) => setNewPOForm({ ...newPOForm, poNumber: e.target.value })}
                      placeholder="e.g., PO-2024-002"
                      className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                    />
                  </div>

                  <div className="border-t border-slate-700 pt-4 mt-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-base font-semibold text-slate-200">Sales Orders</h3>
                      <button
                        type="button"
                        onClick={() => setNewPOSOs([...newPOSOs, {
                          id: newPOSOs.length + 1,
                          customerName: '',
                          soNumbers: [''],
                          weight: '',
                          containerType: '',
                          deliveryLocations: '',
                          vehicleNumber: '',
                          driverMobile: '',
                          containerNumber: '',
                          sealNumber: '',
                          specialInstructions: '',
                        }])}
                        className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-700 rounded text-sm flex items-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add SO
                      </button>
                    </div>

                    <div className="space-y-4 max-h-[50vh] overflow-y-auto">
                      {newPOSOs.map((so, index) => (
                        <div key={so.id} className="border border-slate-700 rounded-lg p-4 bg-slate-900/50">
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="text-sm font-medium text-cyan-400">SO #{index + 1}</h4>
                            {newPOSOs.length > 1 && (
                              <button
                                type="button"
                                onClick={() => setNewPOSOs(newPOSOs.filter(s => s.id !== so.id))}
                                className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-red-400"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            )}
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <div className="col-span-2">
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Customer Name *</label>
                              <input
                                type="text"
                                value={so.customerName}
                                onChange={(e) => setNewPOSOs(newPOSOs.map(s => s.id === so.id ? { ...s, customerName: e.target.value } : s))}
                                placeholder="e.g., Maa Vaishnav Marble"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div className="col-span-2">
                              <div className="flex items-center justify-between mb-1.5">
                                <label className="block text-xs font-medium text-slate-400">SO Number *</label>
                                <button
                                  type="button"
                                  onClick={() => setNewPOSOs(newPOSOs.map(s => s.id === so.id ? { ...s, soNumbers: [...s.soNumbers, ''] } : s))}
                                  className="p-1 bg-cyan-600 hover:bg-cyan-700 rounded text-white"
                                  title="Add another SO number"
                                >
                                  <Plus className="w-3 h-3" />
                                </button>
                              </div>
                              <div className="space-y-2">
                                {so.soNumbers.map((soNum, soNumIndex) => (
                                  <div key={soNumIndex} className="flex items-center gap-2">
                                    <input
                                      type="text"
                                      value={soNum}
                                      onChange={(e) => setNewPOSOs(newPOSOs.map(s => s.id === so.id ? {
                                        ...s,
                                        soNumbers: s.soNumbers.map((n, i) => i === soNumIndex ? e.target.value : n)
                                      } : s))}
                                      placeholder="e.g., 3313383"
                                      className="flex-1 px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                                    />
                                    {so.soNumbers.length > 1 && (
                                      <button
                                        type="button"
                                        onClick={() => setNewPOSOs(newPOSOs.map(s => s.id === so.id ? {
                                          ...s,
                                          soNumbers: s.soNumbers.filter((_, i) => i !== soNumIndex)
                                        } : s))}
                                        className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-red-400"
                                        title="Remove this SO number"
                                      >
                                        <X className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Weight (Tons) *</label>
                              <input
                                type="number"
                                value={so.weight}
                                onChange={(e) => setNewPOSOs(newPOSOs.map(s => s.id === so.id ? { ...s, weight: e.target.value } : s))}
                                placeholder="e.g., 31"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Container Type *</label>
                              <select
                                value={so.containerType}
                                onChange={(e) => setNewPOSOs(newPOSOs.map(s => s.id === so.id ? { ...s, containerType: e.target.value } : s))}
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              >
                                <option value="">Select type...</option>
                                <option value="standard">Standard Height</option>
                                <option value="low">Low Height Container</option>
                              </select>
                            </div>

                            <div className="col-span-2">
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Delivery Locations *</label>
                              <textarea
                                rows={2}
                                value={so.deliveryLocations}
                                onChange={(e) => setNewPOSOs(newPOSOs.map(s => s.id === so.id ? { ...s, deliveryLocations: e.target.value } : s))}
                                placeholder="1) Location 1&#10;2) Location 2"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none font-mono"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Vehicle Number *</label>
                              <input
                                type="text"
                                value={so.vehicleNumber}
                                onChange={(e) => setNewPOSOs(newPOSOs.map(s => s.id === so.id ? { ...s, vehicleNumber: e.target.value } : s))}
                                placeholder="e.g., GJ12AZ6734"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Driver Mobile *</label>
                              <input
                                type="tel"
                                value={so.driverMobile}
                                onChange={(e) => setNewPOSOs(newPOSOs.map(s => s.id === so.id ? { ...s, driverMobile: e.target.value } : s))}
                                placeholder="e.g., 6352484019"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Container Number</label>
                              <input
                                type="text"
                                value={so.containerNumber}
                                onChange={(e) => setNewPOSOs(newPOSOs.map(s => s.id === so.id ? { ...s, containerNumber: e.target.value } : s))}
                                placeholder="e.g., ILKU1600857"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Seal Number</label>
                              <input
                                type="text"
                                value={so.sealNumber}
                                onChange={(e) => setNewPOSOs(newPOSOs.map(s => s.id === so.id ? { ...s, sealNumber: e.target.value } : s))}
                                placeholder="e.g., 30763"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div className="col-span-2">
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Special Instructions</label>
                              <textarea
                                rows={2}
                                value={so.specialInstructions}
                                onChange={(e) => setNewPOSOs(newPOSOs.map(s => s.id === so.id ? { ...s, specialInstructions: e.target.value } : s))}
                                placeholder="Any special notes..."
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {inputType === 'new-so' && (
                <div className="border border-slate-700 rounded-lg p-4 bg-slate-900/50">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-slate-400 mb-1.5">Customer Name *</label>
                      <input
                        type="text"
                        value={newSOForm.transportId}
                        onChange={(e) => setNewSOForm({ ...newSOForm, transportId: e.target.value })}
                        placeholder="e.g., Maa Vaishnav Marble"
                        className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-slate-400 mb-1.5">SO Number *</label>
                      <input
                        type="text"
                        value={newSOForm.soNumber}
                        onChange={(e) => setNewSOForm({ ...newSOForm, soNumber: e.target.value })}
                        placeholder="e.g., 3313383/3313381/3313385"
                        className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1.5">Weight (Tons) *</label>
                      <input
                        type="number"
                        value={newSOForm.weight}
                        onChange={(e) => setNewSOForm({ ...newSOForm, weight: e.target.value })}
                        placeholder="e.g., 31"
                        className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1.5">Container Type *</label>
                      <select
                        value={newSOForm.containerType}
                        onChange={(e) => setNewSOForm({ ...newSOForm, containerType: e.target.value })}
                        className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      >
                        <option value="">Select type...</option>
                        <option value="standard">Standard Height</option>
                        <option value="low">Low Height Container</option>
                      </select>
                    </div>

                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-slate-400 mb-1.5">Delivery Locations *</label>
                      <textarea
                        rows={2}
                        value={newSOForm.deliveryLocations}
                        onChange={(e) => setNewSOForm({ ...newSOForm, deliveryLocations: e.target.value })}
                        placeholder="1) Location 1&#10;2) Location 2"
                        className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none font-mono"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1.5">Vehicle Number *</label>
                      <input
                        type="text"
                        value={newSOForm.vehicleNumber}
                        onChange={(e) => setNewSOForm({ ...newSOForm, vehicleNumber: e.target.value })}
                        placeholder="e.g., GJ12AZ6734"
                        className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1.5">Driver Mobile *</label>
                      <input
                        type="tel"
                        value={newSOForm.driverMobile}
                        onChange={(e) => setNewSOForm({ ...newSOForm, driverMobile: e.target.value })}
                        placeholder="e.g., 6352484019"
                        className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1.5">Container Number</label>
                      <input
                        type="text"
                        value={newSOForm.containerNumber}
                        onChange={(e) => setNewSOForm({ ...newSOForm, containerNumber: e.target.value })}
                        placeholder="e.g., ILKU1600857"
                        className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1.5">Seal Number</label>
                      <input
                        type="text"
                        value={newSOForm.sealNumber}
                        onChange={(e) => setNewSOForm({ ...newSOForm, sealNumber: e.target.value })}
                        placeholder="e.g., 30763"
                        className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-slate-400 mb-1.5">Special Instructions</label>
                      <textarea
                        rows={2}
                        value={newSOForm.specialInstructions}
                        onChange={(e) => setNewSOForm({ ...newSOForm, specialInstructions: e.target.value })}
                        placeholder="Any special notes..."
                        className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}

              {inputType === 'so-details' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Vehicle Number *
                      </label>
                      <input
                        type="text"
                        value={soDetailsForm.vehicleNumber}
                        onChange={(e) =>
                          setSODetailsForm({ ...soDetailsForm, vehicleNumber: e.target.value })
                        }
                        placeholder="e.g., GJ12AZ6734"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Driver Mobile *
                      </label>
                      <input
                        type="tel"
                        value={soDetailsForm.driverMobile}
                        onChange={(e) =>
                          setSODetailsForm({ ...soDetailsForm, driverMobile: e.target.value })
                        }
                        placeholder="e.g., 6352484019"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Container Number
                      </label>
                      <input
                        type="text"
                        value={soDetailsForm.containerNumber}
                        onChange={(e) =>
                          setSODetailsForm({ ...soDetailsForm, containerNumber: e.target.value })
                        }
                        placeholder="e.g., ILKU1600857"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Seal Number
                      </label>
                      <input
                        type="text"
                        value={soDetailsForm.sealNumber}
                        onChange={(e) =>
                          setSODetailsForm({ ...soDetailsForm, sealNumber: e.target.value })
                        }
                        placeholder="e.g., 30763"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Weight (Tons)
                      </label>
                      <input
                        type="number"
                        value={soDetailsForm.weight}
                        onChange={(e) =>
                          setSODetailsForm({ ...soDetailsForm, weight: e.target.value })
                        }
                        placeholder="e.g., 31"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Container Type
                      </label>
                      <select
                        value={soDetailsForm.containerType}
                        onChange={(e) =>
                          setSODetailsForm({ ...soDetailsForm, containerType: e.target.value })
                        }
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      >
                        <option value="">Select type...</option>
                        <option value="standard">Standard Height</option>
                        <option value="low">Low Height Container</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Delivery Locations
                      </label>
                      <textarea
                        rows={3}
                        value={soDetailsForm.deliveryLocations}
                        onChange={(e) =>
                          setSODetailsForm({ ...soDetailsForm, deliveryLocations: e.target.value })
                        }
                        placeholder="Enter delivery locations..."
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Special Instructions
                      </label>
                      <textarea
                        rows={2}
                        value={soDetailsForm.specialInstructions}
                        onChange={(e) =>
                          setSODetailsForm({
                            ...soDetailsForm,
                            specialInstructions: e.target.value,
                          })
                        }
                        placeholder="Any special notes..."
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}

              {inputType === 'shipment-details' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        LR Number *
                      </label>
                      <input
                        type="text"
                        value={shipmentForm.lrNumber}
                        onChange={(e) =>
                          setShipmentForm({ ...shipmentForm, lrNumber: e.target.value })
                        }
                        placeholder="e.g., LR-2024-5678"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        LR Date *
                      </label>
                      <input
                        type="date"
                        value={shipmentForm.lrDate}
                        onChange={(e) =>
                          setShipmentForm({ ...shipmentForm, lrDate: e.target.value })
                        }
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Vehicle Number *
                      </label>
                      <input
                        type="text"
                        value={shipmentForm.vehicleNumber}
                        onChange={(e) =>
                          setShipmentForm({ ...shipmentForm, vehicleNumber: e.target.value })
                        }
                        placeholder="e.g., MH-12-XY-5678"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Shipment Type *
                      </label>
                      <select
                        value={shipmentForm.shipmentType}
                        onChange={(e) =>
                          setShipmentForm({ ...shipmentForm, shipmentType: e.target.value })
                        }
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      >
                        <option value="">Select type...</option>
                        <option value="road">Road</option>
                        <option value="rail">Rail</option>
                        <option value="air">Air</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Plant Code *
                      </label>
                      <input
                        type="text"
                        value={shipmentForm.plantCode}
                        onChange={(e) =>
                          setShipmentForm({ ...shipmentForm, plantCode: e.target.value })
                        }
                        placeholder="e.g., PLT-001"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">
                        Additional Notes
                      </label>
                      <textarea
                        rows={2}
                        value={shipmentForm.notes}
                        onChange={(e) =>
                          setShipmentForm({ ...shipmentForm, notes: e.target.value })
                        }
                        placeholder="Any special shipment instructions..."
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="bg-blue-900/20 border border-blue-700/50 rounded-lg p-3 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-blue-300">
                      <p className="font-medium">Stage 5 - Shipment Creation:</p>
                      <p className="mt-1">
                        After submitting, agent will execute VA02, VTO1N, and VF02 transactions to
                        create shipment document.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => setShowInputModal(false)}
                  className="flex-1 px-4 py-2.5 bg-slate-700 hover:bg-slate-600 rounded-lg font-medium transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (inputType === 'new-po') handleCreatePO();
                    else if (inputType === 'new-so') handleCreateSO();
                    else if (inputType === 'so-details') handleUpdateSO();
                    else handleUpdateShipment();
                  }}
                  className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 rounded-lg font-medium transition-all flex items-center justify-center gap-2"
                >
                  <Save className="w-4 h-4" />
                  {inputType === 'new-po' ? 'Create PO & Start Workflow' : inputType === 'new-so' ? 'Create SO' : 'Submit & Continue'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Status Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-slate-800/90 backdrop-blur border-t border-slate-700 px-6 py-3 z-40">
        <div className="max-w-[1920px] mx-auto flex items-center justify-between text-sm">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
              <span>System Active</span>
            </div>
            <span className="text-slate-400">
              Processing: {purchaseOrders[0]?.poNumber || 'None'}
            </span>
            <span className="text-slate-400">
              Current Stage: {purchaseOrders[0]?.stage || 1}/6
            </span>
          </div>
          <div className="flex items-center gap-6 text-slate-400">
            <span>
              Active POs: <span className="text-cyan-400 font-semibold">{purchaseOrders.length}</span>
            </span>
            <span>
              Total SOs: <span className="text-cyan-400 font-semibold">{totalSOs}</span>
            </span>
            <span>
              Invoices Created:{' '}
              <span className="text-purple-400 font-semibold">{totalInvoices}</span>
            </span>
            <span>
              Pending Inputs:{' '}
              <span className="text-orange-400 font-semibold">{pendingInputs}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
