/**
 * InstancesView — Connected instances, presence, and infrastructure status
 *
 * Shows:
 * - Gateway server info
 * - Connected dashboard clients
 * - Agent nodes (Smith, Johny) with real-time status
 * - Infrastructure services (NATS, Redis, NAS)
 * - Network topology visualization
 */

import { useState, useEffect } from 'react';
import {
  Server, Monitor, Cpu, HardDrive, Radio, Wifi, WifiOff,
  RefreshCw, Clock, Activity, Database, Globe, Box,
  CheckCircle2, XCircle, Loader2,
} from 'lucide-react';
import { gateway } from '../gateway/client.js';
import { useGatewayStore } from '../store/gateway-store.js';
import { formatUptime, formatRelative, formatBytes } from '../utils/formatters.js';

interface InstanceInfo {
  id: string;
  type: 'gateway' | 'agent' | 'dashboard' | 'service';
  name: string;
  status: 'online' | 'offline' | 'busy' | 'degraded';
  hostname?: string;
  ip?: string;
  uptime?: number;
  lastSeen: number;
  details: Record<string, unknown>;
}

export function InstancesView() {
  const connected = useGatewayStore((s) => s.connected);
  const health = useGatewayStore((s) => s.health);
  const agents = useGatewayStore((s) => s.agents);
  const [systemMetrics, setSystemMetrics] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = () => {
    setLoading(true);
    gateway.request('system.metrics').then((data) => {
      setSystemMetrics(data as Record<string, unknown>);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => {
    if (!connected) return;
    loadData();
    const iv = setInterval(loadData, 15000);
    return () => clearInterval(iv);
  }, [connected]);

  // Build instances list from health + agents
  const instances: InstanceInfo[] = [];

  // Gateway
  if (health) {
    instances.push({
      id: 'gateway',
      type: 'gateway',
      name: 'Jarvis Gateway',
      status: 'online',
      uptime: health.uptime,
      lastSeen: Date.now(),
      details: {
        version: health.version,
        port: 18900,
        clients: health.dashboard?.connectedClients ?? 0,
      },
    });
  }

  // Agents
  for (const [, agent] of agents) {
    instances.push({
      id: agent.identity.agentId,
      type: 'agent',
      name: `Agent ${agent.identity.agentId.split('-')[1]?.toUpperCase() ?? agent.identity.agentId}`,
      status: agent.status === 'idle' ? 'online' : agent.status === 'busy' ? 'busy' : 'offline',
      hostname: agent.identity.hostname,
      lastSeen: agent.lastHeartbeat,
      details: {
        role: agent.identity.role,
        machineId: agent.identity.machineId,
        completedTasks: agent.completedTasks,
        failedTasks: agent.failedTasks,
        activeTask: agent.activeTaskDescription,
      },
    });
  }

  // Dashboard (self)
  instances.push({
    id: 'dashboard',
    type: 'dashboard',
    name: 'Dashboard (this)',
    status: connected ? 'online' : 'offline',
    lastSeen: Date.now(),
    details: {
      userAgent: navigator.userAgent.substring(0, 60),
    },
  });

  // Infrastructure services
  if (health?.infrastructure) {
    const infra = health.infrastructure;
    instances.push({
      id: 'nats',
      type: 'service',
      name: 'NATS Message Bus',
      status: infra.nats ? 'online' : 'offline',
      lastSeen: Date.now(),
      details: { port: 4222 },
    });
    instances.push({
      id: 'redis',
      type: 'service',
      name: 'Redis State Store',
      status: infra.redis ? 'online' : 'offline',
      lastSeen: Date.now(),
      details: { port: 6379 },
    });
    instances.push({
      id: 'nas',
      type: 'service',
      name: 'NAS Storage',
      status: infra.nas?.mounted ? 'online' : 'offline',
      lastSeen: Date.now(),
      details: { path: infra.nas?.path },
    });
  }

  const onlineCount = instances.filter((i) => i.status === 'online' || i.status === 'busy').length;

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Server size={20} color="var(--cyan-bright)" />
          <div>
            <h1 style={{
              fontFamily: 'var(--font-display)', fontSize: 16,
              letterSpacing: 3, color: 'var(--text-primary)', margin: 0,
            }}>
              INSTANCES
            </h1>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '2px 0 0' }}>
              Connected nodes, services & infrastructure
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <StatusBadge count={onlineCount} total={instances.length} />
          <button
            onClick={loadData}
            disabled={loading}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', fontSize: 10,
              background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
              borderRadius: 4, cursor: 'pointer', color: 'var(--text-muted)',
            }}
          >
            <RefreshCw size={10} style={{ animation: loading ? 'cv-pulse 1s ease infinite' : 'none' }} />
            Refresh
          </button>
        </div>
      </div>

      {/* Topology overview */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: 16,
        marginBottom: 24,
      }}>
        {instances.map((inst) => (
          <InstanceCard key={inst.id} instance={inst} />
        ))}
      </div>

      {/* System metrics panel */}
      {systemMetrics && (
        <div style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          borderRadius: 8,
          padding: 20,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
          }}>
            <Activity size={14} color="var(--green-bright)" />
            <span style={{
              fontFamily: 'var(--font-display)', fontSize: 11,
              letterSpacing: 2, color: 'var(--green-bright)',
            }}>
              SYSTEM METRICS
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
            <MetricBox
              label="CPU"
              value={`${((systemMetrics.cpuUsage as number) ?? 0).toFixed(1)}%`}
              icon={<Cpu size={12} />}
              color="var(--cyan-bright)"
            />
            <MetricBox
              label="Memory"
              value={formatBytes((systemMetrics.memoryUsed as number) ?? 0)}
              sub={`/ ${formatBytes((systemMetrics.memoryTotal as number) ?? 0)}`}
              icon={<Box size={12} />}
              color="#c084fc"
            />
            <MetricBox
              label="Load Avg"
              value={((systemMetrics.loadAvg as number[]) ?? [0])[0]?.toFixed(2) ?? '0'}
              icon={<Activity size={12} />}
              color="var(--green-bright)"
            />
            <MetricBox
              label="Uptime"
              value={formatUptime(health?.uptime ?? 0)}
              icon={<Clock size={12} />}
              color="#fbbf24"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────

