import { createLogger, HEARTBEAT_INTERVAL, type AgentId } from '@jarvis/shared';
import type { RedisClient } from '../redis/client.js';

const log = createLogger('monitoring:health');

const AGENT_TIMEOUT_MS = HEARTBEAT_INTERVAL * 3; // 3 missed heartbeats = offline
const CHECK_INTERVAL_MS = 15_000; // Check every 15 seconds
const BYTES_PER_MB = 1_048_576;

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'critical';
  timestamp: number;
  uptime: number;
  agents: Record<string, AgentHealth>;
  infrastructure: {
    nats: boolean;
    redis: boolean;
    nas: { mounted: boolean; freeSpaceGb?: number };
  };
  metrics: SystemMetrics;
}

export interface AgentHealth {
  id: string;
  status: 'online' | 'busy' | 'offline' | 'error';
  lastHeartbeat: number;
  activeTask?: string;
  completedTasks: number;
  failedTasks: number;
  uptimeMs: number;
  memoryUsageMb?: number;
}

export interface SystemMetrics {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeTasks: number;
  pendingTasks: number;
  totalTokensUsed: number;
  estimatedCostUsd: number;
}

export interface CostEntry {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: number;
}

/**
 * HealthMonitor - Tracks system health, agent status, and costs.
 *
 * Runs periodic health checks and aggregates metrics.
 */
export class HealthMonitor {
  private readonly startTime = Date.now();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private readonly agentHeartbeats = new Map<string, number>();
  private readonly agentStats = new Map<string, { completed: number; failed: number; startTime: number; memory?: number; cpuLoad?: number; memoryPercent?: number }>();
  private costLog: CostEntry[] = [];
  private natsHealthy = false;
  private nasHealthy = false;
  private nasFreeSpaceGb?: number;

  constructor(
    private redis: RedisClient | null,
    private nasMountPath: string,
  ) {}

  start(): void {
    this.checkInterval = setInterval(() => {
      this.checkAgentTimeouts();
    }, CHECK_INTERVAL_MS);

    log.info('Health monitor started');
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /** Record agent heartbeat */
  recordHeartbeat(agentId: string, data: { memoryUsage?: number; uptime?: number; cpuLoad?: number; memoryPercent?: number }): void {
    this.agentHeartbeats.set(agentId, Date.now());

    if (!this.agentStats.has(agentId)) {
      this.agentStats.set(agentId, { completed: 0, failed: 0, startTime: Date.now() });
    }
    const stats = this.agentStats.get(agentId)!;
    if (data.memoryUsage) stats.memory = data.memoryUsage;
    if (data.cpuLoad !== undefined) stats.cpuLoad = data.cpuLoad;
    if (data.memoryPercent !== undefined) stats.memoryPercent = data.memoryPercent;
  }

  /** Get agent load metrics for smart routing */
  getAgentLoad(agentId: string): { cpuLoad: number; memoryPercent: number; isOverloaded: boolean } | null {
    const stats = this.agentStats.get(agentId);
    if (!stats) return null;
    const lastHeartbeat = this.agentHeartbeats.get(agentId) ?? 0;
    const isOnline = (Date.now() - lastHeartbeat) < AGENT_TIMEOUT_MS;
    if (!isOnline) return null;

    const cpuLoad = stats.cpuLoad ?? 0;
    const memoryPercent = stats.memoryPercent ?? 0;
    return {
      cpuLoad,
      memoryPercent,
      isOverloaded: cpuLoad > 85 || memoryPercent > 90,
    };
  }

  /** Record task completion */
  recordTaskCompleted(agentId: string): void {
    const stats = this.agentStats.get(agentId);
    if (stats) stats.completed++;
  }

  /** Record task failure */
  recordTaskFailed(agentId: string): void {
    const stats = this.agentStats.get(agentId);
    if (stats) stats.failed++;
  }

  /** Record LLM usage for cost tracking */
  recordUsage(entry: CostEntry): void {
    this.costLog.push(entry);
    // Cap cost log to prevent unbounded memory growth
    if (this.costLog.length > 10_000) {
      this.costLog = this.costLog.slice(-5_000);
    }
  }

  /** Update infrastructure status */
  updateNatsStatus(healthy: boolean): void {
    this.natsHealthy = healthy;
  }

  updateNasStatus(healthy: boolean, freeSpaceGb?: number): void {
    this.nasHealthy = healthy;
    this.nasFreeSpaceGb = freeSpaceGb;
  }

  /** Get full system health snapshot */
  getHealth(activeTasksByAgent: Record<string, string | undefined>): SystemHealth {
    const now = Date.now();
    const agents: Record<string, AgentHealth> = {};

    for (const [agentId, stats] of this.agentStats) {
      const lastHeartbeat = this.agentHeartbeats.get(agentId) ?? 0;
      const isOnline = (now - lastHeartbeat) < AGENT_TIMEOUT_MS;
      const activeTask = activeTasksByAgent[agentId];

      agents[agentId] = {
        id: agentId,
        status: !isOnline ? 'offline' : activeTask ? 'busy' : 'online',
        lastHeartbeat,
        activeTask,
        completedTasks: stats.completed,
        failedTasks: stats.failed,
        uptimeMs: now - stats.startTime,
        memoryUsageMb: stats.memory ? Math.round(stats.memory / BYTES_PER_MB) : undefined,
      };
    }

    const redisHealthy = this.redis !== null; // Simplistic check

    const totalCompleted = Array.from(this.agentStats.values()).reduce((s, a) => s + a.completed, 0);
    const totalFailed = Array.from(this.agentStats.values()).reduce((s, a) => s + a.failed, 0);

    // Overall status
    const offlineAgents = Object.values(agents).filter((a) => a.status === 'offline').length;
    const totalAgents = Object.keys(agents).length;
    let status: SystemHealth['status'] = 'healthy';
    if (!this.natsHealthy || !redisHealthy) status = 'critical';
    else if (offlineAgents > 0 && offlineAgents < totalAgents) status = 'degraded';
    else if (offlineAgents === totalAgents && totalAgents > 0) status = 'critical';

    return {
      status,
      timestamp: now,
      uptime: now - this.startTime,
      agents,
      infrastructure: {
        nats: this.natsHealthy,
        redis: redisHealthy,
        nas: { mounted: this.nasHealthy, freeSpaceGb: this.nasFreeSpaceGb },
      },
      metrics: {
        totalTasks: totalCompleted + totalFailed,
        completedTasks: totalCompleted,
        failedTasks: totalFailed,
        activeTasks: Object.values(agents).filter((a) => a.status === 'busy').length,
        pendingTasks: 0, // Would come from Redis queue
        totalTokensUsed: this.costLog.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0),
        estimatedCostUsd: this.costLog.reduce((s, e) => s + e.costUsd, 0),
      },
    };
  }

