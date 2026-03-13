import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useGatewayStore } from '../store/gateway-store.js';
import { gateway } from '../gateway/client.js';
import {
  TrendingUp,
  Target,
  FileText,
  Users,
  BarChart3,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  Clock,
  Zap,
  Send,
  DollarSign,
  Search,
  Copy,
  Eye,
  Star,
  AlertCircle,
  Activity,
  Percent,
  Building2,
  AtSign,
  Database,
  Terminal,
  Cpu,
  Rocket,
  Table,
  ChevronLeft,
  Shield,
  Crosshair,
  Key,
  Save,
  EyeOff,
  BookOpen,
  Globe,
  Calendar,
  Hash,
  Image,
  Video,
  MessageCircle,
  Play,
  Clock as ClockIcon,
  Trash2,
  Plus,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────

interface KPIs {
  empty?: boolean;
  total_campaigns?: number;
  active_campaigns?: number;
  total_budget?: number;
  total_spent?: number;
  total_revenue?: number;
  avg_roi?: number;
  total_leads?: number;
  new_leads?: number;
  hot_leads?: number;
  total_content?: number;
  published_content?: number;
  total_trends?: number;
  actionable_trends?: number;
  total_competitors?: number;
  total_viral?: number;
  total_actions?: number;
  successful_actions?: number;
  active_agents?: number;
}

interface TableInfo {
  name: string;
  rows: number;
}

interface AgentStats {
  agent: string;
  total_actions: number;
  successful: number;
  last_action: string;
  last_description: string;
}

interface QueryResult {
  table: string;
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

type Tab = 'dashboard' | 'social' | 'campaigns' | 'content' | 'leads' | 'intel' | 'agents' | 'skills' | 'database' | 'api-keys';

// ─── Constants ───────────────────────────────────────────

const TABS: { id: Tab; label: string; icon: typeof TrendingUp }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: BarChart3 },
  { id: 'social', label: 'Social', icon: Globe },
  { id: 'campaigns', label: 'Campaigns', icon: Target },
  { id: 'content', label: 'Content', icon: FileText },
  { id: 'leads', label: 'Leads', icon: Users },
  { id: 'intel', label: 'Intel', icon: Eye },
  { id: 'agents', label: 'Agents', icon: Cpu },
  { id: 'skills', label: 'Skills', icon: BookOpen },
  { id: 'database', label: 'DB', icon: Database },
  { id: 'api-keys', label: 'API Keys', icon: Key },
];

interface Product {
  id: string;
  label: string;
  color: string;
  desc: string;
}

const DEFAULT_PRODUCTS: Product[] = [
  { id: 'okidooki', label: 'OKIDOOKI', color: '#f472b6', desc: 'Nightlife reimagined' },
  { id: 'nowtrust', label: 'NowTrust', color: '#3b82f6', desc: 'Trust & security platform' },
  { id: 'makeitfun', label: 'MakeItFun', color: '#f59e0b', desc: 'AI-powered merch & design' },
];

// Mutable products list — loaded from gateway, falls back to defaults
let PRODUCTS: Product[] = [...DEFAULT_PRODUCTS];

const QUICK_COMMANDS = [
  { id: 'sprint', emoji: '\u{1F680}', label: 'Full Sprint', cmd: 'full marketing sprint for all products', needsProduct: false },
  { id: 'research', emoji: '\u{1F50D}', label: 'Research Trends', cmd: 'research trends for {product}', needsProduct: true },
  { id: 'viral', emoji: '\u{1F525}', label: 'Find Viral', cmd: 'find viral content opportunities for all products', needsProduct: false },
  { id: 'plan', emoji: '\u{1F4C5}', label: 'Weekly Plan', cmd: 'create weekly marketing plan for all products', needsProduct: false },
  { id: 'leads', emoji: '\u{1F3AF}', label: 'Lead Hunt', cmd: 'hunt leads for {product}', needsProduct: true },
  { id: 'compete', emoji: '\u{1F50E}', label: 'Competitor Scan', cmd: 'scan competitors for {product}', needsProduct: true },
  { id: 'content', emoji: '\u{1F4DD}', label: 'Content Batch', cmd: 'generate content batch for {product}', needsProduct: true },
  { id: 'report', emoji: '\u{1F4CA}', label: 'Analytics Report', cmd: 'generate full analytics report', needsProduct: false },
  { id: 'audit', emoji: '\u{1F6E1}', label: 'Audit', cmd: 'run marketing audit for {product}', needsProduct: true },
];

const SUB_AGENTS = [
  { id: 'strategy', emoji: '\u{1F9E0}', name: 'Strategy', color: '#f472b6' },
  { id: 'growth', emoji: '\u{1F4E2}', name: 'Growth', color: '#10b981' },
  { id: 'sales', emoji: '\u{1F4BC}', name: 'Sales', color: '#3b82f6' },
  { id: 'conversion', emoji: '\u{1F3AF}', name: 'Conversion', color: '#f59e0b' },
  { id: 'leads', emoji: '\u{1F50D}', name: 'Leads', color: '#8b5cf6' },
  { id: 'data', emoji: '\u{1F4CA}', name: 'Data', color: '#06b6d4' },
  { id: 'reputation', emoji: '\u{1F6E1}', name: 'Reputation', color: '#64748b' },
  { id: 'chatbot', emoji: '\u{1F916}', name: 'Chatbot', color: '#ec4899' },
  { id: 'campaigns', emoji: '\u{2699}\u{FE0F}', name: 'Campaigns', color: '#ef4444' },
];

const LEAD_STATUSES = [
  { id: 'new', label: 'New', color: '#8b5cf6' },
  { id: 'contacted', label: 'Contacted', color: '#3b82f6' },
  { id: 'qualified', label: 'Qualified', color: '#06b6d4' },
  { id: 'proposal', label: 'Proposal', color: '#f59e0b' },
  { id: 'negotiation', label: 'Negotiation', color: '#f97316' },
  { id: 'closed_won', label: 'Won', color: '#10b981' },
  { id: 'closed_lost', label: 'Lost', color: '#ef4444' },
];

// ─── Styles ──────────────────────────────────────────────

const S = {
  card: {
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid var(--border-primary)',
    borderRadius: 12,
    padding: 16,
    transition: 'border-color 0.15s, background 0.15s',
  } as React.CSSProperties,

  input: {
    width: '100%',
    padding: '10px 14px',
    fontSize: 13,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid var(--border-primary)',
    borderRadius: 8,
    color: 'var(--text-white)',
    outline: 'none',
    fontFamily: 'var(--font-ui)',
    transition: 'border-color 0.15s',
  } as React.CSSProperties,

  btnPrimary: {
    padding: '10px 18px',
    fontSize: 12,
    fontWeight: 600,
    background: 'linear-gradient(135deg, #f472b6, #db2777)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--font-ui)',
    letterSpacing: 0.5,
    transition: 'opacity 0.15s, transform 0.1s',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,

  btnSecondary: {
    padding: '8px 14px',
    fontSize: 12,
    fontWeight: 500,
    background: 'rgba(255,255,255,0.06)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-primary)',
    borderRadius: 8,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--font-ui)',
    letterSpacing: 0.3,
    transition: 'background 0.15s',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,

  kpiCard: (color: string): React.CSSProperties => ({
    background: `linear-gradient(135deg, ${color}08, ${color}14)`,
    border: `1px solid ${color}25`,
    borderRadius: 12,
    padding: '16px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  }),

  badge: (color: string): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 4,
    background: `${color}18`,
    color,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    fontFamily: 'var(--font-display)',
    whiteSpace: 'nowrap',
  }),

  productBadge: (product: string): React.CSSProperties => {
    const p = PRODUCTS.find(pr => pr.id === product);
    const color = p?.color ?? '#6b7280';
    return {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '3px 8px',
      fontSize: 10,
      fontWeight: 600,
      borderRadius: 4,
      background: `${color}18`,
      color,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      fontFamily: 'var(--font-display)',
    };
  },

  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-white)',
    fontFamily: 'var(--font-display)',
    letterSpacing: 0.5,
  } as React.CSSProperties,

  muted: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-ui)',
  } as React.CSSProperties,

  emptyState: {
    textAlign: 'center' as const,
    padding: '48px 24px',
    color: 'var(--text-muted)',
    fontSize: 13,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 12,
  } as React.CSSProperties,

  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  } as React.CSSProperties,

  grid2: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
  } as React.CSSProperties,

  grid3: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 12,
  } as React.CSSProperties,

  grid4: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 12,
  } as React.CSSProperties,
} as const;

// ─── Helpers ─────────────────────────────────────────────

