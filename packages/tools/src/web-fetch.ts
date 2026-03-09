import { lookup } from 'node:dns/promises';
import type { AgentTool, ToolContext, ToolResult } from './base.js';
import { createToolResult, createErrorResult } from './base.js';
import { isPrivateUrl } from './ssrf.js';

const MAX_CONTENT_LENGTH = 200_000; // 200KB max
const FETCH_TIMEOUT = 30_000; // 30s

export class WebFetchTool implements AgentTool {
  definition = {
    name: 'web_fetch',
    description: 'Fetch a web page and extract its readable content. Strips HTML and returns clean text. Useful for reading articles, documentation, API responses, etc.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        raw: { type: 'boolean', description: 'Return raw HTML instead of extracted text (default: false)' },
        headers: { type: 'object', description: 'Custom headers to include in the request' },
      },
      required: ['url'],
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const url = params['url'] as string;
    if (!url) return createErrorResult('Missing required parameter: url');

    // SSRF protection: block requests to private/internal networks
    if (isPrivateUrl(url)) {
      return createErrorResult('Blocked: URL targets a private or internal network address');
    }

    // DNS rebinding protection: pre-resolve hostname and verify the IP is not private
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;
      // Only resolve if it's not already an IP address
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && !hostname.startsWith('[')) {
        const { address } = await lookup(hostname);
        if (isPrivateUrl(`http://${address}`)) {
          return createErrorResult(`Blocked: ${hostname} resolves to private IP ${address} (DNS rebinding protection)`);
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      // DNS lookup failure — let fetch handle it (may be a valid URL with DNS issues)
      if (!msg.includes('ENOTFOUND')) {
        // Only block on unexpected errors, not DNS resolution failures
      }
    }

    const raw = params['raw'] as boolean ?? false;
    const customHeaders = (params['headers'] as Record<string, string>) ?? {};

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Jarvis-2.0-Agent/1.0 (compatible; bot)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...customHeaders,
        },
        redirect: 'follow',
      });

      // Post-redirect SSRF check: verify the final URL after redirects
      const finalUrl = response.url;
      if (finalUrl && finalUrl !== url && isPrivateUrl(finalUrl)) {
        clearTimeout(timeoutId);
        return createErrorResult('Blocked: redirect targets a private or internal network address');
      }

      if (!response.ok) {
        clearTimeout(timeoutId);
        return createErrorResult(`HTTP ${response.status}: ${response.statusText} for ${url}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      let body: string;
      try {
        body = await response.text();
      } finally {
        clearTimeout(timeoutId);
      }

      // Truncate if needed
      if (body.length > MAX_CONTENT_LENGTH) {
        body = body.slice(0, MAX_CONTENT_LENGTH) + '\n\n[Content truncated]';
      }

      // If JSON response, return formatted
      if (contentType.includes('application/json')) {
        try {
          const json = JSON.parse(body);
          return createToolResult(JSON.stringify(json, null, 2), { url, contentType });
        } catch {
          return createToolResult(body, { url, contentType });
        }
      }

      // For HTML, extract text content unless raw mode
      if (!raw && contentType.includes('text/html')) {
        const text = extractTextFromHtml(body);
        return createToolResult(text, { url, contentType });
      }

      return createToolResult(body, { url, contentType });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('abort')) {
        return createErrorResult(`Request timed out after ${FETCH_TIMEOUT / 1000}s: ${url}`);
      }
      return createErrorResult(`Failed to fetch: ${message}`);
    }
  }
}

/**
 * Basic HTML-to-text extraction.
 * In production, this would use @mozilla/readability + linkedom for better extraction.
 * For now, a regex-based approach handles common cases.
 */
function extractTextFromHtml(html: string): string {
  let text = html;

  // Remove scripts and styles
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Convert common elements to text
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '  - ');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<td[^>]*>/gi, '\t');

  // Extract href from links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)');

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code as string)));

  // Clean up whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}
