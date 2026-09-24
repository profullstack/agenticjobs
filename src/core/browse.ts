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
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // The first hextet decides the reserved ranges: fe80::/10 is link-local
  // (fe80 through febf, so a prefix test on "fe80:" misses fe90::1),
  // fec0::/10 is site-local and fc00::/7 is unique-local.
  const hextet = Number.parseInt(lower.split(':', 1)[0] ?? '', 16);
  if ((hextet & 0xffc0) === 0xfe80 || (hextet & 0xffc0) === 0xfec0 || (hextet & 0xfe00) === 0xfc00) return true;
  if (lower.startsWith('2001:db8:')) return true;
  // An IPv4 address hidden in an IPv6 one, by whichever prefix carries it:
  // ::ffff: mapped, the deprecated :: compatible form, the NAT64 well-known
  // prefix and 6to4. A host whose only v4 route is a NAT64 translator, or a
  // resolver doing DNS64, really does reach 64:ff9b::a9fe:a9fe as
  // 169.254.169.254, so the address inside is what has to be judged.
  const embedded = embeddedIpv4(lower);
  if (embedded === 'reserved') return true;
  if (embedded === null) return false;
  return isPrivateAddress(embedded);
}

/**
 * The IPv4 an IPv6 translation address stands for, 'reserved' when the
 * spelling is translation space that names no public host, or null when the
 * address embeds no IPv4 at all.
 */
function embeddedIpv4(lower: string): string | 'reserved' | null {
  // A dotted tail is how getaddrinfo spells a mapped address; fold it into
  // two hextets so every form below reads the same way.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(lower);
  if (dotted !== null) {
    const octets = [1, 2, 3, 4].map((part) => Number(dotted[part]));
    lower = `${lower.slice(0, dotted.index)}${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = lower.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const right =
    halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] ?? '').split(':')) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const pad = 8 - left.length - right.length;
  if (halves.length === 2 && pad < 1) return null;
  const h = [...left, ...new Array<string>(Math.max(pad, 0)).fill('0'), ...right].map((part) =>
    Number.parseInt(part, 16),
  );
  if (h.length !== 8 || h.some((part) => Number.isNaN(part))) return null;
  const v4 = (hi: number, lo: number): string =>
    `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
  // 6to4 keeps the relay's address in the two hextets after 2002:.
  if (h[0] === 0x2002) return v4(h[1] ?? 0, h[2] ?? 0);
  // 64:ff9b::/96 is the NAT64 well-known prefix, v4 in the last 32 bits. The
  // rest of 64:ff9b::/32 is translation space with no public host inside.
  if (h[0] === 0x64 && h[1] === 0xff9b) {
    return h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0
      ? v4(h[6] ?? 0, h[7] ?? 0)
      : 'reserved';
  }
  // The mapped form ::ffff:/96 and the compatible form ::/96 both end in v4.
  if (h.slice(0, 5).every((part) => part === 0) && (h[5] === 0xffff || h[5] === 0)) {
    return v4(h[6] ?? 0, h[7] ?? 0);
  }
  return null;
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
  return viaFetch(
    url,
    options.fetch ?? fetch,
    maxChars,
    options.timeoutMs ?? 20_000,
    options.allowPrivate ?? false,
  );
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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

async function viaFetch(
  url: URL,
  fetcher: typeof fetch,
  maxChars: number,
  timeoutMs: number,
  allowPrivate: boolean,
): Promise<BrowseResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let html: string;
  let contentType = '';
  try {
    let current = url;
    let response: Response | undefined;
    for (let hop = 0; ; hop += 1) {
      if (hop > MAX_REDIRECTS) throw new BrowseProblem('Too many redirects.');
      response = await fetcher(current.toString(), {
        headers: {
          accept: 'text/html, text/markdown, text/plain;q=0.9, */*;q=0.1',
          'user-agent': 'agenticjobs (+https://agenticjobs.work)',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || location === null) break;
      // A redirect target is a fresh URL: it needs the same public-address
      // check as the page the user typed, or a public resume link can bounce
      // the fetch to a private address the guard was meant to keep out.
      current = await assertPublicUrl(new URL(location, current).toString(), allowPrivate);
    }
    if (response === undefined || !response.ok)
      throw new BrowseProblem(`${current.hostname} answered ${response?.status ?? 'nothing'}.`);
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
  const named: Record<string, string> = {
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    amp: '&',
  };
  // One pass, amp inside the same alternation: decoding "&amp;lt;" a second
  // time turns the "&lt;" a page wrote literally into a real "<", which is
  // how resume text describing markup arrived already mangled.
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|nbsp|amp);/g,
    (whole, entity: string) => {
      const point = entity.startsWith('#x')
        ? Number.parseInt(entity.slice(2), 16)
        : entity.startsWith('#')
          ? Number(entity.slice(1))
          : null;
      if (point !== null) {
        // Same policy as before: 0, surrogates and out-of-range points
        // become the replacement character instead of a NUL or a throw.
        if (point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
          return '\ufffd';
        return String.fromCodePoint(point);
      }
      return named[entity] ?? whole;
    },
  );
}