const fmtDate = (ts: string | number) => {
  const d = typeof ts === 'string' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const fmtRelative = (ts: string | number) => {
  const d = typeof ts === 'string' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
};

const fmtCurrency = (n: number | null | undefined) => {
  if (n == null || isNaN(n)) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n}`;
};

const fmtNum = (n: number | null | undefined) => {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const statusColor = (status: string) => {
  const map: Record<string, string> = {
    draft: '#6b7280', active: '#10b981', paused: '#f59e0b', completed: '#3b82f6',
    new: '#8b5cf6', contacted: '#3b82f6', qualified: '#06b6d4',
    proposal: '#f59e0b', negotiation: '#f97316', closed_won: '#10b981', closed_lost: '#ef4444',
    published: '#10b981', approved: '#10b981', rejected: '#ef4444',
    high: '#ef4444', medium: '#f59e0b', low: '#3b82f6',
    hot: '#ef4444', warm: '#f59e0b', cold: '#3b82f6',
  };
  return map[status] ?? '#6b7280';
};

function ScoreMeter({ score, size = 32 }: { score: number; size?: number }) {
  const color = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : score >= 40 ? '#f97316' : '#ef4444';
  const circumference = 2 * Math.PI * (size / 2 - 3);
  const offset = circumference - (score / 100) * circumference;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={size / 2 - 3} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={2.5} />
      <circle cx={size / 2} cy={size / 2} r={size / 2 - 3} fill="none" stroke={color} strokeWidth={2.5}
        strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.4s' }}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill={color}
        fontSize={size * 0.3} fontWeight={700} fontFamily="var(--font-display)"
        style={{ transform: 'rotate(90deg)', transformOrigin: 'center' }}
      >
        {score}
      </text>
    </svg>
  );
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 0.4s ease' }} />
    </div>
  );
}

// ─── Main View ───────────────────────────────────────────

export function MarketingView() {
  const connected = useGatewayStore((s) => s.connected);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [loading, setLoading] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(true);
  const [customCmd, setCustomCmd] = useState('');
  const [cmdStatus, setCmdStatus] = useState<{ text: string; color: string } | null>(null);
  const [productPicker, setProductPicker] = useState<string | null>(null);
  const [agentFeed, setAgentFeed] = useState<{ id: string; from: string; content: string; timestamp: number }[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const [feedExpanded, setFeedExpanded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [feedPulse, setFeedPulse] = useState(false);
  const [products, setProducts] = useState<Product[]>(DEFAULT_PRODUCTS);
  const [showProductManager, setShowProductManager] = useState(false);
  const [newProduct, setNewProduct] = useState<Product>({ id: '', label: '', color: '#10b981', desc: '' });
  const [productSaveStatus, setProductSaveStatus] = useState<string | null>(null);

  // Load products from gateway
  useEffect(() => {
    if (!connected) return;
    gateway.request<Product[]>('marketing.products.list', {}).then(res => {
      if (Array.isArray(res) && res.length > 0) {
        PRODUCTS = res;
        setProducts(res);
      }
    }).catch(() => { /* use defaults */ });
  }, [connected]);

  const saveProducts = useCallback(async (list: Product[]) => {
    try {
      await gateway.request('marketing.products.save', { products: list });
      PRODUCTS = list;
      setProducts(list);
      setProductSaveStatus('Saved');
      setTimeout(() => setProductSaveStatus(null), 2000);
    } catch (err) {
      setProductSaveStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const loadKpis = useCallback(async () => {
    try {
      const data = await gateway.request<KPIs>('marketing.db.kpis', {});
      setKpis(data);
    } catch (err) { console.error('[MarketingHub]', err); }
  }, []);

  useEffect(() => { loadKpis(); }, [loadKpis]);

  // Auto-refresh KPIs every 15 seconds
  useEffect(() => {
    const interval = setInterval(() => { loadKpis(); }, 15000);
    return () => clearInterval(interval);
  }, [loadKpis]);

  // Subscribe to agent-johny chat messages for real-time response feed
  useEffect(() => {
    const unsub = gateway.on('chat.message', (payload: unknown) => {
      const msg = payload as { id?: string; from?: string; to?: string; content?: string; timestamp?: number };
      if (msg?.from === 'agent-johny' && msg.content) {
        setAgentFeed(prev => [...prev.slice(-19), {
          id: msg.id ?? String(Date.now()),
          from: msg.from!,
          content: msg.content!,
          timestamp: msg.timestamp ?? Date.now(),
        }]);
        // Auto-expand feed, refresh data, pulse indicator, auto-scroll
        setFeedExpanded(true);
        setRefreshKey(prev => prev + 1);
        setFeedPulse(true);
        setTimeout(() => setFeedPulse(false), 2000);
        loadKpis();
        setTimeout(() => feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' }), 50);
      }
    });
    return unsub;
  }, [loadKpis]);

  const sendCommand = useCallback(async (cmd: string) => {
    setCmdStatus({ text: `Sending: ${cmd.slice(0, 60)}...`, color: '#f59e0b' });
    try {
      await gateway.request('marketing.command', { command: cmd });
      setCmdStatus({ text: `Dispatched: ${cmd.slice(0, 60)}`, color: '#10b981' });
      setTimeout(() => setCmdStatus(null), 5000);
    } catch {
      setCmdStatus({ text: 'Failed to dispatch command', color: '#ef4444' });
    }
  }, []);

  const handleQuickCommand = useCallback((qc: typeof QUICK_COMMANDS[0]) => {
    if (qc.needsProduct) {
      setProductPicker(qc.id);
    } else {
      sendCommand(qc.cmd);
    }
  }, [sendCommand]);

  const handleProductSelect = useCallback((productId: string) => {
    const qc = QUICK_COMMANDS.find(c => c.id === productPicker);
    if (qc) {
      const product = PRODUCTS.find(p => p.id === productId);
      sendCommand(qc.cmd.replace('{product}', product?.label ?? productId));
    }
    setProductPicker(null);
  }, [productPicker, sendCommand]);

  const refresh = useCallback(() => {
    loadKpis();
  }, [loadKpis]);

  const isEmpty = kpis?.empty === true;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header + KPI Strip */}
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TrendingUp size={20} style={{ color: '#f472b6' }} />
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, letterSpacing: 2, color: '#f472b6' }}>
              MARKETING HUB v4
            </span>
            <span style={{
              fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 600, letterSpacing: 1,
              fontFamily: 'var(--font-mono)',
              background: connected ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
              color: connected ? '#10b981' : '#ef4444',
            }}>
              {connected ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setShowProductManager(p => !p)} style={{ ...S.btnSecondary, borderColor: showProductManager ? '#f472b6' : undefined, color: showProductManager ? '#f472b6' : undefined }}>
              <Plus size={12} /> Products ({products.length})
            </button>
            <button onClick={refresh} style={S.btnSecondary}>
              <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : {}} /> Refresh
            </button>
          </div>
        </div>

        {/* Product Manager */}
        {showProductManager && (
          <div style={{
            marginBottom: 12, padding: 14, borderRadius: 8,
            background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(244,114,182,0.2)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 1.5, color: '#f472b6', textTransform: 'uppercase', fontFamily: 'var(--font-display)' }}>
                Products
              </span>
              {productSaveStatus && (
                <span style={{ fontSize: 10, color: productSaveStatus.startsWith('Error') ? '#ef4444' : '#10b981', fontFamily: 'var(--font-mono)' }}>
                  {productSaveStatus}
                </span>
              )}
            </div>

            {/* Existing products */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {products.map(p => (
                <div key={p.id} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
                  borderRadius: 6, border: `1px solid ${p.color}40`, background: `${p.color}10`,
                }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: p.color }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: p.color, fontFamily: 'var(--font-display)' }}>{p.label}</span>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{p.desc}</span>
                  <button
                    onClick={() => {
                      const updated = products.filter(x => x.id !== p.id);
                      saveProducts(updated);
                    }}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
                      padding: '0 2px', fontSize: 14, lineHeight: 1, display: 'flex',
                    }}
                    title="Remove product"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>

            {/* Add new product */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={newProduct.label}
                onChange={e => setNewProduct(p => ({ ...p, label: e.target.value, id: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-') }))}
                placeholder="Product name"
                style={{ ...S.input, width: 140, fontSize: 11 }}
              />
              <input
                value={newProduct.desc}
                onChange={e => setNewProduct(p => ({ ...p, desc: e.target.value }))}
                placeholder="Short description"
                style={{ ...S.input, width: 180, fontSize: 11 }}
              />
              <input
                type="color"
                value={newProduct.color}
                onChange={e => setNewProduct(p => ({ ...p, color: e.target.value }))}
                style={{ width: 30, height: 28, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
              />
              <button
                onClick={() => {
                  if (!newProduct.label.trim()) return;
                  const updated = [...products, { ...newProduct, id: newProduct.id || newProduct.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') }];
                  saveProducts(updated);
                  setNewProduct({ id: '', label: '', color: '#10b981', desc: '' });
                }}
                disabled={!newProduct.label.trim()}
                style={{
                  ...S.btnSecondary,
                  borderColor: newProduct.label.trim() ? '#10b981' : undefined,
                  color: newProduct.label.trim() ? '#10b981' : undefined,
                  padding: '4px 12px', fontSize: 10,
                  opacity: newProduct.label.trim() ? 1 : 0.4,
                }}
              >
                <Plus size={11} /> Add
              </button>
            </div>
          </div>
        )}

        {/* KPI Strip — 8 chips */}
        {kpis && !isEmpty && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 8, marginBottom: 12 }}>
            <KPIChip label="Revenue" value={fmtCurrency(kpis.total_revenue)} color="#10b981" icon={DollarSign} />
            <KPIChip label="ROI" value={kpis.avg_roi != null ? `${kpis.avg_roi}%` : '—'} color="#f472b6" icon={TrendingUp} />
            <KPIChip label="Campaigns" value={String(kpis.active_campaigns ?? 0)} sub={`/${kpis.total_campaigns ?? 0}`} color="#8b5cf6" icon={Target} />
            <KPIChip label="Leads" value={fmtNum(kpis.total_leads)} sub={kpis.hot_leads ? ` (${kpis.hot_leads} hot)` : ''} color="#3b82f6" icon={Users} />
            <KPIChip label="Content" value={String(kpis.published_content ?? 0)} sub={`/${kpis.total_content ?? 0}`} color="#8b5cf6" icon={FileText} />
            <KPIChip label="Budget" value={fmtCurrency(kpis.total_budget)} sub={kpis.total_spent ? ` (${fmtCurrency(kpis.total_spent)} spent)` : ''} color="#f59e0b" icon={DollarSign} />
            <KPIChip label="Trends" value={String(kpis.actionable_trends ?? 0)} sub={`/${kpis.total_trends ?? 0}`} color="#06b6d4" icon={Eye} />
            <KPIChip label="Actions" value={String(kpis.successful_actions ?? 0)} sub={`/${kpis.total_actions ?? 0}`} color="#10b981" icon={Activity} />
          </div>
        )}

        {/* Command Center */}
        {!isEmpty && (
          <div style={{ marginBottom: 12 }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: cmdOpen ? 8 : 0 }}
              onClick={() => setCmdOpen(!cmdOpen)}
            >
              {cmdOpen ? <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />}
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 1.5, color: 'var(--text-muted)', textTransform: 'uppercase', fontFamily: 'var(--font-display)' }}>
                Command Center
              </span>
              {cmdStatus && (
                <span style={{ fontSize: 10, color: cmdStatus.color, fontFamily: 'var(--font-mono)', marginLeft: 8 }}>
                  {cmdStatus.text}
                </span>
              )}
            </div>
            {cmdOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {QUICK_COMMANDS.map(qc => (
                    <button
                      key={qc.id}
                      onClick={() => handleQuickCommand(qc)}
                      style={{
                        padding: '6px 12px', fontSize: 11, fontWeight: 500,
                        background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-primary)',
                        borderRadius: 6, cursor: 'pointer', color: 'var(--text-secondary)',
                        fontFamily: 'var(--font-ui)', transition: 'background 0.15s',
                        display: 'flex', alignItems: 'center', gap: 4,
                      }}
                    >
                      <span>{qc.emoji}</span> {qc.label}
                    </button>
                  ))}
                </div>
                {/* Product picker dropdown */}
                {productPicker && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Select product:</span>
                    {PRODUCTS.map(p => (
                      <button key={p.id} onClick={() => handleProductSelect(p.id)}
                        style={{ ...S.btnSecondary, borderColor: p.color, color: p.color, fontSize: 11, padding: '4px 10px' }}>
                        {p.label}
                      </button>
                    ))}
                    <button onClick={() => setProductPicker(null)} style={{ ...S.btnSecondary, fontSize: 11, padding: '4px 10px' }}>Cancel</button>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={customCmd}
                    onChange={e => setCustomCmd(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && customCmd.trim()) { sendCommand(customCmd.trim()); setCustomCmd(''); } }}
                    placeholder="Custom command..."
                    style={{ ...S.input, flex: 1, padding: '6px 12px', fontSize: 12 }}
                  />
                  <button
                    onClick={() => { if (customCmd.trim()) { sendCommand(customCmd.trim()); setCustomCmd(''); } }}
                    style={{ ...S.btnPrimary, padding: '6px 14px' }}
                  >
                    <Send size={12} /> Send
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Agent Response Feed */}
        {agentFeed.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div
              onClick={() => setFeedExpanded(prev => !prev)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                padding: '6px 10px', background: 'rgba(0,0,0,0.25)', borderRadius: feedExpanded ? '8px 8px 0 0' : 8,
                border: `1px solid ${feedPulse ? 'rgba(244,114,182,0.6)' : 'rgba(244,114,182,0.15)'}`,
                borderBottom: feedExpanded ? 'none' : undefined,
                boxShadow: feedPulse ? '0 0 12px rgba(244,114,182,0.3)' : 'none',
                transition: 'border-color 0.3s, box-shadow 0.3s',
              }}
            >
              {feedExpanded ? <ChevronDown size={12} style={{ color: '#f472b6' }} /> : <ChevronRight size={12} style={{ color: '#f472b6' }} />}
              <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: 1.5, color: '#f472b6', textTransform: 'uppercase', fontFamily: 'var(--font-display)' }}>
                Agent Johny Responses ({agentFeed.length})
              </span>
              <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginLeft: 'auto' }}>
                {new Date(agentFeed[agentFeed.length - 1].timestamp).toLocaleTimeString()}
              </span>
            </div>
            {feedExpanded && (
              <div
                ref={feedRef}
                style={{
                  maxHeight: 500, overflow: 'auto',
                  background: 'rgba(0,0,0,0.25)', borderRadius: '0 0 8px 8px',
                  border: '1px solid rgba(244,114,182,0.15)', borderTop: 'none', padding: '6px 10px',
                }}
              >
                {agentFeed.map(msg => (
                  <div key={msg.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0, fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {msg.content}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-primary)' }}>
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '10px 16px', fontSize: 12, fontWeight: 600,
                fontFamily: 'var(--font-ui)', letterSpacing: 0.5,
                background: 'transparent', border: 'none',
                borderBottom: tab === t.id ? '2px solid #f472b6' : '2px solid transparent',
                color: tab === t.id ? '#f472b6' : 'var(--text-muted)',
                cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              <t.icon size={14} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px 20px' }}>
        {isEmpty ? (
          <EmptyState onInit={async () => {
            setCmdStatus({ text: 'Initializing database...', color: '#f59e0b' });
            try {
              const res = await gateway.request<{ success: boolean; tables: string[] }>('marketing.db.init', {});
              setCmdStatus({ text: `Database initialized — ${res.tables?.length ?? 12} tables created`, color: '#10b981' });
              setTimeout(() => { setCmdStatus(null); loadKpis(); }, 1500);
            } catch (err) {
              setCmdStatus({ text: `Init failed: ${err instanceof Error ? err.message : String(err)}`, color: '#ef4444' });
            }
          }} />
        ) : (
          <>
            {tab === 'dashboard' && <DashboardTab kpis={kpis} refreshKey={refreshKey} />}
            {tab === 'social' && <SocialTab />}
            {tab === 'campaigns' && <CampaignsTab refreshKey={refreshKey} />}
            {tab === 'content' && <ContentTab refreshKey={refreshKey} />}
            {tab === 'leads' && <LeadsTab refreshKey={refreshKey} />}
            {tab === 'intel' && <IntelTab refreshKey={refreshKey} />}
            {tab === 'agents' && <AgentsTab refreshKey={refreshKey} />}
            {tab === 'skills' && <SkillsTab />}
            {tab === 'database' && <DatabaseTab />}
            {tab === 'api-keys' && <ApiKeysTab />}
          </>
        )}
      </div>
    </div>
  );
}

// ─── KPI Chip ────────────────────────────────────────────

function KPIChip({ label, value, sub, color, icon: Icon }: {
  label: string; value: string; sub?: string; color: string; icon: typeof TrendingUp;
}) {
  return (
    <div style={{
      background: `${color}0a`, border: `1px solid ${color}20`, borderRadius: 8,
      padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <Icon size={12} style={{ color, opacity: 0.8 }} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color, fontFamily: 'var(--font-display)', lineHeight: 1.1 }}>
          {value}{sub && <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400 }}>{sub}</span>}
        </div>
        <div style={{ fontSize: 8, color: 'var(--text-muted)', letterSpacing: 0.8, textTransform: 'uppercase', fontFamily: 'var(--font-ui)' }}>
          {label}
        </div>
      </div>
    </div>
  );
}

// ─── Empty State ─────────────────────────────────────────

function EmptyState({ onInit }: { onInit: () => void }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: 20, padding: 40,
    }}>
      <Database size={48} style={{ color: '#f472b6', opacity: 0.5 }} />
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--text-white)', letterSpacing: 1 }}>
        Marketing Hub v4
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 400, lineHeight: 1.6 }}>
        No marketing database found. Click below to initialize the SQLite database with 12 tables:
        trends, viral_tracker, competitors, audience_insights, content_library, leads, campaigns, market_data, chatbot_kb, performance_log, media_assets, email_campaigns.
      </div>
      <button onClick={onInit} style={{ ...S.btnPrimary, padding: '14px 28px', fontSize: 14 }}>
        <Database size={16} /> Initialize Database
      </button>
    </div>
  );
}

// ─── Dashboard Tab ───────────────────────────────────────

function DashboardTab({ kpis, refreshKey }: { kpis: KPIs | null; refreshKey: number }) {
  const [topCampaigns, setTopCampaigns] = useState<Record<string, unknown>[]>([]);
  const [recentLeads, setRecentLeads] = useState<Record<string, unknown>[]>([]);
  const [recentContent, setRecentContent] = useState<Record<string, unknown>[]>([]);
  const [recentActions, setRecentActions] = useState<Record<string, unknown>[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [c, l, ct, a] = await Promise.all([
          gateway.request<QueryResult>('marketing.db.query', { table: 'campaigns', limit: 5, orderBy: 'revenue DESC' }),
          gateway.request<QueryResult>('marketing.db.query', { table: 'leads', limit: 5, orderBy: 'score DESC' }),
          gateway.request<QueryResult>('marketing.db.query', { table: 'content_library', limit: 5, orderBy: 'created_at DESC' }),
          gateway.request<QueryResult>('marketing.db.query', { table: 'performance_log', limit: 10, orderBy: 'logged_at DESC' }),
        ]);
        setTopCampaigns(c.rows);
        setRecentLeads(l.rows);
        setRecentContent(ct.rows);
        setRecentActions(a.rows);
      } catch (err) { console.error('[MarketingHub]', err); }
    })();
  }, [refreshKey]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Summary Cards */}
      <div style={S.grid3}>
        <div style={S.kpiCard('#f472b6')}>
          <div style={S.muted}>Total Revenue</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#f472b6', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>
            {fmtCurrency(kpis?.total_revenue)}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            Budget: {fmtCurrency(kpis?.total_budget)} | Spent: {fmtCurrency(kpis?.total_spent)}
          </div>
        </div>
        <div style={S.kpiCard('#10b981')}>
          <div style={S.muted}>Active Campaigns</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#10b981', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>
            {kpis?.active_campaigns ?? 0}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>of {kpis?.total_campaigns ?? 0} total</div>
        </div>
        <div style={S.kpiCard('#3b82f6')}>
          <div style={S.muted}>Leads Pipeline</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#3b82f6', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>
            {kpis?.total_leads ?? 0}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {kpis?.hot_leads ?? 0} hot | {kpis?.new_leads ?? 0} new this week
          </div>
        </div>
      </div>

      <div style={S.grid2}>
        {/* Top Campaigns */}
        <div style={S.card}>
          <div style={{ ...S.sectionTitle, marginBottom: 12 }}>Top Campaigns</div>
          {topCampaigns.length === 0 && <div style={S.muted}>No campaigns yet</div>}
          {topCampaigns.map((c, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-white)' }}>{String(c.name ?? 'Unnamed')}</div>
                <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                  <span style={S.badge(statusColor(String(c.status ?? 'draft')))}>{String(c.status ?? 'draft')}</span>
                  <span style={S.productBadge(String(c.product ?? ''))}>{String(c.product ?? '—')}</span>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#10b981' }}>{fmtCurrency(Number(c.revenue) || 0)}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>ROI: {c.roi != null ? `${c.roi}%` : '—'}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Hot Leads */}
        <div style={S.card}>
          <div style={{ ...S.sectionTitle, marginBottom: 12 }}>Top Leads</div>
          {recentLeads.length === 0 && <div style={S.muted}>No leads yet</div>}
          {recentLeads.map((l, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <ScoreMeter score={Number(l.score) || 0} size={32} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-white)' }}>{String(l.name ?? 'Unknown')}</div>
                <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                  {l.company && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{String(l.company)}</span>}
                  <span style={S.badge(statusColor(String(l.status ?? 'new')))}>{String(l.status ?? 'new')}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Content + Activity */}
      <div style={S.grid2}>
        <div style={S.card}>
          <div style={{ ...S.sectionTitle, marginBottom: 12 }}>Recent Content</div>
          {recentContent.length === 0 && <div style={S.muted}>No content yet</div>}
          {recentContent.map((c, i) => (
            <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={S.badge('#8b5cf6')}>{String(c.type ?? c.content_type ?? '—')}</span>
                  <span style={S.productBadge(String(c.product ?? ''))}>{String(c.product ?? '—')}</span>
                  {c.platform && <span style={S.badge('#06b6d4')}>{String(c.platform)}</span>}
                </div>
                <span style={S.muted}>{c.created_at ? fmtRelative(String(c.created_at)) : '—'}</span>
              </div>
              {c.title && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{String(c.title).slice(0, 80)}</div>}
            </div>
          ))}
        </div>

        <div style={S.card}>
          <div style={{ ...S.sectionTitle, marginBottom: 12 }}>Recent Activity</div>
          {recentActions.length === 0 && <div style={S.muted}>No activity yet</div>}
          {recentActions.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%', marginTop: 5, flexShrink: 0,
                background: a.success ? '#10b981' : '#ef4444',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {String(a.description ?? '—')}
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>
                  {String(a.agent ?? '—')} · {a.logged_at ? fmtRelative(String(a.logged_at)) : '—'}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Campaigns Tab ───────────────────────────────────────

function CampaignsTab({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await gateway.request<QueryResult>('marketing.db.query', { table: 'campaigns', limit: 100 });
      setData(res.rows);
    } catch (err) { console.error('[MarketingHub]', err); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const grouped = useMemo(() => {
    const g: Record<string, Record<string, unknown>[]> = { active: [], draft: [], paused: [], completed: [] };
    for (const c of data) {
      const s = String(c.status ?? 'draft');
      (g[s] ?? g.draft).push(c);
    }
    return g;
  }, [data]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={S.row}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-white)' }}>{data.length} Campaigns</span>
          <span style={S.badge('#10b981')}>{grouped.active.length} Active</span>
          <span style={S.badge('#6b7280')}>{grouped.draft.length} Draft</span>
        </div>
        <button onClick={load} style={S.btnSecondary}><RefreshCw size={12} /> Refresh</button>
      </div>

      {(['active', 'draft', 'paused', 'completed'] as const).map(status => {
        const items = grouped[status];
        if (!items || items.length === 0) return null;
        return (
          <div key={status}>
            <div style={{ ...S.muted, fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8 }}>
              {status} ({items.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {items.map((c, i) => {
                const color = statusColor(status);
                return (
                  <div key={i} style={{ ...S.card, borderLeft: `3px solid ${color}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={S.row}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-white)' }}>{String(c.name ?? 'Unnamed')}</span>
                        <span style={S.productBadge(String(c.product ?? ''))}>{String(c.product ?? '—')}</span>
                        <span style={S.badge(color)}>{status}</span>
                      </div>
                      <div style={S.row}>
                        {c.budget && <span style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600 }}>Budget: {fmtCurrency(Number(c.budget))}</span>}
                        {c.revenue && <span style={{ fontSize: 12, color: '#10b981', fontWeight: 600 }}>Rev: {fmtCurrency(Number(c.revenue))}</span>}
                        {c.roi != null && <span style={{ fontSize: 12, color: '#f472b6', fontWeight: 600 }}>ROI: {c.roi}%</span>}
                      </div>
                    </div>
                    <div style={{ marginTop: 8, display: 'flex', gap: 16 }}>
                      {c.impressions && <span style={S.muted}>Impressions: {fmtNum(Number(c.impressions))}</span>}
                      {c.clicks && <span style={S.muted}>Clicks: {fmtNum(Number(c.clicks))}</span>}
                      {c.conversions && <span style={S.muted}>Conversions: {fmtNum(Number(c.conversions))}</span>}
                      {c.start_date && <span style={S.muted}>Started: {fmtDate(String(c.start_date))}</span>}
                    </div>
                    {c.description && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
                        {String(c.description).slice(0, 200)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {data.length === 0 && !loading && (
        <div style={S.emptyState}>
          <Target size={32} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
          <span>No campaigns yet. Use Command Center to start a marketing sprint.</span>
        </div>
      )}
    </div>
  );
}

