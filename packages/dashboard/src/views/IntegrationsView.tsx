import { useState, useEffect, useCallback, useRef } from 'react';
import { useGatewayStore } from '../store/gateway-store.js';
import { gateway } from '../gateway/client.js';
import {
  Puzzle,
  MessageCircle,
  Music,
  Home,
  Clock,
  RefreshCw,
  Play,
  Pause,
  SkipForward,
  Volume2,
  Lightbulb,
  Thermometer,
  Send,
  CalendarPlus,
  Calendar,
  List,
  Zap,
  Bell,
  Wifi,
  WifiOff,
  Plug,
  Check,
  X,
  Loader2,
  Key,
} from 'lucide-react';
import { formatTimeAgo } from '../utils/formatters.js';

// ─── Types ───────────────────────────────────────────────────────────

interface IntegrationStatus {
  imessage: { available: boolean; platform: string };
  spotify: { available: boolean; hasApi: boolean; mode: string };
  homeAssistant: { available: boolean; url?: string };
  cron: { available: boolean; jobCount: number };
  calendar: { available: boolean; platform: string };
}

// ─── Main View ───────────────────────────────────────────────────────

export function IntegrationsView() {
  const connected = useGatewayStore((s) => s.connected);
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [activeTab, setActiveTab] = useState<'mcp' | 'imessage' | 'spotify' | 'homeassistant' | 'cron' | 'calendar'>('mcp');
  const [lastPoll, setLastPoll] = useState<number>(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await gateway.request<IntegrationStatus>('integrations.status');
      setStatus(data);
      setLastPoll(Date.now());
    } catch {
      setStatus({
        imessage: { available: typeof navigator !== 'undefined', platform: 'darwin' },
        spotify: { available: true, hasApi: false, mode: 'local' },
        homeAssistant: { available: false },
        cron: { available: true, jobCount: 0 },
        calendar: { available: true, platform: 'darwin' },
      });
      setLastPoll(Date.now());
    }
  }, []);

  // Initial fetch + polling every 30s
  useEffect(() => {
    if (connected) {
      void fetchStatus();
      pollRef.current = setInterval(() => {
        void fetchStatus();
      }, 30_000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [connected, fetchStatus]);

  const integrations = [
    { id: 'mcp' as const, name: 'MCP Servers', icon: Plug, color: '#a78bfa', available: true },
    { id: 'imessage' as const, name: 'iMessage', icon: MessageCircle, color: 'var(--green-bright)', available: status?.imessage?.available ?? true },
    { id: 'spotify' as const, name: 'Spotify', icon: Music, color: '#1DB954', available: status?.spotify?.available ?? true },
    { id: 'homeassistant' as const, name: 'Home Assistant', icon: Home, color: '#41BDF5', available: status?.homeAssistant?.available ?? false },
    { id: 'cron' as const, name: 'Cron Scheduler', icon: Clock, color: 'var(--amber)', available: status?.cron?.available ?? true },
    { id: 'calendar' as const, name: 'Calendar', icon: Calendar, color: '#FF6B6B', available: status?.calendar?.available ?? true },
  ];

  const availableCount = integrations.filter(i => i.available).length;
  const totalCount = integrations.length;

  return (
    <div style={{
      height: '100%',
      overflow: 'auto',
      padding: 20,
      background: 'var(--bg-primary)',
    }}>
      {/* Page Title + Status Bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Puzzle size={20} color="var(--magenta)" />
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 16,
          letterSpacing: 3,
          color: 'var(--magenta)',
          textShadow: '0 0 10px rgba(255,0,200,0.3)',
          margin: 0,
        }}>
          INTEGRATIONS
        </h1>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Live status indicator */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 12,
            background: 'rgba(0,255,65,0.05)',
            border: '1px solid rgba(0,255,65,0.15)',
          }}>
            {connected ? <Wifi size={12} color="#00ff41" /> : <WifiOff size={12} color="#484f58" />}
            <span style={{
              fontSize: 9,
              fontFamily: 'var(--font-display)',
              letterSpacing: 1,
              color: connected ? 'var(--green-primary)' : 'var(--text-muted)',
            }}>
              {availableCount}/{totalCount} ACTIVE
            </span>
          </div>
          {lastPoll > 0 && (
            <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              polled {formatTimeAgo(lastPoll)}
            </span>
          )}
          <button
            onClick={() => void fetchStatus()}
            style={{
              background: 'none',
              border: '1px solid var(--border-primary)',
              borderRadius: 4,
              padding: '3px 8px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color: 'var(--text-muted)',
              fontSize: 9,
              fontFamily: 'var(--font-display)',
              letterSpacing: 0.5,
            }}
            title="Refresh status"
          >
            <RefreshCw size={10} /> REFRESH
          </button>
        </div>
      </div>

      {/* Integration Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: 10,
        marginBottom: 20,
      }}>
        {integrations.map((intg) => (
          <button
            key={intg.id}
            onClick={() => setActiveTab(intg.id)}
            style={{
              background: activeTab === intg.id ? 'var(--bg-secondary)' : 'rgba(13,17,23,0.5)',
              border: `1px solid ${activeTab === intg.id ? intg.color : 'var(--border-primary)'}`,
              borderRadius: 6,
              padding: '12px 14px',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'all 0.15s ease',
              outline: 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <intg.icon size={18} color={intg.color} />
              <div style={{ flex: 1 }}>
                <span style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 10,
                  letterSpacing: 1.5,
                  color: activeTab === intg.id ? intg.color : 'var(--text-secondary)',
                  display: 'block',
                }}>
                  {intg.name.toUpperCase()}
                </span>
                <span style={{
                  fontSize: 8,
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {intg.available ? 'connected' : 'offline'}
                </span>
              </div>
              <StatusDot available={intg.available} />
            </div>
          </button>
        ))}
      </div>

      {/* Active Integration Panel */}
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        borderRadius: 8,
        minHeight: 400,
        overflow: 'hidden',
      }}>
        {activeTab === 'mcp' && <McpPanel />}
        {activeTab === 'imessage' && <IMessagePanel />}
        {activeTab === 'spotify' && <SpotifyPanel />}
        {activeTab === 'homeassistant' && <HomeAssistantPanel />}
        {activeTab === 'cron' && <CronPanel />}
        {activeTab === 'calendar' && <CalendarPanel />}
      </div>
    </div>
  );
}

