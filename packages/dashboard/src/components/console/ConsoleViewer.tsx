import { useRef, useEffect, useState } from 'react';
import { gateway } from '../../gateway/client.js';

interface ConsoleLine {
  id: number;
  agent: string;
  text: string;
  type: 'stream' | 'tool' | 'status' | 'task' | 'system';
}

const COLORS: Record<string, string> = {
  jarvis: 'var(--green-bright)',
  'agent-smith': 'var(--cyan-muted)',
  'agent-johny': 'var(--purple)',
  system: 'var(--yellow)',
};

const LABELS: Record<string, string> = {
  jarvis: 'JARVIS',
  'agent-smith': 'SMITH',
  'agent-johny': 'JOHNY',
  system: 'SYSTEM',
};

let lineId = 0;

/** Tracks which agents are currently streaming (to update in-place instead of adding new lines) */
const streamingAgents = new Set<string>();

export function ConsoleViewer() {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const maxLines = 200;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines.length]);

  useEffect(() => {
    const add = (agent: string, text: string, type: ConsoleLine['type'] = 'system') => {
      if (!text.trim()) return;
      setLines((prev) => [...prev.slice(-(maxLines - 1)), { id: ++lineId, agent, text, type }]);
    };

    /** Update the last stream line for this agent in-place (live typing effect) */
    const updateStream = (agent: string, text: string) => {
      if (!text.trim()) return;
      setLines((prev) => {
        // Find the last 'stream' line for this agent to update in-place
        const lastIdx = prev.findLastIndex((l) => l.agent === agent && l.type === 'stream');
        if (lastIdx >= 0 && streamingAgents.has(agent)) {
          const updated = [...prev];
          updated[lastIdx] = { ...updated[lastIdx], text };
          return updated;
        }
        // No existing stream line — add a new one
        streamingAgents.add(agent);
        return [...prev.slice(-(maxLines - 1)), { id: ++lineId, agent, text, type: 'stream' }];
      });
    };

    const unsubs: Array<() => void> = [];

    // Chat stream — thinking, text, tool calls, done
    unsubs.push(gateway.on('chat.stream', (p: unknown) => {
      const d = p as { from?: string; phase?: string; text?: string; toolName?: string };
      const agent = d.from ?? 'jarvis';
      if (d.phase === 'text' && d.text) {
        // Update in-place — accumulated text replaces previous stream line
        updateStream(agent, d.text);
      } else if (d.phase === 'thinking' && d.text) {
        updateStream(agent, d.text);
      } else if (d.phase === 'tool_start') {
        add(agent, `▶ ${d.toolName ?? 'tool'}`, 'tool');
      } else if (d.phase === 'done') {
        streamingAgents.delete(agent);
        add(agent, '✓ done', 'status');
      }
    }));

    // Chat messages — final response (skip if stream already showed it)
    unsubs.push(gateway.on('chat.message', (p: unknown) => {
      const d = p as { from?: string; content?: string };
      if (d.from && d.from !== 'user' && d.content) {
        // Replace the last stream line with the final clean text
        setLines((prev) => {
          const lastStreamIdx = prev.findLastIndex((l) => l.agent === d.from && l.type === 'stream');
          if (lastStreamIdx >= 0) {
            // Stream line exists — update it with the final content
            const updated = [...prev];
            updated[lastStreamIdx] = { ...updated[lastStreamIdx], text: d.content!.slice(0, 500) };
            return updated;
          }
          // No stream line — add as new (agent didn't stream, e.g. queued response)
          return [...prev.slice(-(maxLines - 1)), { id: ++lineId, agent: d.from!, text: d.content!.slice(0, 500), type: 'stream' }];
        });
      }
    }));

    // Agent status changes
    unsubs.push(gateway.on('agent.status', (p: unknown) => {
      const d = p as { identity?: { agentId?: string }; status?: string };
      if (d.identity?.agentId && d.status) {
        add(d.identity.agentId, `status → ${d.status}`, 'status');
      }
    }));

    // Agent discovery
    unsubs.push(gateway.on('agent.discovery', (p: unknown) => {
      const d = p as { agentId?: string; status?: string };
      if (d.agentId) add('system', `${LABELS[d.agentId] ?? d.agentId} ${d.status ?? 'discovered'}`, 'status');
    }));

    // Task events
    unsubs.push(gateway.on('task.created', (p: unknown) => {
      const d = p as { title?: string; id?: string };
      add('system', `Task created: ${d.title ?? d.id}`, 'task');
    }));
    unsubs.push(gateway.on('task.assigned', (p: unknown) => {
      const d = p as { taskId?: string; agentId?: string };
      add('system', `Task ${d.taskId} → ${LABELS[d.agentId ?? ''] ?? d.agentId}`, 'task');
    }));
    unsubs.push(gateway.on('task.completed', (p: unknown) => {
      const d = p as { taskId?: string };
      add('system', `Task completed: ${d.taskId}`, 'task');
    }));
    unsubs.push(gateway.on('task.failed', (p: unknown) => {
      const d = p as { taskId?: string };
      add('system', `Task failed: ${d.taskId}`, 'task');
    }));

    // Task progress
    unsubs.push(gateway.on('task.progress', (p: unknown) => {
      const d = p as { taskId?: string; message?: string; progress?: number };
      add('system', `${d.taskId}: ${d.message ?? `${d.progress}%`}`, 'task');
    }));

    // Coordination
    unsubs.push(gateway.on('coordination.request', (p: unknown) => {
      const d = p as { from?: string; type?: string; payload?: { title?: string } };
      add(d.from ?? 'system', `delegation: ${d.payload?.title ?? d.type}`, 'task');
    }));
    unsubs.push(gateway.on('coordination.response', (p: unknown) => {
      const d = p as { from?: string; accepted?: boolean };
      add(d.from ?? 'system', `delegation ${d.accepted ? 'accepted' : 'rejected'}`, 'task');
    }));

    // Task delegation
    unsubs.push(gateway.on('task.delegated', (p: unknown) => {
      const d = p as { taskId?: string; targetAgent?: string; title?: string };
      add('system', `Delegated "${d.title}" → ${LABELS[d.targetAgent ?? ''] ?? d.targetAgent}`, 'task');
    }));
    unsubs.push(gateway.on('task.delegation_result', (p: unknown) => {
      const d = p as { taskId?: string; success?: boolean };
      add('system', `Delegation result: ${d.taskId} ${d.success ? '✓' : '✗'}`, 'task');
    }));

    // Agent activity
    unsubs.push(gateway.on('agent.activity', (p: unknown) => {
      const d = p as { source?: string; event?: string; payload?: unknown };
      add(d.source ?? 'system', `${d.event ?? 'activity'}`, 'status');
    }));

    // Log lines (if gateway ever sends them)
    unsubs.push(gateway.on('log.line', (p: unknown) => {
      const d = p as { agentId?: string; line?: string };
      if (d.line) add(d.agentId ?? 'system', d.line, 'system');
    }));

    // Connection events
    unsubs.push(gateway.on('_connected', () => add('system', 'Gateway connected', 'system')));
    unsubs.push(gateway.on('_disconnected', () => add('system', 'Gateway disconnected', 'system')));

    return () => unsubs.forEach((u) => u());
  }, []);

  const typeColor = (type: ConsoleLine['type']) => {
    switch (type) {
      case 'tool': return '#fbbf24';
      case 'task': return '#60a5fa';
      case 'status': return 'var(--text-muted)';
      default: return 'var(--green-secondary)';
    }
  };

  return (
    <div className="panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="panel-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--cyan-bright)' }}>&gt;&gt;</span>
        CONSOLE
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 10 }}>
          {lines.length} LINES
        </span>
        {lines.length > 0 && (
          <button
            onClick={() => setLines([])}
            style={{ fontSize: 9, padding: '1px 6px', color: 'var(--text-muted)', border: '1px solid var(--border-dim)', cursor: 'pointer' }}
          >
            CLEAR
          </button>
        )}
      </div>
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '8px 12px',
        fontSize: 11,
        lineHeight: 1.6,
        fontFamily: 'var(--font-mono)',
      }}>
        {lines.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>
            <span style={{ color: 'var(--green-dim)' }}>[system]</span> CONSOLE V2 — waiting for events...
            <br />
            <span style={{ animation: 'blink 1s ease-in-out infinite', color: 'var(--green-bright)' }}>_</span>
          </div>
        ) : (
          lines.map((line) => (
            <div key={line.id} style={{
              animation: 'slide-in 0.15s ease-out',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}>
              <span style={{ color: COLORS[line.agent] ?? 'var(--text-muted)', fontSize: 10 }}>
                [{LABELS[line.agent] ?? line.agent.toUpperCase()}]
              </span>
              {' '}
              <span style={{ color: typeColor(line.type) }}>{line.text}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