// ─── Content Tab ─────────────────────────────────────────

function ContentTab({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ product: '', platform: '', status: '' });
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await gateway.request<QueryResult>('marketing.db.query', {
        table: 'content_library', limit: 100, orderBy: 'created_at DESC',
      });
      setData(res.rows);
    } catch (err) { console.error('[MarketingHub]', err); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const filtered = useMemo(() => {
    let items = data;
    if (filter.product) items = items.filter(c => c.product === filter.product);
    if (filter.platform) items = items.filter(c => c.platform === filter.platform);
    if (filter.status) items = items.filter(c => c.status === filter.status);
    return items;
  }, [data, filter]);

  const platforms = useMemo(() => [...new Set(data.map(c => String(c.platform ?? '')).filter(Boolean))], [data]);
  const statuses = useMemo(() => [...new Set(data.map(c => String(c.status ?? '')).filter(Boolean))], [data]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={S.row}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-white)' }}>{filtered.length} Content Pieces</span>
          <select value={filter.product} onChange={e => setFilter({ ...filter, product: e.target.value })}
            style={{ ...S.input, width: 'auto', minWidth: 100, padding: '4px 8px', fontSize: 11 }}>
            <option value="">All Products</option>
            {PRODUCTS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <select value={filter.platform} onChange={e => setFilter({ ...filter, platform: e.target.value })}
            style={{ ...S.input, width: 'auto', minWidth: 100, padding: '4px 8px', fontSize: 11 }}>
            <option value="">All Platforms</option>
            {platforms.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}
            style={{ ...S.input, width: 'auto', minWidth: 100, padding: '4px 8px', fontSize: 11 }}>
            <option value="">All Status</option>
            {statuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <button onClick={load} style={S.btnSecondary}><RefreshCw size={12} /> Refresh</button>
      </div>

      {filtered.map((c, i) => {
        const expanded = expandedId === i;
        const body = String(c.body ?? c.content ?? '');
        return (
          <div key={i} style={S.card} onClick={() => setExpandedId(expanded ? null : i)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={S.row}>
                <span style={S.badge('#8b5cf6')}>{String(c.type ?? c.content_type ?? '—')}</span>
                <span style={S.productBadge(String(c.product ?? ''))}>{String(c.product ?? '—')}</span>
                {c.platform && <span style={S.badge('#06b6d4')}>{String(c.platform)}</span>}
                {c.status && <span style={S.badge(statusColor(String(c.status)))}>{String(c.status)}</span>}
              </div>
              <div style={S.row}>
                {c.engagement_score != null && (
                  <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>Engagement: {c.engagement_score}</span>
                )}
                <span style={S.muted}>{c.created_at ? fmtRelative(String(c.created_at)) : '—'}</span>
              </div>
            </div>
            {c.title && <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-white)', marginTop: 6 }}>{String(c.title)}</div>}
            <div style={{
              fontSize: 12, color: 'var(--text-secondary)', marginTop: 6,
              whiteSpace: 'pre-wrap', lineHeight: 1.5,
              maxHeight: expanded ? 'none' : 80, overflow: expanded ? 'visible' : 'hidden',
              position: 'relative',
            }}>
              {body}
              {!expanded && body.length > 200 && (
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0, height: 30,
                  background: 'linear-gradient(transparent, rgba(15,15,15,0.95))',
                }} />
              )}
            </div>
            {expanded && body && (
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(body); }}
                  style={S.btnSecondary}><Copy size={12} /> Copy</button>
              </div>
            )}
          </div>
        );
      })}

      {filtered.length === 0 && !loading && (
        <div style={S.emptyState}>
          <FileText size={32} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
          <span>No content yet. Use Command Center to generate a content batch.</span>
        </div>
      )}
    </div>
  );
}