// ─── Status Dot ─────────────────────────────────────────────────────

function StatusDot({ available }: { available: boolean }) {
  return (
    <span style={{
      width: 8, height: 8, borderRadius: '50%',
      background: available ? '#00ff41' : '#484f58',
      boxShadow: available ? '0 0 8px rgba(0,255,65,0.5)' : 'none',
      display: 'inline-block',
      flexShrink: 0,
    }} />
  );
}

// ─── MCP Servers Panel ───────────────────────────────────────────────

interface McpServer {
  id: string;
  name: string;
  description: string;
  envKey: string;
  envType: 'toggle' | 'token';
  role: 'marketing' | 'dev' | 'all';
  color: string;
}

const MCP_SERVERS: McpServer[] = [
  { id: 'gmail', name: 'Gmail', description: 'Read/send emails — outreach, newsletters, follow-ups', envKey: 'GMAIL_MCP_ENABLED', envType: 'toggle', role: 'marketing', color: '#EA4335' },
  { id: 'gcal', name: 'Google Calendar', description: 'Content scheduling as calendar events', envKey: 'GOOGLE_CALENDAR_MCP_ENABLED', envType: 'toggle', role: 'marketing', color: '#4285F4' },
  { id: 'github', name: 'GitHub', description: 'Issues, PRs, repos — code management', envKey: 'GITHUB_PERSONAL_ACCESS_TOKEN', envType: 'token', role: 'dev', color: '#f0f6fc' },
  { id: 'firebase', name: 'Firebase', description: 'Firestore, Hosting, Functions deployment', envKey: 'FIREBASE_MCP_ENABLED', envType: 'toggle', role: 'dev', color: '#FFCA28' },
  { id: 'slack', name: 'Slack', description: 'Send messages, channel notifications', envKey: 'SLACK_MCP_ENABLED', envType: 'toggle', role: 'all', color: '#4A154B' },
  { id: 'stripe', name: 'Stripe', description: 'Payments, subscriptions, revenue data', envKey: 'STRIPE_MCP_ENABLED', envType: 'toggle', role: 'all', color: '#635BFF' },
];

