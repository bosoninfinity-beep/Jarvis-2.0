import { useEffect, useState, useCallback } from 'react';
import { useGatewayStore } from '../store/gateway-store.js';
import { gateway } from '../gateway/client.js';
import {
  Key,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Shield,
  Save,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Copy,
} from 'lucide-react';
import { formatTimeAgo } from '../utils/formatters.js';

interface ApiKeyEntry {
  id: string;
  name: string;
  provider: string;
  keyPreview: string; // masked key like "sk-...abc123"
  addedAt: number;
  lastUsed?: number;
  status: 'active' | 'expired' | 'invalid';
}

interface ApiKeysConfig {
  keys: Array<{
    id: string;
    name: string;
    provider: string;
    key: string;
    addedAt: number;
    lastUsed?: number;
  }>;
}

const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic (Claude)', color: '#d97706', icon: '🤖' },
  { id: 'openai', name: 'OpenAI (GPT)', color: '#10a37f', icon: '🧠' },
  { id: 'google', name: 'Google (Gemini)', color: '#4285f4', icon: '💎' },
  { id: 'spotify', name: 'Spotify', color: '#1db954', icon: '🎵' },
  { id: 'homeassistant', name: 'Home Assistant', color: '#41bdf5', icon: '🏠' },
  { id: 'slack', name: 'Slack', color: '#611f69', icon: '💬' },
  { id: 'discord', name: 'Discord', color: '#5865f2', icon: '🎮' },
  { id: 'ntfy', name: 'ntfy.sh', color: '#009688', icon: '🔔' },
  { id: 'custom', name: 'Custom', color: '#6b7280', icon: '🔑' },
];

