import { createLogger } from '@jarvis/shared';
import type { AgentTool, ToolContext, ToolResult } from './base.js';
import { createToolResult, createErrorResult } from './base.js';

const log = createLogger('tool:web-search');

const BRAVE_TIMEOUT = 30_000;
const PERPLEXITY_TIMEOUT = 60_000;

/**
 * Web search tool supporting Brave Search API and Perplexity.
 * Falls back between providers based on availability.
 */
export class WebSearchTool implements AgentTool {
  private braveApiKey?: string;
  private perplexityApiKey?: string;

  constructor(config?: { braveApiKey?: string; perplexityApiKey?: string }) {
    this.braveApiKey = config?.braveApiKey ?? process.env['BRAVE_API_KEY'];
    this.perplexityApiKey = config?.perplexityApiKey ?? process.env['PERPLEXITY_API_KEY'];
  }

  definition = {
    name: 'web_search',
    description: 'Search the web for information. Returns search results with titles, URLs, and snippets. Use for finding current information, research, documentation, etc.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        count: { type: 'number', description: 'Number of results to return (default: 10, max: 20)' },
      },
      required: ['query'],
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = params['query'] as string;
    if (!query) return createErrorResult('Missing required parameter: query');
    const count = Math.min((params['count'] as number) || 10, 20);

    // Try Brave first, then Perplexity
    if (this.braveApiKey) {
      try {
        return await this.searchBrave(query, count);
      } catch (err) {
        log.warn(`Brave search failed, trying fallback: ${(err as Error).message}`);
      }
    }

    if (this.perplexityApiKey) {
      try {
        return await this.searchPerplexity(query);
      } catch (err) {
        log.warn(`Perplexity search failed: ${(err as Error).message}`);
      }
    }

    return createErrorResult('No search provider available. Set BRAVE_API_KEY or PERPLEXITY_API_KEY.');
  }

  private async searchBrave(query: string, count: number): Promise<ToolResult> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BRAVE_TIMEOUT);

    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': this.braveApiKey!,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(timeoutId);
      throw new Error(`Brave API error ${response.status}`);
    }

    let data: BraveSearchResponse;
    try {
      data = await response.json() as BraveSearchResponse;
    } catch (jsonErr) {
      clearTimeout(timeoutId);
      throw new Error(`Brave API returned invalid JSON: ${(jsonErr as Error).message}`);
    } finally {
      clearTimeout(timeoutId);
    }
    const results = (data.web?.results ?? []).map((r, i) => (
      `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description ?? ''}`
    ));

    if (results.length === 0) {
      return createToolResult(`No results found for: ${query}`);
    }

    return createToolResult(
      `Search results for: "${query}"\n\n${results.join('\n\n')}`,
      { query, provider: 'brave', resultCount: results.length },
    );
  }

  private async searchPerplexity(query: string): Promise<ToolResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PERPLEXITY_TIMEOUT);

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.perplexityApiKey}`,
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: query }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(timeoutId);
      throw new Error(`Perplexity API error ${response.status}`);
    }

    let data: PerplexityResponse;
    try {
      data = await response.json() as PerplexityResponse;
    } catch (jsonErr) {
      clearTimeout(timeoutId);
      throw new Error(`Perplexity API returned invalid JSON: ${(jsonErr as Error).message}`);
    } finally {
      clearTimeout(timeoutId);
    }
    const answer = data.choices?.[0]?.message?.content ?? '';
    const citations = (data.citations ?? []).map((c, i) => `[${i + 1}] ${c}`).join('\n');

    return createToolResult(
      `Search results for: "${query}"\n\n${answer}\n\nSources:\n${citations}`,
      { query, provider: 'perplexity' },
    );
  }
}

// Brave Search API types
interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title: string;
      url: string;
      description?: string;
    }>;
  };
}

// Perplexity API types
interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
}
