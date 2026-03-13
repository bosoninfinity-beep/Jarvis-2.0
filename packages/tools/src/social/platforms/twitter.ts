import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { ToolResult } from '../../base.js';
import { createToolResult, createErrorResult } from '../../base.js';

const TWITTER_API_V2 = 'https://api.twitter.com/2';
const TWITTER_UPLOAD_V1 = 'https://upload.twitter.com/1.1/media/upload.json';

export interface TwitterConfig {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly accessToken: string;
  readonly accessTokenSecret: string;
  readonly bearerToken: string;
}

/**
 * Twitter/X API v2 client.
 * Handles posting tweets, threads, reading timelines, and analytics.
 */
export class TwitterClient {
  private userId: string | null = null;

  constructor(private config: TwitterConfig) {}

  async postTweet(text: string, options?: {
    replyTo?: string;
    mediaIds?: string[];
    pollOptions?: string[];
    pollDuration?: number;
  }): Promise<ToolResult> {
    const body: Record<string, unknown> = { text };

    if (options?.replyTo) {
      body['reply'] = { in_reply_to_tweet_id: options.replyTo };
    }
    if (options?.mediaIds?.length) {
      body['media'] = { media_ids: options.mediaIds };
    }
    if (options?.pollOptions?.length) {
      body['poll'] = {
        options: options.pollOptions.map((o) => ({ label: o })),
        duration_minutes: options.pollDuration ?? 1440,
      };
    }

    try {
      const tweetUrl = `${TWITTER_API_V2}/tweets`;
      const response = await fetch(tweetUrl, {
        method: 'POST',
        headers: this.getHeaders('POST', tweetUrl),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`Twitter API error ${response.status}: ${err}`);
      }

      const data = await response.json() as { data?: { id?: string; text?: string } };
      return createToolResult(
        `Tweet posted successfully.\nID: ${data.data?.id}\nURL: https://twitter.com/i/status/${data.data?.id}`,
        { tweetId: data.data?.id },
      );
    } catch (err) {
      return createErrorResult(`Failed to post tweet: ${(err as Error).message}`);
    }
  }

  async postThread(tweets: string[]): Promise<ToolResult> {
    const results: string[] = [];
    let lastTweetId: string | undefined;

    for (let i = 0; i < tweets.length; i++) {
      const result = await this.postTweet(tweets[i]!, { replyTo: lastTweetId });
      if (result.type === 'error') {
        return createErrorResult(`Thread failed at tweet ${i + 1}: ${result.content}`);
      }
      lastTweetId = result.metadata?.['tweetId'] as string;
      results.push(`${i + 1}. ${lastTweetId}`);
    }

    return createToolResult(`Thread posted (${tweets.length} tweets):\n${results.join('\n')}`);
  }

  async deleteTweet(tweetId: string): Promise<ToolResult> {
    try {
      const deleteUrl = `${TWITTER_API_V2}/tweets/${tweetId}`;
      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: this.getHeaders('DELETE', deleteUrl),
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`Failed to delete tweet: ${err}`);
      }

