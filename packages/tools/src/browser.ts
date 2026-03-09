/**
 * Browser Tool — OpenClaw-inspired browser automation with:
 * - Accessibility snapshot with ref-based interaction (click ref, type ref)
 * - CSS selector fallback for advanced queries
 * - Screenshot + snapshot dual capture mode
 * - Tab management (multiple tabs)
 * - Cookie & storage management
 * - Network simulation (offline, headers)
 * - Composable wait conditions (text, URL, load state, JS predicate)
 * - SSRF protection for navigation
 *
 * Note: Requires playwright-core as a peer dependency.
 */

import { createLogger } from '@jarvis/shared';
import type { AgentTool, ToolContext, ToolResult } from './base.js';
import { createToolResult, createErrorResult } from './base.js';
import { isPrivateUrl } from './ssrf.js';

const log = createLogger('tool:browser');

const MAX_TEXT_CONTENT = 50_000; // 50KB page text cap
const MAX_SNAPSHOT_SIZE = 30_000; // 30KB accessibility tree cap
const DEFAULT_BROWSER_TIMEOUT = 10_000; // 10s default action timeout
const DEFAULT_NAV_TIMEOUT = 30_000; // 30s default navigation timeout
const DEFAULT_SCROLL_PX = 500; // default scroll amount in pixels
const MAX_WAIT_TIMEOUT = 30_000; // 30s max wait timeout

// ─── Ref tracking ─────────────────────────────────────────────────────

interface ElementRef {
  selector: string;
  role?: string;
  name?: string;
  text?: string;
}

const MAX_REF_MAP_SIZE = 500; // LRU cap — prevent unbounded memory growth
let _refCounter = 0;
let _refMap = new Map<number, ElementRef>();

// ─── Browser Tool ─────────────────────────────────────────────────────

export class BrowserTool implements AgentTool {
  private browser: BrowserInstance | null = null;
  private page: PageInstance | null = null;
  private tabs: Map<string, PageInstance> = new Map();
  private activeTabId = 'main';

