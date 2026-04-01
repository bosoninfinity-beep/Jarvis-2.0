import { createLogger, type AgentId } from '@jarvis/shared';

const log = createLogger('orchestration:decomposer');

export interface SubTask {
  id: string;
  title: string;
  description: string;
  requiredCapabilities: string[];
  preferredAgent?: AgentId;
  priority: 'low' | 'normal' | 'high' | 'critical';
  dependencies: string[]; // IDs of tasks that must complete first
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
}

export interface DecompositionResult {
  originalTask: string;
  subtasks: SubTask[];
  strategy: string;
  estimatedTotalTime: string;
}

/** Capability-to-agent mapping */
const CAPABILITY_AGENT_MAP = {
  code: 'agent-smith',
  build: 'agent-smith',
  deploy: 'agent-smith',
  'app-store': 'agent-smith',
  'react-native': 'agent-smith',
  devops: 'agent-smith',
  testing: 'agent-smith',
  'social-media': 'agent-johny',
  marketing: 'agent-johny',
  research: 'agent-johny',
  content: 'agent-johny',
  analytics: 'agent-johny',
  pr: 'agent-johny',
  seo: 'agent-johny',
} as const satisfies Record<string, AgentId>;

/**
 * TaskDecomposer - Breaks complex user requests into subtasks.
 *
 * Uses keyword matching and patterns to assign tasks to agents.
 * For complex decomposition, delegates to LLM via the gateway's provider.
 */