  /** Get cost breakdown by model and agent */
  getCostBreakdown(periodMs?: number): {
    byModel: Record<string, { calls: number; tokens: number; costUsd: number }>;
    byAgent: Record<string, { calls: number; tokens: number; costUsd: number }>;
    total: { calls: number; tokens: number; costUsd: number };
  } {
    const cutoff = periodMs ? Date.now() - periodMs : 0;
    const entries = this.costLog.filter((e) => e.timestamp >= cutoff);

    const byModel: Record<string, { calls: number; tokens: number; costUsd: number }> = {};
    const byAgent: Record<string, { calls: number; tokens: number; costUsd: number }> = {};
    let totalCalls = 0;
    let totalTokens = 0;
    let totalCost = 0;

    for (const e of entries) {
      const tokens = e.inputTokens + e.outputTokens;

      if (!byModel[e.model]) byModel[e.model] = { calls: 0, tokens: 0, costUsd: 0 };
      byModel[e.model]!.calls++;
      byModel[e.model]!.tokens += tokens;
      byModel[e.model]!.costUsd += e.costUsd;

      if (!byAgent[e.agentId]) byAgent[e.agentId] = { calls: 0, tokens: 0, costUsd: 0 };
      byAgent[e.agentId]!.calls++;
      byAgent[e.agentId]!.tokens += tokens;
      byAgent[e.agentId]!.costUsd += e.costUsd;

      totalCalls++;
      totalTokens += tokens;
      totalCost += e.costUsd;
    }

    return {
      byModel,
      byAgent,
      total: { calls: totalCalls, tokens: totalTokens, costUsd: totalCost },
    };
  }

  private failoverCallback: ((agentId: string) => Promise<void>) | null = null;
  private failoverTriggered = new Set<string>();

  /** Register callback for agent failover (re-assign tasks when agent goes offline) */
  onAgentOffline(callback: (agentId: string) => Promise<void>): void {
    this.failoverCallback = callback;
  }

  /** Check for timed-out agents and trigger failover */
  private checkAgentTimeouts(): void {
    const now = Date.now();
    for (const [agentId, lastHeartbeat] of this.agentHeartbeats) {
      if (now - lastHeartbeat > AGENT_TIMEOUT_MS) {
        if (!this.failoverTriggered.has(agentId)) {
          log.warn(`Agent ${agentId} heartbeat timeout — triggering failover`);
          this.failoverTriggered.add(agentId);
          this.failoverCallback?.(agentId).catch((err) => {
            log.error(`Failover error for ${agentId}: ${(err as Error).message}`);
          });
        }
      } else {
        // Agent recovered — clear failover flag
        this.failoverTriggered.delete(agentId);
      }
    }
  }
}
