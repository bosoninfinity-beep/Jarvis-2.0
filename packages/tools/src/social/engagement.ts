import { createLogger } from '@jarvis/shared';
import type { AgentTool, ToolContext, ToolResult } from '../base.js';
import { createToolResult, createErrorResult } from '../base.js';
import { TwitterClient } from './platforms/twitter.js';
import { RedditClient } from './platforms/reddit.js';
import type { SocialToolConfig } from './social-tool.js';

const log = createLogger('tool:social:engage');

/**
 * Social engagement monitoring tool.
 * Enables agents to monitor mentions, reply to posts, like/upvote content,
 * and search trending/viral content for engagement farming.
 */
export class SocialEngagementTool implements AgentTool {
  private twitter?: TwitterClient;
  private reddit?: RedditClient;

  constructor(config: SocialToolConfig) {
    if (config.twitter) this.twitter = new TwitterClient(config.twitter);
    if (config.reddit) this.reddit = new RedditClient(config.reddit);
  }

  definition = {
    name: 'social_engage',
    description:
      'Monitor mentions, reply to posts, like/upvote content, and search trending/viral content on social platforms. ' +
      'Supports Twitter/X and Reddit for engagement operations.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['monitor', 'reply', 'like', 'search_viral'],
          description:
            'Action to perform: monitor (fetch mentions/replies), reply (post a reply), like (like/upvote), search_viral (find trending content)',
        },
        platform: {
          type: 'string',
          enum: ['twitter', 'instagram', 'facebook', 'linkedin', 'tiktok', 'reddit'],
          description: 'Target social media platform',
        },
        post_id: {
          type: 'string',
          description: 'Post/tweet ID to reply to or like (required for reply and like actions)',
        },
        text: {
          type: 'string',
          description: 'Reply text (required for reply action)',
        },
        query: {
          type: 'string',
          description: 'Search query for monitor and search_viral actions',
        },
        subreddit: {
          type: 'string',
          description: 'Subreddit name without r/ prefix (for Reddit operations)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
      },
      required: ['action', 'platform'],
    },
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    const platform = params['platform'] as string;

    if (!action) return createErrorResult('Missing required parameter: action');
    if (!platform) return createErrorResult('Missing required parameter: platform');

    log.info(`Engagement action=${action} platform=${platform}`);

    switch (action) {
      case 'monitor':
        return this.handleMonitor(platform, params);
      case 'reply':
        return this.handleReply(platform, params);
      case 'like':
        return this.handleLike(platform, params);
      case 'search_viral':
        return this.handleSearchViral(platform, params);
      default:
        return createErrorResult(`Unknown action: ${action}. Valid actions: monitor, reply, like, search_viral`);
    }
  }

  // ── Monitor ──

  private async handleMonitor(platform: string, params: Record<string, unknown>): Promise<ToolResult> {
    const query = params['query'] as string;
    const limit = (params['limit'] as number) ?? 10;

    switch (platform) {
      case 'twitter': {
        if (!this.twitter) return createErrorResult('Twitter not configured');
        if (!query) return createErrorResult('Monitor on Twitter requires a query parameter (e.g. "@yourhandle" or keyword)');
        return this.twitter.searchTweets(query, limit);
      }
      case 'reddit': {
        if (!this.reddit) return createErrorResult('Reddit not configured');
        const subreddit = (params['subreddit'] as string) ?? query;
        if (!subreddit) return createErrorResult('Monitor on Reddit requires subreddit or query parameter');
        return this.reddit.getHotPosts(subreddit, limit);
      }
      default:
        return createErrorResult(
          `Monitoring not directly supported for ${platform}. Use web_search tool for ${platform} mention discovery.`,
        );
    }
  }

  // ── Reply ──

  private async handleReply(platform: string, params: Record<string, unknown>): Promise<ToolResult> {
    const postId = params['post_id'] as string;
    const text = params['text'] as string;

    if (!postId) return createErrorResult('Reply requires post_id parameter');
    if (!text) return createErrorResult('Reply requires text parameter');

    switch (platform) {
      case 'twitter': {
        if (!this.twitter) return createErrorResult('Twitter not configured');
        log.info(`Replying to tweet ${postId}`);
        return this.twitter.postTweet(text, { replyTo: postId });
      }
      case 'reddit': {
        if (!this.reddit) return createErrorResult('Reddit not configured');
        log.info(`Commenting on Reddit thing ${postId}`);
        return this.reddit.comment(postId, text);
      }
      default:
        return createErrorResult(
          `Reply not supported for ${platform} via this tool. Use the social_post tool or web-based approach.`,
        );
    }
  }

  // ── Like / Upvote ──

  private async handleLike(platform: string, params: Record<string, unknown>): Promise<ToolResult> {
    const postId = params['post_id'] as string;

    if (!postId) return createErrorResult('Like requires post_id parameter');

    switch (platform) {
      case 'twitter': {
        if (!this.twitter) return createErrorResult('Twitter not configured');
        log.info(`Liking tweet ${postId}`);
        return this.twitter.likeTweet(postId);
      }
      case 'reddit': {
        if (!this.reddit) return createErrorResult('Reddit not configured');
        log.info(`Upvoting Reddit thing ${postId}`);
        return this.reddit.vote(postId, 1);
      }
      default:
        return createErrorResult(
          `Like/upvote not supported for ${platform} via this tool. Use the computer tool for GUI-based engagement.`,
        );
    }
  }

  // ── Search Viral ──

  private async handleSearchViral(platform: string, params: Record<string, unknown>): Promise<ToolResult> {
    const query = params['query'] as string;
    const limit = (params['limit'] as number) ?? 10;

    switch (platform) {
      case 'twitter': {
        if (!this.twitter) return createErrorResult('Twitter not configured');
        if (!query) return createErrorResult('search_viral on Twitter requires a query parameter');
        return this.twitter.searchTweets(query, limit);
      }
      case 'reddit': {
        if (!this.reddit) return createErrorResult('Reddit not configured');
        const subreddit = (params['subreddit'] as string) ?? query;
        if (!subreddit) return createErrorResult('search_viral on Reddit requires subreddit or query parameter');
        return this.reddit.getHotPosts(subreddit, limit);
      }
      default:
        return createErrorResult(
          `Use web_search for ${platform} trend discovery. This tool supports Twitter and Reddit directly.`,
        );
    }
  }
}