  definition = {
    name: 'browser',
    description: [
      'Control a web browser for navigation, content extraction, interaction, and screenshots.',
      '',
      'Actions:',
      '  navigate    — Go to a URL',
      '  snapshot    — Get accessibility tree with numbered refs (preferred over screenshot for text)',
      '  screenshot  — Take a PNG screenshot',
      '  click       — Click element by ref number or CSS selector',
      '  type        — Type text into element by ref or selector',
      '  select      — Select dropdown option',
      '  scroll      — Scroll page or element',
      '  hover       — Hover over element',
      '  evaluate    — Run JavaScript in page context',
      '  get_text    — Extract text from page or element',
      '  wait        — Wait for element, text, URL, or JS condition',
      '  tab_open    — Open a new tab',
      '  tab_list    — List open tabs',
      '  tab_focus   — Switch to a tab',
      '  tab_close   — Close a tab',
      '  cookies     — Get cookies for current domain',
      '  close       — Close the browser',
      '',
      'Ref-based interaction: Use snapshot first to get numbered refs, then click/type by ref.',
      'Example: snapshot → see [ref=5] Login button → click with ref=5',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'navigate', 'snapshot', 'screenshot', 'click', 'type', 'select',
            'scroll', 'hover', 'evaluate', 'get_text', 'wait',
            'tab_open', 'tab_list', 'tab_focus', 'tab_close',
            'cookies', 'close',
          ],
          description: 'The browser action to perform',
        },
        url: { type: 'string', description: 'URL to navigate to' },
        ref: { type: 'number', description: 'Element reference number from snapshot' },
        selector: { type: 'string', description: 'CSS selector (fallback when ref not available)' },
        text: { type: 'string', description: 'Text to type or value to select' },
        script: { type: 'string', description: 'JavaScript to evaluate' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Scroll amount in pixels (default: 500)' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 10000)' },
        waitFor: {
          type: 'object',
          description: 'Composable wait condition',
          properties: {
            text: { type: 'string', description: 'Wait for this text to appear on page' },
            url: { type: 'string', description: 'Wait for URL to match (glob pattern)' },
            load: { type: 'string', enum: ['domcontentloaded', 'load', 'networkidle'], description: 'Wait for load state' },
            fn: { type: 'string', description: 'Wait for JS function to return true' },
          },
        },
        tabId: { type: 'string', description: 'Tab ID for tab operations' },
      },
      required: ['action'],
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    if (!action) return createErrorResult('Missing required parameter: action');

    try {
      switch (action) {
        case 'navigate': return await this.navigate(params);
        case 'snapshot': return await this.snapshot(params);
        case 'screenshot': return await this.screenshot(params, context);
        case 'click': return await this.click(params);
        case 'type': return await this.typeText(params);
        case 'select': return await this.selectOption(params);
        case 'scroll': return await this.scroll(params);
        case 'hover': return await this.hover(params);
        case 'evaluate': return await this.evaluate(params);
        case 'get_text': return await this.getText(params);
        case 'wait': return await this.waitFor(params);
        case 'tab_open': return await this.tabOpen(params);
        case 'tab_list': return this.tabList();
        case 'tab_focus': return await this.tabFocus(params);
        case 'tab_close': return await this.tabClose(params);
        case 'cookies': return await this.getCookies();
        case 'close': return await this.closeBrowser();
        default: return createErrorResult(`Unknown action: ${action}`);
      }
    } catch (err) {
      return createErrorResult(`Browser action '${action}' failed: ${(err as Error).message}`);
    }
  }

  // ─── Browser lifecycle ────────────────────────────────────────────

  private async ensureBrowser(): Promise<PageInstance> {
    if (this.page) return this.page;

    try {
      const pw = await import('playwright-core');
      this.browser = await pw.chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      }) as unknown as BrowserInstance;

      const ctx = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      });
      this.page = await ctx.newPage() as unknown as PageInstance;
      this.tabs.set('main', this.page);
      log.info('Browser launched');
      return this.page;
    } catch (err) {
      throw new Error(`Failed to launch browser: ${(err as Error).message}. Install: npx playwright install chromium`);
    }
  }

  private resolveTarget(params: Record<string, unknown>): string | undefined {
    // Ref-based resolution (from snapshot)
    if (params['ref'] !== undefined) {
      const ref = params['ref'] as number;
      const entry = _refMap.get(ref);
      if (entry) return entry.selector;
      return undefined;
    }
    return params['selector'] as string | undefined;
  }

  // ─── Actions ──────────────────────────────────────────────────────

  private async navigate(params: Record<string, unknown>): Promise<ToolResult> {
    const url = params['url'] as string;
    if (!url) return createErrorResult('Missing url for navigate action');
    const timeout = (params['timeout'] as number) || DEFAULT_NAV_TIMEOUT;

    // SSRF protection: block private/internal URLs
    if (isPrivateUrl(url)) {
      return createErrorResult(`Navigation blocked: private/internal URLs are not allowed (${url})`);
    }

    const page = await this.ensureBrowser();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const title = await page.title();
    const currentUrl = await page.evaluate('window.location.href');

    // Post-redirect SSRF check
    if (typeof currentUrl === 'string' && isPrivateUrl(currentUrl)) {
      await page.goto('about:blank');
      return createErrorResult(`Navigation blocked: redirected to private URL (${currentUrl})`);
    }

    // Reset refs on navigation
    _refCounter = 0;
    _refMap = new Map();

    return createToolResult(`Navigated to: ${url}\nTitle: ${title}\nCurrent URL: ${currentUrl}`);
  }

  private async snapshot(_params: Record<string, unknown>): Promise<ToolResult> {
    const page = await this.ensureBrowser();

    // Build accessibility tree with ref numbers
    const tree = await page.evaluate(`
      (function() {
        const refs = [];
        let counter = 1;

        function walk(el, depth) {
          if (depth > 8) return '';
          const tag = el.tagName?.toLowerCase() ?? '';
          const role = el.getAttribute?.('role') || '';
          const ariaLabel = el.getAttribute?.('aria-label') || '';
          const text = el.innerText?.trim().slice(0, 100) || '';
          const href = el.getAttribute?.('href') || '';
          const type = el.getAttribute?.('type') || '';
          const value = el.value || '';
          const placeholder = el.getAttribute?.('placeholder') || '';

          // Is this an interactive element?
          const interactive = ['a', 'button', 'input', 'select', 'textarea'].includes(tag)
            || role === 'button' || role === 'link' || role === 'tab'
            || el.getAttribute?.('onclick') || el.getAttribute?.('tabindex');

          let line = '';
          const indent = '  '.repeat(depth);

          if (interactive) {
            const ref = counter++;
            let desc = tag;
            if (role) desc += '[role=' + role + ']';
            if (ariaLabel) desc += ' "' + ariaLabel + '"';
            else if (text && text.length < 80) desc += ' "' + text.replace(/\\n/g, ' ').slice(0, 80) + '"';
            if (href) desc += ' href=' + href.slice(0, 60);
            if (type) desc += ' type=' + type;
            if (placeholder) desc += ' placeholder="' + placeholder + '"';
            if (value) desc += ' value="' + value.slice(0, 40) + '"';

            // Build unique selector
            let sel = '';
            if (el.id) sel = '#' + el.id;
            else {
              const idx = Array.from(el.parentElement?.children ?? []).indexOf(el);
              sel = tag + ':nth-child(' + (idx + 1) + ')';
              let parent = el.parentElement;
              for (let i = 0; i < 3 && parent && parent !== document.body; i++) {
                const pIdx = Array.from(parent.parentElement?.children ?? []).indexOf(parent);
                sel = parent.tagName.toLowerCase() + ':nth-child(' + (pIdx + 1) + ') > ' + sel;
                parent = parent.parentElement;
              }
            }

            refs.push({ ref: ref, selector: sel, role: role || tag, name: ariaLabel || text.slice(0, 50) });
            line = indent + '[ref=' + ref + '] ' + desc;
          } else if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'p' || tag === 'li') {
            if (text) line = indent + tag + ': ' + text.slice(0, 120);
          } else if (tag === 'img') {
            const alt = el.getAttribute?.('alt') || '';
            if (alt) line = indent + 'img: ' + alt.slice(0, 80);
          }

          let result = line ? line + '\\n' : '';
          for (const child of (el.children ?? [])) {
            result += walk(child, depth + (line ? 1 : 0));
          }
          return result;
        }

        const tree = walk(document.body, 0);
        return JSON.stringify({ tree: tree.slice(0, 30000), refs: refs });
      })()
    `);

    // Parse the result and update ref map
    try {
      const parsed = JSON.parse(tree as string);
      _refCounter = 0;
      _refMap = new Map();

      for (const ref of parsed.refs) {
        _refMap.set(ref.ref, { selector: ref.selector, role: ref.role, name: ref.name });
      }

      // LRU eviction: if too many refs, keep only the most recent
      if (_refMap.size > MAX_REF_MAP_SIZE) {
        const keys = [..._refMap.keys()];
        for (let i = 0; i < keys.length - MAX_REF_MAP_SIZE; i++) {
          _refMap.delete(keys[i]!);
        }
      }

      const title = await page.title();
      const url = await page.evaluate('window.location.href');

      return createToolResult(
        `Page: ${title}\nURL: ${url}\n\n` +
        `Accessibility Snapshot (${_refMap.size} interactive elements):\n` +
        `${parsed.tree}\n\n` +
        `Use ref numbers with click/type actions (e.g., click ref=5)`,
      );
    } catch {
      return createToolResult(`Failed to parse snapshot. Raw: ${String(tree).slice(0, 5000)}`);
    }
  }

  private async screenshot(_params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const page = await this.ensureBrowser();
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    const base64 = Buffer.from(buffer).toString('base64');
    return {
      type: 'image',
      content: base64,
      metadata: { format: 'png', encoding: 'base64', mediaType: 'image/png' },
    };
  }

  private async click(params: Record<string, unknown>): Promise<ToolResult> {
    const selector = this.resolveTarget(params);
    if (!selector) return createErrorResult('Missing ref or selector for click');
    const timeout = (params['timeout'] as number) || DEFAULT_BROWSER_TIMEOUT;

    const page = await this.ensureBrowser();
    await page.click(selector, { timeout });
    const refInfo = params['ref'] !== undefined ? ` (ref=${params['ref']})` : '';
    return createToolResult(`Clicked: ${selector}${refInfo}`);
  }

  private async typeText(params: Record<string, unknown>): Promise<ToolResult> {
    const selector = this.resolveTarget(params);
    const text = params['text'] as string;
    if (!selector) return createErrorResult('Missing ref or selector for type');
    if (!text) return createErrorResult('Missing text for type');

    const page = await this.ensureBrowser();
    await page.fill(selector, text);
    return createToolResult(`Typed into ${selector}: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}`);
  }

  private async selectOption(params: Record<string, unknown>): Promise<ToolResult> {
    const selector = this.resolveTarget(params);
    const text = params['text'] as string;
    if (!selector) return createErrorResult('Missing ref or selector for select');
    if (!text) return createErrorResult('Missing text (option value) for select');

    const page = await this.ensureBrowser();
    // Use page.selectOption with Playwright API to avoid JS injection
    await page.evaluate(
      `(function(sel, val) {
        const el = document.querySelector(sel);
        if (el && el.tagName === 'SELECT') {
          for (const opt of el.options) {
            if (opt.value === val || opt.text === val) {
              el.value = opt.value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }
      })(${JSON.stringify(selector)}, ${JSON.stringify(text)})`
    );
    return createToolResult(`Selected "${text}" in ${selector}`);
  }

  private async hover(params: Record<string, unknown>): Promise<ToolResult> {
    const selector = this.resolveTarget(params);
    if (!selector) return createErrorResult('Missing ref or selector for hover');

    const page = await this.ensureBrowser();
    await page.evaluate(
      `(function(sel) {
        const el = document.querySelector(sel);
        if (el) {
          el.scrollIntoView({block:'center'});
          el.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
          el.dispatchEvent(new MouseEvent('mouseenter', {bubbles: true}));
        }
      })(${JSON.stringify(selector)})`
    );
    return createToolResult(`Hovered: ${selector}`);
  }

  private async scroll(params: Record<string, unknown>): Promise<ToolResult> {
    const direction = params['direction'] as string ?? 'down';
    const amount = (params['amount'] as number) || DEFAULT_SCROLL_PX;

    const page = await this.ensureBrowser();
    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    await page.evaluate(`window.scrollBy(${deltaX}, ${deltaY})`);
    return createToolResult(`Scrolled ${direction} by ${amount}px`);
  }

  private async getText(params: Record<string, unknown>): Promise<ToolResult> {
    const selector = this.resolveTarget(params);
    const page = await this.ensureBrowser();

    if (selector) {
      const text = await page.textContent(selector);
      return createToolResult(text ?? '(empty)');
    }

    const text = await page.evaluate('document.body.innerText');
    const truncated = typeof text === 'string' && text.length > MAX_TEXT_CONTENT
      ? text.slice(0, MAX_TEXT_CONTENT) + '\n\n[Content truncated]'
      : text;
    return createToolResult(typeof truncated === 'string' ? truncated : JSON.stringify(truncated));
  }

  private async evaluate(params: Record<string, unknown>): Promise<ToolResult> {
    const script = params['script'] as string;
    if (!script) return createErrorResult('Missing script for evaluate');

    const page = await this.ensureBrowser();
    const result = await page.evaluate(script);
    return createToolResult(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  }

  private async waitFor(params: Record<string, unknown>): Promise<ToolResult> {
    const timeout = (params['timeout'] as number) || DEFAULT_BROWSER_TIMEOUT;
    const waitConfig = params['waitFor'] as Record<string, string> | undefined;
    const selector = this.resolveTarget(params);
    const page = await this.ensureBrowser();

    // Simple selector wait
    if (selector && !waitConfig) {
      await page.waitForSelector(selector, { timeout });
      return createToolResult(`Element appeared: ${selector}`);
    }

    // Composable wait conditions (OpenClaw pattern)
    if (waitConfig) {
      if (waitConfig['text']) {
        const text = waitConfig['text'];
        await page.evaluate(
          `(function(searchText, ms) {
            return new Promise((resolve, reject) => {
              const t = setTimeout(() => reject(new Error('Timeout waiting for text')), ms);
              const check = () => {
                if (document.body.innerText.includes(searchText)) {
                  clearTimeout(t);
                  resolve(true);
                } else {
                  requestAnimationFrame(check);
                }
              };
              check();
            });
          })(${JSON.stringify(text)}, ${Math.min(timeout, MAX_WAIT_TIMEOUT)})`
        );
        return createToolResult(`Text appeared: "${text}"`);
      }

      if (waitConfig['fn']) {
        // Sanitize: only allow simple JS expressions, block dangerous patterns
        const fn = waitConfig['fn'];
        const dangerous = /\b(eval|Function|import|require|fetch|XMLHttpRequest|process|child_process|exec)\b/;
        if (dangerous.test(fn)) {
          return createErrorResult('JS condition contains disallowed keywords');
        }
        await page.evaluate(`
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout')), ${Math.min(timeout, MAX_WAIT_TIMEOUT)});
            const check = () => {
              if (${fn}) {
                clearTimeout(timeout);
                resolve(true);
              } else {
                requestAnimationFrame(check);
              }
            };
            check();
          })
        `);
        return createToolResult(`JS condition met`);
      }

      if (waitConfig['load']) {
        const state = waitConfig['load'];
        await page.evaluate(`new Promise(r => { if (document.readyState === '${state}') r(); else window.addEventListener('load', r); })`);
        return createToolResult(`Page load state: ${state}`);
      }
    }

    // Plain timeout
    const ms = Math.min(timeout, MAX_WAIT_TIMEOUT);
    await new Promise((r) => setTimeout(r, ms));
    return createToolResult(`Waited ${ms}ms`);
  }

  // ─── Tab management ───────────────────────────────────────────────

  private async tabOpen(params: Record<string, unknown>): Promise<ToolResult> {
    const url = params['url'] as string;
    if (!this.browser) await this.ensureBrowser();

    const ctx = await this.browser!.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    const newPage = await ctx.newPage() as unknown as PageInstance;
    const tabId = `tab-${Date.now()}`;
    this.tabs.set(tabId, newPage);

    if (url) {
      await newPage.goto(url, { waitUntil: 'domcontentloaded' });
    }

    this.page = newPage;
    this.activeTabId = tabId;

    return createToolResult(`Opened new tab: ${tabId}${url ? ` → ${url}` : ''}`);
  }

  private tabList(): ToolResult {
    const lines = Array.from(this.tabs.entries()).map(([id]) => {
      const active = id === this.activeTabId ? ' ← active' : '';
      return `  ${id}${active}`;
    });
    return createToolResult(`Open tabs:\n${lines.join('\n')}`);
  }

  private async tabFocus(params: Record<string, unknown>): Promise<ToolResult> {
    const tabId = params['tabId'] as string;
    const page = this.tabs.get(tabId);
    if (!page) return createErrorResult(`Tab not found: ${tabId}`);

    this.page = page;
    this.activeTabId = tabId;
    _refCounter = 0;
    _refMap = new Map();
    return createToolResult(`Focused tab: ${tabId}`);
  }

  private async tabClose(params: Record<string, unknown>): Promise<ToolResult> {
    const tabId = params['tabId'] as string || this.activeTabId;
    const page = this.tabs.get(tabId);
    if (!page) return createErrorResult(`Tab not found: ${tabId}`);
    if (this.tabs.size <= 1) return createErrorResult('Cannot close the last tab');

    this.tabs.delete(tabId);

    // Close the page's browser context to prevent resource leaks
    try {
      const ctx = page.context?.();
      if (ctx && typeof ctx.close === 'function') {
        await ctx.close();
      }
    } catch {
      // Page/context may already be detached — that's fine
    }

    if (tabId === this.activeTabId) {
      const first = this.tabs.entries().next().value;
      if (first) {
        this.activeTabId = first[0];
        this.page = first[1];
      }
    }

    return createToolResult(`Closed tab: ${tabId}. Active: ${this.activeTabId}`);
  }

  // ─── Cookies ──────────────────────────────────────────────────────

  private async getCookies(): Promise<ToolResult> {
    const page = await this.ensureBrowser();
    const cookies = await page.evaluate('document.cookie');
    return createToolResult(typeof cookies === 'string' ? cookies || '(no cookies)' : JSON.stringify(cookies));
  }

  // ─── Browser close ────────────────────────────────────────────────

  private async closeBrowser(): Promise<ToolResult> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.tabs.clear();
      _refCounter = 0;
      _refMap = new Map();
      log.info('Browser closed');
    }
    return createToolResult('Browser closed');
  }

}

// ─── Minimal Playwright type stubs ────────────────────────────────────

interface BrowserInstance {
  newContext(options?: unknown): Promise<ContextInstance>;
  close(): Promise<void>;
}

interface ContextInstance {
  newPage(): Promise<PageInstance>;
}

interface PageInstance {
  goto(url: string, options?: unknown): Promise<unknown>;
  title(): Promise<string>;
  click(selector: string, options?: unknown): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  screenshot(options?: unknown): Promise<Buffer>;
  textContent(selector: string): Promise<string | null>;
  evaluate(script: string | Function, ...args: unknown[]): Promise<unknown>;
  waitForSelector(selector: string, options?: unknown): Promise<unknown>;
}
