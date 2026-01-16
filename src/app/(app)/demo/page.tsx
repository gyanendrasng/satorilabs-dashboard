'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  Play, Pause, AlertCircle, CheckCircle2, Clock, FileText, Package,
  Send, Bot, User, Monitor, Eye, EyeOff, RotateCcw, ZoomIn, ZoomOut,
  ChevronDown, ChevronRight, Edit, Plus, Save, X, MessageSquare, Layers
} from 'lucide-react';

interface LoadingSheet {
  id: string;
  number: string;
  status: string;
}

interface Invoice {
  id: string;
  number: string;
  status: string;
  amount: string;
  requiresInput: boolean;
}

interface SalesOrder {
  id: string;
  number: string;
  status: string;
  requiresInput: boolean;
  expanded: boolean;
  loadingSheets: LoadingSheet[];
  invoices: Invoice[];
}

interface PurchaseOrder {
  id: string;
  number: string;
  status: string;
  stage: number;
  expanded: boolean;
  salesOrders: SalesOrder[];
}

interface ChatMessage {
  id: number;
  sender: 'agent' | 'user';
  text: string;
  timestamp: string;
}

const SAPWorkflowDashboard = () => {
  // Active tab state
  const [activeTab, setActiveTab] = useState<'hierarchy' | 'chat' | 'screen'>('hierarchy');

  // State for hierarchy data - Invoices now at SO level
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([
    {
      id: 'PO1',
      number: 'PO-2024-001',
      status: 'in-progress',
      stage: 4,
      expanded: true,
      salesOrders: [
        {
          id: 'SO11',
          number: 'SO11',
          status: 'completed',
          requiresInput: false,
          expanded: true,
          loadingSheets: [
            { id: 'LS111', number: 'LS111', status: 'completed' },
            { id: 'LS112', number: 'LS112', status: 'completed' },
            { id: 'LS113', number: 'LS113', status: 'completed' }
          ],
          invoices: [
            { id: 'IN11', number: 'IN11', status: 'created', amount: '₹23,500', requiresInput: false }
          ]
        },
        {
          id: 'SO12',
          number: 'SO12',
          status: 'in-progress',
          requiresInput: false,
          expanded: true,
          loadingSheets: [
            { id: 'LS121', number: 'LS121', status: 'completed' },
            { id: 'LS122', number: 'LS122', status: 'in-progress' }
          ],
          invoices: [
            { id: 'IN12', number: 'IN12', status: 'created', amount: '₹18,750', requiresInput: true }
          ]
        },
        {
          id: 'SO13',
          number: 'SO13',
          status: 'pending-input',
          requiresInput: true,
          expanded: false,
          loadingSheets: [
            { id: 'LS131', number: 'LS131', status: 'pending' }
          ],
          invoices: [
            { id: 'IN13', number: 'IN13', status: 'pending', amount: '-', requiresInput: false }
          ]
        },
        {
          id: 'SO14',
          number: 'SO14',
          status: 'pending',
          requiresInput: false,
          expanded: false,
          loadingSheets: [
            { id: 'LS141', number: 'LS141', status: 'pending' }
          ],
          invoices: [
            { id: 'IN14', number: 'IN14', status: 'pending', amount: '-', requiresInput: false }
          ]
        }
      ]
    }
  ]);

  const [showInputModal, setShowInputModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState<SalesOrder | Invoice | null>(null);
  const [inputType, setInputType] = useState(''); // 'new-po', 'so-details' or 'invoice-details'
  const [newPOSOs, setNewPOSOs] = useState([1]); // Track multiple SOs being added to new PO

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      sender: 'agent',
      text: 'Hello! I\'m processing PO-2024-001. Currently at Stage 4.',
      timestamp: '10:45 AM'
    },
    {
      id: 2,
      sender: 'agent',
      text: 'SO11 completed. Invoice IN11 created successfully.',
      timestamp: '10:52 AM'
    },
    {
      id: 3,
      sender: 'agent',
      text: '⚠️ Input required: SO13 needs vehicle and delivery details to proceed.',
      timestamp: '10:55 AM'
    },
    {
      id: 4,
      sender: 'agent',
      text: '⚠️ Input required: Invoice IN12 needs LR details for shipment creation.',
      timestamp: '10:57 AM'
    }
  ]);
  const [inputMessage, setInputMessage] = useState('');
  const [showAgentScreen, setShowAgentScreen] = useState(true);
  const [screenZoom, setScreenZoom] = useState(100);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Stage configuration
  const stages = [
    { id: 1, title: 'Order Details Received', status: 'completed', color: 'emerald' },
    { id: 2, title: 'Email Sent to Plant', status: 'completed', color: 'blue' },
    { id: 3, title: 'Email Received from Plant', status: 'completed', color: 'indigo' },
    { id: 4, title: 'HRJ Invoice Created', status: 'in-progress', color: 'amber' },
    { id: 5, title: 'Shipment Details Created', status: 'pending', color: 'purple' }
  ];

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chatMessages]);

  const handleSendMessage = () => {
    if (inputMessage.trim() === '') return;

    const newMessage: ChatMessage = {
      id: chatMessages.length + 1,
      sender: 'user',
      text: inputMessage,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    };

    setChatMessages([...chatMessages, newMessage]);
    setInputMessage('');

    setTimeout(() => {
      const agentResponse: ChatMessage = {
        id: chatMessages.length + 2,
        sender: 'agent',
        text: 'I understand. Let me check the current status and get back to you.',
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      };
      setChatMessages(prev => [...prev, agentResponse]);
    }, 1000);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const togglePO = (poId: string) => {
    setPurchaseOrders(prev => prev.map(po =>
      po.id === poId ? { ...po, expanded: !po.expanded } : po
    ));
  };

  const toggleSO = (poId: string, soId: string) => {
    setPurchaseOrders(prev => prev.map(po =>
      po.id === poId ? {
        ...po,
        salesOrders: po.salesOrders.map(so =>
          so.id === soId ? { ...so, expanded: !so.expanded } : so
        )
      } : po
    ));
  };

  const openInputModal = (type: string, item: SalesOrder | Invoice) => {
    setInputType(type);
    setSelectedItem(item);
    setShowInputModal(true);
  };

  const getStatusBadge = (status: string, requiresInput = false) => {
    if (requiresInput) {
      return <span className="px-2 py-1 bg-orange-600 text-white text-xs rounded-full flex items-center gap-1">
        <AlertCircle className="w-3 h-3" />
        Input Required
      </span>;
    }

    const configs: Record<string, { bg: string; text: string; icon: React.ElementType }> = {
      'completed': { bg: 'bg-emerald-600', text: 'Completed', icon: CheckCircle2 },
      'in-progress': { bg: 'bg-blue-600', text: 'In Progress', icon: Clock },
      'pending': { bg: 'bg-slate-600', text: 'Pending', icon: Clock },
      'created': { bg: 'bg-purple-600', text: 'Created', icon: FileText },
      'pending-input': { bg: 'bg-orange-600', text: 'Needs Input', icon: AlertCircle }
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-slate-100">
      {/* Header */}
      <div className="border-b border-slate-700 bg-slate-800/50 backdrop-blur">
        <div className="max-w-[1920px] mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
                SAP Workflow Automation Dashboard
              </h1>
              <p className="text-slate-400 text-sm mt-1">Purchase Order → Sales Order → Loading Sheet → Invoice Management</p>
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

          {/* Stage Progress Bar */}
          <div className="mt-4 flex items-center gap-2">
            {stages.map((stage, index) => (
              <React.Fragment key={stage.id}>
                <div className="flex items-center gap-2">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    stage.status === 'completed' ? 'bg-emerald-600' :
                    stage.status === 'in-progress' ? 'bg-blue-600 animate-pulse' :
                    'bg-slate-700'
                  }`}>
                    {stage.id}
                  </div>
                  <span className="text-xs text-slate-300 hidden lg:block">{stage.title}</span>
                </div>
                {index < stages.length - 1 && (
                  <div className={`flex-1 h-1 rounded ${
                    stage.status === 'completed' ? 'bg-emerald-600' : 'bg-slate-700'
                  }`}></div>
                )}
              </React.Fragment>
            ))}
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
              {chatMessages.length > 0 && (
                <span className="px-2 py-0.5 bg-cyan-600 text-white text-xs rounded-full">
                  {chatMessages.length}
                </span>
              )}
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

        {/* Tab Content */}
        {activeTab === 'hierarchy' && (
          <div className="bg-slate-800/50 backdrop-blur rounded-xl border border-slate-700 shadow-xl p-6" style={{ minHeight: 'calc(100vh - 340px)' }}>
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
                  onClick={() => {
                    setInputType('new-po');
                    setShowInputModal(true);
                  }}
                  className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm flex items-center gap-2 font-medium"
                >
                  <Plus className="w-4 h-4" />
                  New PO
                </button>
              </div>
            </div>

            <div className="space-y-4">
              {purchaseOrders.map(po => (
                <div key={po.id} className="border border-slate-700 rounded-lg overflow-hidden">
                  {/* PO Level */}
                  <div
                    className="bg-emerald-900/30 border-l-4 border-emerald-500 p-4 cursor-pointer hover:bg-emerald-900/40 transition-colors"
                    onClick={() => togglePO(po.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {po.expanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                        <div>
                          <div className="flex items-center gap-3">
                            <span className="font-semibold text-lg">{po.number}</span>
                            {getStatusBadge(po.status)}
                            <span className="text-xs bg-slate-700 px-2 py-1 rounded">Stage {po.stage}/5</span>
                          </div>
                          <p className="text-xs text-slate-400 mt-1">Purchase Order</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-slate-400">
                        <span>{po.salesOrders.length} Sales Orders</span>
                        <span>•</span>
                        <span>{po.salesOrders.reduce((acc, so) => acc + so.loadingSheets.length, 0)} Loading Sheets</span>
                        <span>•</span>
                        <span>{po.salesOrders.reduce((acc, so) => acc + so.invoices.length, 0)} Invoices</span>
                      </div>
                    </div>
                  </div>

                  {/* SO Level */}
                  {po.expanded && (
                    <div className="bg-slate-800/50 p-4 space-y-3">
                      {po.salesOrders.map(so => (
                        <div key={so.id} className="border border-slate-600 rounded-lg overflow-hidden">
                          <div
                            className="bg-cyan-900/30 border-l-4 border-cyan-500 p-3 cursor-pointer hover:bg-cyan-900/40 transition-colors"
                            onClick={() => toggleSO(po.id, so.id)}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3 flex-1">
                                {so.expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-semibold text-base">{so.number}</span>
                                    {getStatusBadge(so.status, so.requiresInput)}
                                    <span className="text-xs text-slate-400">
                                      {so.loadingSheets.length} LS • {so.invoices.length} Invoice
                                    </span>
                                  </div>
                                  <p className="text-xs text-slate-400 mt-0.5">Sales Order</p>
                                </div>
                              </div>
                              {so.requiresInput && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openInputModal('so-details', so);
                                  }}
                                  className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 rounded text-sm flex items-center gap-1.5 ml-2"
                                >
                                  <Edit className="w-3.5 h-3.5" />
                                  Provide Input
                                </button>
                              )}
                            </div>
                          </div>

                          {/* LS and Invoice Level - Side by Side with Section Headers */}
                          {so.expanded && (
                            <div className="bg-slate-900/50 p-4">
                              <div className="grid grid-cols-2 gap-4">
                                {/* Loading Sheets Column */}
                                <div>
                                  <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-700">
                                    <FileText className="w-4 h-4 text-slate-400" />
                                    <h4 className="text-sm font-semibold text-slate-300">
                                      Loading Sheets ({so.loadingSheets.length})
                                    </h4>
                                  </div>
                                  <div className="space-y-2">
                                    {so.loadingSheets.map(ls => (
                                      <div key={ls.id} className="bg-slate-800/70 p-3 rounded border border-slate-700 flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                          <FileText className="w-4 h-4 text-slate-400" />
                                          <span className="text-sm font-medium">{ls.number}</span>
                                        </div>
                                        {getStatusBadge(ls.status)}
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                {/* Invoices Column */}
                                <div>
                                  <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-700">
                                    <Package className="w-4 h-4 text-purple-400" />
                                    <h4 className="text-sm font-semibold text-slate-300">
                                      Invoices ({so.invoices.length})
                                    </h4>
                                  </div>
                                  <div className="space-y-2">
                                    {so.invoices.map(inv => (
                                      <div key={inv.id} className="bg-purple-900/20 border border-purple-700/50 p-3 rounded">
                                        <div className="flex items-center justify-between mb-2">
                                          <div className="flex items-center gap-2">
                                            <Package className="w-4 h-4 text-purple-400" />
                                            <span className="text-sm font-medium">{inv.number}</span>
                                          </div>
                                          {getStatusBadge(inv.status, inv.requiresInput)}
                                        </div>
                                        <div className="flex items-center justify-between text-sm mb-2">
                                          <span className="text-slate-400">Amount:</span>
                                          <span className="font-semibold text-purple-300">{inv.amount}</span>
                                        </div>
                                        {inv.requiresInput && (
                                          <button
                                            onClick={() => openInputModal('invoice-details', inv)}
                                            className="w-full px-3 py-2 bg-orange-600 hover:bg-orange-700 rounded text-sm flex items-center justify-center gap-1.5"
                                          >
                                            <Edit className="w-3.5 h-3.5" />
                                            Provide Shipment Details
                                          </button>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'chat' && (
          <div className="bg-slate-800/50 backdrop-blur rounded-xl border border-slate-700 shadow-xl flex flex-col" style={{ height: 'calc(100vh - 340px)' }}>
            <div className="flex items-center justify-between p-4 border-b border-slate-700">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Bot className="w-6 h-6 text-cyan-400" />
                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 rounded-full border-2 border-slate-800"></div>
                </div>
                <div>
                  <h2 className="font-semibold text-lg">AI Agent Communication</h2>
                  <p className="text-xs text-slate-400">Active & Monitoring Workflow</p>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {chatMessages.map((message) => (
                <div key={message.id} className={`flex gap-3 ${message.sender === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                  <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                    message.sender === 'agent' ? 'bg-cyan-600' : 'bg-blue-600'
                  }`}>
                    {message.sender === 'agent' ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
                  </div>
                  <div className={`flex flex-col ${message.sender === 'user' ? 'items-end' : 'items-start'} max-w-[70%]`}>
                    <div className={`rounded-2xl px-4 py-2.5 ${
                      message.sender === 'agent' ? 'bg-slate-700 text-slate-100' : 'bg-blue-600 text-white'
                    }`}>
                      <p className="text-sm leading-relaxed">{message.text}</p>
                    </div>
                    <span className="text-xs text-slate-500 mt-1 px-2">{message.timestamp}</span>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            <div className="p-4 border-t border-slate-700">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Ask the agent anything..."
                  className="flex-1 bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                />
                <button onClick={handleSendMessage} className="px-4 py-2.5 bg-cyan-600 hover:bg-cyan-700 rounded-lg">
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-2">Press Enter to send, Shift+Enter for new line</p>
            </div>
          </div>
        )}

        {activeTab === 'screen' && (
          <div className="bg-slate-800/50 backdrop-blur rounded-xl border border-slate-700 shadow-xl overflow-hidden" style={{ minHeight: 'calc(100vh - 340px)' }}>
            <div className="flex items-center justify-between p-4 border-b border-slate-700">
              <div className="flex items-center gap-3">
                <Monitor className="w-5 h-5 text-cyan-400" />
                <div>
                  <h2 className="font-semibold text-lg">Agent Screen View</h2>
                  <p className="text-xs text-slate-400">Real-time SAP GUI automation</p>
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
                  onClick={() => setShowAgentScreen(!showAgentScreen)}
                  className={`p-2 rounded-lg transition-colors ${showAgentScreen ? 'bg-cyan-600' : 'hover:bg-slate-700'}`}
                >
                  {showAgentScreen ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {showAgentScreen && (
              <div className="p-6 bg-slate-900">
                <div
                  className="bg-white rounded-lg overflow-hidden shadow-2xl mx-auto transition-transform"
                  style={{
                    transform: `scale(${screenZoom / 100})`,
                    transformOrigin: 'top center',
                    maxWidth: '1400px'
                  }}
                >
                  <div className="bg-gradient-to-b from-blue-50 to-white">
                    {/* SAP Menu Bar */}
                    <div className="bg-blue-600 text-white px-3 py-1.5 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-4">
                        <span className="font-semibold">SAP</span>
                        <span>System</span>
                        <span>Help</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="bg-blue-700 px-2 py-0.5 rounded">ZMRKO</span>
                        <span>User: AUTOMATION_AGENT</span>
                      </div>
                    </div>

                    {/* SAP Toolbar */}
                    <div className="bg-slate-100 border-b border-slate-300 px-3 py-2 flex items-center gap-2">
                      <button className="px-3 py-1 bg-white border border-slate-300 rounded text-xs hover:bg-slate-50">Save</button>
                      <button className="px-3 py-1 bg-white border border-slate-300 rounded text-xs hover:bg-slate-50">Back</button>
                      <button className="px-3 py-1 bg-white border border-slate-300 rounded text-xs hover:bg-slate-50">Exit</button>
                      <div className="w-px h-6 bg-slate-300 mx-2"></div>
                      <button className="px-3 py-1 bg-emerald-600 text-white border border-emerald-700 rounded text-xs hover:bg-emerald-700">Execute</button>
                    </div>

                    {/* SAP Content - Invoice Matching */}
                    <div className="p-6">
                      <div className="mb-4">
                        <h3 className="text-lg font-semibold text-slate-800 mb-1">Invoice Matching - ZMRKO</h3>
                        <p className="text-xs text-slate-600">Match GRN with Plant Invoice Details</p>
                      </div>

                      <div className="space-y-4 max-w-4xl">
                        <div className="flex items-center gap-4">
                          <label className="w-40 text-sm text-slate-700 font-medium">SO Number:</label>
                          <div className="flex-1 relative">
                            <input
                              type="text"
                              value="SO12"
                              className="w-full px-3 py-2 border-2 border-blue-500 bg-yellow-50 rounded text-sm"
                              readOnly
                            />
                            <div className="absolute -right-8 top-2">
                              <div className="w-5 h-5 bg-cyan-500 rounded-full animate-pulse"></div>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-4">
                          <label className="w-40 text-sm text-slate-700 font-medium">Invoice Number:</label>
                          <input type="text" value="IN12" className="flex-1 px-3 py-2 border border-slate-300 rounded text-sm" readOnly />
                        </div>

                        <div className="flex items-center gap-4">
                          <label className="w-40 text-sm text-slate-700 font-medium">GRN Number:</label>
                          <input type="text" value="GRN-2024-456" className="flex-1 px-3 py-2 border border-slate-300 rounded text-sm" readOnly />
                        </div>

                        <div className="mt-6">
                          <h4 className="text-sm font-semibold text-slate-800 mb-2">Invoice Items Matching</h4>
                          <table className="w-full border border-slate-300 text-xs">
                            <thead className="bg-slate-200">
                              <tr>
                                <th className="border border-slate-300 px-2 py-1.5 text-left">Item</th>
                                <th className="border border-slate-300 px-2 py-1.5 text-left">Material</th>
                                <th className="border border-slate-300 px-2 py-1.5 text-right">GRN Amount</th>
                                <th className="border border-slate-300 px-2 py-1.5 text-right">Invoice Amount</th>
                                <th className="border border-slate-300 px-2 py-1.5 text-center">Match</th>
                              </tr>
                            </thead>
                            <tbody className="bg-white">
                              <tr>
                                <td className="border border-slate-300 px-2 py-1.5">001</td>
                                <td className="border border-slate-300 px-2 py-1.5">MAT-45678</td>
                                <td className="border border-slate-300 px-2 py-1.5 text-right">₹15,000</td>
                                <td className="border border-slate-300 px-2 py-1.5 text-right">₹15,000</td>
                                <td className="border border-slate-300 px-2 py-1.5 text-center">
                                  <span className="text-emerald-600 font-bold">✓</span>
                                </td>
                              </tr>
                              <tr>
                                <td className="border border-slate-300 px-2 py-1.5">002</td>
                                <td className="border border-slate-300 px-2 py-1.5">MAT-45679</td>
                                <td className="border border-slate-300 px-2 py-1.5 text-right">₹3,750</td>
                                <td className="border border-slate-300 px-2 py-1.5 text-right">₹3,750</td>
                                <td className="border border-slate-300 px-2 py-1.5 text-center">
                                  <span className="text-emerald-600 font-bold">✓</span>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>

                        <div className="mt-4 p-3 bg-emerald-50 border border-emerald-300 rounded-lg text-xs text-emerald-800">
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4" />
                            <span className="font-medium">All items matched successfully. Invoice IN12 created.</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* SAP Status Bar */}
                    <div className="bg-slate-700 text-white px-3 py-1 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-4">
                        <span>System: PRD</span>
                        <span>Client: 100</span>
                        <span>Transaction: ZMRKO</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-emerald-500 rounded-full"></div>
                        <span>Connected</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-center gap-3 text-sm text-slate-400">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-cyan-500 rounded-full animate-pulse"></div>
                    <span>Agent is matching invoice IN12 with GRN values</span>
                  </div>
                  <span className="text-slate-600">|</span>
                  <span>Stage 4 - Invoice Creation</span>
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
                  {inputType === 'new-po' ? 'Create New Purchase Order' :
                   inputType === 'so-details' ? 'Sales Order Details Required' :
                   'Invoice Shipment Details Required'}
                </h2>
                <p className="text-sm text-slate-400 mt-1">
                  {inputType === 'new-po'
                    ? 'Enter PO details and add multiple Sales Orders'
                    : inputType === 'so-details'
                    ? `Provide details for ${(selectedItem as SalesOrder)?.number} to continue workflow (Stage 1)`
                    : `Provide shipment details for ${(selectedItem as Invoice)?.number} (Stage 5)`
                  }
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
              {inputType === 'new-po' ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">PO Number *</label>
                    <input
                      type="text"
                      placeholder="e.g., PO-2024-002"
                      className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                    />
                  </div>

                  <div className="border-t border-slate-700 pt-4 mt-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-base font-semibold text-slate-200">Sales Orders</h3>
                      <button
                        onClick={() => setNewPOSOs([...newPOSOs, newPOSOs.length + 1])}
                        className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-700 rounded text-sm flex items-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add SO
                      </button>
                    </div>

                    <div className="space-y-4 max-h-[50vh] overflow-y-auto">
                      {newPOSOs.map((soIndex) => (
                        <div key={soIndex} className="border border-slate-700 rounded-lg p-4 bg-slate-900/50">
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="text-sm font-medium text-cyan-400">SO #{soIndex}</h4>
                            {newPOSOs.length > 1 && (
                              <button
                                onClick={() => setNewPOSOs(newPOSOs.filter(i => i !== soIndex))}
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
                                placeholder="e.g., Maa Vaishnav Marble"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div className="col-span-2">
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">SO Number *</label>
                              <input
                                type="text"
                                placeholder="e.g., 3313383/3313381/3313385"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Weight (Tons) *</label>
                              <input
                                type="number"
                                placeholder="e.g., 31"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Container Type *</label>
                              <select className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none">
                                <option value="">Select type...</option>
                                <option value="standard">Standard Height</option>
                                <option value="low">Low Height Container</option>
                              </select>
                            </div>

                            <div className="col-span-2">
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Delivery Locations *</label>
                              <textarea
                                rows={2}
                                placeholder="1) Location 1&#10;2) Location 2"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none font-mono"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Vehicle Number *</label>
                              <input
                                type="text"
                                placeholder="e.g., GJ12AZ6734"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Driver Mobile *</label>
                              <input
                                type="tel"
                                placeholder="e.g., 6352484019"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Container Number</label>
                              <input
                                type="text"
                                placeholder="e.g., ILKU1600857"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Seal Number</label>
                              <input
                                type="text"
                                placeholder="e.g., 30763"
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                              />
                            </div>

                            <div className="col-span-2">
                              <label className="block text-xs font-medium text-slate-400 mb-1.5">Special Instructions</label>
                              <textarea
                                rows={2}
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
              ) : inputType === 'so-details' ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">SO Number</label>
                      <input
                        type="text"
                        value={(selectedItem as SalesOrder)?.number || ''}
                        disabled
                        className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-slate-400"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">Customer Name *</label>
                      <input
                        type="text"
                        placeholder="e.g., Maa Vaishnav Marble"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">SO Number *</label>
                      <input
                        type="text"
                        placeholder="e.g., 3313383/3313381/3313385"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                      <p className="text-xs text-slate-500 mt-1">Separate multiple SO numbers with /</p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Weight (Tons) *</label>
                      <input
                        type="number"
                        placeholder="e.g., 31"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Container Type *</label>
                      <select className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none">
                        <option value="">Select type...</option>
                        <option value="standard">Standard Height</option>
                        <option value="low">Low Height Container</option>
                      </select>
                    </div>

                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">Delivery Locations *</label>
                      <textarea
                        rows={3}
                        placeholder="e.g.,&#10;1) Lonix Ceramics Sartanpar Road&#10;2) Leesun Ceramics Matel Road Johnson New Godown for tempo Crossing and bill change"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none font-mono text-sm"
                      />
                      <p className="text-xs text-slate-500 mt-1">Enter each location on a new line</p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Vehicle Number *</label>
                      <input
                        type="text"
                        placeholder="e.g., GJ12AZ6734"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Driver Mobile *</label>
                      <input
                        type="tel"
                        placeholder="e.g., 6352484019"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Container Number</label>
                      <input
                        type="text"
                        placeholder="e.g., ILKU1600857"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Seal Number</label>
                      <input
                        type="text"
                        placeholder="e.g., 30763"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">Special Instructions / Notes</label>
                      <textarea
                        rows={2}
                        placeholder="e.g., Note please confirm before sending the container due to multiple tempo Crossing"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="bg-amber-900/20 border border-amber-700/50 rounded-lg p-3 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-300">
                      <p className="font-medium">Important:</p>
                      <p className="mt-1">All fields marked with * are required. Confirm delivery locations before container dispatch.</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">Invoice Number</label>
                      <input
                        type="text"
                        value={(selectedItem as Invoice)?.number || ''}
                        disabled
                        className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-slate-400"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">LR Number *</label>
                      <input
                        type="text"
                        placeholder="e.g., LR-2024-5678"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">LR Date *</label>
                      <input
                        type="date"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Vehicle Number *</label>
                      <input
                        type="text"
                        placeholder="e.g., MH-12-XY-5678"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Shipment Type *</label>
                      <select className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none">
                        <option value="">Select type...</option>
                        <option value="road">Road</option>
                        <option value="rail">Rail</option>
                        <option value="air">Air</option>
                      </select>
                    </div>

                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">Plant Code *</label>
                      <input
                        type="text"
                        placeholder="e.g., PLT-001"
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">OBD Number</label>
                      <input
                        type="text"
                        placeholder="Auto-generated from VA02"
                        className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-slate-400"
                        disabled
                      />
                      <p className="text-xs text-slate-500 mt-1">This will be auto-filled by the agent</p>
                    </div>

                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-slate-300 mb-2">Additional Notes</label>
                      <textarea
                        rows={2}
                        placeholder="Any special shipment instructions..."
                        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="bg-blue-900/20 border border-blue-700/50 rounded-lg p-3 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-blue-300">
                      <p className="font-medium">Stage 5 - Shipment Creation:</p>
                      <p className="mt-1">After submitting, agent will execute VA02, VTO1N, and VF02 transactions to create shipment document.</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => {
                    setShowInputModal(false);
                    setNewPOSOs([1]); // Reset SO list
                  }}
                  className="flex-1 px-4 py-2.5 bg-slate-700 hover:bg-slate-600 rounded-lg font-medium transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setShowInputModal(false);
                    setNewPOSOs([1]); // Reset SO list
                    // Add logic to save data and notify agent
                  }}
                  className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 rounded-lg font-medium transition-all flex items-center justify-center gap-2"
                >
                  <Save className="w-4 h-4" />
                  {inputType === 'new-po' ? 'Create PO & Start Workflow' : 'Submit & Continue Workflow'}
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
            <span className="text-slate-400">Processing: PO-2024-001</span>
            <span className="text-slate-400">Current Stage: 4/5</span>
          </div>
          <div className="flex items-center gap-6 text-slate-400">
            <span>Active POs: <span className="text-cyan-400 font-semibold">1</span></span>
            <span>Total SOs: <span className="text-cyan-400 font-semibold">4</span></span>
            <span>Invoices Created: <span className="text-purple-400 font-semibold">2</span></span>
            <span>Pending Inputs: <span className="text-orange-400 font-semibold">2</span></span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default function DemoPage() {
  return <SAPWorkflowDashboard />;
}
