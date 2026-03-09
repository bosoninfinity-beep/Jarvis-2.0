import { createLogger } from '@jarvis/shared';
import type { AgentTool, ToolContext, ToolResult } from './base.js';
import { createToolResult, createErrorResult } from './base.js';

const log = createLogger('tool:message-agent');

type NatsPublishFn = (subject: string, data: unknown) => Promise<void>;

/** Per-session inter-agent message tracking to prevent loops */
const sessionMessageCounts = new Map<string, { total: number; perTarget: Record<string, number> }>();
const MAX_MESSAGES_PER_SESSION = 10;
const MAX_MESSAGES_PER_TARGET = 5;

/**
 * Inter-agent messaging tool via NATS.
 * Allows agents to send messages, queries, notifications, and delegation requests to other agents.
 */
export class MessageAgentTool implements AgentTool {
  private publish: NatsPublishFn;

  constructor(publishFn: NatsPublishFn) {
    this.publish = publishFn;
  }

  definition = {
    name: 'message_agent',
    description: 'Send a message to another agent in the Jarvis system. Use for coordination, delegating subtasks, or sharing information between agents.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          enum: ['jarvis', 'agent-smith', 'agent-johny'],
          description: 'The target agent ID',
        },
        type: {
          type: 'string',
          enum: ['task', 'delegation', 'query', 'notification', 'result'],
          description: 'Message type',
        },
        content: {
          type: 'string',
          description: 'The message content',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'critical'],
          description: 'Message priority (default: normal)',
        },
      },
      required: ['to', 'type', 'content'],
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const to = params['to'] as string;
    const type = params['type'] as string;
    const content = params['content'] as string;
    const priority = (params['priority'] as string) || 'normal';

    if (!to) return createErrorResult('Missing required parameter: to');
    if (!type) return createErrorResult('Missing required parameter: type');
    if (!content) return createErrorResult('Missing required parameter: content');
    if (to === context.agentId) return createErrorResult('Cannot send a message to yourself');

    // Anti-loop: track inter-agent messages per session
    const sessionKey = (context as { sessionId?: string }).sessionId ?? context.agentId;
    if (!sessionMessageCounts.has(sessionKey)) {
      sessionMessageCounts.set(sessionKey, { total: 0, perTarget: {} });
    }
    const counts = sessionMessageCounts.get(sessionKey)!;
    counts.total++;
    counts.perTarget[to] = (counts.perTarget[to] || 0) + 1;

    if (counts.total > MAX_MESSAGES_PER_SESSION) {
      log.warn(`Inter-agent message limit reached: ${counts.total} messages this session`);
      return createErrorResult(
        `Inter-agent message limit reached (${counts.total}/${MAX_MESSAGES_PER_SESSION}). ` +
        `You are sending too many messages. Stop and report what you have so far.`,
      );
    }
    if (counts.perTarget[to]! > MAX_MESSAGES_PER_TARGET) {
      log.warn(`Per-target message limit reached: ${counts.perTarget[to]} messages to ${to}`);
      return createErrorResult(
        `Too many messages to ${to} (${counts.perTarget[to]}/${MAX_MESSAGES_PER_TARGET}). ` +
        `You may be in a delegation loop. Stop and report the issue.`,
      );
    }

    const message = {
      id: crypto.randomUUID(),
      from: context.agentId,
      to,
      type,
      payload: type === 'task' || type === 'delegation'
        ? { title: content, description: content, priority }
        : { content },
      priority,
      timestamp: Date.now(),
    };

    try {
      // Route based on message type:
      // - task/delegation → coordination channel (handled by handleCoordinationRequest)
      // - query/notification/result → direct message (handled by handleInterAgentMessage)
      const subject = type === 'task' || type === 'delegation'
        ? `jarvis.coordination.request`
        : `jarvis.agent.${to}.dm`;

      await this.publish(subject, message);
      log.info(`Sent ${type} message to ${to}: ${content.slice(0, 80)}`);
      return createToolResult(`Message sent to ${to} (type: ${type}, priority: ${priority})`);
    } catch (err) {
      return createErrorResult(`Failed to send message: ${(err as Error).message}`);
    }
  }
}
