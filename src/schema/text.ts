/**
 * Small text helpers shared by the database layer, the views and the clients.
 * They live here because a slug computed one way on the server and another way
 * in the CLI produces two URLs for one job.
 */

/**
 * Trim, flatten control characters, cap.
 *
 * Written as a scan rather than a regex character class because this text is
 * printed into a terminal by the TUI and the CLI as well as escaped into HTML
 * by the views, and the escape that starts an ANSI sequence is exactly the
 * kind of character a source-level class is easy to get subtly wrong.
 *
 * `multiline` keeps newlines. Without it a job description posted from a
 * Markdown file arrived as one paragraph, because a newline is a control
 * character and this flattened it along with the rest: every heading, list and
 * paragraph break in a description was silently destroyed on the way in, on a
 * board that renders descriptions as Markdown. A newline cannot begin an
 * escape sequence, so keeping it costs none of the safety this scan exists
 * for. Everything else below 0x20, the ESC that starts an ANSI sequence
 * included, still becomes a space.
 */
export function clean(value: unknown, max: number, options: { multiline?: boolean } = {}): string {
  if (typeof value !== 'string') return '';
  const source = options.multiline === true ? value.replace(/\r\n?/g, '\n') : value;
  let out = '';
  for (const char of source) {
    const code = char.codePointAt(0) ?? 0;
    const keep = options.multiline === true && code === 0x0a;
    out += !keep && (code < 0x20 || code === 0x7f) ? ' ' : char;
  }
  return out.trim().slice(0, max);
}

export function slugify(value: string): string {
  const base = value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  // A title made entirely of punctuation or of a non-Latin script leaves
  // nothing behind, and an empty slug collides with every other empty slug.
  return base === '' ? 'job' : base;
}

/** A short, unambiguous suffix for slug collisions. No l/1/0/O. */
export function suffix(length = 5): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export function parseList(value: unknown, max: number, each = 40): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const cleaned = clean(item, each).toLowerCase();
    if (cleaned === '' || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

const SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '\u20AC',
  GBP: '\u00A3',
  CAD: 'CA$',
  AUD: 'A$',
  JPY: '\u00A5',
};

/**
 * "$120k - $160k a year", "Unpaid", or null when the employer did not say.
 *
 * The three are different answers and the reader is owed the difference. A
 * null here means the field was left empty; "Unpaid" means somebody ticked a
 * box saying the role pays nothing, which is a thing an internship is allowed
 * to be as long as it is not hidden.
 */
export function formatSalary(salary: {
  min: number | null;
  max: number | null;
  currency: string;
  period: string;
  unpaid?: boolean;
}): string | null {
  if (salary.unpaid === true) return 'Unpaid';
  if (salary.min === null && salary.max === null) return null;
  const money = (amount: number): string => {
    const symbol = SYMBOLS[salary.currency.toUpperCase()] ?? `${salary.currency.toUpperCase()} `;
    if (amount >= 1000 && amount % 1000 === 0) return `${symbol}${amount / 1000}k`;
    return `${symbol}${amount.toLocaleString('en-US')}`;
  };
  const min = salary.min;
  const max = salary.max;
  const range =
    min !== null && max !== null && min !== max
      ? `${money(min)} - ${money(max)}`
      : money((min ?? max) as number);
  return `${range} a ${salary.period}`;
}

/** Each entry: below this many seconds, report in the unit named. */
const UNITS: ReadonlyArray<readonly [ceiling: number, divisor: number, name: string]> = [
  [3600, 60, 'minute'],
  [86_400, 3600, 'hour'],
  [604_800, 86_400, 'day'],
  [2_629_800, 604_800, 'week'],
  [31_557_600, 2_629_800, 'month'],
];

/** "3 days ago". Used identically in HTML and in the TUI. */
export function ago(iso: string | null, now = Date.now()): string {
  if (iso === null) return 'not published';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'unknown';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';

  let divisor = 31_557_600;
  let unit = 'year';
  for (const entry of UNITS) {
    if (seconds < entry[0]) {
      divisor = entry[1];
      unit = entry[2];
      break;
    }
  }
  const value = Math.max(1, Math.floor(seconds / divisor));
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}
