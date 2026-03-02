import { useEffect, useState } from 'react';
import { useGatewayStore } from '../store/gateway-store.js';
import { gateway, authFetch } from '../gateway/client.js';
import { Settings, Save, RotateCcw, Code, Eye } from 'lucide-react';

interface ConfigData {
  master?: {
    ip: string;
    hostname: string;
    ports: { gateway: number; dashboard: number; nats: number; redis: number };
  };
  agents?: Record<string, {
    ip: string;
    user: string;
    role: string;
    vnc_port: number;
  }>;
  nas?: {
    ip: string;
    share: string;
    mount: string;
  };
  thunderbolt?: {
    enabled: boolean;
    master_ip: string;
    smith_ip: string;
    johny_ip: string;
    nats_url?: string;
    nats_port?: number;
  };
}

export function ConfigView() {
  const connected = useGatewayStore((s) => s.connected);
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [rawJson, setRawJson] = useState('');
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editedConfig, setEditedConfig] = useState<ConfigData | null>(null);

  useEffect(() => {
    if (connected) {
      void loadConfig();
    }
  }, [connected]);

  const loadConfig = async () => {
    setLoading(true);
    try {
      // Try WS method first, fall back to HTTP
      let data: ConfigData;
      try {
        data = await gateway.request<ConfigData>('config.get');
      } catch {
        const res = await authFetch('/api/config');
        data = await res.json() as ConfigData;
      }
      setConfig(data);
      setEditedConfig(data);
      setRawJson(JSON.stringify(data, null, 2));
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      if (rawMode) {
        const parsed = JSON.parse(rawJson);
        await gateway.request('config.set', parsed);
      } else if (editedConfig) {
        await gateway.request('config.set', editedConfig);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      // ignore
    }
  };

  const updateField = (section: string, field: string, value: string | number | boolean) => {
    if (!editedConfig) return;
    setEditedConfig({
      ...editedConfig,
      [section]: {
        ...(editedConfig as Record<string, Record<string, unknown>>)[section],
        [field]: value,
      },
    });
  };

  return (
    <div style={{
      height: '100%',
      overflow: 'auto',
      padding: 20,
      background: 'var(--bg-primary)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <Settings size={20} color="var(--cyan-bright)" />
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 16,
          letterSpacing: 3,
          color: 'var(--cyan-bright)',
          textShadow: 'var(--glow-cyan)',
          margin: 0,
        }}>
          CONFIGURATION
        </h1>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            onClick={() => {
              setRawMode(!rawMode);
              if (!rawMode && editedConfig) {
                setRawJson(JSON.stringify(editedConfig, null, 2));
              }
            }}
            style={{
              fontSize: 9,
              padding: '4px 10px',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color: rawMode ? 'var(--amber)' : 'var(--text-muted)',
              borderColor: rawMode ? 'rgba(255,170,0,0.3)' : 'var(--border-dim)',
            }}
          >
            {rawMode ? <Eye size={10} /> : <Code size={10} />}
            {rawMode ? 'FORM VIEW' : 'RAW JSON'}
          </button>
          <button
            onClick={() => void loadConfig()}
            style={{ fontSize: 9, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <RotateCcw size={10} /> RELOAD
          </button>
          <button
            onClick={() => void handleSave()}
            className="primary"
            style={{
              fontSize: 9,
              padding: '4px 10px',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Save size={10} />
            {saved ? 'SAVED!' : 'SAVE'}
          </button>
        </div>
      </div>

      {loading && (
        <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          Loading configuration...
        </div>
      )}

      {/* Raw JSON Mode */}
      {rawMode && (
        <div style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          borderRadius: 6,
          overflow: 'hidden',
        }}>
          <textarea
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            style={{
              width: '100%',
              minHeight: 500,
              padding: 16,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              lineHeight: 1.6,
              background: 'var(--bg-secondary)',
              border: 'none',
              color: 'var(--text-primary)',
              resize: 'vertical',
              outline: 'none',
            }}
            spellCheck={false}
          />
        </div>
      )}

      {/* Form Mode */}
      {!rawMode && editedConfig && (
        <div style={{ display: 'grid', gap: 16 }}>
          {/* Master/Gateway */}
          <ConfigSection title="GATEWAY / MASTER">
            <ConfigField label="IP Address" value={editedConfig.master?.ip ?? ''} onChange={(v) => updateField('master', 'ip', v)} />
            <ConfigField label="Hostname" value={editedConfig.master?.hostname ?? ''} onChange={(v) => updateField('master', 'hostname', v)} />
            <ConfigField label="Gateway Port" value={String(editedConfig.master?.ports?.gateway ?? 18900)} onChange={(v) => updateField('master', 'ports', { ...editedConfig.master?.ports, gateway: Number(v) })} />
          </ConfigSection>

          {/* Agents */}
          <ConfigSection title="AGENTS">
            {editedConfig.agents && Object.entries(editedConfig.agents).map(([id, agent]) => (
              <div key={id} style={{
                padding: '8px 12px',
                background: 'var(--bg-card)',
                borderRadius: 4,
                marginBottom: 8,
              }}>
                <div style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-display)',
                  letterSpacing: 1,
                  color: 'var(--cyan-bright)',
                  marginBottom: 6,
                }}>
                  AGENT-{id.toUpperCase()}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <ConfigField label="IP" value={agent.ip ?? ''} onChange={(v) => {
                    const agents = { ...editedConfig.agents };
                    agents[id] = { ...agents[id], ip: v };
                    setEditedConfig({ ...editedConfig, agents });
                  }} />
                  <ConfigField label="User" value={agent.user ?? ''} onChange={(v) => {
                    const agents = { ...editedConfig.agents };
                    agents[id] = { ...agents[id], user: v };
                    setEditedConfig({ ...editedConfig, agents });
                  }} />
                  <ConfigField label="Role" value={agent.role ?? ''} onChange={(v) => {
                    const agents = { ...editedConfig.agents };
                    agents[id] = { ...agents[id], role: v };
                    setEditedConfig({ ...editedConfig, agents });
                  }} />
                  <ConfigField label="VNC Port" value={String(agent.vnc_port ?? 6080)} onChange={(v) => {
                    const agents = { ...editedConfig.agents };
                    agents[id] = { ...agents[id], vnc_port: Number(v) };
                    setEditedConfig({ ...editedConfig, agents });
                  }} />
                </div>
              </div>
            ))}
          </ConfigSection>

          {/* NAS */}
          <ConfigSection title="NAS STORAGE">
            <ConfigField label="NAS IP" value={editedConfig.nas?.ip ?? ''} onChange={(v) => updateField('nas', 'ip', v)} />
            <ConfigField label="Share" value={editedConfig.nas?.share ?? ''} onChange={(v) => updateField('nas', 'share', v)} />
            <ConfigField label="Mount Point" value={editedConfig.nas?.mount ?? ''} onChange={(v) => updateField('nas', 'mount', v)} />
          </ConfigSection>

          {/* Thunderbolt */}
          <ConfigSection title="THUNDERBOLT USB-C">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <label style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>
                ENABLED
              </label>
              <input
                type="checkbox"
                checked={editedConfig.thunderbolt?.enabled ?? false}
                onChange={(e) => updateField('thunderbolt', 'enabled', e.target.checked)}
                style={{ accentColor: 'var(--green-bright)' }}
              />
            </div>
            <ConfigField label="Master IP" value={editedConfig.thunderbolt?.master_ip ?? ''} onChange={(v) => updateField('thunderbolt', 'master_ip', v)} />
            <ConfigField label="Smith IP" value={editedConfig.thunderbolt?.smith_ip ?? ''} onChange={(v) => updateField('thunderbolt', 'smith_ip', v)} />
            <ConfigField label="Johny IP" value={editedConfig.thunderbolt?.johny_ip ?? ''} onChange={(v) => updateField('thunderbolt', 'johny_ip', v)} />
          </ConfigSection>
        </div>
      )}
    </div>
  );
}

function ConfigSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-primary)',
      borderRadius: 6,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '8px 14px',
        background: 'var(--bg-tertiary)',
        borderBottom: '1px solid var(--border-dim)',
        fontFamily: 'var(--font-display)',
        fontSize: 11,
        letterSpacing: 2,
        color: 'var(--green-bright)',
      }}>
        {title}
      </div>
      <div style={{ padding: 14, display: 'grid', gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

function ConfigField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label style={{
        display: 'block',
        fontSize: 9,
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-display)',
        letterSpacing: 1,
        marginBottom: 3,
      }}>
        {label.toUpperCase()}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          fontSize: 12,
          padding: '5px 10px',
        }}
      />
    </div>
  );
}
