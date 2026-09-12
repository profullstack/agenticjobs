/**
 * A web page as Markdown, for importing a resume from a URL.
 *
 * Two ways to read a page. With an Obscura MCP server configured
 * (OBSCURA_MCP_URL), the page is rendered by a real browser engine, so a
 * resume behind client-side rendering comes out whole, and its own
 * browser_markdown tool does the conversion. Without one, the page is
 * fetched and its HTML reduced to Markdown here: headings, paragraphs,
 * lists, links, nothing clever. Either way the person edits the result
 * before it goes anywhere; this is an import step, not a storage format.
 *
 * Obscura's HTTP MCP transport has no authentication of its own, so the
 * server it points at must be private (a Railway internal hostname, a
 * sidecar), never a public URL. This code never sends a credential to it.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BrowseProblem extends Error {}

export interface BrowseOptions {
  /** The Obscura MCP endpoint, e.g. http://obscura.railway.internal:3000/mcp, or null for plain fetch. */
  obscuraMcpUrl: string | null;
  fetch?: typeof fetch;
  /** Skip the private-address check, for tests against a local stub. */
  allowPrivate?: boolean;
  maxChars?: number;
  timeoutMs?: number;
}

export interface BrowseResult {
  markdown: string;
  via: 'obscura' | 'fetch';
  title: string | null;
}

const MAX_CHARS = 120_000;

/** Only a public http(s) page. A resume is not on localhost or inside our own network. */
export async function assertPublicUrl(raw: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BrowseProblem('That is not a URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new BrowseProblem('The URL must start with https:// or http://.');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : await lookup(host, { all: true })
        .then((rows) => rows.map((row) => row.address))
        .catch(() => []);
  if (addresses.length === 0) throw new BrowseProblem(`${url.hostname} does not resolve.`);
  for (const address of addresses) {
    if (isPrivateAddress(address))
      throw new BrowseProblem(`${url.hostname} is not a public address.`);
  }
  return url;
}

export function isPrivateAddress(address: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // An IPv4 address hidden in an IPv6 one.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  return mapped !== null && isPrivateAddress(mapped[1] ?? '');
}

/** The page as Markdown, by whichever route is configured. */
export async function pageToMarkdown(raw: string, options: BrowseOptions): Promise<BrowseResult> {
  const url = await assertPublicUrl(raw, options.allowPrivate);
  const maxChars = options.maxChars ?? MAX_CHARS;
  if (options.obscuraMcpUrl)
    return viaObscura(
      url,
      options.obscuraMcpUrl,
      options.fetch ?? fetch,
      maxChars,
      options.timeoutMs ?? 45_000,
    );
  return viaFetch(url, options.fetch ?? fetch, maxChars, options.timeoutMs ?? 20_000);
}

// --- Obscura -------------------------------------------------------------

interface RpcResult {
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { message?: string };
}

async function viaObscura(
  url: URL,
  mcpUrl: string,
  fetcher: typeof fetch,
  maxChars: number,
  timeoutMs: number,
): Promise<BrowseResult> {
  let id = 0;
  const call = async (
    method: string,
    params?: Record<string, unknown>,
    notification = false,
  ): Promise<RpcResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          ...(notification ? {} : { id: ++id }),
          method,
          ...(params ? { params } : {}),
        }),
        signal: controller.signal,
      });
      if (notification) return {};
      if (!response.ok) throw new BrowseProblem(`The browser service answered ${response.status}.`);
      const text = await response.text();
      const line = text.trim().startsWith('{')
        ? text
        : (text.split('\n').find((row) => row.startsWith('data:')) ?? '').slice(5);
      return JSON.parse(line) as RpcResult;
    } catch (error) {
      if (error instanceof BrowseProblem) throw error;
      throw new BrowseProblem(
        `The browser service could not be reached: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
  const textOf = (reply: RpcResult): string =>
    (reply.result?.content ?? [])
      .map((block) => block.text ?? '')
      .join('\n')
      .trim();

  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'agenticjobs', version: '0' },
  });
  await call('notifications/initialized', undefined, true);
  const navigated = await call('tools/call', {
    name: 'browser_navigate',
    arguments: { url: url.toString(), waitUntil: 'load' },
  });
  if (navigated.error || navigated.result?.isError)
    throw new BrowseProblem(
      `The page could not be opened: ${navigated.error?.message ?? textOf(navigated) ?? 'unknown'}`,
    );
  const title = /— "(.+)"$/.exec(textOf(navigated))?.[1] ?? null;
  const page = await call('tools/call', {
    name: 'browser_markdown',
    arguments: { max_chars: maxChars },
  });
  if (page.error || page.result?.isError)
    throw new BrowseProblem(`The page could not be read: ${page.error?.message ?? textOf(page)}`);
  const markdown = textOf(page);
  if (markdown.length < 40) throw new BrowseProblem('The page had almost no text.');
  return { markdown, via: 'obscura', title };
}

// --- plain fetch -----------------------------------------------------------

async function viaFetch(
  url: URL,
  fetcher: typeof fetch,
  maxChars: number,
  timeoutMs: number,
): Promise<BrowseResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let html: string;
  let contentType = '';
  try {
    const response = await fetcher(url.toString(), {
      headers: {
        accept: 'text/html, text/markdown, text/plain;q=0.9, */*;q=0.1',
        'user-agent': 'agenticjobs (+https://agenticjobs.work)',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new BrowseProblem(`${url.hostname} answered ${response.status}.`);
    contentType = response.headers.get('content-type') ?? '';
    html = (await response.text()).slice(0, 4 * 1024 * 1024);
  } catch (error) {
    if (error instanceof BrowseProblem) throw error;
    throw new BrowseProblem(
      `${url.hostname} could not be fetched: ${(error as Error).name === 'AbortError' ? 'timed out' : (error as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (/text\/(markdown|plain)/.test(contentType) || !/<[a-z][\s\S]*>/i.test(html)) {
    return { markdown: html.trim().slice(0, maxChars), via: 'fetch', title: null };
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  const markdown = htmlToMarkdown(html).slice(0, maxChars);
  if (markdown.length < 40)
    throw new BrowseProblem(
      'The page had almost no text. A page that renders in the browser needs the browser service.',
    );
  return { markdown, via: 'fetch', title: title ? decode(title) : null };
}

/** Enough of a page to be a resume draft: headings, paragraphs, lists, links, line breaks. */
export function htmlToMarkdown(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, '');
  const main =
    /<main[\s\S]*?<\/main>/i.exec(s)?.[0] ??
    /<article[\s\S]*?<\/article>/i.exec(s)?.[0] ??
    /<body[\s\S]*?<\/body>/i.exec(s)?.[0] ??
    s;
  s = main.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inline(inner)}\n\n`,
  );
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => `\n- ${inline(inner)}`);
  s = s.replace(/<\/(ul|ol)>/gi, '\n\n');
  s = s
    .replace(/<(p|div|section|tr|blockquote|dd|dt)[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|tr|blockquote|dd|dt)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<(td|th)[^>]*>/gi, ' ').replace(/<\/(td|th)>/gi, ' | ');
  s = inline(s);
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inline(fragment: string): string {
  return decode(
    fragment
      .replace(
        /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_, href: string, text: string) => {
          const label = text.replace(/<[^>]+>/g, '').trim();
          return label && /^https?:\/\//i.test(href) ? `[${label}](${href})` : label;
        },
      )
      .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
      .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*')
      .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<[^>]+>/g, ''),
  );
}

function decode(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}
