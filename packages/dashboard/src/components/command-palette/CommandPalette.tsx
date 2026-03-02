import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  LayoutDashboard,
  Activity,
  ScrollText,
  ListTodo,
  Coins,
  FileText,
  Settings,
  Bug,
  Puzzle,
  GitBranch,
  Bell,
  Key,
  Clock,
  Variable,
  GitCommitHorizontal,
  Terminal,
  Zap,
  RefreshCw,
  AudioWaveform,
  Bot,
  Package,
  type LucideIcon,
} from 'lucide-react';
import { gateway } from '../../gateway/client.js';

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  category: 'navigate' | 'action' | 'rpc';
  action: () => void;
  keywords?: string[];
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const commands: CommandItem[] = useMemo(() => [
    // Navigation
    { id: 'nav-dashboard', label: 'Dashboard', description: 'Main dashboard view', icon: LayoutDashboard, category: 'navigate', action: () => navigate('/'), keywords: ['home', 'main'] },
    { id: 'nav-overview', label: 'Overview', description: 'System overview with metrics', icon: Activity, category: 'navigate', action: () => navigate('/overview'), keywords: ['system', 'metrics', 'cpu', 'memory'] },
    { id: 'nav-sessions', label: 'Sessions', description: 'Active sessions list', icon: ScrollText, category: 'navigate', action: () => navigate('/sessions') },
    { id: 'nav-tasks', label: 'Tasks', description: 'Task management', icon: ListTodo, category: 'navigate', action: () => navigate('/tasks'), keywords: ['todo', 'jobs'] },
    { id: 'nav-workflows', label: 'Workflows', description: 'Workflow automation', icon: GitBranch, category: 'navigate', action: () => navigate('/workflows'), keywords: ['automation', 'pipeline'] },
    { id: 'nav-usage', label: 'Usage', description: 'Token usage and costs', icon: Coins, category: 'navigate', action: () => navigate('/usage'), keywords: ['tokens', 'cost', 'billing'] },
    { id: 'nav-logs', label: 'Logs', description: 'System logs viewer', icon: FileText, category: 'navigate', action: () => navigate('/logs'), keywords: ['console', 'output'] },
    { id: 'nav-integrations', label: 'Integrations', description: 'External service connections', icon: Puzzle, category: 'navigate', action: () => navigate('/integrations'), keywords: ['spotify', 'homeassistant', 'imessage'] },
    { id: 'nav-notifications', label: 'Notifications', description: 'Notification settings', icon: Bell, category: 'navigate', action: () => navigate('/notifications'), keywords: ['alerts', 'sounds'] },
    { id: 'nav-keys', label: 'API Keys', description: 'API key management', icon: Key, category: 'navigate', action: () => navigate('/api-keys'), keywords: ['secrets', 'tokens', 'anthropic', 'openai'] },
    { id: 'nav-scheduler', label: 'Scheduler', description: 'Cron job management', icon: Clock, category: 'navigate', action: () => navigate('/scheduler'), keywords: ['cron', 'schedule', 'timer'] },
    { id: 'nav-timeline', label: 'Timeline', description: 'Agent activity timeline', icon: GitCommitHorizontal, category: 'navigate', action: () => navigate('/timeline'), keywords: ['activity', 'history'] },
    { id: 'nav-env', label: 'Environment', description: 'Environment variables', icon: Variable, category: 'navigate', action: () => navigate('/environment'), keywords: ['env', 'vars', 'config'] },
    { id: 'nav-config', label: 'Config', description: 'Gateway configuration', icon: Settings, category: 'navigate', action: () => navigate('/config'), keywords: ['settings'] },
    { id: 'nav-voice', label: 'Voice', description: 'Voice interface — talk to Jarvis', icon: AudioWaveform, category: 'navigate', action: () => navigate('/voice'), keywords: ['speech', 'microphone', 'talk', 'speak', 'tts', 'stt'] },
    { id: 'nav-agents', label: 'Agents', description: 'Agent fleet management', icon: Bot, category: 'navigate', action: () => navigate('/agents'), keywords: ['smith', 'johny', 'fleet'] },
    { id: 'nav-plugins', label: 'Plugins', description: 'Plugin registry', icon: Package, category: 'navigate', action: () => navigate('/plugins'), keywords: ['extensions', 'modules'] },
    { id: 'nav-files', label: 'Files', description: 'NAS file manager', icon: Settings, category: 'navigate', action: () => navigate('/files'), keywords: ['nas', 'browse', 'storage', 'disk'] },
    { id: 'nav-debug', label: 'Debug', description: 'Debug tools & RPC caller', icon: Bug, category: 'navigate', action: () => navigate('/debug'), keywords: ['rpc', 'events', 'inspect'] },

    // Quick actions
    { id: 'action-refresh-health', label: 'Refresh Health', description: 'Fetch latest health status', icon: RefreshCw, category: 'action', action: () => { void gateway.request('health.detailed'); }, keywords: ['check', 'status'] },
    { id: 'action-test-notification', label: 'Test Notification', description: 'Send a test notification', icon: Bell, category: 'action', action: () => { void gateway.request('notifications.test'); }, keywords: ['alert', 'sound'] },

    // RPC shortcuts
    { id: 'rpc-agents', label: 'List Agents', description: 'agents.list', icon: Terminal, category: 'rpc', action: () => { navigate('/debug'); setTimeout(() => { /* method auto-fills in debug view */ }, 100); }, keywords: ['agent', 'status'] },
    { id: 'rpc-tasks', label: 'List Tasks', description: 'tasks.list', icon: Terminal, category: 'rpc', action: () => { navigate('/debug'); }, keywords: ['task', 'queue'] },
    { id: 'rpc-metrics', label: 'System Metrics', description: 'system.metrics', icon: Zap, category: 'rpc', action: () => { navigate('/overview'); }, keywords: ['cpu', 'memory', 'disk'] },
  ], [navigate]);

  const filtered = query.trim()
    ? commands.filter((cmd) => {
        const q = query.toLowerCase();
        return (
          cmd.label.toLowerCase().includes(q) ||
          (cmd.description?.toLowerCase().includes(q)) ||
          cmd.keywords?.some((kw) => kw.includes(q))
        );
      })
    : commands;

  // Keyboard handler
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setOpen((prev) => !prev);
      setQuery('');
      setSelectedIndex(0);
    }
    if (e.key === 'Escape' && open) {
      setOpen(false);
    }
  }, [open]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const executeCommand = (cmd: CommandItem) => {
    cmd.action();
    setOpen(false);
    setQuery('');
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && filtered[selectedIndex]) {
      executeCommand(filtered[selectedIndex]);
    }
  };

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={() => setOpen(false)}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(4px)',
          zIndex: 99999,
        }}
      />

      {/* Palette */}
      <div style={{
        position: 'fixed',
        top: '15%',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 520,
        maxHeight: '60vh',
        background: 'linear-gradient(135deg, #0d1117 0%, #161b22 100%)',
        border: '1px solid var(--green-dim)',
        borderRadius: 12,
        boxShadow: '0 0 30px rgba(0,255,65,0.1), 0 20px 60px rgba(0,0,0,0.5)',
        zIndex: 100000,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        animation: 'fade-in 0.15s ease-out',
      }}>
        {/* Input */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 16px',
          borderBottom: '1px solid var(--border-primary)',
        }}>
          <Search size={16} color="var(--green-bright)" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search commands, navigate, or run actions..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 14,
              fontFamily: 'var(--font-ui)',
              color: 'var(--text-white)',
              letterSpacing: 0.3,
            }}
          />
          <kbd style={{
            fontSize: 9,
            padding: '2px 6px',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-dim)',
            borderRadius: 3,
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
          }}>
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div style={{
          overflow: 'auto',
          maxHeight: 400,
          padding: '4px 0',
        }}>
          {filtered.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              No matching commands
            </div>
          )}

          {/* Group by category */}
          {(['navigate', 'action', 'rpc'] as const).map((cat) => {
            const items = filtered.filter((c) => c.category === cat);
            if (items.length === 0) return null;
            const catLabel = cat === 'navigate' ? 'NAVIGATION' : cat === 'action' ? 'ACTIONS' : 'RPC';

            return (
              <div key={cat}>
                <div style={{
                  padding: '6px 16px 2px',
                  fontSize: 8,
                  fontFamily: 'var(--font-display)',
                  letterSpacing: 2,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                }}>
                  {catLabel}
                </div>
                {items.map((cmd) => {
                  const globalIndex = filtered.indexOf(cmd);
                  const isSelected = globalIndex === selectedIndex;

                  return (
                    <div
                      key={cmd.id}
                      onClick={() => executeCommand(cmd)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 16px',
                        cursor: 'pointer',
                        background: isSelected ? 'rgba(0,255,65,0.06)' : 'transparent',
                        borderLeft: isSelected ? '2px solid var(--green-bright)' : '2px solid transparent',
                        transition: 'all 0.1s',
                      }}
                    >
                      <cmd.icon size={14} color={isSelected ? 'var(--green-bright)' : 'var(--text-muted)'} />
                      <div style={{ flex: 1 }}>
                        <div style={{
                          fontSize: 12,
                          fontFamily: 'var(--font-ui)',
                          fontWeight: 600,
                          color: isSelected ? 'var(--text-white)' : 'var(--text-secondary)',
                          letterSpacing: 0.3,
                        }}>
                          {cmd.label}
                        </div>
                        {cmd.description && (
                          <div style={{
                            fontSize: 10,
                            color: 'var(--text-muted)',
                            fontFamily: 'var(--font-ui)',
                          }}>
                            {cmd.description}
                          </div>
                        )}
                      </div>
                      {isSelected && (
                        <kbd style={{
                          fontSize: 8,
                          padding: '1px 5px',
                          background: 'var(--bg-tertiary)',
                          border: '1px solid var(--border-dim)',
                          borderRadius: 3,
                          color: 'var(--text-muted)',
                          fontFamily: 'var(--font-mono)',
                        }}>
                          ENTER
                        </kbd>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--border-dim)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 9,
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-ui)',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <kbd style={{ fontSize: 8, padding: '0 3px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)', borderRadius: 2 }}>↑↓</kbd>
            Navigate
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <kbd style={{ fontSize: 8, padding: '0 3px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)', borderRadius: 2 }}>↵</kbd>
            Select
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <kbd style={{ fontSize: 8, padding: '0 3px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)', borderRadius: 2 }}>⌘K</kbd>
            Toggle
          </span>
        </div>
      </div>
    </>
  );
}