      return createToolResult(`Tweet ${tweetId} deleted`);
    } catch (err) {
      return createErrorResult(`Delete failed: ${(err as Error).message}`);
    }
  }

  async getUserTimeline(userId: string, maxResults = 10): Promise<ToolResult> {
    try {
      const url = new URL(`${TWITTER_API_V2}/users/${userId}/tweets`);
      url.searchParams.set('max_results', String(maxResults));
      url.searchParams.set('tweet.fields', 'created_at,public_metrics,text');

      const response = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${this.config.bearerToken}` },
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`Timeline fetch failed: ${err}`);
      }

      const data = await response.json() as TwitterTimelineResponse;
      const tweets = (data.data ?? []).map((t, i) =>
        `${i + 1}. [${t.created_at}] ${t.text?.slice(0, 100)}... | Likes: ${t.public_metrics?.like_count ?? 0} | RT: ${t.public_metrics?.retweet_count ?? 0}`,
      );

      return createToolResult(`Timeline (${tweets.length} tweets):\n${tweets.join('\n')}`);
    } catch (err) {
      return createErrorResult(`Timeline failed: ${(err as Error).message}`);
    }
  }

  async searchTweets(query: string, maxResults = 10): Promise<ToolResult> {
    try {
      const url = new URL(`${TWITTER_API_V2}/tweets/search/recent`);
      url.searchParams.set('query', query);
      url.searchParams.set('max_results', String(Math.min(maxResults, 100)));
      url.searchParams.set('tweet.fields', 'created_at,public_metrics,author_id,text');

      const response = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${this.config.bearerToken}` },
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`Search failed: ${err}`);
      }

      const data = await response.json() as TwitterTimelineResponse;
      const tweets = (data.data ?? []).map((t, i) =>
        `${i + 1}. @${t.author_id}: ${t.text?.slice(0, 120)}... | Likes: ${t.public_metrics?.like_count ?? 0}`,
      );

      return createToolResult(`Search "${query}" (${tweets.length} results):\n${tweets.join('\n')}`);
    } catch (err) {
      return createErrorResult(`Search failed: ${(err as Error).message}`);
    }
  }

  async getAnalytics(tweetId: string): Promise<ToolResult> {
    try {
      const url = new URL(`${TWITTER_API_V2}/tweets/${tweetId}`);
      url.searchParams.set('tweet.fields', 'public_metrics,organic_metrics,created_at');

      const response = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${this.config.bearerToken}` },
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`Analytics failed: ${err}`);
      }

      const data = await response.json() as { data?: TwitterTweet };
      const m = data.data?.public_metrics;
      return createToolResult(
        `Tweet ${tweetId} Analytics:\n` +
        `  Likes: ${m?.like_count ?? 0}\n` +
        `  Retweets: ${m?.retweet_count ?? 0}\n` +
        `  Replies: ${m?.reply_count ?? 0}\n` +
        `  Impressions: ${m?.impression_count ?? 0}\n` +
        `  Quotes: ${m?.quote_count ?? 0}\n` +
        `  Bookmarks: ${m?.bookmark_count ?? 0}`,
      );
    } catch (err) {
      return createErrorResult(`Analytics failed: ${(err as Error).message}`);
    }
  }

  /**
   * Upload media (image/video) to Twitter via chunked upload API v1.1.
   * Returns the media_id_string to attach to a tweet.
   */
  async uploadMedia(filePath: string): Promise<{ mediaId: string } | { error: string }> {
    try {
      const fileData = readFileSync(filePath);
      const fileStat = statSync(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      const isVideo = ['mp4', 'mov', 'webm'].includes(ext);
      const mimeType = isVideo
        ? (ext === 'mp4' ? 'video/mp4' : ext === 'mov' ? 'video/quicktime' : 'video/webm')
        : (ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg');
      const mediaCategory = isVideo ? 'tweet_video' : (ext === 'gif' ? 'tweet_gif' : 'tweet_image');

      // INIT
      const initParams: Record<string, string> = {
        command: 'INIT',
        total_bytes: String(fileStat.size),
        media_type: mimeType,
        media_category: mediaCategory,
      };
      const initUrl = TWITTER_UPLOAD_V1;
      const initBody = new URLSearchParams(initParams).toString();
      const initResp = await fetch(initUrl, {
        method: 'POST',
        headers: {
          ...this.getOAuthHeaderOnly('POST', initUrl, initParams),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: initBody,
      });
      if (!initResp.ok) {
        return { error: `INIT failed (${initResp.status}): ${await initResp.text()}` };
      }
      const initData = await initResp.json() as { media_id_string: string };
      const mediaId = initData.media_id_string;

      // APPEND — send in 5MB chunks
      const CHUNK_SIZE = 5 * 1024 * 1024;
      for (let segment = 0; segment * CHUNK_SIZE < fileData.length; segment++) {
        const chunk = fileData.subarray(segment * CHUNK_SIZE, (segment + 1) * CHUNK_SIZE);
        const boundary = `----Boundary${randomBytes(8).toString('hex')}`;

        // Build multipart body manually
        const parts: Buffer[] = [];
        const addField = (name: string, value: string) => {
          parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
        };
        addField('command', 'APPEND');
        addField('media_id', mediaId);
        addField('segment_index', String(segment));
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="media_data"\r\nContent-Transfer-Encoding: base64\r\n\r\n`,
        ));
        parts.push(Buffer.from(chunk.toString('base64')));
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
        const body = Buffer.concat(parts);

        // For APPEND with multipart, OAuth signature should NOT include body params
        const appendResp = await fetch(initUrl, {
          method: 'POST',
          headers: {
            ...this.getOAuthHeaderOnly('POST', initUrl),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
        });
        if (!appendResp.ok && appendResp.status !== 204) {
          return { error: `APPEND segment ${segment} failed (${appendResp.status}): ${await appendResp.text()}` };
        }
      }

      // FINALIZE
      const finalParams: Record<string, string> = {
        command: 'FINALIZE',
        media_id: mediaId,
      };
      const finalResp = await fetch(initUrl, {
        method: 'POST',
        headers: {
          ...this.getOAuthHeaderOnly('POST', initUrl, finalParams),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(finalParams).toString(),
      });
      if (!finalResp.ok) {
        return { error: `FINALIZE failed (${finalResp.status}): ${await finalResp.text()}` };
      }

      const finalData = await finalResp.json() as {
        media_id_string: string;
        processing_info?: { state: string; check_after_secs?: number };
      };

      // Poll for processing completion (videos need async processing)
      if (finalData.processing_info) {
        let state = finalData.processing_info.state;
        let waitSec = finalData.processing_info.check_after_secs ?? 5;
        while (state === 'pending' || state === 'in_progress') {
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          const statusUrl = `${initUrl}?command=STATUS&media_id=${mediaId}`;
          const statusResp = await fetch(statusUrl, {
            headers: { 'Authorization': this.generateOAuthHeader('GET', statusUrl) },
          });
          if (!statusResp.ok) break;
          const statusData = await statusResp.json() as {
            processing_info?: { state: string; check_after_secs?: number; error?: { message: string } };
          };
          state = statusData.processing_info?.state ?? 'succeeded';
          waitSec = statusData.processing_info?.check_after_secs ?? 5;
          if (state === 'failed') {
            return { error: `Media processing failed: ${statusData.processing_info?.error?.message ?? 'unknown'}` };
          }
        }
      }

      return { mediaId };
    } catch (err) {
      return { error: `Upload failed: ${(err as Error).message}` };
    }
  }

  /** Post a tweet with media file (image or video). Handles upload + tweet in one call. */
  async postTweetWithMedia(text: string, filePath: string, options?: { replyTo?: string }): Promise<ToolResult> {
    const upload = await this.uploadMedia(filePath);
    if ('error' in upload) {
      return createErrorResult(`Media upload failed: ${upload.error}`);
    }
    return this.postTweet(text, { mediaIds: [upload.mediaId], replyTo: options?.replyTo });
  }

  /** Like a tweet by ID. Uses Twitter API v2 POST /2/users/:id/likes */
  async likeTweet(tweetId: string): Promise<ToolResult> {
    try {
      const userId = await this.getAuthenticatedUserId();
      if (!userId) return createErrorResult('Failed to resolve authenticated Twitter user ID');

      const likeUrl = `${TWITTER_API_V2}/users/${userId}/likes`;
      const response = await fetch(likeUrl, {
        method: 'POST',
        headers: this.getHeaders('POST', likeUrl),
        body: JSON.stringify({ tweet_id: tweetId }),
      });

      if (!response.ok) {
        const err = await response.text();
        return createErrorResult(`Twitter like failed (${response.status}): ${err}`);
      }

      return createToolResult(`Liked tweet ${tweetId}`, { liked: true, tweetId });
    } catch (err) {
      return createErrorResult(`Failed to like tweet: ${(err as Error).message}`);
    }
  }

  /** Resolve the authenticated user's ID (cached after first call) */
  private async getAuthenticatedUserId(): Promise<string | null> {
    if (this.userId) return this.userId;

    try {
      const response = await fetch(`${TWITTER_API_V2}/users/me`, {
        headers: { 'Authorization': `Bearer ${this.config.bearerToken}` },
      });

      if (!response.ok) return null;

      const data = await response.json() as { data?: { id?: string } };
      this.userId = data.data?.id ?? null;
      return this.userId;
    } catch {
      return null;
    }
  }

  private getHeaders(method?: string, url?: string): Record<string, string> {
    // Use OAuth 1.0a for write requests (POST/DELETE), Bearer for read (GET)
    if (method && method.toUpperCase() !== 'GET') {
      return {
        'Content-Type': 'application/json',
        'Authorization': this.generateOAuthHeader(method, url ?? ''),
      };
    }
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.bearerToken}`,
    };
  }

  /** Return only the Authorization header (no Content-Type). Extra params included in signature. */
  private getOAuthHeaderOnly(method: string, url: string, extraParams?: Record<string, string>): Record<string, string> {
    return { 'Authorization': this.generateOAuthHeader(method, url, extraParams) };
  }

  private generateOAuthHeader(method: string, url: string, extraSignatureParams?: Record<string, string>): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');

    const params: Record<string, string> = {
      oauth_consumer_key: this.config.apiKey,
      oauth_nonce: nonce,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: timestamp,
      oauth_token: this.config.accessToken,
      oauth_version: '1.0',
    };

    // Include extra params in signature (e.g. command, media_id for non-multipart requests)
    const allSignatureParams = { ...params, ...(extraSignatureParams ?? {}) };

    // Build parameter string (sorted)
    const paramString = Object.entries(allSignatureParams)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const baseString = `${method.toUpperCase()}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
    const signingKey = `${encodeURIComponent(this.config.apiSecret)}&${encodeURIComponent(this.config.accessTokenSecret)}`;
    const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

    params['oauth_signature'] = signature;

    return 'OAuth ' + Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
      .join(', ');
  }
}

interface TwitterTweet {
  id?: string;
  text?: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    impression_count?: number;
    quote_count?: number;
    bookmark_count?: number;
  };
}

interface TwitterTimelineResponse {
  data?: TwitterTweet[];
  meta?: { result_count?: number; next_token?: string };
}
