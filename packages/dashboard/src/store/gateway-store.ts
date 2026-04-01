import { create } from 'zustand';
import { gateway } from '../gateway/client.js';

interface AgentState {
  identity: { agentId: string; role: string; machineId: string; hostname: string };
  status: string;
  activeTaskId: string | null;
  activeTaskDescription: string | null;
  lastHeartbeat: number;
  completedTasks: number;
  failedTasks: number;
}

interface ChatMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

interface TaskDef {
  id: string;
  title: string;
  description: string;
  priority: string;
  status?: string;
  assignedAgent: string | null;
  requiredCapabilities?: string[];
  createdAt?: number;
  updatedAt?: number;
}

interface ActivityEntry {
  id: string;
  agentId: string;
  action: string;
  detail: string;
  timestamp: number;
}

export type FeedEntryType = 'tool_call' | 'task_progress' | 'delegation' | 'status_change';

export interface FeedEntry {
  id: string;
  type: FeedEntryType;
  agentId: string;
  timestamp: number;
  detail: string;
  // tool_call
  toolName?: string;
  toolArgs?: string;
  // task_progress
  taskId?: string;
  progress?: number; // 0-100
  taskTitle?: string;
  // delegation
  fromAgent?: string;
  toAgent?: string;
  // status_change
  oldStatus?: string;
  newStatus?: string;
}

interface UpdateInfo {
  commitsBehind: number;
  latestCommit: string;
  latestMessage: string;
  localHead: string;
  remoteHead: string;
}

interface HealthInfo {
  status: string;
  version: string;
  uptime: number;
  infrastructure: {
    nats: boolean;
    redis: boolean;
    nas: { mounted: boolean; path: string };
  };
  agents: Array<{
    id: string;
    role: string;
    status: string;
    alive: boolean;
    activeTask: string | null;
  }>;
  dashboard: { connectedClients: number };
}

interface GatewayStore {
  connected: boolean;
  initialized: boolean;
  agents: Map<string, AgentState>;
  tasks: TaskDef[];
  chatMessages: ChatMessage[];
  activityLog: ActivityEntry[];
  activityFeed: FeedEntry[];
  taskProgress: Map<string, FeedEntry>;
  health: HealthInfo | null;
  consoleLines: Array<{ agentId: string; line: string; timestamp: number }>;
  update: UpdateInfo | null;
  updateInProgress: boolean;
  setupRequired: boolean | null;

  // Actions
  init: () => void;
  destroy: () => void;
  sendChat: (to: string, content: string) => void;
  createTask: (task: Partial<TaskDef>) => void;
  checkForUpdate: () => Promise<void>;
  applyUpdate: () => void;
}

