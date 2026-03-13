/**
 * Reddit API client.
 * Uses OAuth2 (script app) for submitting posts to subreddits.
 * Supports text posts, link posts, and image posts.
 */

import type { ToolResult } from '../../base.js';
import { createToolResult, createErrorResult } from '../../base.js';

const REDDIT_OAUTH_URL = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_API_URL = 'https://oauth.reddit.com';

export interface RedditConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly username: string;
  readonly password: string;
}

/**
 * Reddit OAuth2 client for posting to subreddits.
 * Uses "script" app type (personal use scripts).
 */
export class RedditClient {
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(private config: RedditConfig) {}

  /** Submit a text post (self post) to a subreddit */
  async submitTextPost(subreddit: string, title: string, text: string, options?: {
    flair_id?: string;
    nsfw?: boolean;
  }): Promise<ToolResult> {
    const token = await this.getAccessToken();
    if (!token) return createErrorResult('Reddit authentication failed');

    try {
      const body = new URLSearchParams({
        api_type: 'json',
        kind: 'self',
        sr: subreddit,
        title,
        text,
        ...(options?.flair_id ? { flair_id: options.flair_id } : {}),
        ...(options?.nsfw ? { nsfw: 'true' } : {}),
      });

      const response = await fetch(`${REDDIT_API_URL}/api/submit`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'JarvisMarketing/4.0',
        },
        body: body.toString(),
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`Reddit submit failed (${response.status}): ${err}`);
      }

      const data = await response.json() as RedditSubmitResponse;
      if (data.json?.errors?.length) {
        return createErrorResult(`Reddit errors: ${data.json.errors.map((e) => e.join(': ')).join('; ')}`);
      }