// ─── Leads Tab ───────────────────────────────────────────

function LeadsTab({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await gateway.request<QueryResult>('marketing.db.query', {
        table: 'leads', limit: 200, orderBy: 'score DESC',
      });
      setData(res.rows);
    } catch (err) { console.error('[MarketingHub]', err); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  // Pipeline funnel
  const pipeline = useMemo(() => {
    const p: Record<string, number> = {};
    for (const s of LEAD_STATUSES) p[s.id] = 0;
    for (const l of data) {
      const s = String(l.status ?? 'new');
      if (s in p) p[s]++;
    }
    return p;
  }, [data]);

  const filtered = useMemo(() => {
    let items = data;
    if (statusFilter) items = items.filter(l => l.status === statusFilter);
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      items = items.filter(l =>
        String(l.name ?? '').toLowerCase().includes(q) ||
        String(l.company ?? '').toLowerCase().includes(q) ||
        String(l.email ?? '').toLowerCase().includes(q)
      );
    }
    return items;
  }, [data, statusFilter, searchTerm]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Pipeline Visualization */}
      <div style={{ ...S.card, padding: '14px 16px' }}>
        <div style={{ ...S.muted, fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 10 }}>
          LEAD PIPELINE
        </div>
        <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end' }}>
          {LEAD_STATUSES.map(s => {
            const count = pipeline[s.id] ?? 0;
            const maxCount = Math.max(...Object.values(pipeline), 1);
            const heightPct = (count / maxCount) * 100;
            return (
              <div key={s.id} style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                cursor: 'pointer', opacity: statusFilter === s.id ? 1 : 0.7,
              }} onClick={() => setStatusFilter(statusFilter === s.id ? '' : s.id)}>
                <span style={{ fontSize: 14, fontWeight: 700, color: s.color }}>{count}</span>
                <div style={{
                  width: '100%', maxWidth: 60, height: Math.max(heightPct * 0.6, 4), borderRadius: 4,
                  background: `linear-gradient(180deg, ${s.color}, ${s.color}80)`,
                  transition: 'height 0.3s ease',
                }} />
                <span style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 0.5, textAlign: 'center' }}>
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={S.row}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-white)' }}>{filtered.length} Leads</span>
          <div style={{ ...S.input, width: 180, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Search size={12} style={{ color: 'var(--text-muted)' }} />
            <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Search..."
              style={{ background: 'none', border: 'none', color: 'var(--text-white)', outline: 'none', fontSize: 11, width: '100%', fontFamily: 'var(--font-ui)' }} />
          </div>
        </div>
        <button onClick={load} style={S.btnSecondary}><RefreshCw size={12} /> Refresh</button>
      </div>

      {/* Lead Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {filtered.map((l, i) => {
          const score = Number(l.score) || 0;
          const tierColor = score >= 70 ? '#ef4444' : score >= 40 ? '#f59e0b' : '#3b82f6';
          return (
            <div key={i} style={{
              ...S.card, padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 14,
              borderLeft: `3px solid ${tierColor}`,
            }}>
              <ScoreMeter score={score} size={38} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-white)' }}>{String(l.name ?? 'Unknown')}</span>
                  {l.company && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
                      <Building2 size={10} /> {String(l.company)}
                    </span>
                  )}
                  {l.email && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
                      <AtSign size={10} /> {String(l.email)}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={S.badge(statusColor(String(l.status ?? 'new')))}>{String(l.status ?? 'new').replace(/_/g, ' ')}</span>
                  <span style={S.productBadge(String(l.product ?? ''))}>{String(l.product ?? '—')}</span>
                  {l.source && <span style={S.badge('#6b7280')}>{String(l.source).replace(/_/g, ' ')}</span>}
                  {l.estimated_value && <span style={{ fontSize: 11, color: '#10b981', fontWeight: 600 }}>{fmtCurrency(Number(l.estimated_value))}</span>}
                </div>
                {l.next_action && (
                  <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 4 }}>
                    Next: {String(l.next_action)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && !loading && (
        <div style={S.emptyState}>
          <Users size={32} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
          <span>No leads yet. Use Command Center to run a lead hunt.</span>
        </div>
      )}
    </div>
  );
}

// ─── Intel Tab ───────────────────────────────────────────

function IntelTab({ refreshKey }: { refreshKey: number }) {
  const [trends, setTrends] = useState<Record<string, unknown>[]>([]);
  const [viral, setViral] = useState<Record<string, unknown>[]>([]);
  const [competitors, setCompetitors] = useState<Record<string, unknown>[]>([]);
  const [insights, setInsights] = useState<Record<string, unknown>[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ trends: true, viral: true, competitors: true, insights: true });

  useEffect(() => {
    (async () => {
      try {
        const [t, v, c, ins] = await Promise.all([
          gateway.request<QueryResult>('marketing.db.query', { table: 'trends', limit: 50, orderBy: 'created_at DESC' }),
          gateway.request<QueryResult>('marketing.db.query', { table: 'viral_tracker', limit: 50, orderBy: 'created_at DESC' }),
          gateway.request<QueryResult>('marketing.db.query', { table: 'competitors', limit: 50, orderBy: 'created_at DESC' }),
          gateway.request<QueryResult>('marketing.db.query', { table: 'audience_insights', limit: 50, orderBy: 'created_at DESC' }),
        ]);
        setTrends(t.rows);
        setViral(v.rows);
        setCompetitors(c.rows);
        setInsights(ins.rows);
      } catch (err) { console.error('[MarketingHub]', err); }
    })();
  }, [refreshKey]);

  const toggleSection = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Trends */}
      <IntelSection
        title={`Trends (${trends.length})`}
        icon={<TrendingUp size={14} style={{ color: '#06b6d4' }} />}
        open={expanded.trends}
        onToggle={() => toggleSection('trends')}
      >
        {trends.length === 0 && <div style={S.muted}>No trends data yet. Run "Research Trends" command.</div>}
        {trends.map((t, i) => (
          <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={S.row}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-white)' }}>{String(t.name ?? t.trend ?? '—')}</span>
                {t.category && <span style={S.badge('#06b6d4')}>{String(t.category)}</span>}
                {t.actionable && <span style={S.badge('#10b981')}>ACTIONABLE</span>}
              </div>
              {t.relevance_score != null && <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>Relevance: {t.relevance_score}</span>}
            </div>
            {t.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>{String(t.description).slice(0, 200)}</div>}
          </div>
        ))}
      </IntelSection>

      {/* Viral Tracker */}
      <IntelSection
        title={`Viral Tracker (${viral.length})`}
        icon={<Zap size={14} style={{ color: '#f472b6' }} />}
        open={expanded.viral}
        onToggle={() => toggleSection('viral')}
      >
        {viral.length === 0 && <div style={S.muted}>No viral content tracked yet.</div>}
        {viral.map((v, i) => (
          <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={S.row}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-white)' }}>{String(v.title ?? v.url ?? '—')}</span>
                {v.platform && <span style={S.badge('#8b5cf6')}>{String(v.platform)}</span>}
              </div>
              {v.engagement != null && <span style={{ fontSize: 11, color: '#f472b6', fontWeight: 600 }}>Engagement: {fmtNum(Number(v.engagement))}</span>}
            </div>
            {v.why_viral && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{String(v.why_viral).slice(0, 200)}</div>}
          </div>
        ))}
      </IntelSection>

      {/* Competitors */}
      <IntelSection
        title={`Competitors (${competitors.length})`}
        icon={<Crosshair size={14} style={{ color: '#ef4444' }} />}
        open={expanded.competitors}
        onToggle={() => toggleSection('competitors')}
      >
        {competitors.length === 0 && <div style={S.muted}>No competitor data yet. Run "Competitor Scan" command.</div>}
        {competitors.map((c, i) => (
          <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={S.row}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-white)' }}>{String(c.name ?? '—')}</span>
              {c.product && <span style={S.productBadge(String(c.product))}>{String(c.product)}</span>}
              {c.threat_level && <span style={S.badge(statusColor(String(c.threat_level)))}>{String(c.threat_level)}</span>}
            </div>
            {c.strengths && <div style={{ fontSize: 11, color: '#10b981', marginTop: 4 }}>Strengths: {String(c.strengths).slice(0, 150)}</div>}
            {c.weaknesses && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 2 }}>Weaknesses: {String(c.weaknesses).slice(0, 150)}</div>}
          </div>
        ))}
      </IntelSection>

      {/* Audience Insights */}
      <IntelSection
        title={`Audience Insights (${insights.length})`}
        icon={<Eye size={14} style={{ color: '#f59e0b' }} />}
        open={expanded.insights}
        onToggle={() => toggleSection('insights')}
      >
        {insights.length === 0 && <div style={S.muted}>No audience insights yet.</div>}
        {insights.map((ins, i) => (
          <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={S.row}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-white)' }}>{String(ins.segment ?? ins.title ?? '—')}</span>
              {ins.product && <span style={S.productBadge(String(ins.product))}>{String(ins.product)}</span>}
            </div>
            {ins.insight && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{String(ins.insight).slice(0, 200)}</div>}
            {ins.recommendation && <div style={{ fontSize: 11, color: '#06b6d4', marginTop: 2 }}>Recommendation: {String(ins.recommendation).slice(0, 150)}</div>}
          </div>
        ))}
      </IntelSection>
    </div>
  );
}