function McpPanel() {
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});

  const fetchEnv = useCallback(async () => {
    try {
      const data = await gateway.request<{ variables: Record<string, string> }>('environment.list');
      setEnvVars(data?.variables ?? {});
    } catch {
      setEnvVars({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchEnv(); }, [fetchEnv]);

  const toggleServer = async (server: McpServer) => {
    setSaving(server.id);
    try {
      const isEnabled = envVars[server.envKey] === '1';
      if (isEnabled) {
        await gateway.request('environment.delete', { key: server.envKey });
      } else {
        await gateway.request('environment.set', { key: server.envKey, value: '1' });
      }
      await fetchEnv();
    } finally {
      setSaving(null);
    }
  };

  const saveToken = async (server: McpServer) => {
    const token = tokenInputs[server.id];
    if (!token) return;
    setSaving(server.id);
    try {
      await gateway.request('environment.set', { key: server.envKey, value: token });
      await fetchEnv();
      setTokenInputs(prev => ({ ...prev, [server.id]: '' }));
    } finally {
      setSaving(null);
    }
  };

  const removeToken = async (server: McpServer) => {
    setSaving(server.id);
    try {
      await gateway.request('environment.delete', { key: server.envKey });
      await fetchEnv();
    } finally {
      setSaving(null);
    }
  };

  const roleLabel = (role: string) => {
    switch (role) {
      case 'marketing': return 'JOHNY';
      case 'dev': return 'SMITH';
      default: return 'ALL';
    }
  };

  const roleColor = (role: string) => {
    switch (role) {
      case 'marketing': return '#ffaa00';
      case 'dev': return '#00ffff';
      default: return '#a78bfa';
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <PanelHeader icon={<Plug size={16} color="#a78bfa" />} title="MCP SERVERS" subtitle="Claude CLI native integrations (per agent role)" color="#a78bfa" />

      <InfoBox text="MCP servers are attached to Claude CLI agents based on their role. Toggle servers below — changes take effect on next agent task. Agents must be restarted for MCP changes to apply." show />

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {MCP_SERVERS.map((server) => {
          const isEnabled = server.envType === 'toggle'
            ? envVars[server.envKey] === '1'
            : !!envVars[server.envKey];
          const isSaving = saving === server.id;

          return (
            <div key={server.id} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 14px',
              background: isEnabled ? 'rgba(0,255,65,0.03)' : 'rgba(0,0,0,0.2)',
              border: `1px solid ${isEnabled ? server.color + '44' : 'var(--border-primary)'}`,
              borderRadius: 6,
              transition: 'all 0.15s ease',
            }}>
              {/* Status dot */}
              <StatusDot available={isEnabled} />

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 11,
                    letterSpacing: 1.5,
                    color: isEnabled ? server.color : 'var(--text-secondary)',
                  }}>
                    {server.name.toUpperCase()}
                  </span>
                  <span style={{
                    fontSize: 8,
                    fontFamily: 'var(--font-display)',
                    letterSpacing: 1,
                    padding: '1px 6px',
                    borderRadius: 3,
                    background: roleColor(server.role) + '15',
                    color: roleColor(server.role),
                    border: `1px solid ${roleColor(server.role)}33`,
                  }}>
                    {roleLabel(server.role)}
                  </span>
                </div>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {server.description}
                </span>
              </div>

              {/* Action */}
              {server.envType === 'toggle' ? (
                <button
                  onClick={() => void toggleServer(server)}
                  disabled={isSaving || loading}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 14px',
                    fontSize: 9,
                    fontFamily: 'var(--font-display)',
                    letterSpacing: 1,
                    color: isEnabled ? '#00ff41' : 'var(--text-muted)',
                    background: isEnabled ? 'rgba(0,255,65,0.08)' : 'rgba(0,0,0,0.3)',
                    border: `1px solid ${isEnabled ? '#00ff4133' : 'var(--border-primary)'}`,
                    borderRadius: 4,
                    cursor: isSaving ? 'wait' : 'pointer',
                    minWidth: 80,
                    justifyContent: 'center',
                  }}
                >
                  {isSaving ? <Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} /> :
                    isEnabled ? <><Check size={10} /> ENABLED</> : <><X size={10} /> DISABLED</>
                  }
                </button>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {isEnabled ? (
                    <>
                      <span style={{ fontSize: 9, color: '#00ff41', fontFamily: 'var(--font-mono)' }}>
                        {envVars[server.envKey]!.slice(0, 8)}...
                      </span>
                      <button
                        onClick={() => void removeToken(server)}
                        disabled={isSaving}
                        style={{
                          ...btnStyle,
                          padding: '4px 10px',
                          fontSize: 9,
                          color: '#ff6b6b',
                          borderColor: '#ff6b6b33',
                          background: 'rgba(255,107,107,0.05)',
                        }}
                      >
                        {isSaving ? <Loader2 size={10} /> : <X size={10} />} REMOVE
                      </button>
                    </>
                  ) : (
                    <>
                      <input
                        type="password"
                        placeholder="Paste token..."
                        value={tokenInputs[server.id] ?? ''}
                        onChange={(e) => setTokenInputs(prev => ({ ...prev, [server.id]: e.target.value }))}
                        style={{ ...inputStyle, width: 160, fontSize: 10 }}
                      />
                      <button
                        onClick={() => void saveToken(server)}
                        disabled={isSaving || !tokenInputs[server.id]}
                        style={{ ...btnStyle, padding: '4px 10px', fontSize: 9 }}
                      >
                        {isSaving ? <Loader2 size={10} /> : <Key size={10} />} SAVE
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{
        marginTop: 16,
        padding: 10,
        fontSize: 9,
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-mono)',
        lineHeight: 1.6,
        borderTop: '1px solid var(--border-primary)',
      }}>
        MCP (Model Context Protocol) servers give Claude CLI native access to external services.
        Each server runs as a subprocess inside the Claude CLI process — no custom tool code needed.
        Toggle: set env var to "1". Token: paste API token/key. Changes persist in NAS config.
      </div>
    </div>
  );
}

// ─── iMessage Panel ──────────────────────────────────────────────────

function IMessagePanel() {
  const [conversations, setConversations] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [sendText, setSendText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [result, setResult] = useState('');

  const callTool = async (action: string, params: Record<string, unknown> = {}) => {
    setLoading(true);
    try {
      const data = await gateway.request<{ result: string }>('tool.execute', {
        tool: 'imessage',
        params: { action, ...params },
      });
      return data?.result ?? JSON.stringify(data);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <PanelHeader icon={<MessageCircle size={16} color="var(--green-bright)" />} title="iMESSAGE" subtitle="macOS Messages.app integration" color="var(--green-bright)" />

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <ActionButton label="List Conversations" icon={<List size={12} />} onClick={async () => { const r = await callTool('conversations'); setConversations(r); }} loading={loading} />
        <ActionButton label="Unread Count" icon={<Zap size={12} />} onClick={async () => { const r = await callTool('unread'); setResult(r); }} loading={loading} />
      </div>

      <FormSection title="SEND MESSAGE">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input placeholder="Phone or email" value={sendTo} onChange={(e) => setSendTo(e.target.value)} style={inputStyle} />
          <input placeholder="Message text" value={sendText} onChange={(e) => setSendText(e.target.value)} style={{ ...inputStyle, flex: 2 }} />
          <button onClick={async () => { if (sendTo && sendText) { const r = await callTool('send', { to: sendTo, message: sendText }); setResult(r); setSendText(''); } }} style={btnStyle}>
            <Send size={12} /> SEND
          </button>
        </div>
      </FormSection>

      <FormSection title="SEARCH MESSAGES">
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="Search query..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <button onClick={async () => { if (searchQuery) { const r = await callTool('search', { query: searchQuery }); setResult(r); } }} style={btnStyle}>SEARCH</button>
        </div>
      </FormSection>

      {(conversations || result) && <pre style={preStyle}>{conversations || result}</pre>}
    </div>
  );
}

// ─── Spotify Panel ───────────────────────────────────────────────────

function SpotifyPanel() {
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const callTool = async (action: string, params: Record<string, unknown> = {}) => {
    setLoading(true);
    try {
      const data = await gateway.request<{ result: string }>('tool.execute', {
        tool: 'spotify',
        params: { action, ...params },
      });
      return data?.result ?? JSON.stringify(data);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    } finally {
      setLoading(false);
    }
  };

  // Auto-refresh now playing every 10s
  useEffect(() => {
    void callTool('status').then(setStatus);
    pollRef.current = setInterval(() => {
      void callTool('status').then(setStatus);
    }, 10_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  return (
    <div style={{ padding: 16 }}>
      <PanelHeader icon={<Music size={16} color="#1DB954" />} title="SPOTIFY" subtitle="Playback control + search" color="#1DB954" />

      <div style={{
        padding: 14,
        background: 'rgba(29,185,84,0.05)',
        border: '1px solid rgba(29,185,84,0.2)',
        borderRadius: 6,
        marginBottom: 16,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--text-secondary)',
        whiteSpace: 'pre-wrap',
        position: 'relative',
      }}>
        <div style={{
          position: 'absolute',
          top: 6,
          right: 8,
          fontSize: 8,
          color: 'rgba(29,185,84,0.5)',
          fontFamily: 'var(--font-display)',
          letterSpacing: 1,
        }}>
          NOW PLAYING ● LIVE
        </div>
        {status || 'Loading...'}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <ActionButton label="Play" icon={<Play size={12} />} onClick={async () => setStatus(await callTool('play'))} loading={loading} color="#1DB954" />
        <ActionButton label="Pause" icon={<Pause size={12} />} onClick={async () => setStatus(await callTool('pause'))} loading={loading} color="#1DB954" />
        <ActionButton label="Next" icon={<SkipForward size={12} />} onClick={async () => setStatus(await callTool('next'))} loading={loading} color="#1DB954" />
        <ActionButton label="Status" icon={<RefreshCw size={12} />} onClick={async () => setStatus(await callTool('status'))} loading={loading} color="#1DB954" />
        <ActionButton label="Vol 50%" icon={<Volume2 size={12} />} onClick={async () => setStatus(await callTool('volume', { volume: 50 }))} loading={loading} color="#1DB954" />
      </div>

      <FormSection title="SEARCH TRACKS (requires API token)">
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="Search artist or track..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <button onClick={async () => { if (searchQuery) { const r = await callTool('search', { query: searchQuery }); setSearchResults(r); } }} style={btnStyle}>SEARCH</button>
        </div>
      </FormSection>

      {searchResults && <pre style={preStyle}>{searchResults}</pre>}
    </div>
  );
}

// ─── Home Assistant Panel ────────────────────────────────────────────

function HomeAssistantPanel() {
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [entityId, setEntityId] = useState('');
  const [domain, setDomain] = useState('light');

  const callTool = async (action: string, params: Record<string, unknown> = {}) => {
    setLoading(true);
    try {
      const data = await gateway.request<{ result: string }>('tool.execute', {
        tool: 'home_assistant',
        params: { action, ...params },
      });
      return data?.result ?? JSON.stringify(data);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <PanelHeader icon={<Home size={16} color="#41BDF5" />} title="HOME ASSISTANT" subtitle="Smart home control via REST API" color="#41BDF5" />

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <ActionButton label="Status" icon={<Zap size={12} />} onClick={async () => setResult(await callTool('status'))} loading={loading} color="#41BDF5" />
        <ActionButton label="All Lights" icon={<Lightbulb size={12} />} onClick={async () => setResult(await callTool('states', { domain: 'light' }))} loading={loading} color="#41BDF5" />
        <ActionButton label="Climate" icon={<Thermometer size={12} />} onClick={async () => setResult(await callTool('states', { domain: 'climate' }))} loading={loading} color="#41BDF5" />
        <ActionButton label="Scenes" icon={<List size={12} />} onClick={async () => setResult(await callTool('scenes'))} loading={loading} color="#41BDF5" />
        <ActionButton label="Automations" icon={<Zap size={12} />} onClick={async () => setResult(await callTool('automations'))} loading={loading} color="#41BDF5" />
      </div>

      <FormSection title="ENTITY CONTROL">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select value={domain} onChange={(e) => setDomain(e.target.value)} style={{ ...inputStyle, width: 100 }}>
            <option value="light">light</option>
            <option value="switch">switch</option>
            <option value="climate">climate</option>
            <option value="cover">cover</option>
            <option value="fan">fan</option>
            <option value="lock">lock</option>
            <option value="media_player">media_player</option>
          </select>
          <input placeholder={`${domain}.entity_name`} value={entityId} onChange={(e) => setEntityId(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <button onClick={async () => { if (entityId) setResult(await callTool('toggle', { entity_id: entityId })); }} style={btnStyle}>TOGGLE</button>
          <button onClick={async () => { if (entityId) setResult(await callTool('turn_on', { entity_id: entityId })); }} style={{ ...btnStyle, borderColor: 'var(--green-dim)' }}>ON</button>
          <button onClick={async () => { if (entityId) setResult(await callTool('turn_off', { entity_id: entityId })); }} style={{ ...btnStyle, borderColor: 'var(--red-dim)' }}>OFF</button>
        </div>
      </FormSection>

      <FormSection title="LIST ENTITIES BY DOMAIN">
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={domain} onChange={(e) => setDomain(e.target.value)} style={{ ...inputStyle, width: 140 }}>
            {['light', 'switch', 'sensor', 'binary_sensor', 'climate', 'cover', 'fan', 'lock', 'media_player', 'automation', 'scene', 'person'].map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <button onClick={async () => setResult(await callTool('states', { domain }))} style={btnStyle}>LIST</button>
        </div>
      </FormSection>

      <InfoBox text="Set HASS_URL and HASS_TOKEN in .env to connect. Get a long-lived access token from: HA → Profile → Long-Lived Access Tokens." show={!result} />
      {result && <pre style={preStyle}>{result}</pre>}
    </div>
  );
}

// ─── Cron Panel ──────────────────────────────────────────────────────

function CronPanel() {
  const [jobs, setJobs] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');
  const [newName, setNewName] = useState('');
  const [newCron, setNewCron] = useState('');
  const [newAt, setNewAt] = useState('');
  const [newTask, setNewTask] = useState('');
  const [newAgent, setNewAgent] = useState('');

  const callTool = async (action: string, params: Record<string, unknown> = {}) => {
    setLoading(true);
    try {
      const data = await gateway.request<{ result: string }>('tool.execute', {
        tool: 'cron',
        params: { action, ...params },
      });
      return data?.result ?? JSON.stringify(data);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void callTool('list').then(setJobs);
  }, []);

  return (
    <div style={{ padding: 16 }}>
      <PanelHeader icon={<Clock size={16} color="var(--amber)" />} title="CRON SCHEDULER" subtitle="Scheduled & recurring tasks" color="var(--amber)" />

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <ActionButton label="List Jobs" icon={<List size={12} />} onClick={async () => setJobs(await callTool('list'))} loading={loading} color="var(--amber)" />
        <ActionButton label="Upcoming" icon={<Clock size={12} />} onClick={async () => setResult(await callTool('next'))} loading={loading} color="var(--amber)" />
        <ActionButton label="History" icon={<RefreshCw size={12} />} onClick={async () => setResult(await callTool('history'))} loading={loading} color="var(--amber)" />
      </div>

      <FormSection title="CREATE JOB" icon={<CalendarPlus size={12} color="var(--amber)" />}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <input placeholder="Job name" value={newName} onChange={(e) => setNewName(e.target.value)} style={inputStyle} />
          <input placeholder="Cron expr (0 9 * * 1-5)" value={newCron} onChange={(e) => setNewCron(e.target.value)} style={inputStyle} />
          <input placeholder="Or: ISO datetime" value={newAt} onChange={(e) => setNewAt(e.target.value)} style={inputStyle} />
          <input placeholder="Target agent" value={newAgent} onChange={(e) => setNewAgent(e.target.value)} style={{ ...inputStyle, width: 110 }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="Task instruction (what the agent should do)" value={newTask} onChange={(e) => setNewTask(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <button
            onClick={async () => {
              if (newName && newTask && (newCron || newAt)) {
                const r = await callTool('create', {
                  name: newName, task_instruction: newTask,
                  ...(newCron ? { cron: newCron } : { at: newAt }),
                  ...(newAgent ? { target_agent: newAgent } : {}),
                });
                setResult(r);
                void callTool('list').then(setJobs);
                setNewName(''); setNewCron(''); setNewAt(''); setNewTask(''); setNewAgent('');
              }
            }}
            style={btnStyle}
          >
            <CalendarPlus size={12} /> CREATE
          </button>
        </div>
        <div style={{ marginTop: 6, fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          Cron format: minute hour dayOfMonth month dayOfWeek (e.g., "0 9 * * 1-5" = weekdays 9AM, "*/30 * * * *" = every 30 min)
        </div>
      </FormSection>

      {jobs && <pre style={preStyle}>{jobs}</pre>}
      {result && <pre style={{ ...preStyle, marginTop: 12 }}>{result}</pre>}
    </div>
  );
}

// ─── Calendar Panel (NEW) ────────────────────────────────────────────

function CalendarPanel() {
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [eventTitle, setEventTitle] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [eventTime, setEventTime] = useState('');
  const [eventDuration, setEventDuration] = useState('60');
  const [reminderTitle, setReminderTitle] = useState('');
  const [reminderDue, setReminderDue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const callTool = async (action: string, params: Record<string, unknown> = {}) => {
    setLoading(true);
    try {
      const data = await gateway.request<{ result: string }>('tool.execute', {
        tool: 'calendar',
        params: { action, ...params },
      });
      return data?.result ?? JSON.stringify(data);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void callTool('events_today').then(setResult);
  }, []);

  return (
    <div style={{ padding: 16 }}>
      <PanelHeader icon={<Calendar size={16} color="#FF6B6B" />} title="CALENDAR & REMINDERS" subtitle="Apple Calendar + Reminders.app" color="#FF6B6B" />

      {/* Quick Actions */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <ActionButton label="Today's Events" icon={<Calendar size={12} />} onClick={async () => setResult(await callTool('events_today'))} loading={loading} color="#FF6B6B" />
        <ActionButton label="Upcoming" icon={<Clock size={12} />} onClick={async () => setResult(await callTool('events_upcoming', { days: 7 }))} loading={loading} color="#FF6B6B" />
        <ActionButton label="Calendars" icon={<List size={12} />} onClick={async () => setResult(await callTool('calendars'))} loading={loading} color="#FF6B6B" />
        <ActionButton label="Reminders" icon={<Bell size={12} />} onClick={async () => setResult(await callTool('reminders_incomplete'))} loading={loading} color="#FF6B6B" />
        <ActionButton label="All Reminders" icon={<List size={12} />} onClick={async () => setResult(await callTool('reminders_list'))} loading={loading} color="#FF6B6B" />
      </div>

      {/* Create Event */}
      <FormSection title="CREATE EVENT" icon={<CalendarPlus size={12} color="#FF6B6B" />}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input placeholder="Event title" value={eventTitle} onChange={(e) => setEventTitle(e.target.value)} style={{ ...inputStyle, flex: 2 }} />
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} style={{ ...inputStyle, width: 140 }} />
          <input type="time" value={eventTime} onChange={(e) => setEventTime(e.target.value)} style={{ ...inputStyle, width: 100 }} />
          <input placeholder="Duration (min)" value={eventDuration} onChange={(e) => setEventDuration(e.target.value)} style={{ ...inputStyle, width: 90 }} />
          <button
            onClick={async () => {
              if (eventTitle && eventDate) {
                const startDate = eventTime ? `${eventDate}T${eventTime}` : `${eventDate}T09:00`;
                const r = await callTool('event_create', {
                  title: eventTitle,
                  start_date: startDate,
                  duration_minutes: Number(eventDuration) || 60,
                });
                setResult(r);
                setEventTitle(''); setEventDate(''); setEventTime('');
              }
            }}
            style={btnStyle}
          >
            <CalendarPlus size={12} /> CREATE
          </button>
        </div>
      </FormSection>

      {/* Create Reminder */}
      <FormSection title="CREATE REMINDER" icon={<Bell size={12} color="#FF6B6B" />}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input placeholder="Reminder title" value={reminderTitle} onChange={(e) => setReminderTitle(e.target.value)} style={{ ...inputStyle, flex: 2 }} />
          <input type="datetime-local" value={reminderDue} onChange={(e) => setReminderDue(e.target.value)} style={{ ...inputStyle, width: 200 }} />
          <button
            onClick={async () => {
              if (reminderTitle) {
                const r = await callTool('reminder_create', {
                  title: reminderTitle,
                  ...(reminderDue ? { due_date: reminderDue } : {}),
                });
                setResult(r);
                setReminderTitle(''); setReminderDue('');
              }
            }}
            style={btnStyle}
          >
            <Bell size={12} /> ADD
          </button>
        </div>
      </FormSection>

      {/* Search Events */}
      <FormSection title="SEARCH EVENTS">
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="Search events..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <button onClick={async () => { if (searchQuery) setResult(await callTool('events_search', { query: searchQuery })); }} style={btnStyle}>SEARCH</button>
        </div>
      </FormSection>

      <InfoBox text="Requires macOS with Calendar.app and Reminders.app configured. Events and reminders are created via AppleScript." show={!result} />
      {result && <pre style={preStyle}>{result}</pre>}
    </div>
  );
}

// ─── Shared UI components ────────────────────────────────────────────

function PanelHeader({ icon, title, subtitle, color }: { icon: React.ReactNode; title: string; subtitle: string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
      {icon}
      <span style={{ fontFamily: 'var(--font-display)', fontSize: 13, letterSpacing: 2, color }}>{title}</span>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{subtitle}</span>
    </div>
  );
}

function FormSection({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      padding: 12,
      background: 'rgba(0,0,0,0.2)',
      borderRadius: 6,
      marginBottom: 12,
      border: '1px solid var(--border-primary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        {icon}
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function ActionButton({ label, icon, onClick, loading, color }: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  loading: boolean;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        fontSize: 10,
        fontFamily: 'var(--font-display)',
        letterSpacing: 1,
        color: color ?? 'var(--text-secondary)',
        background: 'rgba(0,0,0,0.3)',
        border: `1px solid ${color ? color + '33' : 'var(--border-primary)'}`,
        borderRadius: 4,
        cursor: loading ? 'wait' : 'pointer',
        opacity: loading ? 0.5 : 1,
        transition: 'all 0.15s ease',
      }}
    >
      {icon}
      {label.toUpperCase()}
    </button>
  );
}

function InfoBox({ text, show }: { text: string; show: boolean }) {
  if (!show) return null;
  return (
    <div style={{
      padding: 12,
      background: 'rgba(65,189,245,0.05)',
      border: '1px solid rgba(65,189,245,0.15)',
      borderRadius: 6,
      fontSize: 11,
      color: 'var(--text-muted)',
      fontFamily: 'var(--font-mono)',
      lineHeight: 1.5,
    }}>
      {text}
    </div>
  );
}

// ─── Shared styles ───────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  background: 'rgba(0,0,0,0.3)',
  border: '1px solid var(--border-primary)',
  borderRadius: 4,
  color: 'var(--text-secondary)',
  outline: 'none',
  minWidth: 120,
};

const btnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 14px',
  fontSize: 10,
  fontFamily: 'var(--font-display)',
  letterSpacing: 1,
  color: 'var(--cyan-bright)',
  background: 'rgba(0,255,255,0.05)',
  border: '1px solid var(--border-cyan)',
  borderRadius: 4,
  cursor: 'pointer',
};

const preStyle: React.CSSProperties = {
  padding: 14,
  background: 'rgba(0,0,0,0.4)',
  border: '1px solid var(--border-primary)',
  borderRadius: 6,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--text-secondary)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 400,
  overflow: 'auto',
  margin: 0,
  lineHeight: 1.5,
};
