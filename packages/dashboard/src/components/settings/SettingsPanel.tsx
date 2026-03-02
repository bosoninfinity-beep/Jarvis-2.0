import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../../gateway/client.js';

interface NetworkConfig {
  master: { ip: string; hostname: string; ports: { gateway: number; dashboard: number; nats: number; redis: number } };
  agents: {
    smith: { ip: string; user: string; role: string; vnc_port: number };
    johny: { ip: string; user: string; role: string; vnc_port: number };
  };
  nas: { ip: string; share: string; mount: string };
  thunderbolt?: {
    enabled: boolean;
    master_ip: string;
    smith_ip: string;
    johny_ip: string;
    nats_url: string;
  };
  auth_token: string;
  generated: string;
}

interface SettingsPanelProps {
  visible: boolean;
  onClose: () => void;
}

export function SettingsPanel({ visible, onClose }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<'network' | 'nas' | 'agents' | 'thunderbolt' | 'api'>('network');
  const [config, setConfig] = useState<NetworkConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Form states
  const [smithIp, setSmithIp] = useState('');
  const [johnyIp, setJohnyIp] = useState('');
  const [nasIp, setNasIp] = useState('');
  const [nasShare, setNasShare] = useState('');
  const [nasUser, setNasUser] = useState('');
  const [nasPass, setNasPass] = useState('');
  const [nasMount, setNasMount] = useState('');

  // Thunderbolt form states
  const [tbEnabled, setTbEnabled] = useState(false);
  const [tbMasterIp, setTbMasterIp] = useState('169.254.100.1');
  const [tbSmithIp, setTbSmithIp] = useState('169.254.100.2');
  const [tbJohnyIp, setTbJohnyIp] = useState('169.254.100.3');

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      const res = await authFetch('/api/config');
      if (res.ok) {
        const data = await res.json() as NetworkConfig;
        setConfig(data);
        setSmithIp(data.agents?.smith?.ip ?? '');
        setJohnyIp(data.agents?.johny?.ip ?? '');
        setNasIp(data.nas?.ip ?? '');
        setNasShare(data.nas?.share ?? '');
        setNasMount(data.nas?.mount ?? '');
        // Thunderbolt
        if (data.thunderbolt) {
          setTbEnabled(data.thunderbolt.enabled);
          setTbMasterIp(data.thunderbolt.master_ip || '169.254.100.1');
          setTbSmithIp(data.thunderbolt.smith_ip || '169.254.100.2');
          setTbJohnyIp(data.thunderbolt.johny_ip || '169.254.100.3');
        }
      }
    } catch {
      // config endpoint may not exist yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) void fetchConfig();
  }, [visible, fetchConfig]);

  const handleSave = async (section: string, data: Record<string, unknown>) => {
    try {
      setSaveMsg('Zapisywanie...');
      const res = await authFetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, ...data }),
      });
      if (res.ok) {
        setSaveMsg('Zapisano!');
        setTimeout(() => setSaveMsg(''), 2000);
      } else {
        setSaveMsg('Blad zapisu');
      }
    } catch {
      setSaveMsg('Blad polaczenia');
    }
  };

  if (!visible) return null;

  const tabs = [
    { id: 'network' as const, label: 'SIEC' },
    { id: 'nas' as const, label: 'NAS' },
    { id: 'agents' as const, label: 'AGENCI' },
    { id: 'thunderbolt' as const, label: 'THUNDERBOLT' },
    { id: 'api' as const, label: 'API KEYS' },
  ];

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.85)',
      backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        width: 700,
        maxHeight: '80vh',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-bright)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 0 30px rgba(0,255,65,0.1)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '12px 16px',
          borderBottom: '1px solid var(--border-primary)',
          background: 'var(--bg-tertiary)',
        }}>
          <span style={{
            fontFamily: 'var(--font-display)',
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: 2,
            color: 'var(--cyan-bright)',
          }}>
            SETTINGS
          </span>
          {saveMsg && (
            <span style={{
              marginLeft: 16,
              fontSize: 11,
              color: saveMsg === 'Zapisano!' ? 'var(--green-bright)' : 'var(--amber)',
              animation: 'fade-in 0.2s ease-out',
            }}>
              {saveMsg}
            </span>
          )}
          <button
            onClick={onClose}
            aria-label="Close settings"
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid var(--border-dim)',
              color: 'var(--text-muted)',
              padding: '2px 10px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            ESC
          </button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--border-primary)',
        }}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                flex: 1,
                padding: '8px 0',
                border: 'none',
                borderBottom: activeTab === tab.id ? '2px solid var(--green-bright)' : '2px solid transparent',
                borderRadius: 0,
                background: activeTab === tab.id ? 'var(--bg-card)' : 'transparent',
                color: activeTab === tab.id
                  ? (tab.id === 'thunderbolt' ? 'var(--amber)' : 'var(--green-bright)')
                  : 'var(--text-muted)',
                fontSize: 10,
                fontFamily: 'var(--font-display)',
                letterSpacing: 1.5,
                cursor: 'pointer',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: 20,
        }}>
          {loading ? (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>
              Ladowanie...
            </div>
          ) : (
            <>
              {activeTab === 'network' && (
                <div>
                  <SectionTitle>Konfiguracja sieci</SectionTitle>
                  <InfoRow label="Master IP" value={config?.master?.ip ?? 'Nieznane'} />
                  <InfoRow label="Hostname" value={config?.master?.hostname ?? 'Nieznane'} />
                  <InfoRow label="Gateway Port" value={String(config?.master?.ports?.gateway ?? 18900)} />
                  <InfoRow label="NATS Port" value={String(config?.master?.ports?.nats ?? 4222)} />
                  <InfoRow label="Redis Port" value={String(config?.master?.ports?.redis ?? 6379)} />

                  <SectionTitle style={{ marginTop: 20 }}>Adresy agentow</SectionTitle>
                  <FormRow label="Smith IP" value={smithIp} onChange={setSmithIp} placeholder="192.168.1.x lub hostname" />
                  <FormRow label="Johny IP" value={johnyIp} onChange={setJohnyIp} placeholder="192.168.1.x lub hostname" />

                  <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                    <button
                      className="primary"
                      onClick={() => void handleSave('agents', { smithIp, johnyIp })}
                      style={{ fontSize: 11, padding: '6px 16px' }}
                    >
                      ZAPISZ
                    </button>
                    <button
                      onClick={() => void handleSave('scan', {})}
                      style={{ fontSize: 11, padding: '6px 16px' }}
                    >
                      SKANUJ SIEC
                    </button>
                  </div>
                </div>
              )}

              {activeTab === 'nas' && (
                <div>
                  <SectionTitle>QNAP NAS Configuration</SectionTitle>
                  <FormRow label="NAS IP" value={nasIp} onChange={setNasIp} placeholder="192.168.1.x" />
                  <FormRow label="SMB Share" value={nasShare} onChange={setNasShare} placeholder="jarvis-nas" />
                  <FormRow label="Username" value={nasUser} onChange={setNasUser} placeholder="admin" />
                  <FormRow label="Password" value={nasPass} onChange={setNasPass} placeholder="••••••" type="password" />
                  <FormRow label="Mount Path" value={nasMount} onChange={setNasMount} placeholder="/Volumes/JarvisNAS/jarvis" />

                  <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                    <button
                      className="primary"
                      onClick={() => void handleSave('nas', { nasIp, nasShare, nasUser, nasPass, nasMount })}
                      style={{ fontSize: 11, padding: '6px 16px' }}
                    >
                      MONTUJ NAS
                    </button>
                    <button
                      onClick={() => void handleSave('nas_test', { nasIp })}
                      style={{ fontSize: 11, padding: '6px 16px' }}
                    >
                      TESTUJ POLACZENIE
                    </button>
                  </div>

                  <div style={{
                    marginTop: 16,
                    padding: 12,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-primary)',
                    borderRadius: 4,
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    lineHeight: 1.6,
                  }}>
                    <span style={{ color: 'var(--cyan-muted)' }}>INFO:</span> NAS jest montowany automatycznie po restarcie
                    przez launchd. Haslo przechowywane w macOS Keychain.
                    <br /><br />
                    Struktura: sessions/ workspace/ knowledge/ logs/ media/ config/
                  </div>
                </div>
              )}

              {activeTab === 'agents' && (
                <div>
                  <SectionTitle>Agent Smith (Developer)</SectionTitle>
                  <InfoRow label="IP" value={config?.agents?.smith?.ip || 'Nie skonfigurowany'} />
                  <InfoRow label="Rola" value="Developer - kod, React Native, deploy, DevOps" />
                  <InfoRow label="VNC Port" value={String(config?.agents?.smith?.vnc_port ?? 6080)} />

                  <SectionTitle style={{ marginTop: 20 }}>Agent Johny (Marketing)</SectionTitle>
                  <InfoRow label="IP" value={config?.agents?.johny?.ip || 'Nie skonfigurowany'} />
                  <InfoRow label="Rola" value="Marketing - social media, research, content" />
                  <InfoRow label="VNC Port" value={String(config?.agents?.johny?.vnc_port ?? 6081)} />

                  <div style={{ marginTop: 20, display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => void handleSave('deploy_smith', {})}
                      style={{ fontSize: 11, padding: '6px 16px' }}
                    >
                      DEPLOY SMITH
                    </button>
                    <button
                      onClick={() => void handleSave('deploy_johny', {})}
                      style={{ fontSize: 11, padding: '6px 16px' }}
                    >
                      DEPLOY JOHNY
                    </button>
                    <button
                      className="primary"
                      onClick={() => void handleSave('deploy_all', {})}
                      style={{ fontSize: 11, padding: '6px 16px' }}
                    >
                      DEPLOY ALL
                    </button>
                  </div>
                </div>
              )}

              {activeTab === 'thunderbolt' && (
                <div>
                  <SectionTitle>Thunderbolt Bridge Cluster (10 Gbps USB-C)</SectionTitle>

                  {/* Diagram */}
                  <div style={{
                    padding: 12,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--amber)',
                    borderRadius: 4,
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--amber)',
                    lineHeight: 1.8,
                    marginBottom: 16,
                    whiteSpace: 'pre',
                    overflow: 'auto',
                  }}>
{`       THUNDERBOLT (10 Gbps, direct cable)
  ┌──── USB-C ──── MASTER ──── USB-C ────┐
  │            (2-3 porty TB)             │
┌─▼──────┐                         ┌─────▼──┐
│ SMITH  │                         │ JOHNY  │
└─┬──────┘                         └─┬──────┘
  └──────── WiFi/ETH (internet) ─────┘`}
                  </div>

                  {/* Enable toggle */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '8px 0',
                    gap: 12,
                    marginBottom: 12,
                  }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11, width: 120 }}>Thunderbolt</span>
                    <button
                      onClick={() => setTbEnabled(!tbEnabled)}
                      style={{
                        padding: '4px 16px',
                        fontSize: 11,
                        fontFamily: 'var(--font-display)',
                        letterSpacing: 1,
                        background: tbEnabled ? 'rgba(255,170,0,0.2)' : 'transparent',
                        border: `1px solid ${tbEnabled ? 'var(--amber)' : 'var(--border-dim)'}`,
                        color: tbEnabled ? 'var(--amber)' : 'var(--text-muted)',
                        cursor: 'pointer',
                      }}
                    >
                      {tbEnabled ? 'ENABLED' : 'DISABLED'}
                    </button>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                      {tbEnabled ? 'NATS + VNC uzywa Thunderbolt (priorytet)' : 'Tylko WiFi/Ethernet'}
                    </span>
                  </div>

                  <SectionTitle style={{ marginTop: 8 }}>Adresy IP Thunderbolt Bridge</SectionTitle>
                  <FormRow label="Master IP" value={tbMasterIp} onChange={setTbMasterIp} placeholder="169.254.100.1" />
                  <FormRow label="Smith IP" value={tbSmithIp} onChange={setTbSmithIp} placeholder="169.254.100.2" />
                  <FormRow label="Johny IP" value={tbJohnyIp} onChange={setTbJohnyIp} placeholder="169.254.100.3" />

                  <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                    <button
                      className="primary"
                      onClick={() => void handleSave('thunderbolt', {
                        enabled: tbEnabled,
                        masterIp: tbMasterIp,
                        smithIp: tbSmithIp,
                        johnyIp: tbJohnyIp,
                        natsPort: '4223',
                      })}
                      style={{ fontSize: 11, padding: '6px 16px' }}
                    >
                      ZAPISZ
                    </button>
                    <button
                      onClick={() => void handleSave('thunderbolt_detect', {})}
                      style={{ fontSize: 11, padding: '6px 16px' }}
                    >
                      WYKRYJ KABLE
                    </button>
                  </div>

                  {/* Performance comparison */}
                  <div style={{
                    marginTop: 16,
                    padding: 12,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-primary)',
                    borderRadius: 4,
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    lineHeight: 1.8,
                  }}>
                    <span style={{ color: 'var(--amber)', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>PERFORMANCE</span>
                    <br />
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr', gap: '2px 16px', marginTop: 4 }}>
                      <span></span>
                      <span style={{ color: 'var(--text-muted)' }}>WiFi</span>
                      <span style={{ color: 'var(--text-muted)' }}>Ethernet</span>
                      <span style={{ color: 'var(--amber)' }}>Thunderbolt</span>

                      <span>Bandwidth</span>
                      <span>~400 Mbps</span>
                      <span>1 Gbps</span>
                      <span style={{ color: 'var(--amber)' }}>10 Gbps</span>

                      <span>Latency</span>
                      <span>~5ms</span>
                      <span>~1ms</span>
                      <span style={{ color: 'var(--amber)' }}>&lt;0.5ms</span>

                      <span>VNC</span>
                      <span>720p laggy</span>
                      <span>1080p OK</span>
                      <span style={{ color: 'var(--amber)' }}>4K smooth</span>

                      <span>NATS</span>
                      <span>~40k msg/s</span>
                      <span>~100k msg/s</span>
                      <span style={{ color: 'var(--amber)' }}>~500k msg/s</span>
                    </div>
                    <br />
                    <span style={{ color: 'var(--cyan-muted)' }}>INFO:</span> Podlacz Mac Mini kablem USB-C/Thunderbolt.
                    macOS automatycznie tworzy interfejs &quot;Thunderbolt Bridge&quot;.
                    Instalator przypisze statyczne IP z zakresu 169.254.100.x
                  </div>
                </div>
              )}

              {activeTab === 'api' && (
                <div>
                  <SectionTitle>Klucze API LLM</SectionTitle>
                  <div style={{
                    padding: 12,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-primary)',
                    borderRadius: 4,
                    fontSize: 11,
                    color: 'var(--amber)',
                    marginBottom: 16,
                  }}>
                    Ze wzgledow bezpieczenstwa klucze API edytuj bezposrednio w pliku .env
                    <br />
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--green-dim)' }}>
                      $ nano ~/Documents/Jarvis-2.0/jarvis/.env
                    </span>
                  </div>

                  <InfoRow label="Anthropic" value="ANTHROPIC_API_KEY" />
                  <InfoRow label="OpenAI" value="OPENAI_API_KEY" />
                  <InfoRow label="Google AI" value="GOOGLE_AI_API_KEY" />
                  <InfoRow label="OpenRouter" value="OPENROUTER_API_KEY" />
                  <InfoRow label="Ollama" value="Lokalne modele (darmowe) - brew install ollama" />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function SectionTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      fontFamily: 'var(--font-display)',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: 2,
      color: 'var(--green-muted)',
      marginBottom: 12,
      paddingBottom: 6,
      borderBottom: '1px solid var(--border-primary)',
      ...style,
    }}>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      padding: '5px 0',
      fontSize: 12,
    }}>
      <span style={{ width: 120, color: 'var(--text-muted)', fontSize: 11 }}>{label}</span>
      <span style={{ color: 'var(--text-white)', fontFamily: 'var(--font-mono)' }}>{value}</span>
    </div>
  );
}

function FormRow({ label, value, onChange, placeholder, type = 'text' }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      padding: '4px 0',
      gap: 8,
    }}>
      <span style={{ width: 100, color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1,
          padding: '4px 8px',
          fontSize: 12,
        }}
      />
    </div>
  );
}