export const useGatewayStore = create<GatewayStore>((set, get) => ({
  connected: false,
  initialized: false,
  agents: new Map(),
  tasks: [],
  chatMessages: [],
  activityLog: [],
  activityFeed: [],
  taskProgress: new Map(),
  health: null,
  consoleLines: [],
  update: null,
  updateInProgress: false,
  setupRequired: null,

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });

    // Track all unsub functions so we can clean up on destroy / re-init
    const unsubs: Array<() => void> = [];

    gateway.connect();

    unsubs.push(gateway.on('_connected', () => {
      set({ connected: true });
      // Fetch initial state
      void gateway.request('agents.list').then((agents) => {
        const map = new Map<string, AgentState>();
        for (const a of agents as AgentState[]) {
          map.set(a.identity.agentId, a);
        }
        set({ agents: map });
      });
      void gateway.request('tasks.list').then((tasks) => {
        set({ tasks: tasks as TaskDef[] });
      });
      void gateway.request<{ setupComplete: boolean }>('setup.wizard.status').then((status) => {
        set({ setupRequired: !status.setupComplete });
      }).catch(() => {
        set({ setupRequired: null });
      });
    }));

    unsubs.push(gateway.on('_disconnected', () => {
      set({ connected: false });
    }));

    unsubs.push(gateway.on('agent.status', (payload) => {
      const state = payload as AgentState;
      set((prev) => {
        const agents = new Map(prev.agents);
        const oldAgent = agents.get(state.identity.agentId);
        agents.set(state.identity.agentId, state);

        // Emit status_change feed entry when status actually changes
        if (oldAgent && oldAgent.status !== state.status) {
          const feedEntry: FeedEntry = {
            id: `feed-sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: 'status_change',
            agentId: state.identity.agentId,
            timestamp: Date.now(),
            detail: `${state.identity.agentId} → ${state.status}`,
            oldStatus: oldAgent.status,
            newStatus: state.status,
          };
          return {
            agents,
            activityFeed: [...prev.activityFeed.slice(-299), feedEntry],
          };
        }

        return { agents };
      });
    }));

    unsubs.push(gateway.on('agent.activity', (payload) => {
      const entry = payload as ActivityEntry;

      // Also push tool_call entries to activityFeed
      const isToolCall = entry.action?.startsWith('tool') || entry.action?.includes('call');
      if (isToolCall) {
        const feedEntry: FeedEntry = {
          id: `feed-tc-${entry.id}`,
          type: 'tool_call',
          agentId: entry.agentId,
          timestamp: entry.timestamp,
          detail: entry.detail,
          toolName: entry.action.replace('tool:', '').replace('tool_call:', ''),
          toolArgs: entry.detail,
        };
        set((prev) => ({
          activityLog: [...prev.activityLog.slice(-200), entry],
          activityFeed: [...prev.activityFeed.slice(-299), feedEntry],
        }));
      } else {
        set((prev) => ({
          activityLog: [...prev.activityLog.slice(-200), entry],
        }));
      }
    }));

    unsubs.push(gateway.on('task.progress', (payload) => {
      const data = payload as { taskId: string; agentId: string; progress: number; detail?: string; title?: string };
      const feedEntry: FeedEntry = {
        id: `feed-tp-${data.taskId}-${Date.now()}`,
        type: 'task_progress',
        agentId: data.agentId,
        timestamp: Date.now(),
        detail: data.detail ?? `Task ${data.taskId} — ${data.progress}%`,
        taskId: data.taskId,
        progress: data.progress,
        taskTitle: data.title,
      };
      set((prev) => {
        const taskProgress = new Map(prev.taskProgress);
        if (data.progress >= 100) {
          taskProgress.delete(data.taskId);
        } else {
          taskProgress.set(data.taskId, feedEntry);
        }
        return {
          activityFeed: [...prev.activityFeed.slice(-299), feedEntry],
          taskProgress,
        };
      });
    }));

    unsubs.push(gateway.on('coordination.request', (payload) => {
      const data = payload as { fromAgent: string; toAgent: string; taskId?: string; detail?: string };
      const feedEntry: FeedEntry = {
        id: `feed-del-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'delegation',
        agentId: data.fromAgent,
        timestamp: Date.now(),
        detail: data.detail ?? `${data.fromAgent} → ${data.toAgent}`,
        fromAgent: data.fromAgent,
        toAgent: data.toAgent,
        taskId: data.taskId,
      };
      set((prev) => ({
        activityFeed: [...prev.activityFeed.slice(-299), feedEntry],
      }));
    }));

    unsubs.push(gateway.on('coordination.response', (payload) => {
      const data = payload as { fromAgent: string; toAgent: string; taskId?: string; detail?: string };
      const feedEntry: FeedEntry = {
        id: `feed-delr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'delegation',
        agentId: data.fromAgent,
        timestamp: Date.now(),
        detail: data.detail ?? `${data.fromAgent} responded to ${data.toAgent}`,
        fromAgent: data.fromAgent,
        toAgent: data.toAgent,
        taskId: data.taskId,
      };
      set((prev) => ({
        activityFeed: [...prev.activityFeed.slice(-299), feedEntry],
      }));
    }));

    unsubs.push(gateway.on('task.created', (payload) => {
      const task = payload as TaskDef;
      set((prev) => ({ tasks: [...prev.tasks.slice(-499), task] }));
    }));

    unsubs.push(gateway.on('task.completed', (payload) => {
      const result = payload as { taskId: string };
      set((prev) => ({
        tasks: prev.tasks.map((t) =>
          t.id === result.taskId ? { ...t, status: 'completed' } : t
        ),
      }));
    }));

    unsubs.push(gateway.on('task.cancelled', (payload) => {
      const result = payload as { taskId: string };
      set((prev) => ({
        tasks: prev.tasks.map((t) =>
          t.id === result.taskId ? { ...t, status: 'cancelled', assignedAgent: null } : t
        ),
      }));
    }));

    unsubs.push(gateway.on('task.assigned', (payload) => {
      const result = payload as { taskId: string; agentId: string };
      set((prev) => ({
        tasks: prev.tasks.map((t) =>
          t.id === result.taskId ? { ...t, status: 'assigned', assignedAgent: result.agentId } : t
        ),
      }));
    }));

    unsubs.push(gateway.on('task.failed', (payload) => {
      const result = payload as { taskId: string };
      set((prev) => ({
        tasks: prev.tasks.map((t) =>
          t.id === result.taskId ? { ...t, status: 'failed' } : t
        ),
      }));
    }));

    unsubs.push(gateway.on('chat.message', (payload) => {
      const msg = payload as ChatMessage;
      set((prev) => ({
        chatMessages: [...prev.chatMessages.slice(-500), msg],
      }));
    }));

    unsubs.push(gateway.on('system.health', (payload) => {
      set({ health: payload as HealthInfo });
    }));

    unsubs.push(gateway.on('log.line', (payload) => {
      const line = payload as { agentId: string; line: string; timestamp: number };
      set((prev) => ({
        consoleLines: [...prev.consoleLines.slice(-200), line],
      }));
    }));

    // Note: chat.stream is handled directly by ConsoleViewer (with in-place updates).
    // No need to duplicate into consoleLines here.

    // --- OTA Update events ---
    unsubs.push(gateway.on('system.update.available', (payload) => {
      set({ update: payload as UpdateInfo });
    }));

    unsubs.push(gateway.on('system.update.started', () => {
      set({ updateInProgress: true });
    }));

    unsubs.push(gateway.on('system.update.completed', () => {
      set({ update: null, updateInProgress: false });
    }));

    unsubs.push(gateway.on('system.update.failed', () => {
      set({ updateInProgress: false });
    }));

    // Store cleanup function on the store so destroy() can call it
    (useGatewayStore as unknown as { _unsubs: Array<() => void> })._unsubs = unsubs;
  },

  destroy: () => {
    const unsubs = (useGatewayStore as unknown as { _unsubs?: Array<() => void> })._unsubs ?? [];
    for (const unsub of unsubs) unsub();
    (useGatewayStore as unknown as { _unsubs: Array<() => void> })._unsubs = [];
    set({ initialized: false, connected: false });
  },

  sendChat: (to: string, content: string) => {
    // Sanitize: strip control characters (except newline/tab), limit length
    const sanitized = content
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .slice(0, 10_000);
    if (!sanitized.trim()) return;
    void gateway.request('chat.send', {
      from: 'user',
      to,
      content: sanitized,
      timestamp: Date.now(),
    });
  },

  createTask: (task: Partial<TaskDef>) => {
    void gateway.request('tasks.create', {
      ...task,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },

  checkForUpdate: async () => {
    try {
      const result = await gateway.request<{ available: boolean; commitsBehind: number; latestCommit: string; latestMessage: string; localHead: string; remoteHead: string }>('system.update.check');
      if (result.available) {
        set({ update: { commitsBehind: result.commitsBehind, latestCommit: result.latestCommit, latestMessage: result.latestMessage, localHead: result.localHead, remoteHead: result.remoteHead } });
      } else {
        set({ update: null });
      }
    } catch { /* ignore — gateway may be unreachable */ }
  },

  applyUpdate: () => {
    set({ updateInProgress: true });
    void gateway.request('system.update.apply');
  },
}));