function IntelSection({ title, icon, open, onToggle, children }: {
  title: string; icon: React.ReactNode; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div style={S.card}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        onClick={onToggle}
      >
        {open ? <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
        {icon}
        <span style={S.sectionTitle}>{title}</span>
      </div>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  );
}

// ─── Agents Tab ──────────────────────────────────────────

function AgentsTab({ refreshKey }: { refreshKey: number }) {
  const [agentStats, setAgentStats] = useState<AgentStats[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const stats = await gateway.request<AgentStats[]>('marketing.db.agents', {});
        setAgentStats(stats);
      } catch (err) { console.error('[MarketingHub]', err); }
    })();
  }, [refreshKey]);

  const statsMap = useMemo(() => {
    const m: Record<string, AgentStats> = {};
    for (const s of agentStats) m[s.agent] = s;
    return m;
  }, [agentStats]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ ...S.sectionTitle, fontSize: 14 }}>Marketing Sub-Agents</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {SUB_AGENTS.map(agent => {
          const stats = statsMap[agent.id];
          const successRate = stats && stats.total_actions > 0
            ? Math.round((stats.successful / stats.total_actions) * 100)
            : null;
          return (
            <div key={agent.id} style={{
              ...S.card,
              borderTop: `3px solid ${agent.color}`,
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 24 }}>{agent.emoji}</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: agent.color, fontFamily: 'var(--font-display)', letterSpacing: 0.5 }}>
                    {agent.name}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.8 }}>
                    {agent.id}
                  </div>
                </div>
              </div>

              {stats ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={S.muted}>Total Actions</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-white)' }}>{stats.total_actions}</span>
                  </div>
                  {successRate !== null && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                        <span style={S.muted}>Success Rate</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: successRate >= 80 ? '#10b981' : successRate >= 50 ? '#f59e0b' : '#ef4444' }}>
                          {successRate}%
                        </span>
                      </div>
                      <ProgressBar value={successRate} max={100} color={successRate >= 80 ? '#10b981' : successRate >= 50 ? '#f59e0b' : '#ef4444'} />
                    </div>
                  )}
                  {stats.last_action && (
                    <div>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Last: {fmtRelative(stats.last_action)}</span>
                    </div>
                  )}
                  {stats.last_description && (
                    <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.3 }}>
                      {stats.last_description.slice(0, 80)}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  No activity recorded
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Skills Tab ─────────────────────────────────────────

interface SkillInfo {
  id: string;
  title: string;
  category: string;
  hasEvals: boolean;
  hasReferences: boolean;
  lines: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  'CRO': '#f472b6',
  'Content & Copy': '#60a5fa',
  'SEO & Discovery': '#34d399',
  'Paid & Measurement': '#fbbf24',
  'Growth & Retention': '#a78bfa',
  'Strategy': '#f97316',
  'Sales & RevOps': '#22d3ee',
  'Foundation': '#00ff41',
};

