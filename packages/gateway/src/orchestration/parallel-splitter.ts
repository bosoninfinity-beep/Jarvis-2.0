/**
 * Parallel Task Splitter — Splits a single task into parallel subtasks
 * distributed across multiple agents.
 *
 * Use cases:
 * - "Run tests on all packages" → split per package, one per agent
 * - "Search for X in repos A, B, C" → one search per agent
 * - "Build and deploy all services" → parallel builds
 * - "Analyze these 10 documents" → split batch across agents
 *
 * Each subtask runs independently (no dependencies). Results are
 * aggregated when all subtasks complete.
 */

import { createLogger, type AgentId } from '@jarvis/shared';

const log = createLogger('orchestration:parallel');

export interface ParallelSubtask {
  id: string;
  title: string;
  description: string;
  requiredCapabilities: string[];
  preferredAgent?: AgentId;
  priority: 'low' | 'normal' | 'high' | 'critical';
}

export interface ParallelPlan {
  parentTaskId: string;
  strategy: string;
  subtasks: ParallelSubtask[];
  /** How to combine results: 'concat' | 'merge' | 'summary' */
  aggregation: 'concat' | 'merge' | 'summary';
}

export interface ParallelTracker {
  parentTaskId: string;
  subtaskIds: string[];
  results: Map<string, { success: boolean; output: string }>;
  completedCount: number;
  totalCount: number;
  startedAt: number;
  aggregation: 'concat' | 'merge' | 'summary';
}

/** Patterns that indicate a task can be parallelized */
const PARALLEL_PATTERNS = [
  { pattern: /(?:run|execute)\s+(?:tests?|specs?)\s+(?:on|for|across)\s+(?:all|every|each)/i, type: 'per-package' as const },
  { pattern: /(?:search|find|look\s+for|grep)\s+.+\s+(?:in|across)\s+(?:all|every|each|multiple)/i, type: 'per-target' as const },
  { pattern: /(?:build|compile|deploy)\s+(?:all|every|each)/i, type: 'per-service' as const },
  { pattern: /(?:analyze|review|check|scan|lint)\s+(?:all|every|each|these|multiple)/i, type: 'per-item' as const },
  { pattern: /(?:install|update|upgrade)\s+(?:on|across)\s+(?:all|every|each)\s+(?:machines?|agents?|nodes?|servers?)/i, type: 'per-agent' as const },
];

export class ParallelSplitter {
  private activeTrackers = new Map<string, ParallelTracker>();
  private completionCallback: ((parentTaskId: string, results: Array<{ subtaskId: string; success: boolean; output: string }>) => void) | null = null;

  /** Register callback for when all parallel subtasks of a parent complete */
  onAllCompleted(callback: (parentTaskId: string, results: Array<{ subtaskId: string; success: boolean; output: string }>) => void): void {
    this.completionCallback = callback;
  }

  /** Check if a task description suggests parallel execution */
  isParallelizable(title: string, description: string, metadata?: Record<string, unknown>): boolean {
    // Explicit flag
    if (metadata?.parallel === true) return true;

    const text = `${title} ${description}`.toLowerCase();
    return PARALLEL_PATTERNS.some(p => p.pattern.test(text));
  }

  /** Split a task into parallel subtasks for available agents */
  split(
    parentTaskId: string,
    title: string,
    description: string,
    priority: 'low' | 'normal' | 'high' | 'critical',
    availableAgents: Array<{ id: AgentId; capabilities: string[] }>,
    metadata?: Record<string, unknown>,
  ): ParallelPlan | null {
    if (availableAgents.length < 2) {
      log.info(`Cannot parallelize ${parentTaskId} — need at least 2 agents`);
      return null;
    }

    const text = `${title} ${description}`;

    // Check for explicit split instructions in metadata
    const explicitParts = metadata?.parallelParts as string[] | undefined;
    if (explicitParts && Array.isArray(explicitParts)) {
      return this.splitExplicit(parentTaskId, title, priority, explicitParts, availableAgents);
    }

    // Detect parallel type from patterns
    const matchedPattern = PARALLEL_PATTERNS.find(p => p.pattern.test(text));
    if (!matchedPattern && metadata?.parallel !== true) return null;

    // For per-agent type: create one subtask per available agent
    if (matchedPattern?.type === 'per-agent') {
      return this.splitPerAgent(parentTaskId, title, description, priority, availableAgents);
    }

    // Default: split description across agents with round-robin
    return this.splitGeneric(parentTaskId, title, description, priority, availableAgents);
  }

  /** Split with explicit parts provided by the caller */
  private splitExplicit(
    parentTaskId: string,
    title: string,
    priority: 'low' | 'normal' | 'high' | 'critical',
    parts: string[],
    agents: Array<{ id: AgentId; capabilities: string[] }>,
  ): ParallelPlan {
    const subtasks: ParallelSubtask[] = parts.map((part, i) => ({
      id: `${parentTaskId}-p${i}`,
      title: `[${i + 1}/${parts.length}] ${title}`,
      description: part,
      requiredCapabilities: [],
      preferredAgent: agents[i % agents.length]!.id,
      priority,
    }));

    log.info(`Parallel split (explicit): ${parentTaskId} → ${subtasks.length} parts across ${agents.length} agents`);

    return {
      parentTaskId,
      strategy: `Explicit split: ${parts.length} parts across ${agents.length} agents`,
      subtasks,
      aggregation: 'concat',
    };
  }

