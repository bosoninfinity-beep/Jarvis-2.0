/**
 * AgentsView — Enhanced Agent Fleet Manager
 *
 * OpenClaw-inspired multi-tab per-agent interface:
 * - Left sidebar: Agent list with selection
 * - Right panel: 5 tabs per agent (Overview, Tools, Skills, Activity, Config)
 * - Per-agent tool toggles, model selection, config editing
 * - Quick chat, capability badges, real-time activity
 */

import { useEffect, useState, useCallback } from 'react';
import { useGatewayStore } from '../store/gateway-store.js';
import { gateway } from '../gateway/client.js';
import {
  Bot,
  RefreshCw,
  WifiOff,
  Play,
  Pause,
  CheckCircle2,
  XCircle,
  Zap,
  Activity,
  Send,
  Terminal,
  Wrench,
  Brain,
  Shield,
  Sparkles,
  Settings,
  Eye,
  ToggleLeft,
  ToggleRight,
  Search,
  Radio,
  Save,
  RotateCcw,
  Layers,
  Package,
  LogIn,
  Key,
} from 'lucide-react';
import { formatTimeAgo } from '../utils/formatters.js';

// --- Types ---

interface AgentCapabilities {
  capabilities: string[];
  tools: string[];
  plugins: string[];
  model: string;
}

type AgentTab = 'overview' | 'tools' | 'skills' | 'activity' | 'config';

const ROLE_COLORS: Record<string, string> = {
  orchestrator: 'var(--amber)',
  dev: 'var(--cyan-bright)',
  marketing: 'var(--purple)',
  ops: 'var(--amber)',
  research: 'var(--green-bright)',
  default: 'var(--text-secondary)',
};

const AGENT_NAMES: Record<string, string> = {
  jarvis: 'JARVIS',
  'agent-smith': 'SMITH',
  'agent-johny': 'JOHNY',
};

const STATUS_CONFIG: Record<string, { color: string; bg: string; label: string; Icon: typeof Play }> = {
  idle: { color: 'var(--green-bright)', bg: 'rgba(0,255,65,0.06)', label: 'IDLE', Icon: Pause },
  busy: { color: 'var(--amber)', bg: 'rgba(255,170,0,0.06)', label: 'ACTIVE', Icon: Play },
  offline: { color: 'var(--text-muted)', bg: 'rgba(72,79,88,0.06)', label: 'OFFLINE', Icon: WifiOff },
  error: { color: 'var(--red-bright)', bg: 'rgba(255,51,51,0.06)', label: 'ERROR', Icon: XCircle },
  starting: { color: 'var(--amber)', bg: 'rgba(255,170,0,0.06)', label: 'STARTING', Icon: Zap },
};

const TABS: { id: AgentTab; label: string; icon: typeof Eye }[] = [
  { id: 'overview', label: 'Overview', icon: Eye },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'config', label: 'Config', icon: Settings },
];

// Known tools with descriptions (from Jarvis agent runtime)
const TOOL_CATALOG: Record<string, { description: string; category: string }> = {
  'shell_exec': { description: 'Execute shell commands on the host machine', category: 'System' },
  'file_read': { description: 'Read file contents from filesystem', category: 'Files' },
  'file_write': { description: 'Write or create files on filesystem', category: 'Files' },
  'file_search': { description: 'Search for files by name or content', category: 'Files' },
  'web_search': { description: 'Search the web using search engines', category: 'Web' },
  'web_fetch': { description: 'Fetch and parse web page content', category: 'Web' },
  'browser_navigate': { description: 'Navigate browser to URL', category: 'Browser' },
  'browser_screenshot': { description: 'Take screenshot of browser page', category: 'Browser' },
  'browser_click': { description: 'Click elements on web pages', category: 'Browser' },
  'browser_type': { description: 'Type text into browser inputs', category: 'Browser' },
  'memory_search': { description: 'Search semantic memory for context', category: 'Memory' },
  'memory_store': { description: 'Store information in long-term memory', category: 'Memory' },
  'voice_respond': { description: 'Generate voice response with TTS', category: 'Voice' },
  'task_create': { description: 'Create a new task in the queue', category: 'Tasks' },
  'task_status': { description: 'Get task status and progress', category: 'Tasks' },
  'message_send': { description: 'Send message to a channel or user', category: 'Channels' },
  'image_generate': { description: 'Generate images using AI models', category: 'AI' },
  'code_execute': { description: 'Execute code in sandboxed environment', category: 'Dev' },
  'git_operation': { description: 'Git operations (commit, push, pull)', category: 'Dev' },
  'cron_schedule': { description: 'Schedule recurring tasks via cron', category: 'Automation' },
  'notification_send': { description: 'Send push/email notifications', category: 'Channels' },
  'subagent_spawn': { description: 'Spawn sub-agents for delegation', category: 'Agents' },
};

// Known skills catalog
const SKILL_CATALOG: { id: string; name: string; emoji: string; category: string; description: string }[] = [
  { id: 'github', name: 'GitHub', emoji: '🐙', category: 'Dev', description: 'Create issues, PRs, manage repos' },
  { id: 'notion', name: 'Notion', emoji: '📝', category: 'Productivity', description: 'Create/update Notion pages and databases' },
  { id: 'slack', name: 'Slack', emoji: '💬', category: 'Communication', description: 'Send messages, manage channels' },
  { id: 'spotify', name: 'Spotify', emoji: '🎵', category: 'Media', description: 'Control playback, search music' },
  { id: 'weather', name: 'Weather', emoji: '🌤️', category: 'Utility', description: 'Get weather forecasts via Open-Meteo' },
  { id: 'apple-notes', name: 'Apple Notes', emoji: '📒', category: 'Apple', description: 'Create and search Apple Notes' },
  { id: 'apple-reminders', name: 'Reminders', emoji: '⏰', category: 'Apple', description: 'Manage Apple Reminders' },
  { id: 'calendar', name: 'Calendar', emoji: '📅', category: 'Productivity', description: 'Manage calendar events' },
  { id: 'email', name: 'Email', emoji: '📧', category: 'Communication', description: 'Send and read emails' },
  { id: 'trello', name: 'Trello', emoji: '📋', category: 'Productivity', description: 'Manage Trello boards and cards' },
  { id: 'jira', name: 'Jira', emoji: '🎫', category: 'Dev', description: 'Manage Jira issues and sprints' },
  { id: 'docker', name: 'Docker', emoji: '🐳', category: 'Dev', description: 'Manage Docker containers' },
  { id: 'homekit', name: 'HomeKit', emoji: '🏠', category: 'Smart Home', description: 'Control HomeKit devices' },
  { id: 'whisper', name: 'Whisper', emoji: '🎙️', category: 'AI', description: 'Speech-to-text transcription' },
  { id: 'dalle', name: 'DALL-E', emoji: '🎨', category: 'AI', description: 'Generate images with DALL-E' },
  { id: 'system-monitor', name: 'System Monitor', emoji: '📊', category: 'System', description: 'Monitor CPU, RAM, disk usage' },
  { id: '1password', name: '1Password', emoji: '🔐', category: 'Security', description: 'Manage passwords securely' },
  { id: 'ssh', name: 'SSH', emoji: '🔑', category: 'System', description: 'Remote SSH connections' },
  { id: 'youtube', name: 'YouTube', emoji: '▶️', category: 'Media', description: 'Search and manage YouTube' },
  { id: 'google-drive', name: 'Google Drive', emoji: '📁', category: 'Productivity', description: 'Manage Google Drive files' },
];