function StatusBadge({ count, total }: { count: number; total: number }) {
  const allGood = count === total;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 12,
      background: allGood ? 'rgba(0,255,65,0.08)' : 'rgba(251,191,36,0.08)',
      border: `1px solid ${allGood ? 'var(--green-dim)' : 'rgba(251,191,36,0.3)'}`,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: allGood ? '#00ff41' : '#fbbf24',
        boxShadow: `0 0 6px ${allGood ? 'rgba(0,255,65,0.5)' : 'rgba(251,191,36,0.5)'}`,
      }} />
      <span style={{
        fontSize: 10, fontWeight: 600,
        color: allGood ? 'var(--green-bright)' : '#fbbf24',
      }}>
        {count}/{total} online
      </span>
    </div>
  );
}

function InstanceCard({ instance }: { instance: InstanceInfo }) {
  const statusColors: Record<string, string> = {
    online: '#00ff41',
    busy: '#fbbf24',
    degraded: '#f97316',
    offline: '#ef4444',
  };

  const typeIcons: Record<string, typeof Server> = {
    gateway: Globe,
    agent: Cpu,
    dashboard: Monitor,
    service: Database,
  };

  const Icon = typeIcons[instance.type] ?? Server;
  const statusColor = statusColors[instance.status] ?? '#484f58';

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-primary)',
      borderRadius: 8,
      padding: 16,
      transition: 'border-color 0.2s',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 6,
          background: `${statusColor}10`,
          border: `1px solid ${statusColor}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={16} color={statusColor} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontSize: 11, fontWeight: 700, color: 'var(--text-primary)',
              letterSpacing: 0.5,
            }}>
              {instance.name}
            </span>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: statusColor,
              boxShadow: `0 0 6px ${statusColor}80`,
            }} />
          </div>
          <span style={{
            fontSize: 9, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: 1,
          }}>
            {instance.type} • {instance.status}
          </span>
        </div>
        {instance.status === 'online' ? (
          <Wifi size={12} color="var(--green-muted)" />
        ) : instance.status === 'busy' ? (
          <Loader2 size={12} color="#fbbf24" style={{ animation: 'cv-pulse 1s ease infinite' }} />
        ) : (
          <WifiOff size={12} color="var(--text-muted)" />
        )}
      </div>

      {/* Details */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        gap: '4px 12px', fontSize: 10,
      }}>
        {instance.hostname && (
          <>
            <span style={{ color: 'var(--text-muted)' }}>Hostname</span>
            <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
              {instance.hostname}
            </span>
          </>
        )}
        {instance.uptime != null && (
          <>
            <span style={{ color: 'var(--text-muted)' }}>Uptime</span>
            <span style={{ color: 'var(--text-primary)' }}>{formatUptime(instance.uptime)}</span>
          </>
        )}
        <span style={{ color: 'var(--text-muted)' }}>Last seen</span>
        <span style={{ color: 'var(--text-primary)' }}>{formatRelative(instance.lastSeen)}</span>

        {Object.entries(instance.details).map(([k, v]) => {
          if (v == null || v === '') return null;
          return (
            <DetailRow key={k} label={k} value={v} />
          );
        })}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: unknown }) {
  const display = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (display.length > 60) return null; // Skip very long values

  return (
    <>
      <span style={{ color: 'var(--text-muted)', textTransform: 'capitalize' }}>
        {label.replace(/([A-Z])/g, ' $1').trim()}
      </span>
      <span style={{
        color: 'var(--text-primary)',
        fontFamily: typeof value === 'number' ? 'var(--font-mono)' : 'inherit',
        fontSize: 9,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {display}
      </span>
    </>
  );
}

function MetricBox({ label, value, sub, icon, color }: {
  label: string; value: string; sub?: string;
  icon: React.ReactNode; color: string;
}) {
  return (
    <div style={{
      background: 'var(--bg-tertiary)',
      border: '1px solid var(--border-dim)',
      borderRadius: 6,
      padding: '10px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ color }}>{icon}</span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>
          {label}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 18, fontWeight: 700, color, fontFamily: 'var(--font-mono)' }}>
          {value}
        </span>
        {sub && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{sub}</span>
        )}
      </div>
    </div>
  );
}