      const postUrl = data.json?.data?.url ?? '';
      const postId = data.json?.data?.id ?? '';
      return createToolResult(
        `Posted to r/${subreddit}\nTitle: ${title}\nURL: ${postUrl}\nID: ${postId}`,
        { postId, postUrl, subreddit },
      );
    } catch (err) {
      return createErrorResult(`Reddit post failed: ${(err as Error).message}`);
    }
  }

  /** Submit a link post to a subreddit */
  async submitLinkPost(subreddit: string, title: string, url: string, options?: {
    flair_id?: string;
    nsfw?: boolean;
  }): Promise<ToolResult> {
    const token = await this.getAccessToken();
    if (!token) return createErrorResult('Reddit authentication failed');

    try {
      const body = new URLSearchParams({
        api_type: 'json',
        kind: 'link',
        sr: subreddit,
        title,
        url,
        resubmit: 'true',
        ...(options?.flair_id ? { flair_id: options.flair_id } : {}),
        ...(options?.nsfw ? { nsfw: 'true' } : {}),
      });

      const response = await fetch(`${REDDIT_API_URL}/api/submit`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'JarvisMarketing/4.0',
        },
        body: body.toString(),
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`Reddit submit failed (${response.status}): ${err}`);
      }

      const data = await response.json() as RedditSubmitResponse;
      if (data.json?.errors?.length) {
        return createErrorResult(`Reddit errors: ${data.json.errors.map((e) => e.join(': ')).join('; ')}`);
      }

      const postUrl = data.json?.data?.url ?? '';
      const postId = data.json?.data?.id ?? '';
      return createToolResult(
        `Link posted to r/${subreddit}\nTitle: ${title}\nLink: ${url}\nPost URL: ${postUrl}`,
        { postId, postUrl, subreddit },
      );
    } catch (err) {
      return createErrorResult(`Reddit link post failed: ${(err as Error).message}`);
    }
  }

  /** Post a comment on a post or reply to a comment */
  async comment(thingId: string, text: string): Promise<ToolResult> {
    const token = await this.getAccessToken();
    if (!token) return createErrorResult('Reddit authentication failed');

    try {
      const body = new URLSearchParams({
        api_type: 'json',
        thing_id: thingId.startsWith('t') ? thingId : `t3_${thingId}`,
        text,
      });

      const response = await fetch(`${REDDIT_API_URL}/api/comment`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'JarvisMarketing/4.0',
        },
        body: body.toString(),
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`Reddit comment failed: ${err}`);
      }

      return createToolResult(`Comment posted on ${thingId}`);
    } catch (err) {
      return createErrorResult(`Reddit comment failed: ${(err as Error).message}`);
    }
  }

  /** Vote (upvote/downvote/unvote) on a post or comment */
  async vote(thingId: string, direction: 1 | 0 | -1 = 1): Promise<ToolResult> {
    const token = await this.getAccessToken();
    if (!token) return createErrorResult('Reddit authentication failed');

    try {
      const fullId = thingId.startsWith('t') ? thingId : `t3_${thingId}`;
      const body = new URLSearchParams({
        id: fullId,
        dir: String(direction),
      });

      const response = await fetch(`${REDDIT_API_URL}/api/vote`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'JarvisMarketing/4.0',
        },
        body: body.toString(),
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`Reddit vote failed (${response.status}): ${err}`);
      }

      const label = direction === 1 ? 'Upvoted' : direction === -1 ? 'Downvoted' : 'Removed vote on';
      return createToolResult(`${label} ${fullId}`, { voted: true, thingId: fullId, direction });
    } catch (err) {
      return createErrorResult(`Reddit vote failed: ${(err as Error).message}`);
    }
  }

  /** Get subreddit info and rules */
  async getSubredditInfo(subreddit: string): Promise<ToolResult> {
    const token = await this.getAccessToken();
    if (!token) return createErrorResult('Reddit authentication failed');

    try {
      const response = await fetch(`${REDDIT_API_URL}/r/${subreddit}/about`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'JarvisMarketing/4.0',
        },
      });

      if (!response.ok) {
        return createErrorResult(`Failed to get subreddit info: ${response.status}`);
      }

      const data = await response.json() as { data?: RedditSubredditInfo };
      const d = data.data;
      return createToolResult(
        `r/${subreddit} Info:\n` +
        `  Subscribers: ${d?.subscribers?.toLocaleString() ?? 'unknown'}\n` +
        `  Active users: ${d?.active_user_count?.toLocaleString() ?? 'unknown'}\n` +
        `  Description: ${d?.public_description?.slice(0, 200) ?? ''}\n` +
        `  Type: ${d?.subreddit_type ?? 'unknown'}\n` +
        `  Allows text: ${d?.submission_type !== 'link'}\n` +
        `  Allows links: ${d?.submission_type !== 'self'}`,
        { subscribers: d?.subscribers, activeUsers: d?.active_user_count },
      );
    } catch (err) {
      return createErrorResult(`Subreddit info failed: ${(err as Error).message}`);
    }
  }

  /** Get hot/top posts from a subreddit (for research) */
  async getHotPosts(subreddit: string, limit = 10): Promise<ToolResult> {
    const token = await this.getAccessToken();
    if (!token) return createErrorResult('Reddit authentication failed');

    try {
      const url = new URL(`${REDDIT_API_URL}/r/${subreddit}/hot`);
      url.searchParams.set('limit', String(Math.min(limit, 25)));

      const response = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'JarvisMarketing/4.0',
        },
      });

      if (!response.ok) return createErrorResult(`Hot posts failed: ${response.status}`);

      const data = await response.json() as RedditListingResponse;
      const posts = (data.data?.children ?? []).map((child, i) => {
        const p = child.data;
        return `${i + 1}. [${p.score}↑] ${p.title?.slice(0, 100)} (${p.num_comments} comments)`;
      });

      return createToolResult(`r/${subreddit} Hot Posts:\n${posts.join('\n')}`);
    } catch (err) {
      return createErrorResult(`Hot posts failed: ${(err as Error).message}`);
    }
  }

  // ── Auth ──

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const auth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'password',
        username: this.config.username,
        password: this.config.password,
      });

      const response = await fetch(REDDIT_OAUTH_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'JarvisMarketing/4.0',
        },
        body: body.toString(),
      });

      if (!response.ok) return null;

      const data = await response.json() as { access_token?: string; expires_in?: number };
      if (!data.access_token) return null;

      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000;
      return this.accessToken;
    } catch {
      return null;
    }
  }
}

interface RedditSubmitResponse {
  json?: {
    errors?: string[][];
    data?: { id?: string; url?: string; name?: string };
  };
}

interface RedditSubredditInfo {
  subscribers?: number;
  active_user_count?: number;
  public_description?: string;
  subreddit_type?: string;
  submission_type?: string;
}

interface RedditListingResponse {
  data?: {
    children?: Array<{
      data: { title?: string; score: number; num_comments: number; url?: string; id?: string };
    }>;
  };
}