export class TaskDecomposer {
  /**
   * Rule-based decomposition for common patterns.
   * Falls through to LLM-based decomposition for complex cases.
   */
  decompose(taskDescription: string, taskTitle: string): DecompositionResult {
    const text = `${taskTitle} ${taskDescription}`.toLowerCase();
    const subtasks: SubTask[] = [];
    let strategy = '';
    let idCounter = 0;

    const makeId = () => `sub-${Date.now()}-${++idCounter}`;

    // Pattern: "build an app" / "create application" / "develop"
    if (this.matchesPattern(text, ['build app', 'create app', 'develop app', 'react native', 'mobile app'])) {
      strategy = 'App Development Pipeline: research → design → develop → test → deploy';
      subtasks.push(
        { id: makeId(), title: 'Market research for app concept', description: `Research market for: ${taskTitle}. Analyze competitors, target audience, market size.`, requiredCapabilities: ['research'], preferredAgent: 'agent-johny', priority: 'high', dependencies: [], estimatedComplexity: 'moderate' },
        { id: makeId(), title: 'Technical architecture and setup', description: 'Set up React Native project, configure build tools, define architecture.', requiredCapabilities: ['code', 'react-native'], preferredAgent: 'agent-smith', priority: 'high', dependencies: [], estimatedComplexity: 'moderate' },
        { id: makeId(), title: 'Core feature implementation', description: `Implement core features for: ${taskTitle}`, requiredCapabilities: ['code'], preferredAgent: 'agent-smith', priority: 'critical', dependencies: [], estimatedComplexity: 'complex' },
        { id: makeId(), title: 'Create marketing materials and app store assets', description: 'Design app store screenshots, write descriptions, prepare marketing content.', requiredCapabilities: ['content', 'marketing'], preferredAgent: 'agent-johny', priority: 'normal', dependencies: [], estimatedComplexity: 'moderate' },
        { id: makeId(), title: 'Testing and QA', description: 'Run automated tests, perform manual testing, fix bugs.', requiredCapabilities: ['testing'], preferredAgent: 'agent-smith', priority: 'high', dependencies: [], estimatedComplexity: 'moderate' },
        { id: makeId(), title: 'Build and submit to app stores', description: 'Build production binaries and submit to App Store and Google Play.', requiredCapabilities: ['build', 'app-store'], preferredAgent: 'agent-smith', priority: 'high', dependencies: [], estimatedComplexity: 'moderate' },
        { id: makeId(), title: 'Launch marketing campaign', description: 'Execute launch campaign across social media platforms.', requiredCapabilities: ['social-media', 'marketing'], preferredAgent: 'agent-johny', priority: 'normal', dependencies: [], estimatedComplexity: 'moderate' },
      );
      // Set dependencies
      subtasks[2]!.dependencies = [subtasks[1]!.id];
      subtasks[4]!.dependencies = [subtasks[2]!.id];
      subtasks[5]!.dependencies = [subtasks[4]!.id];
      subtasks[6]!.dependencies = [subtasks[3]!.id, subtasks[5]!.id];
    }

    // Pattern: "market research" / "analyze market" / "competitive analysis"
    else if (this.matchesPattern(text, ['market research', 'competitive analysis', 'analyze market', 'market study', 'industry analysis'])) {
      strategy = 'Research Pipeline: gather → analyze → strategize → report';
      subtasks.push(
        { id: makeId(), title: 'Data gathering and web research', description: `Comprehensive web search and data collection for: ${taskTitle}`, requiredCapabilities: ['research'], preferredAgent: 'agent-johny', priority: 'high', dependencies: [], estimatedComplexity: 'moderate' },
        { id: makeId(), title: 'Analysis and pattern recognition', description: 'Synthesize gathered data, identify patterns, perform SWOT analysis.', requiredCapabilities: ['research', 'analytics'], preferredAgent: 'agent-johny', priority: 'high', dependencies: [], estimatedComplexity: 'complex' },
        { id: makeId(), title: 'Strategic recommendations', description: 'Develop actionable recommendations based on analysis.', requiredCapabilities: ['research'], preferredAgent: 'agent-johny', priority: 'normal', dependencies: [], estimatedComplexity: 'moderate' },
        { id: makeId(), title: 'Generate report and presentation', description: 'Create comprehensive report with executive summary, findings, and recommendations.', requiredCapabilities: ['content'], preferredAgent: 'agent-johny', priority: 'normal', dependencies: [], estimatedComplexity: 'simple' },
      );
      subtasks[1]!.dependencies = [subtasks[0]!.id];
      subtasks[2]!.dependencies = [subtasks[1]!.id];
      subtasks[3]!.dependencies = [subtasks[2]!.id];
    }

    // Pattern: "social media campaign" / "post on social" / "content calendar"
    else if (this.matchesPattern(text, ['social media', 'campaign', 'content calendar', 'post on', 'social strategy'])) {
      strategy = 'Social Media Campaign: plan → create → schedule → publish → analyze';
      subtasks.push(
        { id: makeId(), title: 'Campaign strategy and planning', description: `Plan social media campaign for: ${taskTitle}. Define goals, audience, platforms.`, requiredCapabilities: ['marketing'], preferredAgent: 'agent-johny', priority: 'high', dependencies: [], estimatedComplexity: 'moderate' },
        { id: makeId(), title: 'Content creation', description: 'Create post copy, captions, hashtags for all platforms.', requiredCapabilities: ['content'], preferredAgent: 'agent-johny', priority: 'high', dependencies: [], estimatedComplexity: 'moderate' },
        { id: makeId(), title: 'Schedule and publish', description: 'Schedule posts across platforms according to content calendar.', requiredCapabilities: ['social-media'], preferredAgent: 'agent-johny', priority: 'normal', dependencies: [], estimatedComplexity: 'simple' },
        { id: makeId(), title: 'Monitor and analyze', description: 'Track campaign performance, engagement metrics, adjust strategy.', requiredCapabilities: ['analytics'], preferredAgent: 'agent-johny', priority: 'normal', dependencies: [], estimatedComplexity: 'simple' },
      );
      subtasks[1]!.dependencies = [subtasks[0]!.id];
      subtasks[2]!.dependencies = [subtasks[1]!.id];
      subtasks[3]!.dependencies = [subtasks[2]!.id];
    }

    // Pattern: "deploy" / "update website" / "maintenance"
    else if (this.matchesPattern(text, ['deploy', 'update website', 'maintenance', 'fix bug', 'hotfix'])) {
      strategy = 'Deployment Pipeline: fix/update → test → deploy → verify';
      subtasks.push(
        { id: makeId(), title: 'Implement changes', description: `Implement: ${taskTitle}`, requiredCapabilities: ['code'], preferredAgent: 'agent-smith', priority: 'high', dependencies: [], estimatedComplexity: 'moderate' },
        { id: makeId(), title: 'Test changes', description: 'Run automated tests and verify changes.', requiredCapabilities: ['testing'], preferredAgent: 'agent-smith', priority: 'high', dependencies: [], estimatedComplexity: 'simple' },
        { id: makeId(), title: 'Deploy to production', description: 'Deploy changes to production environment.', requiredCapabilities: ['deploy'], preferredAgent: 'agent-smith', priority: 'high', dependencies: [], estimatedComplexity: 'simple' },
        { id: makeId(), title: 'Post-deployment verification', description: 'Monitor deployment, verify functionality, check for issues.', requiredCapabilities: ['deploy'], preferredAgent: 'agent-smith', priority: 'normal', dependencies: [], estimatedComplexity: 'simple' },
      );
      subtasks[1]!.dependencies = [subtasks[0]!.id];
      subtasks[2]!.dependencies = [subtasks[1]!.id];
      subtasks[3]!.dependencies = [subtasks[2]!.id];
    }

    // Generic: single task assigned by keyword matching
    else {
      strategy = 'Direct assignment based on capabilities';
      const agent = this.detectAgent(text);
      subtasks.push({
        id: makeId(),
        title: taskTitle,
        description: taskDescription,
        requiredCapabilities: this.detectCapabilities(text),
        preferredAgent: agent,
        priority: 'normal',
        dependencies: [],
        estimatedComplexity: 'moderate',
      });
    }

    return {
      originalTask: taskTitle,
      subtasks,
      strategy,
      estimatedTotalTime: this.estimateTime(subtasks),
    };
  }