function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const data = await gateway.request<SkillInfo[]>('marketing.skills.list', {});
        setSkills(data);
      } catch (err) { console.error('[MarketingHub]', err); }
    })();
  }, []);

  const loadSkill = useCallback(async (id: string) => {
    setSelected(id);
    setLoading(true);
    try {
      const res = await gateway.request<{ id: string; content: string }>('marketing.skills.read', { id });
      setContent(res.content);
    } catch {
      setContent('Failed to load skill.');
    }
    setLoading(false);
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, SkillInfo[]>();
    const filtered = skills.filter(s =>
      !filter || s.id.includes(filter.toLowerCase()) || s.title.toLowerCase().includes(filter.toLowerCase()) || s.category.toLowerCase().includes(filter.toLowerCase())
    );
    for (const s of filtered) {
      const list = map.get(s.category) || [];
      list.push(s);
      map.set(s.category, list);
    }
    return map;
  }, [skills, filter]);

  if (selected) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => { setSelected(null); setContent(''); }} style={{ ...S.btnGhost, padding: '4px 10px', fontSize: 11 }}>
            <ChevronLeft size={12} /> Back
          </button>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, color: 'var(--text-white)', letterSpacing: 1 }}>
            {selected}
          </span>
        </div>
        <div style={{
          flex: 1, overflow: 'auto', background: 'rgba(0,0,0,0.3)', borderRadius: 8,
          border: '1px solid var(--border)', padding: 16, fontSize: 12, lineHeight: 1.7,
          color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap',
        }}>
          {loading ? 'Loading...' : content}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <BookOpen size={16} style={{ color: '#f472b6' }} />
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, color: 'var(--text-white)', letterSpacing: 1 }}>
          MARKETING SKILLS LIBRARY
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          {skills.length} skills from coreyhaines31/marketingskills
        </span>
      </div>

      <input
        type="text"
        placeholder="Filter skills..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
        style={{ ...S.input, maxWidth: 300, fontSize: 11 }}
      />

      {Array.from(grouped.entries()).map(([category, items]) => (
        <div key={category} style={{ marginBottom: 8 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase',
            color: CATEGORY_COLORS[category] ?? '#888', marginBottom: 6,
            fontFamily: 'var(--font-display)',
          }}>
            {category} ({items.length})
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
            {items.map(skill => (
              <button
                key={skill.id}
                onClick={() => loadSkill(skill.id)}
                style={{
                  background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '8px 12px', textAlign: 'left', cursor: 'pointer',
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = CATEGORY_COLORS[category] ?? '#666')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-white)', marginBottom: 2, fontFamily: 'var(--font-ui)' }}>
                  {skill.title}
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  <span>{skill.id}</span>
                  <span>{skill.lines} lines</span>
                  {skill.hasEvals && <span style={{ color: '#34d399' }}>evals</span>}
                  {skill.hasReferences && <span style={{ color: '#60a5fa' }}>refs</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Social Tab ──────────────────────────────────────────

const SOCIAL_PLATFORMS = [
  { id: 'twitter', label: 'Twitter', color: '#1DA1F2', icon: Hash },
  { id: 'instagram', label: 'Instagram', color: '#E4405F', icon: Image },
  { id: 'facebook', label: 'Facebook', color: '#1877F2', icon: Globe },
  { id: 'linkedin', label: 'LinkedIn', color: '#0A66C2', icon: MessageCircle },
  { id: 'tiktok', label: 'TikTok', color: '#ffffff', icon: Play },
  { id: 'reddit', label: 'Reddit', color: '#FF4500', icon: MessageCircle },
] as const;

interface ScheduledPost {
  id: string;
  platform: string;
  text: string;
  scheduled_at: string;
  post_type?: string;
  media_url?: string;
  status?: string;
}

interface SocialConfig {
  twitter: boolean;
  instagram: boolean;
  facebook: boolean;
  linkedin: boolean;
  tiktok: boolean;
  reddit: boolean;
  flux: boolean;
  kling: boolean;
  elevenlabs: boolean;
  heygen: boolean;
  brevo: boolean;
  resend: boolean;
  apollo: boolean;
}

function SocialTab() {
  // ─── State ─────────────────────────────────────────
  const [config, setConfig] = useState<SocialConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);

  const [postText, setPostText] = useState('');
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<string>>(new Set());
  const [selectedProduct, setSelectedProduct] = useState<string>('');
  const [posting, setPosting] = useState(false);
  const [postStatus, setPostStatus] = useState<{ text: string; color: string } | null>(null);


  const [scheduleDate, setScheduleDate] = useState('');

  const [scheduled, setScheduled] = useState<ScheduledPost[]>([]);
  const [scheduledLoading, setScheduledLoading] = useState(false);

  const [lastCommand, setLastCommand] = useState<{ cmd: string; status: string; time: string } | null>(null);

  // Media source picker
  type MediaMode = 'auto' | 'folder' | 'database';
  const [mediaMode, setMediaMode] = useState<MediaMode>('auto');
  const [mediaFolder, setMediaFolder] = useState('/Volumes/Public/jarvis-nas/media');
  const [folderFiles, setFolderFiles] = useState<{ name: string; path: string; size: number; type: 'image' | 'video' }[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<Set<string>>(new Set());
  const [dbMedia, setDbMedia] = useState<{ id: string; filename: string; path: string; type: string; product: string }[]>([]);
  const [dbMediaLoading, setDbMediaLoading] = useState(false);

  // ─── Data fetching ─────────────────────────────────
  const fetchConfig = useCallback(async () => {
    try {
      setConfigLoading(true);
      const res = await gateway.request<SocialConfig>('social.config', {});
      setConfig(res);
    } catch (err) {
      console.error('Failed to fetch social config:', err);
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const fetchScheduled = useCallback(async () => {
    try {
      setScheduledLoading(true);
      const res = await gateway.request<ScheduledPost[]>('social.schedule.list', {});
      setScheduled(Array.isArray(res) ? res : []);
    } catch (err) {
      console.error('Failed to fetch scheduled posts:', err);
    } finally {
      setScheduledLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
    fetchScheduled();
  }, [fetchConfig, fetchScheduled]);

  // Auto-refresh scheduled queue every 30s
  useEffect(() => {
    const interval = setInterval(fetchScheduled, 30000);
    return () => clearInterval(interval);
  }, [fetchScheduled]);

  // ─── Actions ───────────────────────────────────────
  const togglePlatform = useCallback((platformId: string) => {
    setSelectedPlatforms(prev => {
      const next = new Set(prev);
      if (next.has(platformId)) next.delete(platformId);
      else next.add(platformId);
      return next;
    });
  }, []);

  const handlePost = useCallback(async () => {
    if (!postText.trim() || selectedPlatforms.size === 0) {
      setPostStatus({ text: 'Select at least one platform and enter text', color: '#ef4444' });
      return;
    }
    setPosting(true);
    setPostStatus(null);
    try {
      const platforms = Array.from(selectedPlatforms);
      for (const platform of platforms) {
        await gateway.request('social.post', {
          platform,
          text: postText.trim(),
          ...(selectedProduct ? { product: selectedProduct } : {}),
        });
      }
      setPostStatus({ text: `Posted to ${platforms.join(', ')} successfully`, color: '#10b981' });
      setPostText('');
      setSelectedPlatforms(new Set());
    } catch (err) {
      setPostStatus({ text: `Post failed: ${err instanceof Error ? err.message : String(err)}`, color: '#ef4444' });
    } finally {
      setPosting(false);
    }
  }, [postText, selectedPlatforms, selectedProduct]);

  const handleSchedule = useCallback(async () => {
    if (!postText.trim() || selectedPlatforms.size === 0 || !scheduleDate) {
      setPostStatus({ text: 'Select platform(s), enter text, and pick a date', color: '#ef4444' });
      return;
    }
    setPosting(true);
    setPostStatus(null);
    try {
      const platforms = Array.from(selectedPlatforms);
      for (const platform of platforms) {
        await gateway.request('social.schedule', {
          platform,
          text: postText.trim(),
          scheduled_at: new Date(scheduleDate).toISOString(),
          ...(selectedProduct ? { product: selectedProduct } : {}),
        });
      }
      setPostStatus({ text: `Scheduled for ${platforms.join(', ')}`, color: '#10b981' });
      setPostText('');
      setSelectedPlatforms(new Set());
      setScheduleDate('');
      fetchScheduled();
    } catch (err) {
      setPostStatus({ text: `Schedule failed: ${err instanceof Error ? err.message : String(err)}`, color: '#ef4444' });
    } finally {
      setPosting(false);
    }
  }, [postText, selectedPlatforms, scheduleDate, selectedProduct, fetchScheduled]);

  const cancelScheduled = useCallback(async (postId: string) => {
    try {
      await gateway.request('social.schedule.cancel', { post_id: postId });
      setScheduled(prev => prev.filter(p => p.id !== postId));
    } catch (err) {
      console.error('Failed to cancel scheduled post:', err);
    }
  }, []);

  const sendAgentCommand = useCallback(async (command: string) => {
    const ts = new Date().toLocaleTimeString();
    setLastCommand({ cmd: command, status: 'Sending...', time: ts });
    try {
      await gateway.request('marketing.command', { command });
      setLastCommand({ cmd: command, status: 'Sent to agent-johny', time: ts });
    } catch (err) {
      setLastCommand({ cmd: command, status: `Failed: ${err instanceof Error ? err.message : String(err)}`, time: ts });
    }
  }, []);

  const browseFolder = useCallback(async (path: string) => {
    setFolderLoading(true);
    try {
      const res = await gateway.request<{ files: { name: string; path: string; size: number; type: 'image' | 'video' }[] }>('social.media.browse', { path });
      setFolderFiles(res?.files ?? []);
    } catch (err) {
      console.error('Browse failed:', err);
      setFolderFiles([]);
    } finally {
      setFolderLoading(false);
    }
  }, []);

  const fetchDbMedia = useCallback(async () => {
    setDbMediaLoading(true);
    try {
      const res = await gateway.request<{ rows: { id: string; filename: string; file_path: string; media_type: string; product: string }[] }>('marketing.db.query', { table: 'media_assets', limit: 50, orderBy: 'created_at DESC' });
      setDbMedia((res?.rows ?? []).map(r => ({ id: String(r.id), filename: r.filename, path: r.file_path, type: r.media_type, product: r.product })));
    } catch {
      setDbMedia([]);
    } finally {
      setDbMediaLoading(false);
    }
  }, []);

  const toggleMediaFile = useCallback((path: string) => {
    setSelectedMedia(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Build media instruction string for agent commands
  const getMediaInstruction = useCallback(() => {
    if (mediaMode === 'auto') return 'MEDIA: Auto-generate all visuals — image with image_generate (Flux Pro), video with media_generate (Kling 3.0). NEVER post without media.';
    if (mediaMode === 'folder' && selectedMedia.size > 0) {
      const paths = Array.from(selectedMedia);
      return `MEDIA: Use these specific files from the user's folder: ${paths.join(', ')}. Attach them to the post. If more visuals needed, generate additional with image_generate.`;
    }
    if (mediaMode === 'folder' && mediaFolder) {
      return `MEDIA: Browse folder "${mediaFolder}" using file_read/file_search tools, pick the best/most relevant images and videos for the post. Attach them. If folder is empty or no suitable media, generate with image_generate.`;
    }
    if (mediaMode === 'database' && selectedMedia.size > 0) {
      const paths = Array.from(selectedMedia);
      return `MEDIA: Use these existing assets from media_assets database: ${paths.join(', ')}. Attach them to the post. If more visuals needed, generate additional with image_generate.`;
    }
    return 'MEDIA: Auto-generate all visuals — image with image_generate (Flux Pro). NEVER post without media.';
  }, [mediaMode, selectedMedia, mediaFolder]);

  // ─── Render ────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── A) Platform Connection Status ── */}
      <div>
        <div style={{ ...S.sectionTitle, marginBottom: 12 }}>Platform Connections</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {configLoading ? (
            <span style={S.muted}>Loading platforms...</span>
          ) : (
            SOCIAL_PLATFORMS.map(p => {
              const connected = config?.[p.id as keyof SocialConfig] ?? false;
              return (
                <div
                  key={p.id}
                  style={{
                    ...S.card,
                    padding: '10px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minWidth: 140,
                    cursor: 'pointer',
                    borderColor: connected ? `${p.color}50` : undefined,
                    background: connected ? `${p.color}10` : undefined,
                  }}
                  onClick={() => {
                    // Could open config modal in future
                  }}
                >
                  <p.icon size={16} style={{ color: connected ? p.color : '#6b7280' }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: connected ? p.color : '#6b7280', fontFamily: 'var(--font-display)' }}>
                    {p.label}
                  </span>
                  {connected ? (
                    <CheckCircle size={14} style={{ color: '#10b981', marginLeft: 'auto' }} />
                  ) : (
                    <AlertCircle size={14} style={{ color: '#6b7280', marginLeft: 'auto' }} />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── B) AI Auto Composer ── */}
      <div style={S.card}>
        <div style={{ ...S.sectionTitle, marginBottom: 4 }}>AI Auto Composer</div>
        <div style={{ ...S.muted, marginBottom: 14, fontSize: 10 }}>Select product & platforms, AI generates and publishes automatically.</div>

        {/* Product selector */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ ...S.muted, marginBottom: 6 }}>Product</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {PRODUCTS.map(p => {
              const active = selectedProduct === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => setSelectedProduct(active ? '' : p.id)}
                  style={{
                    padding: '8px 16px', fontSize: 12, fontWeight: 700,
                    fontFamily: 'var(--font-display)', letterSpacing: 0.5,
                    border: `1px solid ${active ? '#f472b6' : 'var(--border-primary)'}`,
                    borderRadius: 6, cursor: 'pointer',
                    background: active ? 'rgba(244,114,182,0.15)' : 'rgba(255,255,255,0.04)',
                    color: active ? '#f472b6' : 'var(--text-muted)',
                    transition: 'all 0.15s',
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Platform toggles */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={S.muted}>Platforms</span>
            <button
              onClick={() => {
                if (selectedPlatforms.size === SOCIAL_PLATFORMS.length) {
                  setSelectedPlatforms(new Set());
                } else {
                  setSelectedPlatforms(new Set(SOCIAL_PLATFORMS.map(p => p.id)));
                }
              }}
              style={{ fontSize: 9, color: '#f472b6', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-display)', letterSpacing: 0.5 }}
            >
              {selectedPlatforms.size === SOCIAL_PLATFORMS.length ? 'DESELECT ALL' : 'SELECT ALL'}
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SOCIAL_PLATFORMS.map(p => {
              const active = selectedPlatforms.has(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => togglePlatform(p.id)}
                  style={{
                    padding: '6px 12px', fontSize: 11, fontWeight: 600,
                    fontFamily: 'var(--font-display)', letterSpacing: 0.5,
                    border: `1px solid ${active ? p.color : 'var(--border-primary)'}`,
                    borderRadius: 6, cursor: 'pointer',
                    background: active ? `${p.color}20` : 'rgba(255,255,255,0.04)',
                    color: active ? p.color : 'var(--text-muted)',
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    transition: 'all 0.15s',
                  }}
                >
                  <p.icon size={12} />
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Media Source Picker */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ ...S.muted, marginBottom: 6 }}>Media Source</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {([
              { id: 'auto' as MediaMode, label: 'AI Auto-Generate', icon: Zap, color: '#f472b6' },
              { id: 'folder' as MediaMode, label: 'From Folder', icon: Image, color: '#3b82f6' },
              { id: 'database' as MediaMode, label: 'From Database', icon: Database, color: '#8b5cf6' },
            ]).map(m => {
              const active = mediaMode === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => {
                    setMediaMode(m.id);
                    setSelectedMedia(new Set());
                    if (m.id === 'folder') browseFolder(mediaFolder);
                    if (m.id === 'database') fetchDbMedia();
                  }}
                  style={{
                    padding: '6px 14px', fontSize: 11, fontWeight: 600,
                    fontFamily: 'var(--font-display)', letterSpacing: 0.5,
                    border: `1px solid ${active ? m.color : 'var(--border-primary)'}`,
                    borderRadius: 6, cursor: 'pointer',
                    background: active ? `${m.color}20` : 'rgba(255,255,255,0.04)',
                    color: active ? m.color : 'var(--text-muted)',
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    transition: 'all 0.15s',
                  }}
                >
                  <m.icon size={12} />
                  {m.label}
                </button>
              );
            })}
          </div>

          {/* Folder browser */}
          {mediaMode === 'folder' && (
            <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, border: '1px solid var(--border-primary)', padding: 10 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <input
                  value={mediaFolder}
                  onChange={e => setMediaFolder(e.target.value)}
                  placeholder="/Volumes/Public/jarvis-nas/media"
                  style={{ ...S.input, flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)' }}
                  onKeyDown={e => { if (e.key === 'Enter') browseFolder(mediaFolder); }}
                />
                <button
                  onClick={() => browseFolder(mediaFolder)}
                  disabled={folderLoading}
                  style={{ ...S.btnSecondary, padding: '4px 10px', fontSize: 10 }}
                >
                  <Search size={11} />
                  Browse
                </button>
              </div>
              {folderLoading ? (
                <span style={{ ...S.muted, fontSize: 10 }}>Loading...</span>
              ) : folderFiles.length === 0 ? (
                <span style={{ ...S.muted, fontSize: 10 }}>No media files found. Enter a folder path and click Browse.</span>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ ...S.muted, fontSize: 10 }}>{folderFiles.length} files found</span>
                    {selectedMedia.size > 0 && (
                      <span style={{ fontSize: 10, color: '#10b981', fontFamily: 'var(--font-mono)' }}>
                        {selectedMedia.size} selected
                      </span>
                    )}
                    <button
                      onClick={() => {
                        if (selectedMedia.size === folderFiles.length) setSelectedMedia(new Set());
                        else setSelectedMedia(new Set(folderFiles.map(f => f.path)));
                      }}
                      style={{ fontSize: 9, color: '#3b82f6', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-display)' }}
                    >
                      {selectedMedia.size === folderFiles.length ? 'DESELECT ALL' : 'SELECT ALL'}
                    </button>
                  </div>
                  <div style={{ maxHeight: 160, overflow: 'auto', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {folderFiles.map(f => {
                      const sel = selectedMedia.has(f.path);
                      return (
                        <button
                          key={f.path}
                          onClick={() => toggleMediaFile(f.path)}
                          style={{
                            padding: '4px 8px', fontSize: 10, fontFamily: 'var(--font-mono)',
                            border: `1px solid ${sel ? (f.type === 'video' ? '#f59e0b' : '#3b82f6') : 'var(--border-dim)'}`,
                            borderRadius: 4, cursor: 'pointer',
                            background: sel ? (f.type === 'video' ? 'rgba(245,158,11,0.15)' : 'rgba(59,130,246,0.15)') : 'rgba(255,255,255,0.03)',
                            color: sel ? (f.type === 'video' ? '#f59e0b' : '#3b82f6') : 'var(--text-muted)',
                            display: 'flex', alignItems: 'center', gap: 4,
                          }}
                        >
                          {f.type === 'video' ? <Video size={10} /> : <Image size={10} />}
                          {f.name}
                          <span style={{ fontSize: 8, opacity: 0.6 }}>{(f.size / 1024 / 1024).toFixed(1)}MB</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Database media browser */}
          {mediaMode === 'database' && (
            <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, border: '1px solid var(--border-primary)', padding: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ ...S.muted, fontSize: 10 }}>media_assets table</span>
                <button onClick={fetchDbMedia} disabled={dbMediaLoading} style={{ ...S.btnSecondary, padding: '2px 8px', fontSize: 9 }}>
                  <RefreshCw size={10} style={dbMediaLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
                  Refresh
                </button>
                {selectedMedia.size > 0 && (
                  <span style={{ fontSize: 10, color: '#10b981', fontFamily: 'var(--font-mono)', marginLeft: 'auto' }}>
                    {selectedMedia.size} selected
                  </span>
                )}
              </div>
              {dbMediaLoading ? (
                <span style={{ ...S.muted, fontSize: 10 }}>Loading...</span>
              ) : dbMedia.length === 0 ? (
                <span style={{ ...S.muted, fontSize: 10 }}>No assets in media_assets table. Run a content batch to generate some.</span>
              ) : (
                <div style={{ maxHeight: 160, overflow: 'auto', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {dbMedia.map(m => {
                    const sel = selectedMedia.has(m.path);
                    const isVid = m.type?.includes('video');
                    return (
                      <button
                        key={m.id}
                        onClick={() => toggleMediaFile(m.path)}
                        style={{
                          padding: '4px 8px', fontSize: 10, fontFamily: 'var(--font-mono)',
                          border: `1px solid ${sel ? '#8b5cf6' : 'var(--border-dim)'}`,
                          borderRadius: 4, cursor: 'pointer',
                          background: sel ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.03)',
                          color: sel ? '#8b5cf6' : 'var(--text-muted)',
                          display: 'flex', alignItems: 'center', gap: 4,
                        }}
                      >
                        {isVid ? <Video size={10} /> : <Image size={10} />}
                        {m.filename || m.path.split('/').pop()}
                        {m.product && <span style={{ fontSize: 8, opacity: 0.6 }}>({m.product})</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Auto mode info */}
          {mediaMode === 'auto' && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', padding: '4px 0' }}>
              AI will auto-generate images (Flux Pro) and videos (Kling 3.0) matching the post content.
            </div>
          )}
        </div>

        {/* AI Auto Actions */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => {
              const product = selectedProduct ? PRODUCTS.find(p => p.id === selectedProduct)?.label ?? selectedProduct : 'all products';
              const platforms = selectedPlatforms.size > 0 ? Array.from(selectedPlatforms).join(', ') : 'all platforms';
              const media = getMediaInstruction();
              sendAgentCommand(`Generate a compelling social media post for ${product}. Steps: 1) web_search current trends in the niche 2) Write copy using product brand voice — strong hook, hashtags, CTA 3) Include product link/landing page URL in the post 4) Publish text + media to: ${platforms} using social_post tool 5) Store in content_library + media_assets database. ${media}`);
            }}
            disabled={posting}
            style={{ ...S.btnPrimary, opacity: posting ? 0.6 : 1 }}
          >
            <Zap size={14} />
            AI Post
          </button>
          <button
            onClick={() => {
              const product = selectedProduct ? PRODUCTS.find(p => p.id === selectedProduct)?.label ?? selectedProduct : 'all products';
              const platforms = selectedPlatforms.size > 0 ? Array.from(selectedPlatforms).join(', ') : 'all platforms';
              const media = getMediaInstruction();
              sendAgentCommand(`Create a short 5-second marketing video for ${product}. Steps: 1) web_search trending video formats and hooks 2) Write script: hook (3s) + value + CTA 3) Generate thumbnail image 4) Write engaging copy with hashtags, CTA, and product link 5) Publish video + text to: ${platforms} using social_post tool 6) Store in content_library + media_assets database. ${media}`);
            }}
            disabled={posting}
            style={S.btnSecondary}
          >
            <Video size={14} />
            AI Post + Video
          </button>
          <button
            onClick={() => {
              const product = selectedProduct ? PRODUCTS.find(p => p.id === selectedProduct)?.label ?? selectedProduct : 'all products';
              const platforms = selectedPlatforms.size > 0 ? Array.from(selectedPlatforms).join(', ') : 'Twitter, Instagram, TikTok, LinkedIn';
              const media = getMediaInstruction();
              sendAgentCommand(`Run full social autopilot for ${product}. FULL AUTO — no manual input. Steps: 1) web_search trending content + viral formats in product niche 2) Check media_assets and content_library for existing unused assets — reuse if relevant 3) Generate content batch: 5 posts, each with unique angle (educational, entertaining, social proof, behind-scenes, promotional) 4) For EACH post: attach media — alternate between image and video posts, NEVER post without media 5) Include product links/landing pages in every post 6) Publish all to: ${platforms} using social_post, respecting optimal posting times from product config 7) Store everything in content_library + media_assets database 8) Report: what was posted, where, with links. ${media}`);
            }}
            disabled={posting}
            style={{
              ...S.btnSecondary,
              borderColor: '#f472b6',
              color: '#f472b6',
              background: 'rgba(244,114,182,0.08)',
            }}
          >
            <Rocket size={14} />
            Full Autopilot (5 posts)
          </button>
        </div>

        {/* Schedule section */}
        <div style={{ marginTop: 14, borderTop: '1px solid var(--border-primary)', paddingTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Calendar size={12} style={{ color: 'var(--text-muted)' }} />
            <span style={S.muted}>Schedule for later</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="datetime-local"
              value={scheduleDate}
              onChange={e => setScheduleDate(e.target.value)}
              style={{ ...S.input, width: 220, fontSize: 11 }}
            />
            <button
              onClick={() => {
                if (!scheduleDate || selectedPlatforms.size === 0) {
                  setPostStatus({ text: 'Select platform(s) and pick a date', color: '#ef4444' });
                  return;
                }
                const product = selectedProduct ? PRODUCTS.find(p => p.id === selectedProduct)?.label ?? selectedProduct : 'all products';
                const platforms = Array.from(selectedPlatforms).join(', ');
                const schedAt = new Date(scheduleDate).toISOString();
                const media = getMediaInstruction();
                sendAgentCommand(`Generate a compelling post for ${product}. Steps: 1) web_search trends 2) Write copy with hashtags, hook, CTA, product link 3) SCHEDULE (not post now) text + media to: ${platforms} at ${schedAt} using social_schedule tool 4) Store in content_library + media_assets. ${media}`);
                setScheduleDate('');
              }}
              disabled={!scheduleDate}
              style={{
                ...S.btnSecondary,
                borderColor: scheduleDate ? '#10b981' : undefined,
                color: scheduleDate ? '#10b981' : undefined,
                opacity: scheduleDate ? 1 : 0.5,
              }}
            >
              <Clock size={12} />
              AI Generate & Schedule
            </button>
          </div>
        </div>

        {/* Optional manual override (collapsed) */}
        <div style={{ marginTop: 14, borderTop: '1px solid var(--border-primary)', paddingTop: 12 }}>
          <details>
            <summary style={{ ...S.muted, cursor: 'pointer', fontSize: 10, fontFamily: 'var(--font-display)', letterSpacing: 0.5 }}>
              MANUAL POST (override)
            </summary>
            <div style={{ marginTop: 10 }}>
              <textarea
                value={postText}
                onChange={e => setPostText(e.target.value)}
                placeholder="Write your own post text..."
                rows={3}
                style={{ ...S.input, resize: 'vertical', minHeight: 60, marginBottom: 10 }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={handlePost}
                  disabled={posting || !postText.trim() || selectedPlatforms.size === 0}
                  style={{ ...S.btnSecondary, opacity: posting || !postText.trim() ? 0.5 : 1 }}
                >
                  <Send size={12} />
                  {posting ? 'Posting...' : 'Post Now'}
                </button>
                <button
                  onClick={handleSchedule}
                  disabled={posting || !postText.trim() || selectedPlatforms.size === 0 || !scheduleDate}
                  style={{ ...S.btnSecondary, opacity: posting || !postText.trim() || !scheduleDate ? 0.5 : 1 }}
                >
                  <Calendar size={12} />
                  Schedule
                </button>
              </div>
            </div>
          </details>
        </div>

        {/* Status message */}
        {postStatus && (
          <div style={{ marginTop: 10, fontSize: 12, color: postStatus.color, fontFamily: 'var(--font-ui)' }}>
            {postStatus.text}
          </div>
        )}
      </div>

      {/* ── C) Scheduled Queue ── */}
      <div style={S.card}>
        <div style={{ ...S.row, justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={S.sectionTitle}>Scheduled Queue</div>
          <button onClick={fetchScheduled} style={{ ...S.btnSecondary, padding: '4px 10px', fontSize: 11 }}>
            <RefreshCw size={12} style={scheduledLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
            Refresh
          </button>
        </div>

        {scheduledLoading && scheduled.length === 0 ? (
          <div style={S.muted}>Loading scheduled posts...</div>
        ) : scheduled.length === 0 ? (
          <div style={S.emptyState}>
            <Calendar size={32} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
            <span>No scheduled posts</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {scheduled.map(post => {
              const platform = SOCIAL_PLATFORMS.find(p => p.id === post.platform);
              const pColor = platform?.color ?? '#6b7280';
              return (
                <div
                  key={post.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid var(--border-primary)',
                    borderRadius: 8,
                  }}
                >
                  <span style={S.badge(pColor)}>
                    {platform?.label ?? post.platform}
                  </span>
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {post.text.length > 80 ? post.text.slice(0, 80) + '...' : post.text}
                  </span>
                  <span style={{ ...S.muted, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <ClockIcon size={11} />
                    {new Date(post.scheduled_at).toLocaleString()}
                  </span>
                  <button
                    onClick={() => cancelScheduled(post.id)}
                    style={{
                      ...S.btnSecondary,
                      padding: '4px 8px',
                      fontSize: 11,
                      color: '#ef4444',
                      borderColor: '#ef444440',
                    }}
                    title="Cancel scheduled post"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── D) Agent Activity Feed ── */}
      <div style={S.card}>
        <div style={{ ...S.sectionTitle, marginBottom: 8 }}>Agent Activity</div>
        {lastCommand ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Activity size={14} style={{ color: '#f472b6', flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: 'var(--text-white)', marginBottom: 2 }}>
                {lastCommand.cmd.length > 100 ? lastCommand.cmd.slice(0, 100) + '...' : lastCommand.cmd}
              </div>
              <div style={S.muted}>
                {lastCommand.status} &middot; {lastCommand.time}
              </div>
            </div>
          </div>
        ) : (
          <div style={S.muted}>No recent agent activity. Use Quick Actions above to send commands.</div>
        )}
      </div>
    </div>
  );
}

// ─── Database Tab ────────────────────────────────────────

function DatabaseTab() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState('');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  useEffect(() => {
    (async () => {
      try {
        const t = await gateway.request<TableInfo[]>('marketing.db.tables', {});
        setTables(t);
        if (t.length > 0) setSelectedTable(t[0].name);
      } catch (err) { console.error('[MarketingHub]', err); }
    })();
  }, []);

  const loadTable = useCallback(async (table: string, offset = 0) => {
    if (!table) return;
    setLoading(true);
    try {
      const res = await gateway.request<QueryResult>('marketing.db.query', {
        table, limit: PAGE_SIZE, offset,
      });
      setQueryResult(res);
    } catch (err) { console.error('[MarketingHub]', err); }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (selectedTable) {
      setPage(0);
      loadTable(selectedTable, 0);
    }
  }, [selectedTable, loadTable]);

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    loadTable(selectedTable, newPage * PAGE_SIZE);
  };

  const columns = queryResult && queryResult.rows.length > 0
    ? Object.keys(queryResult.rows[0])
    : [];

  const totalPages = queryResult ? Math.ceil(queryResult.total / PAGE_SIZE) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Table selector + stats */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={S.row}>
          <Database size={14} style={{ color: '#f472b6' }} />
          <select
            value={selectedTable}
            onChange={e => setSelectedTable(e.target.value)}
            style={{ ...S.input, width: 'auto', minWidth: 180, padding: '6px 12px', fontSize: 12 }}
          >
            {tables.map(t => (
              <option key={t.name} value={t.name}>{t.name} ({t.rows} rows)</option>
            ))}
          </select>
        </div>
        <div style={S.row}>
          {queryResult && (
            <span style={S.muted}>
              {queryResult.total} total rows | Page {page + 1}/{totalPages || 1}
            </span>
          )}
          <button onClick={() => loadTable(selectedTable, page * PAGE_SIZE)} style={S.btnSecondary}>
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {/* Table overview chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {tables.map(t => (
          <div
            key={t.name}
            onClick={() => setSelectedTable(t.name)}
            style={{
              padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
              background: selectedTable === t.name ? 'rgba(244,114,182,0.15)' : 'rgba(255,255,255,0.04)',
              border: selectedTable === t.name ? '1px solid rgba(244,114,182,0.3)' : '1px solid var(--border-primary)',
              color: selectedTable === t.name ? '#f472b6' : 'var(--text-muted)',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              transition: 'all 0.15s',
            }}
          >
            {t.name} <span style={{ opacity: 0.6 }}>({t.rows})</span>
          </div>
        ))}
      </div>

      {/* Data table */}
      {queryResult && queryResult.rows.length > 0 && (
        <div style={{ overflow: 'auto', borderRadius: 8, border: '1px solid var(--border-primary)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            <thead>
              <tr>
                {columns.map(col => (
                  <th key={col} style={{
                    padding: '8px 10px', textAlign: 'left', fontWeight: 600,
                    borderBottom: '1px solid var(--border-primary)',
                    color: '#f472b6', background: 'rgba(244,114,182,0.05)',
                    whiteSpace: 'nowrap', letterSpacing: 0.3,
                  }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {queryResult.rows.map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  {columns.map(col => (
                    <td key={col} style={{
                      padding: '6px 10px', color: 'var(--text-secondary)',
                      maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {row[col] != null ? String(row[col]) : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>null</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {queryResult && queryResult.rows.length === 0 && (
        <div style={S.emptyState}>
          <Table size={24} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
          <span>Table "{selectedTable}" is empty</span>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => handlePageChange(page - 1)}
            disabled={page === 0}
            style={{ ...S.btnSecondary, opacity: page === 0 ? 0.3 : 1 }}
          >
            <ChevronLeft size={12} /> Prev
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => handlePageChange(page + 1)}
            disabled={page >= totalPages - 1}
            style={{ ...S.btnSecondary, opacity: page >= totalPages - 1 ? 0.3 : 1 }}
          >
            Next <ChevronRight size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── API Keys Tab ───────────────────────────────────────

const API_KEY_GROUPS = [
  {
    title: 'Media Creation',
    icon: '🎬',
    keys: [
      { id: 'FAL_API_KEY', label: 'fal.ai (Flux Pro)', desc: 'Image generation' },
      { id: 'OPENAI_API_KEY', label: 'OpenAI (DALL-E 3)', desc: 'Image generation' },
      { id: 'KLING_ACCESS_KEY', label: 'Kling 3.0 — Access Key', desc: 'Video generation' },
      { id: 'KLING_SECRET_KEY', label: 'Kling 3.0 — Secret Key', desc: '' },
      { id: 'RUNWAY_API_KEY', label: 'Runway Gen-4', desc: 'Premium video' },
      { id: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', desc: 'Voice & audio' },
      { id: 'HEYGEN_API_KEY', label: 'HeyGen', desc: 'Avatar videos' },
      { id: 'CREATOMATE_API_KEY', label: 'Creatomate', desc: 'Template video' },
    ],
  },
  {
    title: 'Social Media Posting',
    icon: '📢',
    keys: [
      { id: 'LATE_API_KEY', label: 'Late.dev', desc: 'Unified posting (13 platforms)' },
      { id: 'OPENTWEET_API_KEY', label: 'OpenTweet', desc: 'X/Twitter threads & bulk' },
      { id: 'META_ACCESS_TOKEN', label: 'Meta Graph API', desc: 'Instagram & Facebook' },
      { id: 'TIKTOK_ACCESS_TOKEN', label: 'TikTok', desc: 'Content Posting API' },
      { id: 'YOUTUBE_API_KEY', label: 'YouTube', desc: 'Data API v3' },
      { id: 'LINKEDIN_ACCESS_TOKEN', label: 'LinkedIn', desc: 'Posts API v2' },
      { id: 'PINTEREST_ACCESS_TOKEN', label: 'Pinterest', desc: 'Content API' },
    ],
  },
  {
    title: 'Email Automation',
    icon: '📧',
    keys: [
      { id: 'BREVO_API_KEY', label: 'Brevo', desc: 'Email marketing (ex-Sendinblue)' },
      { id: 'RESEND_API_KEY', label: 'Resend', desc: 'Developer-first email' },
    ],
  },
  {
    title: 'Lead Generation',
    icon: '🔍',
    keys: [
      { id: 'APOLLO_API_KEY', label: 'Apollo.io', desc: 'B2B contacts & enrichment' },
      { id: 'HUNTER_API_KEY', label: 'Hunter.io', desc: 'Email finder' },
    ],
  },
  {
    title: 'Analytics',
    icon: '📊',
    keys: [
      { id: 'WINDSOR_API_KEY', label: 'Windsor.ai', desc: 'Cross-platform attribution' },
    ],
  },
  {
    title: 'Twitter / X (Direct)',
    icon: '🐦',
    keys: [
      { id: 'TWITTER_API_KEY', label: 'API Key', desc: 'Twitter API v2' },
      { id: 'TWITTER_API_SECRET', label: 'API Secret', desc: '' },
      { id: 'TWITTER_ACCESS_TOKEN', label: 'Access Token', desc: '' },
      { id: 'TWITTER_ACCESS_TOKEN_SECRET', label: 'Access Token Secret', desc: '' },
      { id: 'TWITTER_BEARER_TOKEN', label: 'Bearer Token', desc: '' },
    ],
  },
];

function ApiKeysTab() {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showValues, setShowValues] = useState<Record<string, boolean>>({});

  useEffect(() => {
    (async () => {
      try {
        const res = await gateway.request<Record<string, string>>('marketing.apikeys.get', {});
        setKeys(res ?? {});
      } catch (err) { console.error('[MarketingHub]', err); }
      setLoading(false);
    })();
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    try {
      await gateway.request('marketing.apikeys.set', keys);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      console.error('Failed to save API keys', e);
    }
    setSaving(false);
  }, [keys]);

  const updateKey = useCallback((id: string, value: string) => {
    setKeys(prev => ({ ...prev, [id]: value }));
    setSaved(false);
  }, []);

  const toggleShow = useCallback((id: string) => {
    setShowValues(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const configuredCount = useMemo(() =>
    Object.values(keys).filter(v => v && v.trim()).length,
    [keys]);

  const totalCount = useMemo(() =>
    API_KEY_GROUPS.reduce((sum, g) => sum + g.keys.length, 0),
    []);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading API keys...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Key size={16} style={{ color: '#00ffff' }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
            API Keys Configuration
          </span>
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 8,
            background: configuredCount > 0 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
            color: configuredCount > 0 ? '#10b981' : '#ef4444',
            fontFamily: 'var(--font-mono)',
          }}>
            {configuredCount}/{totalCount} configured
          </span>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            ...S.btnPrimary,
            display: 'flex', alignItems: 'center', gap: 6,
            background: saved ? '#10b981' : undefined,
          }}
        >
          {saved ? <CheckCircle size={12} /> : <Save size={12} />}
          {saving ? 'Saving...' : saved ? 'Saved!' : 'Save All Keys'}
        </button>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Keys are stored on NAS and automatically loaded by Agent Johny on startup.
        After saving, restart Johny or wait for NAS sync (~15s).
      </div>

      {/* Key groups */}
      {API_KEY_GROUPS.map(group => (
        <div key={group.title} style={{
          background: 'var(--bg-secondary)', borderRadius: 8,
          border: '1px solid var(--border)', overflow: 'hidden',
        }}>
          <div style={{
            padding: '10px 14px', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'rgba(0,255,65,0.03)',
          }}>
            <span style={{ fontSize: 14 }}>{group.icon}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '0.02em' }}>
              {group.title}
            </span>
            <span style={{
              fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginLeft: 'auto',
            }}>
              {group.keys.filter(k => keys[k.id]?.trim()).length}/{group.keys.length}
            </span>
          </div>
          <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {group.keys.map(keyDef => {
              const val = keys[keyDef.id] || '';
              const isSet = val.trim().length > 0;
              const isVisible = showValues[keyDef.id];
              return (
                <div key={keyDef.id} style={{
                  display: 'grid', gridTemplateColumns: '180px 1fr auto', alignItems: 'center', gap: 8,
                  padding: '4px 0',
                }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {keyDef.label}
                    </div>
                    {keyDef.desc && (
                      <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{keyDef.desc}</div>
                    )}
                  </div>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <input
                      type={isVisible ? 'text' : 'password'}
                      value={val}
                      onChange={e => updateKey(keyDef.id, e.target.value)}
                      placeholder={keyDef.id}
                      spellCheck={false}
                      style={{
                        width: '100%', padding: '5px 30px 5px 8px',
                        background: 'var(--bg-primary)', border: '1px solid var(--border)',
                        borderRadius: 4, color: 'var(--text-primary)',
                        fontFamily: 'var(--font-mono)', fontSize: 11,
                        borderColor: isSet ? 'rgba(16,185,129,0.4)' : undefined,
                      }}
                    />
                    <button
                      onClick={() => toggleShow(keyDef.id)}
                      style={{
                        position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                        background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                        color: 'var(--text-muted)', display: 'flex',
                      }}
                    >
                      {isVisible ? <Eye size={12} /> : <EyeOff size={12} />}
                    </button>
                  </div>
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: isSet ? '#10b981' : 'rgba(255,255,255,0.1)',
                  }} />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