// --- Main Component ---

export function AgentsView() {
  const connected = useGatewayStore((s) => s.connected);
  const agents = useGatewayStore((s) => s.agents);
  const activityLog = useGatewayStore((s) => s.activityLog);
  const sendChat = useGatewayStore((s) => s.sendChat);

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AgentTab>('overview');
  const [capabilities, setCapabilities] = useState<Record<string, AgentCapabilities>>({});
  const [toolStates, setToolStates] = useState<Record<string, Record<string, boolean>>>({});
  const [skillStates, setSkillStates] = useState<Record<string, Record<string, boolean>>>({});
  const [agentConfigs, setAgentConfigs] = useState<Record<string, Record<string, string>>>({});
  const [configDirty, setConfigDirty] = useState(false);
  const [quickMessage, setQuickMessage] = useState('');
  const [toolSearch, setToolSearch] = useState('');
  const [skillSearch, setSkillSearch] = useState('');
  const [skillCategory, setSkillCategory] = useState('All');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lifecycleLoading, setLifecycleLoading] = useState<string | null>(null);
  const [claudeAuthStatus, setClaudeAuthStatus] = useState<Record<string, { loggedIn: boolean; email?: string; loading: boolean; error?: string }>>({});
  const [claudeLoginLoading, setClaudeLoginLoading] = useState<Record<string, boolean>>({});

  const agentList = Array.from(agents.values());

  // Auto-select first agent
  useEffect(() => {
    if (!selectedAgentId && agentList.length > 0) {
      setSelectedAgentId(agentList[0].identity.agentId);
    }
  }, [agentList.length, selectedAgentId]);

  // Fetch capabilities
  const fetchCapabilities = useCallback(async () => {
    if (!connected) return;
    for (const agent of agentList) {
      try {
        const caps = await gateway.request<AgentCapabilities>('agents.capabilities', { agentId: agent.identity.agentId });
        if (caps) {
          setCapabilities((prev) => ({ ...prev, [agent.identity.agentId]: caps }));
          // Initialize tool states from capabilities
          if (caps.tools) {
            setToolStates((prev) => {
              const existing = prev[agent.identity.agentId] || {};
              const merged: Record<string, boolean> = {};
              for (const t of caps.tools) merged[t] = existing[t] !== undefined ? existing[t] : true;
              return { ...prev, [agent.identity.agentId]: merged };
            });
          }
        }
      } catch { /* ignore */ }
    }
  }, [connected, agentList.length]);

  useEffect(() => {
    void fetchCapabilities();
    const interval = setInterval(() => void fetchCapabilities(), 30000);
    return () => clearInterval(interval);
  }, [fetchCapabilities]);

  // Initialize skill states (all enabled by default)
  useEffect(() => {
    if (selectedAgentId && !skillStates[selectedAgentId]) {
      const initial: Record<string, boolean> = {};
      for (const skill of SKILL_CATALOG) initial[skill.id] = true;
      setSkillStates((prev) => ({ ...prev, [selectedAgentId]: initial }));
    }
  }, [selectedAgentId, skillStates]);

  // Load saved config from NAS when agent is selected
  useEffect(() => {
    if (!selectedAgentId || !connected) return;
    const agent = agentList.find((a) => a.identity.agentId === selectedAgentId);
    if (!agent) return;

    const defaults = {
      model: capabilities[selectedAgentId]?.model || 'claude-opus-4-6',
      fallbackModels: 'gpt-5.2, gemini-2.5-pro',
      maxTokens: '8192',
      temperature: '0.7',
      systemPrompt: `You are ${selectedAgentId}, a Jarvis AI agent with role: ${agent.identity.role}.`,
      memoryEnabled: 'true',
      toolTimeout: '30',
    };

    gateway.request<{ config?: Record<string, string>; tools?: Record<string, boolean>; skills?: Record<string, boolean> }>('config.agent.get', { agentId: selectedAgentId })
      .then((saved) => {
        if (saved?.config) {
          setAgentConfigs((prev) => ({ ...prev, [selectedAgentId]: { ...defaults, ...saved.config } }));
        } else if (!agentConfigs[selectedAgentId]) {
          setAgentConfigs((prev) => ({ ...prev, [selectedAgentId]: defaults }));
        }
        if (saved?.tools) {
          setToolStates((prev) => ({ ...prev, [selectedAgentId]: { ...(prev[selectedAgentId] || {}), ...saved.tools } }));
        }
        if (saved?.skills) {
          setSkillStates((prev) => ({ ...prev, [selectedAgentId]: { ...(prev[selectedAgentId] || {}), ...saved.skills } }));
        }
      })
      .catch(() => {
        if (!agentConfigs[selectedAgentId]) {
          setAgentConfigs((prev) => ({ ...prev, [selectedAgentId]: defaults }));
        }
      });
  }, [selectedAgentId, connected]);

  const selectedAgent = agentList.find((a) => a.identity.agentId === selectedAgentId);
  const selectedCaps = selectedAgentId ? capabilities[selectedAgentId] : null;
  const selectedStatus = selectedAgent ? (STATUS_CONFIG[selectedAgent.status] || STATUS_CONFIG.offline) : STATUS_CONFIG.offline;

  const handleSendMessage = () => {
    if (!selectedAgentId || !quickMessage.trim()) return;
    sendChat(selectedAgentId, quickMessage.trim());
    setQuickMessage('');
  };

  const toggleTool = (tool: string) => {
    if (!selectedAgentId) return;
    setToolStates((prev) => ({
      ...prev,
      [selectedAgentId]: {
        ...prev[selectedAgentId],
        [tool]: !prev[selectedAgentId]?.[tool],
      },
    }));
    setConfigDirty(true);
  };

  const toggleSkill = (skillId: string) => {
    if (!selectedAgentId) return;
    setSkillStates((prev) => ({
      ...prev,
      [selectedAgentId]: {
        ...prev[selectedAgentId],
        [skillId]: !prev[selectedAgentId]?.[skillId],
      },
    }));
    setConfigDirty(true);
  };

  const handleConfigChange = (key: string, value: string) => {
    if (!selectedAgentId) return;
    setAgentConfigs((prev) => ({
      ...prev,
      [selectedAgentId]: { ...prev[selectedAgentId], [key]: value },
    }));
    setConfigDirty(true);
  };

  const handleSaveConfig = async () => {
    if (!selectedAgentId) return;
    setSaveStatus('saving');
    setSaveError(null);
    try {
      const result = await gateway.request<{ success: boolean; message?: string }>('config.set', {
        agentId: selectedAgentId,
        tools: toolStates[selectedAgentId],
        skills: skillStates[selectedAgentId],
        config: agentConfigs[selectedAgentId],
      });
      if (result?.success) {
        setConfigDirty(false);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        setSaveStatus('error');
        setSaveError(result?.message || 'Save failed');
      }
    } catch (err) {
      setSaveStatus('error');
      setSaveError((err as Error).message);
    }
  };

  const handleAgentLifecycle = async (action: 'start' | 'stop') => {
    if (!selectedAgentId) return;
    setLifecycleLoading(action);
    try {
      await gateway.request(`setup.agents.${action}`, { agentId: selectedAgentId });
    } catch { /* ignore — agent status events will update UI */ }
    setLifecycleLoading(null);
  };

  const handleAgentRestart = async () => {
    if (!selectedAgentId) return;
    setLifecycleLoading('restart');
    try {
      await gateway.request('setup.agents.stop', { agentId: selectedAgentId });
      // Brief pause to let process exit
      await new Promise((r) => setTimeout(r, 1000));
      await gateway.request('setup.agents.start', { agentId: selectedAgentId });
    } catch { /* ignore */ }
    setLifecycleLoading(null);
  };

  // Filtered tools
  const allTools = Object.keys(TOOL_CATALOG);
  const agentTools = selectedCaps?.tools || [];
  const mergedTools = [...new Set([...allTools, ...agentTools])];
  const filteredTools = mergedTools.filter((t) =>
    !toolSearch || t.toLowerCase().includes(toolSearch.toLowerCase()) ||
    (TOOL_CATALOG[t]?.description || '').toLowerCase().includes(toolSearch.toLowerCase()),
  );

  // Group tools by category
  const toolsByCategory: Record<string, string[]> = {};
  for (const t of filteredTools) {
    const cat = TOOL_CATALOG[t]?.category || 'Other';
    if (!toolsByCategory[cat]) toolsByCategory[cat] = [];
    toolsByCategory[cat].push(t);
  }

  // Filtered skills
  const filteredSkills = SKILL_CATALOG.filter((s) => {
    if (skillCategory !== 'All' && s.category !== skillCategory) return false;
    if (skillSearch && !s.name.toLowerCase().includes(skillSearch.toLowerCase()) &&
      !s.description.toLowerCase().includes(skillSearch.toLowerCase())) return false;
    return true;
  });

  const skillCategories = ['All', ...new Set(SKILL_CATALOG.map((s) => s.category))];

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      {/* Left sidebar — Agent list */}
      <div style={{
        width: 240,
        minWidth: 240,
        height: '100%',
        borderRight: '1px solid var(--border-primary)',
        background: 'var(--bg-secondary)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Sidebar header */}
        <div style={{
          padding: '14px 14px 10px',
          borderBottom: '1px solid var(--border-dim)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <Bot size={16} color="var(--cyan-bright)" />
          <span style={{
            fontFamily: 'var(--font-display)',
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 2,
            color: 'var(--cyan-bright)',
          }}>
            AGENTS
          </span>
          <span style={{
            fontSize: 9,
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            padding: '1px 6px',
            background: 'var(--bg-tertiary)',
            borderRadius: 3,
            marginLeft: 'auto',
          }}>
            {agentList.filter((a) => a.status !== 'offline').length}/{agentList.length}
          </span>
          <button
            onClick={() => void fetchCapabilities()}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 2,
              color: 'var(--text-muted)', display: 'flex',
            }}
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>

        {/* Agent list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
          {agentList.length === 0 ? (
            <div style={{
              padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 10,
            }}>
              <Bot size={24} style={{ marginBottom: 6, opacity: 0.3 }} />
              <div>Waiting for agents...</div>
            </div>
          ) : (
            agentList.map((agent) => {
              const agentId = agent.identity.agentId;
              const sc = STATUS_CONFIG[agent.status] || STATUS_CONFIG.offline;
              const isSelected = agentId === selectedAgentId;
              const isAlive = Date.now() - agent.lastHeartbeat < 30000;

              return (
                <button
                  key={agentId}
                  onClick={() => { setSelectedAgentId(agentId); setActiveTab('overview'); }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 6,
                    border: isSelected ? `1px solid ${sc.color}44` : '1px solid transparent',
                    background: isSelected ? `${sc.color}0a` : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    marginBottom: 2,
                    transition: 'all 0.15s ease',
                  }}
                >
                  {/* Status dot */}
                  <div style={{
                    width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                    background: isAlive ? sc.color : 'var(--text-muted)',
                    boxShadow: isAlive ? `0 0 6px ${sc.color}55` : 'none',
                  }} />
                  {/* Info */}
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: 1.5,
                      color: isSelected ? sc.color : 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {AGENT_NAMES[agentId] ?? agentId.toUpperCase()}
                    </div>
                    <div style={{
                      fontSize: 8,
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                      marginTop: 1,
                    }}>
                      {agent.identity.role} • {formatTimeAgo(agent.lastHeartbeat)}
                    </div>
                  </div>
                  {/* Active task indicator */}
                  {agent.activeTaskDescription && (
                    <Activity size={10} color="var(--amber)" style={{ flexShrink: 0 }} />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Main panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!selectedAgent ? (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 8, color: 'var(--text-muted)',
          }}>
            <Bot size={40} style={{ opacity: 0.2 }} />
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, letterSpacing: 2 }}>
              SELECT AN AGENT
            </span>
          </div>
        ) : (
          <>
            {/* Agent header */}
            <div style={{
              padding: '14px 20px',
              borderBottom: '1px solid var(--border-primary)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              background: 'var(--bg-secondary)',
            }}>
              {/* Avatar */}
              <div style={{
                width: 44, height: 44, borderRadius: 10, flexShrink: 0,
                background: `${selectedStatus.color}10`,
                border: `2px solid ${selectedStatus.color}44`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Bot size={22} color={selectedStatus.color} />
              </div>

              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 16,
                    fontWeight: 800,
                    letterSpacing: 2,
                    color: selectedStatus.color,
                  }}>
                    {AGENT_NAMES[selectedAgentId!] ?? selectedAgentId!.toUpperCase()}
                  </span>
                  <span style={{
                    fontSize: 8, padding: '2px 8px', borderRadius: 3,
                    background: `${ROLE_COLORS[selectedAgent.identity.role] || ROLE_COLORS.default}15`,
                    border: `1px solid ${ROLE_COLORS[selectedAgent.identity.role] || ROLE_COLORS.default}33`,
                    color: ROLE_COLORS[selectedAgent.identity.role] || ROLE_COLORS.default,
                    fontFamily: 'var(--font-display)', letterSpacing: 1, textTransform: 'uppercase',
                  }}>
                    {selectedAgent.identity.role}
                  </span>
                  <span style={{
                    fontSize: 8, padding: '2px 8px', borderRadius: 3,
                    background: selectedStatus.bg,
                    border: `1px solid ${selectedStatus.color}33`,
                    color: selectedStatus.color,
                    fontFamily: 'var(--font-display)', letterSpacing: 1,
                    display: 'flex', alignItems: 'center', gap: 3,
                  }}>
                    <selectedStatus.Icon size={8} />
                    {selectedStatus.label}
                  </span>

                  {/* Lifecycle buttons */}
                  {selectedAgent.status === 'offline' && (
                    <button
                      onClick={() => void handleAgentLifecycle('start')}
                      disabled={lifecycleLoading !== null}
                      title="Start agent"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 3,
                        padding: '2px 8px', borderRadius: 3, fontSize: 8,
                        fontFamily: 'var(--font-display)', letterSpacing: 1,
                        background: 'rgba(0,255,65,0.1)', border: '1px solid rgba(0,255,65,0.3)',
                        color: 'var(--green-bright)', cursor: 'pointer',
                      }}
                    >
                      <Play size={8} />
                      {lifecycleLoading === 'start' ? 'STARTING...' : 'START'}
                    </button>
                  )}
                  {selectedAgent.status !== 'offline' && (
                    <>
                      <button
                        onClick={() => void handleAgentLifecycle('stop')}
                        disabled={lifecycleLoading !== null}
                        title="Stop agent"
                        style={{
                          display: 'flex', alignItems: 'center', gap: 3,
                          padding: '2px 8px', borderRadius: 3, fontSize: 8,
                          fontFamily: 'var(--font-display)', letterSpacing: 1,
                          background: 'rgba(255,51,51,0.1)', border: '1px solid rgba(255,51,51,0.3)',
                          color: 'var(--red-bright)', cursor: 'pointer',
                        }}
                      >
                        <Pause size={8} />
                        {lifecycleLoading === 'stop' ? 'STOPPING...' : 'STOP'}
                      </button>
                      <button
                        onClick={() => void handleAgentRestart()}
                        disabled={lifecycleLoading !== null}
                        title="Restart agent"
                        style={{
                          display: 'flex', alignItems: 'center', gap: 3,
                          padding: '2px 8px', borderRadius: 3, fontSize: 8,
                          fontFamily: 'var(--font-display)', letterSpacing: 1,
                          background: 'rgba(255,170,0,0.1)', border: '1px solid rgba(255,170,0,0.3)',
                          color: 'var(--amber)', cursor: 'pointer',
                        }}
                      >
                        <RefreshCw size={8} />
                        {lifecycleLoading === 'restart' ? 'RESTARTING...' : 'RESTART'}
                      </button>
                    </>
                  )}
                </div>
                <div style={{
                  fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 3,
                  display: 'flex', gap: 12,
                }}>
                  <span>{selectedAgent.identity.machineId}</span>
                  <span>heartbeat {formatTimeAgo(selectedAgent.lastHeartbeat)}</span>
                  {selectedCaps?.model && <span>model: {selectedCaps.model}</span>}
                </div>
              </div>

              {/* Save button */}
              {(configDirty || saveStatus !== 'idle') && (
                <button
                  onClick={handleSaveConfig}
                  disabled={saveStatus === 'saving'}
                  title={saveError || undefined}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '6px 14px', borderRadius: 4,
                    background: saveStatus === 'saved' ? 'rgba(0,255,65,0.15)' : saveStatus === 'error' ? 'rgba(255,60,60,0.1)' : 'rgba(0,255,65,0.1)',
                    border: `1px solid ${saveStatus === 'error' ? 'rgba(255,60,60,0.3)' : 'var(--green-dim)'}`,
                    color: saveStatus === 'error' ? '#ff6060' : 'var(--green-bright)',
                    cursor: saveStatus === 'saving' ? 'wait' : 'pointer',
                    fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 1,
                  }}
                >
                  {saveStatus === 'saving' ? <><RefreshCw size={10} /> SAVING...</> :
                   saveStatus === 'saved' ? <><CheckCircle2 size={10} /> SAVED</> :
                   saveStatus === 'error' ? <><XCircle size={10} /> ERROR</> :
                   <><Save size={10} /> SAVE</>}
                </button>
              )}
            </div>

            {/* Tabs */}
            <div style={{
              display: 'flex',
              borderBottom: '1px solid var(--border-primary)',
              background: 'var(--bg-secondary)',
              padding: '0 16px',
            }}>
              {TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      padding: '10px 16px',
                      background: 'none',
                      border: 'none',
                      borderBottom: isActive ? `2px solid var(--cyan-bright)` : '2px solid transparent',
                      color: isActive ? 'var(--cyan-bright)' : 'var(--text-muted)',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-display)',
                      fontSize: 10,
                      letterSpacing: 1,
                      textTransform: 'uppercase',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <tab.icon size={12} />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Tab content */}
            <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
              {/* ====== OVERVIEW TAB ====== */}
              {activeTab === 'overview' && (
                <div>
                  {/* Active Task Banner */}
                  {selectedAgent.activeTaskDescription && (
                    <div style={{
                      padding: '10px 14px', borderRadius: 6, marginBottom: 16,
                      background: 'rgba(255,170,0,0.06)', border: '1px solid rgba(255,170,0,0.2)',
                      display: 'flex', alignItems: 'center', gap: 10,
                    }}>
                      <Activity size={14} color="var(--amber)" />
                      <div>
                        <div style={{ fontSize: 8, color: 'var(--amber)', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>ACTIVE TASK</div>
                        <div style={{ fontSize: 12, color: 'var(--text-white)', marginTop: 2 }}>{selectedAgent.activeTaskDescription}</div>
                      </div>
                    </div>
                  )}

                  {/* Stats Grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20 }}>
                    <StatCard label="Completed" value={selectedAgent.completedTasks} icon={CheckCircle2} color="var(--green-bright)" />
                    <StatCard label="Failed" value={selectedAgent.failedTasks} icon={XCircle} color="var(--red-bright)" />
                    <StatCard label="Tools" value={selectedCaps?.tools?.length || 0} icon={Wrench} color="var(--cyan-bright)" />
                    <StatCard label="Plugins" value={selectedCaps?.plugins?.length || 0} icon={Package} color="var(--purple)" />
                  </div>

                  {/* KV Grid */}
                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20,
                  }}>
                    <KVCard label="Model" value={selectedCaps?.model || 'claude-opus-4-6'} icon={Brain} color="var(--purple)" />
                    <KVCard label="Role" value={selectedAgent.identity.role} icon={Shield} color={ROLE_COLORS[selectedAgent.identity.role] || ROLE_COLORS.default} />
                    <KVCard label="Machine" value={selectedAgent.identity.machineId} icon={Layers} color="var(--text-secondary)" />
                    <KVCard label="Hostname" value={selectedAgent.identity.hostname || 'localhost'} icon={Radio} color="var(--text-secondary)" />
                  </div>

                  {/* Capabilities */}
                  {selectedCaps?.capabilities && selectedCaps.capabilities.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <SectionLabel>CAPABILITIES</SectionLabel>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {selectedCaps.capabilities.map((cap) => (
                          <span key={cap} style={{
                            fontSize: 9, padding: '3px 8px', borderRadius: 4,
                            background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)',
                            color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)',
                          }}>
                            {cap}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Plugins */}
                  {selectedCaps?.plugins && selectedCaps.plugins.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <SectionLabel>PLUGINS</SectionLabel>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {selectedCaps.plugins.map((p) => (
                          <span key={p} style={{
                            fontSize: 9, padding: '3px 8px', borderRadius: 4,
                            background: 'rgba(191,90,242,0.06)', border: '1px solid rgba(191,90,242,0.2)',
                            color: 'var(--purple)', fontFamily: 'var(--font-mono)',
                          }}>
                            {p}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Quick Chat */}
                  <div style={{ marginTop: 16 }}>
                    <SectionLabel>QUICK CHAT</SectionLabel>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Terminal size={14} color="var(--text-muted)" style={{ marginTop: 8, flexShrink: 0 }} />
                      <input
                        value={quickMessage}
                        onChange={(e) => setQuickMessage(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSendMessage(); }}
                        placeholder={`Send message to ${selectedAgentId}...`}
                        style={{
                          flex: 1, padding: '8px 12px', fontSize: 12,
                          background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)',
                          borderRadius: 6, color: 'var(--text-primary)', fontFamily: 'var(--font-ui)',
                          outline: 'none',
                        }}
                      />
                      <button
                        onClick={handleSendMessage}
                        disabled={!quickMessage.trim()}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          padding: '8px 14px', borderRadius: 6,
                          background: quickMessage.trim() ? 'rgba(0,255,65,0.1)' : 'var(--bg-tertiary)',
                          border: `1px solid ${quickMessage.trim() ? 'var(--green-dim)' : 'var(--border-dim)'}`,
                          color: quickMessage.trim() ? 'var(--green-bright)' : 'var(--text-muted)',
                          cursor: quickMessage.trim() ? 'pointer' : 'default',
                          fontSize: 9, fontFamily: 'var(--font-display)', letterSpacing: 1,
                        }}
                      >
                        <Send size={10} /> SEND
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* ====== TOOLS TAB ====== */}
              {activeTab === 'tools' && selectedAgentId && (
                <div>
                  {/* Tools header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                    <div style={{
                      flex: 1, display: 'flex', alignItems: 'center', gap: 6,
                      background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)',
                      borderRadius: 6, padding: '6px 10px',
                    }}>
                      <Search size={12} color="var(--text-muted)" />
                      <input
                        value={toolSearch}
                        onChange={(e) => setToolSearch(e.target.value)}
                        placeholder="Search tools..."
                        style={{
                          flex: 1, background: 'none', border: 'none', color: 'var(--text-primary)',
                          fontFamily: 'var(--font-ui)', fontSize: 11, outline: 'none',
                        }}
                      />
                    </div>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {Object.values(toolStates[selectedAgentId] || {}).filter(Boolean).length}/{mergedTools.length} enabled
                    </span>
                    <button
                      onClick={() => {
                        const all: Record<string, boolean> = {};
                        for (const t of mergedTools) all[t] = true;
                        setToolStates((prev) => ({ ...prev, [selectedAgentId!]: all }));
                        setConfigDirty(true);
                      }}
                      style={{
                        fontSize: 8, padding: '4px 10px', borderRadius: 4,
                        background: 'rgba(0,255,65,0.06)', border: '1px solid var(--green-dim)',
                        color: 'var(--green-bright)', cursor: 'pointer',
                        fontFamily: 'var(--font-display)', letterSpacing: 1,
                      }}
                    >
                      ENABLE ALL
                    </button>
                    <button
                      onClick={() => {
                        const all: Record<string, boolean> = {};
                        for (const t of mergedTools) all[t] = false;
                        setToolStates((prev) => ({ ...prev, [selectedAgentId!]: all }));
                        setConfigDirty(true);
                      }}
                      style={{
                        fontSize: 8, padding: '4px 10px', borderRadius: 4,
                        background: 'rgba(255,60,60,0.06)', border: '1px solid rgba(255,60,60,0.2)',
                        color: '#ff6060', cursor: 'pointer',
                        fontFamily: 'var(--font-display)', letterSpacing: 1,
                      }}
                    >
                      DISABLE ALL
                    </button>
                  </div>

                  {/* Tools grouped by category */}
                  {Object.entries(toolsByCategory).sort(([a], [b]) => a.localeCompare(b)).map(([category, tools]) => (
                    <div key={category} style={{ marginBottom: 14 }}>
                      <div style={{
                        fontSize: 9, fontFamily: 'var(--font-display)', letterSpacing: 1.5,
                        color: 'var(--cyan-bright)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4,
                      }}>
                        <Layers size={10} />
                        {category.toUpperCase()} ({tools.length})
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {tools.map((tool) => {
                          const isEnabled = toolStates[selectedAgentId!]?.[tool] !== false;
                          const info = TOOL_CATALOG[tool];
                          return (
                            <div
                              key={tool}
                              onClick={() => toggleTool(tool)}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '8px 12px', borderRadius: 6, cursor: 'pointer',
                                background: isEnabled ? 'rgba(0,255,65,0.03)' : 'var(--bg-tertiary)',
                                border: `1px solid ${isEnabled ? 'var(--green-dim)' : 'var(--border-dim)'}`,
                                transition: 'all 0.15s ease',
                              }}
                            >
                              {isEnabled
                                ? <ToggleRight size={16} color="var(--green-bright)" />
                                : <ToggleLeft size={16} color="var(--text-muted)" />
                              }
                              <div style={{ flex: 1 }}>
                                <span style={{
                                  fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600,
                                  color: isEnabled ? 'var(--text-primary)' : 'var(--text-muted)',
                                }}>
                                  {tool}
                                </span>
                                {info && (
                                  <span style={{
                                    fontSize: 10, color: 'var(--text-muted)', marginLeft: 8,
                                    fontFamily: 'var(--font-ui)',
                                  }}>
                                    {info.description}
                                  </span>
                                )}
                              </div>
                              <span style={{
                                fontSize: 7, fontFamily: 'var(--font-display)', letterSpacing: 1,
                                color: isEnabled ? 'var(--green-bright)' : 'var(--text-muted)',
                              }}>
                                {isEnabled ? 'ON' : 'OFF'}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ====== SKILLS TAB ====== */}
              {activeTab === 'skills' && selectedAgentId && (
                <div>
                  {/* Skills header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                    <div style={{
                      flex: 1, minWidth: 180, display: 'flex', alignItems: 'center', gap: 6,
                      background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)',
                      borderRadius: 6, padding: '6px 10px',
                    }}>
                      <Search size={12} color="var(--text-muted)" />
                      <input
                        value={skillSearch}
                        onChange={(e) => setSkillSearch(e.target.value)}
                        placeholder="Search skills..."
                        style={{
                          flex: 1, background: 'none', border: 'none', color: 'var(--text-primary)',
                          fontFamily: 'var(--font-ui)', fontSize: 11, outline: 'none',
                        }}
                      />
                    </div>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {Object.values(skillStates[selectedAgentId] || {}).filter(Boolean).length}/{SKILL_CATALOG.length} enabled
                    </span>
                  </div>

                  {/* Category tabs */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 14 }}>
                    {skillCategories.map((cat) => (
                      <button
                        key={cat}
                        onClick={() => setSkillCategory(cat)}
                        style={{
                          fontSize: 9, padding: '4px 10px', borderRadius: 4,
                          background: skillCategory === cat ? 'rgba(0,255,65,0.1)' : 'var(--bg-tertiary)',
                          border: `1px solid ${skillCategory === cat ? 'var(--green-dim)' : 'var(--border-dim)'}`,
                          color: skillCategory === cat ? 'var(--green-bright)' : 'var(--text-muted)',
                          cursor: 'pointer', fontFamily: 'var(--font-display)', letterSpacing: 1,
                        }}
                      >
                        {cat.toUpperCase()}
                      </button>
                    ))}
                  </div>

                  {/* Skills list */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                    {filteredSkills.map((skill) => {
                      const isEnabled = skillStates[selectedAgentId]?.[skill.id] !== false;
                      return (
                        <div
                          key={skill.id}
                          onClick={() => toggleSkill(skill.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
                            background: isEnabled ? 'rgba(0,255,65,0.03)' : 'var(--bg-tertiary)',
                            border: `1px solid ${isEnabled ? 'var(--green-dim)' : 'var(--border-dim)'}`,
                            transition: 'all 0.15s ease',
                          }}
                        >
                          <span style={{ fontSize: 20 }}>{skill.emoji}</span>
                          <div style={{ flex: 1 }}>
                            <div style={{
                              fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700,
                              letterSpacing: 1, color: isEnabled ? 'var(--text-primary)' : 'var(--text-muted)',
                            }}>
                              {skill.name}
                            </div>
                            <div style={{
                              fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)',
                              marginTop: 1,
                            }}>
                              {skill.description}
                            </div>
                          </div>
                          <div style={{
                            fontSize: 8, padding: '2px 6px', borderRadius: 3,
                            background: `${isEnabled ? 'rgba(0,255,65,0.1)' : 'rgba(255,60,60,0.06)'}`,
                            border: `1px solid ${isEnabled ? 'var(--green-dim)' : 'rgba(255,60,60,0.15)'}`,
                            color: isEnabled ? 'var(--green-bright)' : '#ff6060',
                            fontFamily: 'var(--font-display)', letterSpacing: 1,
                          }}>
                            {isEnabled ? 'ON' : 'OFF'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ====== ACTIVITY TAB ====== */}
              {activeTab === 'activity' && selectedAgentId && (
                <div>
                  <SectionLabel>ACTIVITY LOG</SectionLabel>
                  {(() => {
                    const agentActivity = activityLog
                      .filter((a) => a.agentId === selectedAgentId)
                      .slice(-50)
                      .reverse();

                    if (agentActivity.length === 0) {
                      return (
                        <div style={{
                          padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11,
                        }}>
                          No activity recorded yet.
                        </div>
                      );
                    }

                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {agentActivity.map((a) => (
                          <div key={a.id} style={{
                            display: 'flex', alignItems: 'baseline', gap: 10,
                            padding: '6px 10px', borderRadius: 4,
                            background: 'var(--bg-secondary)', border: '1px solid var(--border-dim)',
                          }}>
                            <span style={{
                              fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
                              flexShrink: 0, minWidth: 60,
                            }}>
                              {new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                            <span style={{
                              fontSize: 8, padding: '1px 6px', borderRadius: 3,
                              background: a.type === 'error' ? 'rgba(255,60,60,0.08)' : 'var(--bg-tertiary)',
                              border: `1px solid ${a.type === 'error' ? 'rgba(255,60,60,0.2)' : 'var(--border-dim)'}`,
                              color: a.type === 'error' ? '#ff6060' : 'var(--text-muted)',
                              fontFamily: 'var(--font-display)', letterSpacing: 0.5,
                              flexShrink: 0, textTransform: 'uppercase',
                            }}>
                              {a.type || 'info'}
                            </span>
                            <span style={{
                              fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {a.detail}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* ====== CONFIG TAB ====== */}
              {activeTab === 'config' && selectedAgentId && agentConfigs[selectedAgentId] && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                    <SectionLabel>AGENT CONFIGURATION</SectionLabel>
                    <div style={{ flex: 1 }} />
                    <button
                      onClick={() => {
                        // Reset to defaults
                        setAgentConfigs((prev) => {
                          const copy = { ...prev };
                          delete copy[selectedAgentId!];
                          return copy;
                        });
                        setConfigDirty(false);
                      }}
                      style={{
                        fontSize: 8, padding: '4px 10px', borderRadius: 4,
                        background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)',
                        color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                        fontFamily: 'var(--font-display)', letterSpacing: 1,
                      }}
                    >
                      <RotateCcw size={9} /> RESET
                    </button>
                    <button
                      onClick={handleSaveConfig}
                      disabled={!configDirty}
                      style={{
                        fontSize: 8, padding: '4px 10px', borderRadius: 4,
                        background: configDirty ? 'rgba(0,255,65,0.1)' : 'var(--bg-tertiary)',
                        border: `1px solid ${configDirty ? 'var(--green-dim)' : 'var(--border-dim)'}`,
                        color: configDirty ? 'var(--green-bright)' : 'var(--text-muted)',
                        cursor: configDirty ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 4,
                        fontFamily: 'var(--font-display)', letterSpacing: 1,
                      }}
                    >
                      <Save size={9} /> SAVE
                    </button>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    {/* Model */}
                    <ConfigField
                      label="Primary Model"
                      value={agentConfigs[selectedAgentId].model}
                      onChange={(v) => handleConfigChange('model', v)}
                      type="select"
                      options={[
                        'claude-opus-4-6',
                        'claude-sonnet-4-6',
                        'claude-haiku-4-5-20251001',
                        'gpt-5.2',
                        'gpt-5-mini',
                        'o3',
                        'gemini-2.5-pro',
                      ]}
                    />

                    {/* Fallback models */}
                    <ConfigField
                      label="Fallback Models (comma-separated)"
                      value={agentConfigs[selectedAgentId].fallbackModels}
                      onChange={(v) => handleConfigChange('fallbackModels', v)}
                    />

                    {/* Max tokens */}
                    <ConfigField
                      label="Max Tokens"
                      value={agentConfigs[selectedAgentId].maxTokens}
                      onChange={(v) => handleConfigChange('maxTokens', v)}
                      type="number"
                    />

                    {/* Temperature */}
                    <ConfigField
                      label="Temperature"
                      value={agentConfigs[selectedAgentId].temperature}
                      onChange={(v) => handleConfigChange('temperature', v)}
                      type="number"
                    />

                    {/* Tool timeout */}
                    <ConfigField
                      label="Tool Timeout (seconds)"
                      value={agentConfigs[selectedAgentId].toolTimeout}
                      onChange={(v) => handleConfigChange('toolTimeout', v)}
                      type="number"
                    />

                    {/* Memory */}
                    <ConfigField
                      label="Memory Enabled"
                      value={agentConfigs[selectedAgentId].memoryEnabled}
                      onChange={(v) => handleConfigChange('memoryEnabled', v)}
                      type="select"
                      options={['true', 'false']}
                    />
                  </div>

                  {/* Claude CLI Auth */}
                  <div style={{
                    marginTop: 16, padding: 14, borderRadius: 8,
                    background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <Key size={12} style={{ color: 'var(--cyan-bright)' }} />
                      <span style={{
                        fontSize: 9, fontFamily: 'var(--font-display)', letterSpacing: 1,
                        color: 'var(--text-muted)', textTransform: 'uppercase',
                      }}>
                        CLAUDE CLI AUTH (MAX SUBSCRIPTION)
                      </span>
                      <div style={{ flex: 1 }} />
                      {(() => {
                        const status = claudeAuthStatus[selectedAgentId!];
                        if (!status) return null;
                        if (status.loading) return (
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                            <RefreshCw size={10} style={{ animation: 'spin 1s linear infinite', marginRight: 4 }} />
                            Checking...
                          </span>
                        );
                        return (
                          <span style={{
                            fontSize: 10, fontFamily: 'var(--font-mono)',
                            display: 'flex', alignItems: 'center', gap: 4,
                            color: status.loggedIn ? 'var(--green-bright)' : 'var(--red-bright)',
                          }}>
                            {status.loggedIn
                              ? <><CheckCircle2 size={11} /> Logged in{status.email ? ` (${status.email})` : ''}</>
                              : <><XCircle size={11} /> {status.error || 'Not logged in'}</>
                            }
                          </span>
                        );
                      })()}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={async () => {
                          const aid = selectedAgentId!;
                          setClaudeAuthStatus((prev) => ({ ...prev, [aid]: { loggedIn: false, loading: true } }));
                          try {
                            const res = await gateway.request<{ loggedIn: boolean; email?: string; error?: string }>('agents.claude-status', { agentId: aid });
                            setClaudeAuthStatus((prev) => ({ ...prev, [aid]: { loggedIn: res?.loggedIn ?? false, email: res?.email, loading: false, error: res?.error } }));
                          } catch (err) {
                            setClaudeAuthStatus((prev) => ({ ...prev, [aid]: { loggedIn: false, loading: false, error: String(err) } }));
                          }
                        }}
                        style={{
                          fontSize: 9, padding: '6px 14px', borderRadius: 4,
                          background: 'rgba(0,255,255,0.06)', border: '1px solid rgba(0,255,255,0.2)',
                          color: 'var(--cyan-bright)', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: 5,
                          fontFamily: 'var(--font-display)', letterSpacing: 1,
                        }}
                      >
                        <RefreshCw size={10} /> CHECK STATUS
                      </button>
                      <button
                        disabled={!!claudeLoginLoading[selectedAgentId!]}
                        onClick={async () => {
                          const aid = selectedAgentId!;
                          setClaudeLoginLoading((prev) => ({ ...prev, [aid]: true }));
                          setClaudeAuthStatus((prev) => ({ ...prev, [aid]: { loggedIn: false, loading: true } }));
                          try {
                            const res = await gateway.request<{ loggedIn: boolean; email?: string; output?: string; error?: string }>('agents.claude-login', { agentId: aid });
                            setClaudeAuthStatus((prev) => ({ ...prev, [aid]: { loggedIn: res?.loggedIn ?? false, email: res?.email, loading: false, error: res?.loggedIn ? undefined : (res?.error || res?.output) } }));
                          } catch (err) {
                            setClaudeAuthStatus((prev) => ({ ...prev, [aid]: { loggedIn: false, loading: false, error: String(err) } }));
                          } finally {
                            setClaudeLoginLoading((prev) => ({ ...prev, [aid]: false }));
                          }
                        }}
                        style={{
                          fontSize: 9, padding: '6px 14px', borderRadius: 4,
                          background: claudeLoginLoading[selectedAgentId!]
                            ? 'rgba(255,170,0,0.06)'
                            : 'rgba(0,255,65,0.06)',
                          border: `1px solid ${claudeLoginLoading[selectedAgentId!] ? 'rgba(255,170,0,0.2)' : 'rgba(0,255,65,0.2)'}`,
                          color: claudeLoginLoading[selectedAgentId!] ? 'var(--amber)' : 'var(--green-bright)',
                          cursor: claudeLoginLoading[selectedAgentId!] ? 'wait' : 'pointer',
                          display: 'flex', alignItems: 'center', gap: 5,
                          fontFamily: 'var(--font-display)', letterSpacing: 1,
                        }}
                      >
                        <LogIn size={10} /> {claudeLoginLoading[selectedAgentId!] ? 'LOGGING IN...' : 'LOGIN CLI'}
                      </button>
                    </div>
                  </div>

                  {/* System prompt */}
                  <div style={{ marginTop: 16 }}>
                    <div style={{
                      fontSize: 9, fontFamily: 'var(--font-display)', letterSpacing: 1,
                      color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase',
                    }}>
                      SYSTEM PROMPT
                    </div>
                    <textarea
                      value={agentConfigs[selectedAgentId].systemPrompt}
                      onChange={(e) => handleConfigChange('systemPrompt', e.target.value)}
                      rows={6}
                      style={{
                        width: '100%', padding: '10px 12px', borderRadius: 6,
                        background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)',
                        color: 'var(--text-primary)', fontFamily: 'var(--font-mono)',
                        fontSize: 11, resize: 'vertical', outline: 'none', lineHeight: 1.6,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --- Shared sub-components ---

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 9, fontFamily: 'var(--font-display)', letterSpacing: 1.5,
      color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase',
    }}>
      {children}
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color }: {
  label: string; value: number; icon: typeof CheckCircle2; color: string;
}) {
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 8,
      background: 'var(--bg-secondary)', border: '1px solid var(--border-dim)',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <Icon size={16} color={color} style={{ opacity: 0.7 }} />
      <div>
        <div style={{
          fontSize: 20, fontWeight: 800, color,
          fontFamily: 'var(--font-display)', lineHeight: 1,
        }}>
          {value}
        </div>
        <div style={{
          fontSize: 7, color: 'var(--text-muted)',
          fontFamily: 'var(--font-display)', letterSpacing: 1,
          textTransform: 'uppercase', marginTop: 2,
        }}>
          {label}
        </div>
      </div>
    </div>
  );
}

function KVCard({ label, value, icon: Icon, color }: {
  label: string; value: string; icon: typeof Brain; color: string;
}) {
  return (
    <div style={{
      padding: '10px 14px', borderRadius: 8,
      background: 'var(--bg-secondary)', border: '1px solid var(--border-dim)',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <Icon size={14} color={color} style={{ opacity: 0.6, flexShrink: 0 }} />
      <div>
        <div style={{
          fontSize: 7, color: 'var(--text-muted)',
          fontFamily: 'var(--font-display)', letterSpacing: 1,
          textTransform: 'uppercase',
        }}>
          {label}
        </div>
        <div style={{
          fontSize: 11, color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)', marginTop: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {value}
        </div>
      </div>
    </div>
  );
}

function ConfigField({ label, value, onChange, type = 'text', options }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: 'text' | 'number' | 'select'; options?: string[];
}) {
  const inputStyle = {
    width: '100%', padding: '8px 10px', borderRadius: 6,
    background: 'var(--bg-tertiary)', border: '1px solid var(--border-dim)',
    color: 'var(--text-primary)', fontFamily: 'var(--font-mono)',
    fontSize: 11, outline: 'none',
  };

  return (
    <div>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-display)', letterSpacing: 1,
        color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase',
      }}>
        {label}
      </div>
      {type === 'select' && options ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        />
      )}
    </div>
  );
}