export function ApiKeysView() {
  const connected = useGatewayStore((s) => s.connected);
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [newKey, setNewKey] = useState({ name: '', provider: 'anthropic', key: '' });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const data = await gateway.request<ApiKeysConfig>('apikeys.list');
      if (data?.keys) {
        setKeys(data.keys.map(k => ({
          id: k.id,
          name: k.name,
          provider: k.provider,
          keyPreview: maskKey(k.key),
          addedAt: k.addedAt,
          lastUsed: k.lastUsed,
          status: 'active' as const,
        })));
      }
    } catch {
      // Load from local fallback - show env-based keys
      const envKeys: ApiKeyEntry[] = [];
      // These are just display indicators, no actual keys exposed
      envKeys.push({
        id: 'env-anthropic',
        name: 'Claude CLI (Max subscription)',
        provider: 'anthropic',
        keyPreview: '(Claude CLI)',
        addedAt: Date.now(),
        status: 'active',
      });
      setKeys(envKeys);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connected) void fetchKeys();
  }, [connected, fetchKeys]);

  const handleAddKey = async () => {
    if (!newKey.name || !newKey.key) return;
    setError(null);
    try {
      await gateway.request('apikeys.add', {
        name: newKey.name,
        provider: newKey.provider,
        key: newKey.key,
      });
      setNewKey({ name: '', provider: 'anthropic', key: '' });
      setShowAdd(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      void fetchKeys();
    } catch (err) {
      setError(`Failed to save key: ${(err as Error).message}`);
      setTimeout(() => setError(null), 5000);
    }
  };

  const handleDeleteKey = async (keyId: string) => {
    setError(null);
    try {
      await gateway.request('apikeys.delete', { id: keyId });
      void fetchKeys();
    } catch (err) {
      setError(`Failed to delete key: ${(err as Error).message}`);
      setTimeout(() => setError(null), 5000);
    }
  };

  const toggleReveal = (keyId: string) => {
    setRevealedKeys(prev => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  const copyKey = (keyId: string) => {
    // Just copy the preview (we don't expose full keys)
    const key = keys.find(k => k.id === keyId);
    if (key) {
      navigator.clipboard.writeText(key.keyPreview).catch(() => {});
      setCopiedId(keyId);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const getProvider = (id: string) => PROVIDERS.find(p => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];

  return (
    <div style={{
      height: '100%',
      overflow: 'auto',
      padding: 20,
      background: 'var(--bg-primary)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <Key size={20} color="var(--amber)" />
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 16,
          letterSpacing: 3,
          color: 'var(--amber)',
          textShadow: '0 0 8px rgba(255,170,0,0.4)',
          margin: 0,
        }}>
          API KEYS
        </h1>

        {saved && (
          <span style={{
            fontSize: 9, padding: '2px 8px', borderRadius: 3,
            background: 'rgba(0,255,65,0.1)', border: '1px solid var(--green-dim)',
            color: 'var(--green-bright)', fontFamily: 'var(--font-display)', letterSpacing: 1,
          }}>SAVED</span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => void fetchKeys()} style={{
            fontSize: 9, padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 4,
            background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)',
            borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer',
            fontFamily: 'var(--font-display)', letterSpacing: 1,
          }}>
            <RefreshCw size={10} /> REFRESH
          </button>
          <button onClick={() => setShowAdd(!showAdd)} style={{
            fontSize: 9, padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 4,
            background: showAdd ? 'rgba(0,255,255,0.08)' : 'rgba(0,255,65,0.08)',
            border: `1px solid ${showAdd ? 'var(--cyan-dim)' : 'var(--green-dim)'}`,
            borderRadius: 4, color: showAdd ? 'var(--cyan-bright)' : 'var(--green-bright)', cursor: 'pointer',
            fontFamily: 'var(--font-display)', letterSpacing: 1,
          }}>
            <Plus size={10} /> ADD KEY
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          background: 'rgba(255,60,60,0.06)',
          border: '1px solid rgba(255,60,60,0.3)',
          borderRadius: 6,
          marginBottom: 10,
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          color: 'var(--red-bright)',
        }}>
          <XCircle size={14} />
          {error}
        </div>
      )}

      {/* Security notice */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px',
        background: 'rgba(255,170,0,0.04)',
        border: '1px solid rgba(255,170,0,0.15)',
        borderRadius: 6,
        marginBottom: 16,
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        color: 'var(--amber)',
      }}>
        <Shield size={14} />
        Keys are stored encrypted on NAS. Environment variables take priority over stored keys.
      </div>

      {/* Add Key Form */}
      {showAdd && (
        <div style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-cyan)',
          borderRadius: 6,
          padding: 16,
          marginBottom: 16,
        }}>
          <div style={{
            fontSize: 11,
            fontFamily: 'var(--font-display)',
            letterSpacing: 2,
            color: 'var(--cyan-bright)',
            marginBottom: 12,
          }}>
            ADD NEW API KEY
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>
                NAME
              </label>
              <input
                value={newKey.name}
                onChange={(e) => setNewKey({ ...newKey, name: e.target.value })}
                placeholder="My Anthropic Key"
                style={{
                  width: '100%', fontSize: 11, padding: '5px 10px', marginTop: 3,
                  background: 'var(--bg-primary)', border: '1px solid var(--border-primary)',
                  borderRadius: 4, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)',
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>
                PROVIDER
              </label>
              <select
                value={newKey.provider}
                onChange={(e) => setNewKey({ ...newKey, provider: e.target.value })}
                style={{
                  width: '100%', fontSize: 11, padding: '5px 10px', marginTop: 3,
                  background: 'var(--bg-primary)', border: '1px solid var(--border-primary)',
                  borderRadius: 4, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)',
                }}
              >
                {PROVIDERS.map(p => (
                  <option key={p.id} value={p.id}>{p.icon} {p.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>
              API KEY
            </label>
            <input
              type="password"
              value={newKey.key}
              onChange={(e) => setNewKey({ ...newKey, key: e.target.value })}
              placeholder="sk-..."
              style={{
                width: '100%', fontSize: 11, padding: '5px 10px', marginTop: 3,
                background: 'var(--bg-primary)', border: '1px solid var(--border-primary)',
                borderRadius: 4, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleAddKey} style={{
              fontSize: 9, padding: '5px 14px', display: 'flex', alignItems: 'center', gap: 4,
              background: 'rgba(0,255,65,0.08)', border: '1px solid var(--green-dim)',
              borderRadius: 4, color: 'var(--green-bright)', cursor: 'pointer',
              fontFamily: 'var(--font-display)', letterSpacing: 1,
            }}>
              <Save size={10} /> SAVE KEY
            </button>
            <button onClick={() => setShowAdd(false)} style={{
              fontSize: 9, padding: '5px 14px',
              background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)',
              borderRadius: 4, color: 'var(--text-muted)', cursor: 'pointer',
              fontFamily: 'var(--font-display)', letterSpacing: 1,
            }}>
              CANCEL
            </button>
          </div>
        </div>
      )}

      {/* Keys List */}
      {loading && (
        <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          Loading API keys...
        </div>
      )}

      {!loading && keys.length === 0 && (
        <div style={{
          padding: 40,
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
        }}>
          No API keys configured. Add one to get started.
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {keys.map(key => {
          const provider = getProvider(key.provider);
          return (
            <div key={key.id} style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-primary)',
              borderRadius: 6,
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              {/* Provider icon */}
              <span style={{ fontSize: 20 }}>{provider.icon}</span>

              {/* Key info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <span style={{
                    fontSize: 12,
                    fontFamily: 'var(--font-display)',
                    letterSpacing: 1,
                    color: 'var(--text-white)',
                  }}>
                    {key.name}
                  </span>
                  <span style={{
                    fontSize: 8,
                    padding: '1px 6px',
                    borderRadius: 3,
                    background: `${provider.color}22`,
                    border: `1px solid ${provider.color}44`,
                    color: provider.color,
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {provider.name}
                  </span>
                  <StatusBadge status={key.status} />
                </div>
                <div style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {revealedKeys.has(key.id) ? key.keyPreview : '••••••••••••••••'}
                </div>
                <div style={{
                  fontSize: 8,
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)',
                  marginTop: 2,
                }}>
                  Added {new Date(key.addedAt).toLocaleDateString()}
                  {key.lastUsed && ` • Last used ${formatTimeAgo(key.lastUsed)}`}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 4 }}>
                <IconButton
                  icon={revealedKeys.has(key.id) ? <EyeOff size={12} /> : <Eye size={12} />}
                  onClick={() => toggleReveal(key.id)}
                  title={revealedKeys.has(key.id) ? 'Hide' : 'Reveal'}
                />
                <IconButton
                  icon={copiedId === key.id ? <CheckCircle size={12} /> : <Copy size={12} />}
                  onClick={() => copyKey(key.id)}
                  title="Copy"
                  color={copiedId === key.id ? 'var(--green-bright)' : undefined}
                />
                {!key.id.startsWith('env-') && (
                  <IconButton
                    icon={<Trash2 size={12} />}
                    onClick={() => void handleDeleteKey(key.id)}
                    title="Delete"
                    color="var(--red-bright)"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: 10,
        marginTop: 20,
      }}>
        <SummaryBox label="Total Keys" value={String(keys.length)} color="var(--amber)" />
        <SummaryBox label="Active" value={String(keys.filter(k => k.status === 'active').length)} color="var(--green-bright)" />
        <SummaryBox label="Providers" value={String(new Set(keys.map(k => k.provider)).size)} color="var(--cyan-bright)" />
      </div>
    </div>
  );
}

/* === Sub-components === */

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; icon: React.ReactNode }> = {
    active: { color: 'var(--green-bright)', icon: <CheckCircle size={8} /> },
    expired: { color: 'var(--amber)', icon: <AlertTriangle size={8} /> },
    invalid: { color: 'var(--red-bright)', icon: <XCircle size={8} /> },
  };
  const c = config[status] ?? config.active;

  return (
    <span style={{
      fontSize: 8,
      padding: '1px 5px',
      borderRadius: 3,
      background: `${c.color}11`,
      border: `1px solid ${c.color}33`,
      color: c.color,
      fontFamily: 'var(--font-display)',
      letterSpacing: 1,
      display: 'flex',
      alignItems: 'center',
      gap: 3,
    }}>
      {c.icon}
      {status.toUpperCase()}
    </span>
  );
}

function IconButton({ icon, onClick, title, color }: {
  icon: React.ReactNode;
  onClick: () => void;
  title: string;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 28,
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-primary)',
        borderRadius: 4,
        color: color ?? 'var(--text-muted)',
        cursor: 'pointer',
        padding: 0,
      }}
    >
      {icon}
    </button>
  );
}

function SummaryBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-primary)',
      borderRadius: 6,
      padding: '10px 12px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 18, fontFamily: 'var(--font-display)', color, fontWeight: 700 }}>
        {value}
      </div>
      <div style={{ fontSize: 8, fontFamily: 'var(--font-display)', color: 'var(--text-muted)', letterSpacing: 1, marginTop: 3 }}>
        {label.toUpperCase()}
      </div>
    </div>
  );
}

/* === Helpers === */

function maskKey(key: string): string {
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 5) + '•'.repeat(Math.max(0, key.length - 11)) + key.slice(-6);
}