  /** One subtask per agent — same task, different machines */
  private splitPerAgent(
    parentTaskId: string,
    title: string,
    description: string,
    priority: 'low' | 'normal' | 'high' | 'critical',
    agents: Array<{ id: AgentId; capabilities: string[] }>,
  ): ParallelPlan {
    const subtasks: ParallelSubtask[] = agents.map((agent, i) => ({
      id: `${parentTaskId}-a${i}`,
      title: `[${agent.id}] ${title}`,
      description: `Execute on ${agent.id}: ${description}`,
      requiredCapabilities: [],
      preferredAgent: agent.id,
      priority,
    }));

    log.info(`Parallel split (per-agent): ${parentTaskId} → ${subtasks.length} agents`);

    return {
      parentTaskId,
      strategy: `Per-agent execution: same task on ${agents.length} agents`,
      subtasks,
      aggregation: 'merge',
    };
  }

  /** Generic split: divide work evenly across agents */
  private splitGeneric(
    parentTaskId: string,
    title: string,
    description: string,
    priority: 'low' | 'normal' | 'high' | 'critical',
    agents: Array<{ id: AgentId; capabilities: string[] }>,
  ): ParallelPlan {
    // Split into as many parts as we have agents (max 3)
    const partCount = Math.min(agents.length, 3);
    const subtasks: ParallelSubtask[] = [];

    for (let i = 0; i < partCount; i++) {
      subtasks.push({
        id: `${parentTaskId}-g${i}`,
        title: `[Part ${i + 1}/${partCount}] ${title}`,
        description: `Part ${i + 1} of ${partCount}:\n${description}\n\nThis is part ${i + 1} of a parallelized task. Focus on your portion and be thorough.`,
        requiredCapabilities: [],
        preferredAgent: agents[i]!.id,
        priority,
      });
    }

    log.info(`Parallel split (generic): ${parentTaskId} → ${partCount} parts`);

    return {
      parentTaskId,
      strategy: `Generic parallel split: ${partCount} parts across ${partCount} agents`,
      subtasks,
      aggregation: 'summary',
    };
  }

  // ─── Tracking ────────────────────────────────────────────────────

  /** Start tracking a parallel execution */
  track(plan: ParallelPlan): void {
    const tracker: ParallelTracker = {
      parentTaskId: plan.parentTaskId,
      subtaskIds: plan.subtasks.map(s => s.id),
      results: new Map(),
      completedCount: 0,
      totalCount: plan.subtasks.length,
      startedAt: Date.now(),
      aggregation: plan.aggregation,
    };
    this.activeTrackers.set(plan.parentTaskId, tracker);
    log.info(`Tracking parallel task ${plan.parentTaskId}: ${plan.subtasks.length} subtasks`);
  }

  /** Record a subtask result; triggers completion callback when all done */
  recordResult(subtaskId: string, success: boolean, output: string): void {
    for (const [parentId, tracker] of this.activeTrackers) {
      if (!tracker.subtaskIds.includes(subtaskId)) continue;

      tracker.results.set(subtaskId, { success, output });
      tracker.completedCount++;

      log.info(`Parallel subtask ${subtaskId} done (${tracker.completedCount}/${tracker.totalCount}) for parent ${parentId}`);

      if (tracker.completedCount >= tracker.totalCount) {
        // All subtasks complete — aggregate and notify
        const results = tracker.subtaskIds.map(id => ({
          subtaskId: id,
          ...(tracker.results.get(id) ?? { success: false, output: 'No result received' }),
        }));

        log.info(`Parallel task ${parentId} fully complete in ${Date.now() - tracker.startedAt}ms`);
        this.activeTrackers.delete(parentId);
        this.completionCallback?.(parentId, results);
      }
      return;
    }
  }

  /** Aggregate results based on strategy */
  static aggregateResults(
    results: Array<{ subtaskId: string; success: boolean; output: string }>,
    strategy: 'concat' | 'merge' | 'summary',
  ): { success: boolean; output: string } {
    const allSuccess = results.every(r => r.success);
    const failedCount = results.filter(r => !r.success).length;

    switch (strategy) {
      case 'concat':
        return {
          success: allSuccess,
          output: results.map(r => `--- ${r.subtaskId} (${r.success ? 'OK' : 'FAILED'}) ---\n${r.output}`).join('\n\n'),
        };

      case 'merge':
        return {
          success: allSuccess,
          output: results.map(r => r.output).join('\n\n'),
        };

      case 'summary': {
        const header = allSuccess
          ? `All ${results.length} parallel tasks completed successfully.`
          : `${results.length - failedCount}/${results.length} tasks succeeded, ${failedCount} failed.`;
        const details = results.map(r =>
          `[${r.success ? 'OK' : 'FAIL'}] ${r.subtaskId}: ${r.output.substring(0, 200)}${r.output.length > 200 ? '...' : ''}`
        ).join('\n');
        return { success: allSuccess, output: `${header}\n\n${details}` };
      }
    }
  }

  /** Get status of a parallel execution */
  getStatus(parentTaskId: string): ParallelTracker | null {
    return this.activeTrackers.get(parentTaskId) ?? null;
  }

  /** Get all active parallel executions */
  getActiveTrackers(): ParallelTracker[] {
    return Array.from(this.activeTrackers.values());
  }
}
