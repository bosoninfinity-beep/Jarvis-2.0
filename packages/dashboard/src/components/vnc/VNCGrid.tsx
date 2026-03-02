import { useState, useEffect, useCallback, useRef } from 'react';
import { VNCViewer } from './VNCViewer.js';
import { authFetch } from '../../gateway/client.js';
import { useGatewayStore } from '../../store/gateway-store.js';

interface VNCEndpoint {
  id: string;
  label: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  thunderbolt?: boolean;
  enabled?: boolean;
}

type VNCStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

const DEFAULT_ENDPOINTS: VNCEndpoint[] = [
  { id: 'smith', label: 'AGENT SMITH // DEV', host: '192.168.1.37', port: 6080, enabled: true },
  { id: 'johny', label: 'AGENT JOHNY // MARKETING', host: '192.168.1.32', port: 6081, enabled: false },
];

export function VNCGrid() {
  const connected = useGatewayStore((s) => s.connected);
  const [fullscreen, setFullscreen] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<VNCEndpoint[]>(DEFAULT_ENDPOINTS);
  const [endpointsLoaded, setEndpointsLoaded] = useState(false);
  const [thunderboltActive, setThunderboltActive] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, VNCStatus>>({});
  const [viewOnly, setViewOnly] = useState(false);

  // Fetch VNC endpoints from gateway — only once when first connected (not on every reconnect)
  const fetchedRef = useRef(false);
  useEffect(() => {
    if (!connected || fetchedRef.current) return;
    fetchedRef.current = true;
    const fetchVncEndpoints = async () => {
      try {
        const res = await authFetch('/api/vnc');
        if (res.ok) {
          const data = await res.json() as {
            endpoints: Record<string, { host: string; port: number; username?: string; password?: string; label: string; thunderbolt?: boolean }>;
            thunderboltEnabled?: boolean;
          };
          const fetched: VNCEndpoint[] = [];
          if (data.endpoints.smith) {
            fetched.push({
              id: 'smith',
              label: 'AGENT SMITH // DEV',
              host: data.endpoints.smith.host,
              port: data.endpoints.smith.port,
              username: data.endpoints.smith.username || undefined,
              password: data.endpoints.smith.password || undefined,
              thunderbolt: data.endpoints.smith.thunderbolt,
              enabled: true,
            });
          }
          if (data.endpoints.johny) {
            const johnyHost = data.endpoints.johny.host;
            const johnyConfigured = johnyHost !== 'localhost' && johnyHost !== '127.0.0.1' && johnyHost !== 'mac-mini-johny.local';
            fetched.push({
              id: 'johny',
              label: 'AGENT JOHNY // MARKETING',
              host: johnyHost,
              port: data.endpoints.johny.port,
              username: data.endpoints.johny.username || undefined,
              password: data.endpoints.johny.password || undefined,
              thunderbolt: data.endpoints.johny.thunderbolt,
              enabled: johnyConfigured,
            });
          }
          if (fetched.length > 0) setEndpoints(fetched);
          setThunderboltActive(!!data.thunderboltEnabled);
        }
      } catch {
        // Use defaults on error
      }
      setEndpointsLoaded(true);
    };
    void fetchVncEndpoints();
  }, [connected]);

  // Stable callback – never changes identity so VNCViewer won't re-render
  const handleStatusChange = useCallback((epId: string, status: VNCStatus) => {
    setStatuses((prev) => ({ ...prev, [epId]: status }));
  }, []);

  // Create stable per-endpoint callbacks (memoized by endpoint id)
  const statusCallbacksRef = useRef<Record<string, (s: VNCStatus) => void>>({});
  endpoints.forEach((ep) => {
    if (!statusCallbacksRef.current[ep.id]) {
      statusCallbacksRef.current[ep.id] = (s: VNCStatus) => handleStatusChange(ep.id, s);
    }
  });

  // Only show enabled endpoints (or the fullscreen one)
  const enabledEndpoints = endpoints.filter((e) => e.enabled !== false);
  const displayEndpoints = fullscreen
    ? enabledEndpoints.filter((e) => e.id === fullscreen)
    : enabledEndpoints;

  // Keyboard shortcut: Escape exits fullscreen
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && fullscreen) {
        e.preventDefault();
        setFullscreen(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fullscreen]);

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-primary)',
    }}>
      {/* VNC Header */}
      <div className="panel-header" style={{
        borderBottom: '1px solid var(--border-primary)',
        background: 'var(--bg-tertiary)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 10px',
        height: 28,
        minHeight: 28,
      }}>
        <span style={{ color: 'var(--cyan-bright)' }}>&gt;&gt;</span>
        <span style={{
          fontFamily: 'var(--font-display)',
          fontSize: 10,
          letterSpacing: 1.5,
          color: 'var(--text-primary)',
        }}>
          REMOTE CONTROL
        </span>
        {thunderboltActive && (
          <span style={{
            fontSize: 8,
            padding: '1px 5px',
            background: 'rgba(255,170,0,0.15)',
            border: '1px solid var(--amber)',
            color: 'var(--amber)',
            borderRadius: 3,
            letterSpacing: 1,
            fontFamily: 'var(--font-display)',
          }}>
            USB-C 5G
          </span>
        )}

        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          {/* View Only Toggle */}
          <button
            onClick={() => setViewOnly(!viewOnly)}
            style={{
              fontSize: 8, padding: '1px 6px',
              border: `1px solid ${viewOnly ? 'var(--amber)' : 'var(--border-dim)'}`,
              background: viewOnly ? 'rgba(255,170,0,0.1)' : 'transparent',
              color: viewOnly ? 'var(--amber)' : 'var(--text-muted)',
              cursor: 'pointer', borderRadius: 2,
              fontFamily: 'var(--font-mono)',
            }}
            title="Toggle view-only mode (no keyboard/mouse input)"
          >
            {viewOnly ? 'VIEW ONLY' : 'INTERACTIVE'}
          </button>

          {fullscreen && (
            <button onClick={() => setFullscreen(null)} style={{
              fontSize: 9, padding: '2px 8px',
              background: 'rgba(0,255,255,0.1)',
              border: '1px solid var(--cyan-dim)',
              color: 'var(--cyan-bright)',
              cursor: 'pointer', borderRadius: 2,
            }}>
              GRID VIEW
            </button>
          )}
        </span>
      </div>

      {/* VNC Viewers Grid */}
      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: fullscreen ? '1fr' : `repeat(${endpoints.length}, 1fr)`,
        gap: 1,
        background: 'var(--border-dim)',
        overflow: 'hidden',
      }}>
        {displayEndpoints.map((ep) => {
          const epStatus = statuses[ep.id] ?? 'disconnected';

          return (
            <div key={ep.id} style={{
              position: 'relative',
              background: 'var(--bg-primary)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}>
              {/* VNC Toolbar per viewer */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 8px',
                background: 'var(--bg-card)',
                borderBottom: '1px solid var(--border-primary)',
                fontSize: 10,
                minHeight: 22,
              }}>
                {/* Status dot */}
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: epStatus === 'connected'
                    ? 'var(--green-bright)'
                    : epStatus === 'connecting'
                      ? 'var(--amber)'
                      : 'var(--red-bright)',
                  boxShadow: epStatus === 'connected'
                    ? '0 0 6px rgba(0,255,65,0.5)'
                    : epStatus === 'connecting'
                      ? '0 0 6px rgba(255,170,0,0.5)'
                      : '0 0 6px rgba(255,50,50,0.3)',
                  flexShrink: 0,
                }} />

                {/* Label */}
                <span style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 9,
                  letterSpacing: 1.5,
                  color: ep.id === 'smith' ? 'var(--cyan-bright)' : 'var(--purple)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {ep.label}
                </span>

                {/* TB badge */}
                {ep.thunderbolt && (
                  <span style={{
                    fontSize: 7,
                    color: 'var(--amber)',
                    fontFamily: 'var(--font-display)',
                    letterSpacing: 1,
                    padding: '0px 3px',
                    border: '1px solid rgba(255,170,0,0.3)',
                    borderRadius: 2,
                  }}>
                    USB-C
                  </span>
                )}

                {/* Connection info */}
                <span style={{
                  fontSize: 8,
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {ep.host}:{ep.port}
                </span>

                {/* Buttons */}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
                  {!viewOnly && epStatus === 'connected' && (
                    <span style={{
                      fontSize: 7,
                      color: 'var(--green-bright)',
                      fontFamily: 'var(--font-display)',
                      letterSpacing: 1,
                      opacity: 0.7,
                    }}>
                      KVM
                    </span>
                  )}
                  <button
                    onClick={() => setFullscreen(fullscreen === ep.id ? null : ep.id)}
                    style={{
                      fontSize: 8, padding: '1px 6px',
                      border: '1px solid var(--border-dim)',
                      background: fullscreen === ep.id ? 'rgba(0,255,255,0.1)' : 'transparent',
                      color: fullscreen === ep.id ? 'var(--cyan-bright)' : 'var(--text-muted)',
                      cursor: 'pointer', borderRadius: 2,
                    }}
                  >
                    {fullscreen === ep.id ? 'EXIT' : 'MAX'}
                  </button>
                </span>
              </div>

              {/* VNC Canvas — only connect after credentials loaded from API */}
              <div style={{ flex: 1, overflow: 'hidden' }}>
                {endpointsLoaded ? (
                  <VNCViewer
                    host={ep.host}
                    port={ep.port}
                    id={ep.id}
                    target={ep.id}
                    username={ep.username}
                    password={ep.password}
                    viewOnly={viewOnly}
                    onStatusChange={statusCallbacksRef.current[ep.id]}
                  />
                ) : (
                  <div style={{
                    width: '100%', height: '100%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--text-muted)', fontSize: 11,
                    fontFamily: 'var(--font-display)', letterSpacing: 2,
                  }}>
                    {connected ? 'LOADING VNC...' : 'WAITING FOR GATEWAY...'}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Show disabled (not configured) endpoints as placeholders */}
        {!fullscreen && endpoints.filter((e) => e.enabled === false).map((ep) => (
          <div key={ep.id} style={{
            position: 'relative',
            background: 'var(--bg-primary)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 8px',
              background: 'var(--bg-card)',
              borderBottom: '1px solid var(--border-primary)',
              fontSize: 10,
              minHeight: 22,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--text-muted)',
                opacity: 0.4,
                flexShrink: 0,
              }} />
              <span style={{
                fontFamily: 'var(--font-display)',
                fontSize: 9,
                letterSpacing: 1.5,
                color: 'var(--text-muted)',
                opacity: 0.6,
              }}>
                {ep.label}
              </span>
              <span style={{
                fontSize: 8,
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                opacity: 0.4,
              }}>
                NOT CONFIGURED
              </span>
            </div>
            <div style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: 8,
            }}>
              <div style={{
                fontFamily: 'var(--font-display)',
                fontSize: 12,
                color: 'var(--text-muted)',
                letterSpacing: 2,
                opacity: 0.4,
              }}>
                AWAITING SETUP
              </div>
              <div style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                opacity: 0.3,
                fontFamily: 'var(--font-mono)',
              }}>
                Configure VNC in Settings
              </div>
              {/* Decorative grid */}
              <div style={{
                position: 'absolute', inset: 0,
                backgroundImage:
                  'linear-gradient(rgba(0,255,65,0.015) 1px, transparent 1px),' +
                  'linear-gradient(90deg, rgba(0,255,65,0.015) 1px, transparent 1px)',
                backgroundSize: '30px 30px',
                pointerEvents: 'none',
              }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