  /** Assign subtask to the best available agent (load-aware) */
  assignAgent(
    subtask: SubTask,
    availableAgents: Array<{ id: AgentId; capabilities: string[]; status: string }>,
    agentLoads?: Map<string, { cpuLoad: number; memoryPercent: number; isOverloaded: boolean }>,
  ): AgentId | null {
    const isOverloaded = (id: string) => agentLoads?.get(id)?.isOverloaded ?? false;
    const getLoadScore = (id: string) => {
      const load = agentLoads?.get(id);
      if (!load) return 50; // unknown = medium
      return (load.cpuLoad + load.memoryPercent) / 2;
    };

    // Filter out offline and overloaded agents
    const online = availableAgents.filter((a) => a.status !== 'offline' && !isOverloaded(a.id));

    // Prefer the designated agent if available and not overloaded
    if (subtask.preferredAgent) {
      const preferred = online.find((a) => a.id === subtask.preferredAgent);
      if (preferred) return preferred.id;
      // Preferred is overloaded — fall through to capability match
    }

    // Match by capabilities, pick least loaded
    const capable = online.filter((a) =>
      subtask.requiredCapabilities.some((cap) => a.capabilities.includes(cap)),
    );
    if (capable.length > 0) {
      capable.sort((a, b) => getLoadScore(a.id) - getLoadScore(b.id));
      return capable[0]!.id;
    }

    // Fallback: least loaded idle agent
    const idle = online.filter((a) => a.status === 'idle');
    if (idle.length > 0) {
      idle.sort((a, b) => getLoadScore(a.id) - getLoadScore(b.id));
      return idle[0]!.id;
    }

    // Last resort: any online agent (even busy), least loaded
    if (online.length > 0) {
      online.sort((a, b) => getLoadScore(a.id) - getLoadScore(b.id));
      return online[0]!.id;
    }

    return null;
  }

  private matchesPattern(text: string, patterns: string[]): boolean {
    return patterns.some((p) => text.includes(p));
  }

  private detectAgent(text: string): AgentId {
    for (const [capability, agent] of Object.entries(CAPABILITY_AGENT_MAP)) {
      if (text.includes(capability)) return agent;
    }
    return 'agent-smith'; // Default to dev
  }

  private detectCapabilities(text: string): string[] {
    const caps: string[] = [];
    for (const cap of Object.keys(CAPABILITY_AGENT_MAP)) {
      if (text.includes(cap)) caps.push(cap);
    }
    return caps.length > 0 ? caps : ['general'];
  }

  private estimateTime(subtasks: SubTask[]): string {
    const complexityMinutes: Record<string, number> = { simple: 5, moderate: 15, complex: 45 };
    const total = subtasks.reduce((sum, t) => sum + (complexityMinutes[t.estimatedComplexity] ?? 15), 0);
    if (total < 60) return `~${total} minutes`;
    return `~${Math.round(total / 60)} hours`;
  }
}
