/**
 * What a listing pays, in the words people use to say it.
 *
 * A salary range per year was the whole vocabulary, and it described one
 * kind of work. The listings this board is for pay per task, per pull
 * request, per social post, a flat fee for a project, a share of revenue, or
 * a bounty, in dollars or in a coin, settled over whatever rail the two sides
 * agree on. ugig.net has carried that vocabulary for a year (`budget_type`,
 * `budget_unit`, `payment_coin`) and this is the same model, so a gig there
 * and a job here describe pay the same way and a shared package can lift it
 * later without either side changing shape.
 *
 * Three ideas, kept apart on purpose:
 *
 *   - A LINE is one price: an amount or range, what it is per, and what it
 *     is denominated in. A listing may carry several: "$0.25 per task" and
 *     "$0.25 per PR that fixes a bug" are two lines, not one with a note.
 *   - The DENOMINATION is what the number is written in: USD, EUR, or a
 *     ticker such as SOL. "$0.25 per task" is denominated in dollars even
 *     when it is paid in SOL.
 *   - The METHOD is the rail it is settled over: SOL, USDC, a bank transfer,
 *     PayPal, payroll. One per listing, separate from the price, because
 *     "$100 an hour paid in USDC" is one rate with a preference, not two
 *     rates - the number does not change because the rail did.
 *
 * Everything here is text in, text out. A person types "$0.25 per task", an
 * agent sends the same string, the front matter of a job file carries it as a
 * list, and the page prints it back. The structured form is what the API
 * serves, but the string is what everybody writes, so the parser is the
 * feature and the JSON is its shadow.
 *
 * No imports from the rest of the board: this file is meant to be lifted into
 * a shared package with ugig.net and CoinPay behind it.
 */

/**
 * The kinds of price. The same list ugig.net's `budget_type` carries, in the
 * same spelling, so a value round-trips between the two boards untouched.
 *
 *   hourly … yearly   a rate per unit of time
 *   fixed             a flat fee for the whole engagement
 *   per_task          a price per task, the unit being "task"
 *   per_unit          a price per anything else, named in `unit`
 *   revenue_share     a percentage; min and max are percentages
 *   bounty            a fixed payout for an accepted submission
 */
export const PAY_TYPES = [
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'fixed',
  'per_task',
  'per_unit',
  'revenue_share',
  'bounty',
] as const;
export type PayType = (typeof PAY_TYPES)[number];

/**
 * Coins a listing is commonly settled in. ugig.net's list, which is the set
 * CoinPay can take payment in; Lightning and on-chain BTC are deliberately
 * not on it because CoinPay cannot settle them. The method field is free
 * text and accepts anything, so this list only drives the suggestions in a
 * form and the upper-casing of a ticker somebody typed in lowercase.
 */
export const PAYMENT_COINS = ['SOL', 'ETH', 'USDC', 'USDT', 'POL'] as const;

/** Rails that are not coins, offered beside them in a form. */
export const PAYMENT_RAILS = ['bank transfer', 'PayPal', 'payroll', 'card', 'invoice'] as const;

export interface PayLine {
  type: PayType;
  /** Bottom of the range, or the only figure. Percent for revenue_share. */
  min: number | null;
  /** Top of the range. Null for a single figure or an open-ended floor. */
  max: number | null;
  /** What the figure is written in: an ISO code or a ticker. `%` for a share. */
  currency: string;
  /** For per_task and per_unit: what one of them is. Null otherwise. */
  unit: string | null;
}

export interface Pay {
  lines: PayLine[];
  /** How it is settled: a coin such as SOL, or a rail such as "bank transfer". */
  method: string | null;
  /** Free text, "0.1% - 0.4%". Never parsed. */
  equity: string | null;
  /**
   * The role pays nothing, and the employer is saying so. Distinct from an
   * empty `lines`, which means nobody filled the field in.
   */
  unpaid: boolean;
}

export const EMPTY_PAY: Pay = { lines: [], method: null, equity: null, unpaid: false };

/** The most lines a listing can carry. Past this it is a rate card, not a job. */
export const PAY_LINES_MAX = 8;
/** The longest a per-unit description can be: "PR that fixes a bug you find". */
export const UNIT_MAX = 60;
export const METHOD_MAX = 40;
export const EQUITY_MAX = 60;

// --- currencies ----------------------------------------------------------

const FIAT = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'SEK', 'NOK', 'NZD', 'INR', 'CNY',
  'BRL', 'MXN', 'ZAR', 'SGD', 'HKD', 'PLN', 'DKK', 'KWD',
]);

const CRYPTO = new Set([
  'SOL', 'USDC', 'USDT', 'BTC', 'ETH', 'POL', 'MATIC', 'BNB', 'XRP', 'DOGE', 'LTC', 'AVAX',
  'ADA', 'DAI', 'PYUSD', 'BCH', 'SATS',
]);

const SYMBOL_TO_CODE: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
};

const CODE_TO_SYMBOL: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
};

export const isFiat = (code: string): boolean => FIAT.has(code.toUpperCase());
export const isKnownCurrency = (code: string): boolean =>
  FIAT.has(code.toUpperCase()) || CRYPTO.has(code.toUpperCase());

/** The keys of the time-based types, in the period words the rest of the board uses. */
const PERIOD_TYPE: Record<string, PayType> = {
  hour: 'hourly',
  hr: 'hourly',
  h: 'hourly',
  day: 'daily',
  week: 'weekly',
  wk: 'weekly',
  month: 'monthly',
  mo: 'monthly',
  year: 'yearly',
  yr: 'yearly',
  annum: 'yearly',
};

const TYPE_PERIOD: Partial<Record<PayType, 'hour' | 'day' | 'week' | 'month' | 'year'>> = {
  hourly: 'hour',
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
};

/** The period word for a time-based line, or null for every other kind. */
export function periodOf(type: PayType): 'hour' | 'day' | 'week' | 'month' | 'year' | null {
  return TYPE_PERIOD[type] ?? null;
}

export function isPayType(value: unknown): value is PayType {
  return typeof value === 'string' && (PAY_TYPES as readonly string[]).includes(value);
}

// --- parsing -------------------------------------------------------------

/** How a pay line is written, for every error message that has to explain it. */
export const PAY_LINE_EXAMPLES =
  '"$0.25 per task", "$120k - $150k a year", "$100 an hour", "$5000 fixed", "0.01 SOL per PR that fixes a bug", "10% revenue share"';

/** "$120k" -> 120000, "1.5m" -> 1500000, "0.25" -> 0.25. */
function amountOf(digits: string, scale: string | undefined): number {
  const base = Number(digits.replace(/[,_]/g, ''));
  const factor = scale === undefined ? 1 : scale.toLowerCase() === 'k' ? 1_000 : 1_000_000;
  return base * factor;
}

/** One money token: an optional symbol or code, digits, an optional k/m.
 * A scale must end before a letter so it cannot consume a ticker or "monthly".
 */
const MONEY =
  /(?:([$€£¥])\s*)?(?:([A-Za-z]{3,5})\s+)?(\d[\d,_]*(?:\.\d+)?)\s*([kKmM](?![A-Za-z]))?(?:\s*([$€£¥])|\s*([A-Za-z]{3,5})\b)?/y;

interface Money {
  amount: number;
  currency: string | null;
  end: number;
}

/**
 * Words that follow an amount and are not a currency code, so "$100 per
 * hour" does not read "per" as a ticker. A code is taken only when it is one
 * this file knows, or when it was typed in capitals, which is how tickers are
 * written and how nothing else in a pay line is.
 */
function codeFrom(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const upper = raw.toUpperCase();
  if (isKnownCurrency(upper)) return upper;
  if (raw === upper && /^[A-Z]{3,5}$/.test(upper)) return upper;
  return null;
}

function readMoney(text: string, at: number): Money | null {
  MONEY.lastIndex = at;
  const match = MONEY.exec(text);
  if (match === null) return null;
  const [, symbolBefore, codeBefore, digits, scale, symbolAfter, codeAfter] = match;
  let end = at + match[0].length;
  let currency: string | null = null;
  if (symbolBefore !== undefined) currency = SYMBOL_TO_CODE[symbolBefore] ?? null;
  if (currency === null && codeBefore !== undefined) {
    currency = codeFrom(codeBefore);
    // A leading word that is not a code is not part of the amount at all.
    if (currency === null) return null;
  }
  if (currency === null && symbolAfter !== undefined) currency = SYMBOL_TO_CODE[symbolAfter] ?? null;
  if (codeAfter !== undefined) {
    const code = codeFrom(codeAfter);
    if (code !== null) {
      currency ??= code;
    } else {
      // "per", "an", "fixed": give the word back to the rest of the line.
      end -= match[0].length - match[0].lastIndexOf(codeAfter);
    }
  }
  if (digits === undefined) return null;
  return { amount: amountOf(digits, scale), currency, end };
}

const REVENUE = /\b(rev(?:enue)?(?:\s+share)?|profit\s+share|of\s+(?:the\s+)?revenue|share)\b/i;

function parseRevenueShare(text: string): PayLine | string | null {
  if (!REVENUE.test(text) || !/%|percent/i.test(text)) return null;
  const numbers = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent)?/g)].map((m) => Number(m[1]));
  if (numbers.length === 0) return 'A revenue share needs a percentage: "10% revenue share".';
  const upTo = /^\s*(up\s*to|max(?:imum)?)\b/i.test(text);
  const from = /^\s*(from|at\s+least|min(?:imum)?)\b/i.test(text) || /\+\s*%?/.test(text);
  const [first, second] = numbers;
  if (first === undefined) return 'A revenue share needs a percentage: "10% revenue share".';
  let min: number | null = first;
  let max: number | null = second ?? null;
  if (second === undefined) {
    if (upTo) {
      min = null;
      max = first;
    } else if (!from) {
      max = first;
    }
  }
  if (min !== null && max !== null && max < min) {
    return 'The top of the revenue share is below the bottom of it.';
  }
  if ((min ?? 0) > 100 || (max ?? 0) > 100) return 'A revenue share is at most 100%.';
  return { type: 'revenue_share', min, max, currency: '%', unit: null };
}

const FLAT = /^(?:fixed|flat|total|one[- ]off|lump\s+sum|(?:for|per)\s+(?:the\s+)?(?:whole\s+)?(?:project|job|engagement)|project(?:\s+fee)?)\.?$/i;
const BOUNTY = /^(?:as\s+a\s+)?bounty\.?$/i;
const PERIOD_ONLY = /^(hourly|daily|weekly|monthly|yearly|annually|annual|p\.?a\.?)\.?$/i;
const PER = /^(?:(?:per|an|a|each|every|for\s+each|for\s+every)\s+|\/\s*)(.+?)\.?$/i;

const PERIOD_WORD: Record<string, PayType> = {
  hourly: 'hourly',
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
  yearly: 'yearly',
  annually: 'yearly',
  annual: 'yearly',
  pa: 'yearly',
  'p.a.': 'yearly',
  'p.a': 'yearly',
};

/**
 * One pay line from the way a person wrote it.
 *
 * Returns the line, or a sentence saying what could not be read. A sentence
 * rather than a throw, because the caller is a form or an API handler and
 * the person has to be told which line and what it should look like.
 */
export function parsePayLine(input: unknown): PayLine | string {
  const read = readPayLine(input);
  return typeof read === 'string' ? read : read.line;
}

/**
 * "…, settled in SOL" / "paid in USDC" / "via bank transfer" on the end of a
 * line names the rail, not the unit. It is split off here so the form's
 * one-line-per-price box accepts the sentence people actually write, and the
 * method lands where the rest of the board looks for it.
 */
const SETTLED =
  /[,;]?\s*(?:(?:paid|settled|payable|payment)\s+)?(?:in|via|by|over|through)\s+([A-Za-z][A-Za-z ]{1,30})\.?$/i;

/** The line and, when the text named one, the rail it is settled over. */
export function readPayLine(input: unknown): { line: PayLine; method: string | null } | string {
  const raw = typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';
  if (raw === '') return `An empty pay line. Write one like ${PAY_LINE_EXAMPLES}.`;
  if (raw.length > 200) return 'A pay line is at most 200 characters.';

  let text = raw;
  let method: string | null = null;
  const settled = SETTLED.exec(raw);
  if (settled !== null) {
    const named = normaliseMethod(settled[1]);
    // Only a rail this file recognises is split off. "per hour in London" is
    // a place, and stays part of the line for the person to fix or keep.
    if (named !== null && (isKnownCurrency(named) || isRail(named))) {
      method = named;
      text = raw.slice(0, settled.index).trim();
    }
  }
  const line = parseLine(text);
  return typeof line === 'string' ? line : { line, method };
}

function isRail(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    (PAYMENT_RAILS as readonly string[]).some((rail) => rail.toLowerCase() === lower) ||
    /^(?:bank|wire|ach|sepa|paypal|stripe|payroll|card|invoice|crypto|stablecoin|lightning)\b/.test(lower)
  );
}

function parseLine(text: string): PayLine | string {
  const share = parseRevenueShare(text);
  if (share !== null) return share;

  let cursor = 0;
  let lead: 'from' | 'upto' | null = null;
  const leadMatch = /^(from|at least|min(?:imum)?|up to|upto|max(?:imum)?|starting at)\s+/i.exec(text);
  if (leadMatch !== null) {
    const word = (leadMatch[1] ?? '').toLowerCase();
    lead = word.startsWith('up') || word.startsWith('max') ? 'upto' : 'from';
    cursor = leadMatch[0].length;
  }

  const first = readMoney(text, cursor);
  if (first === null) {
    return `Could not find an amount in "${text}". Write it like ${PAY_LINE_EXAMPLES}.`;
  }
  cursor = first.end;

  let second: Money | null = null;
  const dash = /\s*(?:-|–|—|to)\s*/y;
  dash.lastIndex = cursor;
  const dashMatch = dash.exec(text);
  if (dashMatch !== null) {
    second = readMoney(text, cursor + dashMatch[0].length);
    if (second !== null) cursor = second.end;
  }

  let openEnded = false;
  if (second === null && text.charAt(cursor) === '+') {
    openEnded = true;
    cursor += 1;
  }

  const currency = (first.currency ?? second?.currency ?? 'USD').toUpperCase();
  if (second !== null && second.currency !== null && second.currency !== currency) {
    return `"${text}" mixes two currencies. A range is written in one.`;
  }

  let min: number | null = first.amount;
  let max: number | null = second?.amount ?? null;
  if (second === null) {
    if (lead === 'upto') {
      min = null;
      max = first.amount;
    } else if (lead !== 'from' && !openEnded) {
      max = first.amount;
    }
  }
  if (min !== null && max !== null && max < min) {
    return `The top of "${text}" is below the bottom of it.`;
  }

  const rest = text.slice(cursor).trim().replace(/^[,;:]\s*/, '');
  if (rest === '') {
    return `"${text}" says how much but not what for. Add "a year", "an hour", "fixed" or "per task".`;
  }

  const base = { min, max, currency };
  if (FLAT.test(rest)) return { ...base, type: 'fixed', unit: null };
  if (BOUNTY.test(rest)) return { ...base, type: 'bounty', unit: null };

  const periodOnly = PERIOD_ONLY.exec(rest);
  if (periodOnly !== null) {
    const type = PERIOD_WORD[(periodOnly[1] ?? '').toLowerCase()];
    if (type !== undefined) return { ...base, type, unit: null };
  }

  const per = PER.exec(rest);
  if (per !== null) {
    const what = (per[1] ?? '').trim();
    const period = PERIOD_TYPE[what.toLowerCase().replace(/s$/, '')];
    if (period !== undefined) return { ...base, type: period, unit: null };
    if (/^(?:project|job|engagement)$/i.test(what)) return { ...base, type: 'fixed', unit: null };
    if (/^tasks?$/i.test(what)) return { ...base, type: 'per_task', unit: 'task' };
    if (what.length > UNIT_MAX) return `The unit in "${text}" is too long: at most ${UNIT_MAX} characters.`;
    return { ...base, type: 'per_unit', unit: what };
  }

  return `Could not read "${rest}" in "${text}". Write it like ${PAY_LINE_EXAMPLES}.`;
}

// --- formatting ----------------------------------------------------------

/** "$0.25", "$120k", "0.01 SOL", "CAD 1,000", "10%". */
export function formatAmount(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  if (code === '%') return `${trimNumber(amount)}%`;
  const symbol = CODE_TO_SYMBOL[code];
  if (symbol !== undefined) {
    if (amount >= 1000 && amount % 1000 === 0) return `${symbol}${amount / 1000}k`;
    return `${symbol}${trimNumber(amount)}`;
  }
  if (isFiat(code)) {
    if (amount >= 1000 && amount % 1000 === 0) return `${code} ${amount / 1000}k`;
    return `${code} ${trimNumber(amount)}`;
  }
  // A coin amount is a quantity: 0.5 SOL is 0.5 SOL, not 0.50000000 SOL.
  return `${trimNumber(amount)} ${code}`;
}

function trimNumber(amount: number): string {
  if (Number.isInteger(amount)) return amount.toLocaleString('en-US');
  return amount.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function suffixOf(line: PayLine): string {
  switch (line.type) {
    case 'hourly':
      return 'an hour';
    case 'daily':
      return 'a day';
    case 'weekly':
      return 'a week';
    case 'monthly':
      return 'a month';
    case 'yearly':
      return 'a year';
    case 'fixed':
      return 'fixed';
    case 'bounty':
      return 'bounty';
    case 'per_task':
      return `per ${line.unit ?? 'task'}`;
    case 'per_unit':
      return `per ${line.unit ?? 'unit'}`;
    case 'revenue_share':
      return 'revenue share';
  }
}

/**
 * One line, the way it is printed everywhere: the badge on a card, the CLI,
 * the TUI, a federated result. A single endpoint is a bound rather than a
 * fixed figure, and is labelled as one.
 */
export function formatPayLine(line: PayLine): string {
  const suffix = suffixOf(line);
  const { min, max } = line;
  if (min === null && max === null) return suffix;
  const money = (amount: number): string => formatAmount(amount, line.currency);
  if (min === null) return `Up to ${money(max as number)} ${suffix}`;
  if (max === null) return `From ${money(min)} ${suffix}`;
  const range = min === max ? money(min) : `${money(min)} - ${money(max)}`;
  return `${range} ${suffix}`;
}

/** Every line, or "Unpaid", or null when the listing says nothing about pay. */
export function formatPay(pay: Pay): string | null {
  if (pay.unpaid) return 'Unpaid';
  const lines = pay.lines.filter((line) => line.min !== null || line.max !== null);
  if (lines.length === 0) return null;
  return lines.map(formatPayLine).join(', ');
}

/** The first line only, for a badge with one line of room. */
export function formatPayShort(pay: Pay): string | null {
  if (pay.unpaid) return 'Unpaid';
  const first = pay.lines.find((line) => line.min !== null || line.max !== null);
  if (first === undefined) return null;
  const more = pay.lines.length - 1;
  return more > 0 ? `${formatPayLine(first)} +${more}` : formatPayLine(first);
}

/** "Paid in SOL", "Paid by bank transfer". */
export function formatMethod(method: string | null): string | null {
  if (method === null || method.trim() === '') return null;
  const upper = method.toUpperCase();
  const isTicker = method === upper && /^[A-Z]{2,6}$/.test(upper);
  return isTicker ? `Paid in ${upper}` : `Paid by ${method}`;
}

/** Has the employer said what it pays? Unpaid counts: it is a statement. */
export function payStated(pay: Pay): boolean {
  if (pay.unpaid) return true;
  return pay.lines.some((line) => line.min !== null || line.max !== null);
}

// --- the legacy salary shape ---------------------------------------------

export interface SalaryLike {
  min: number | null;
  max: number | null;
  currency: string;
  period: string;
  equity?: string | null;
  unpaid?: boolean;
}

/** A listing from a board that predates pay lines, read into the new shape. */
export function payFromSalary(salary: SalaryLike): Pay {
  const type = PERIOD_TYPE[salary.period] ?? 'yearly';
  const stated = salary.min !== null || salary.max !== null;
  return {
    lines: stated
      ? [{ type, min: salary.min, max: salary.max, currency: salary.currency.toUpperCase(), unit: null }]
      : [],
    method: null,
    equity: salary.equity ?? null,
    unpaid: salary.unpaid === true,
  };
}

/**
 * The time-based line a listing's `salary` columns carry, for search, sort
 * and structured data - all of which compare on an annual basis and have no
 * meaning for a price per task. The first time-based line wins; a listing
 * with none has a null range, so it stays out of every salary filter.
 */
export function salaryFromPay(pay: Pay): {
  min: number | null;
  max: number | null;
  currency: string;
  period: 'hour' | 'day' | 'week' | 'month' | 'year';
} {
  const line = pay.unpaid ? undefined : pay.lines.find((entry) => periodOf(entry.type) !== null);
  if (line === undefined) {
    const first = pay.lines[0];
    return { min: null, max: null, currency: first?.currency ?? 'USD', period: 'year' };
  }
  // The columns are integers. A rate under a unit rounds to nothing, and
  // nothing is more honest than "From $0".
  const whole = (value: number | null): number | null =>
    value === null ? null : Math.round(value) === 0 ? null : Math.round(value);
  return {
    min: whole(line.min),
    max: whole(line.max),
    currency: line.currency,
    period: periodOf(line.type) ?? 'year',
  };
}

// --- from a request ------------------------------------------------------

function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return ['true', 'on', 'yes', '1'].includes(value.trim().toLowerCase());
  return false;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A ticker typed in any case comes out in capitals; a rail stays as typed. */
export function normaliseMethod(value: unknown): string | null {
  const text = cleanText(value, METHOD_MAX);
  if (text === '') return null;
  const upper = text.toUpperCase();
  if ((PAYMENT_COINS as readonly string[]).includes(upper) || CRYPTO.has(upper)) return upper;
  return text;
}

function lineFromObject(value: Record<string, unknown>): PayLine | string {
  if (typeof value['text'] === 'string') return parsePayLine(value['text']);
  const type = value['type'];
  if (!isPayType(type)) {
    return `A pay line needs a type from ${PAY_TYPES.join(', ')}, or a "text" such as "$0.25 per task".`;
  }
  const number = (raw: unknown): number | null => {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,_$]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  // `amount` is a single figure: ugig writes a fixed price as min = max, and
  // an object with only `min` is an open floor, printed "From".
  const amount = number(value['amount']);
  const min = amount ?? number(value['min']);
  const max = amount ?? number(value['max']);
  if (min !== null && max !== null && max < min) return 'The top of a pay range is below the bottom of it.';
  const currency =
    type === 'revenue_share' ? '%' : cleanText(value['currency'], 5).toUpperCase() || 'USD';
  const unit = cleanText(value['unit'], UNIT_MAX) || null;
  return {
    type,
    min,
    max,
    currency,
    unit: type === 'per_task' ? (unit ?? 'task') : type === 'per_unit' ? unit : null,
  };
}

/**
 * Pay, from whatever a form, an API client or a model sent.
 *
 * `pay` may be a string (one line, or several separated by newlines), an
 * array of strings or of line objects, or an object with `lines` and
 * `method`. The old flat fields - salaryMin, salaryMax, salaryCurrency,
 * salaryPeriod, salaryUnpaid, salaryEquity - still work and become one line,
 * so a client written against 0.11 keeps posting listings.
 *
 * Returns the pay, or a sentence saying which line could not be read.
 */
export function normalisePay(input: Record<string, unknown>): Pay | string {
  const raw = input['pay'] ?? input['payLines'];
  const nested = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
  const unpaid =
    truthy(input['salaryUnpaid']) ||
    truthy(input['payUnpaid']) ||
    truthy(input['unpaid']) ||
    (nested !== null && truthy(nested['unpaid']));

  const items: unknown[] = [];
  const source = nested !== null ? nested['lines'] : raw;
  if (typeof source === 'string') {
    items.push(...source.split(/\r?\n|;/).map((line) => line.trim()).filter((line) => line !== ''));
  } else if (Array.isArray(source)) {
    items.push(...source);
  } else if (nested !== null && nested['lines'] === undefined && isPayType(nested['type'])) {
    items.push(nested);
  }

  const lines: PayLine[] = [];
  let saidUnpaid = unpaid;
  let namedMethod: string | null = null;
  for (const item of items) {
    if (typeof item === 'string' && /^unpaid\.?$/i.test(item.trim())) {
      saidUnpaid = true;
      continue;
    }
    if (typeof item === 'object' && item !== null) {
      const line = lineFromObject(item as Record<string, unknown>);
      if (typeof line === 'string') return line;
      lines.push(line);
      continue;
    }
    const read = readPayLine(item);
    if (typeof read === 'string') return read;
    lines.push(read.line);
    if (read.method !== null) namedMethod ??= read.method;
  }

  // The flat fields, when nothing newer was sent.
  if (lines.length === 0 && !saidUnpaid) {
    const money = (value: unknown): number | null => {
      if (value === null || value === undefined || value === '') return null;
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[,_$]/g, ''));
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const min = money(input['salaryMin']);
    const max = money(input['salaryMax']);
    if (min !== null || max !== null) {
      if (min !== null && max !== null && max < min) {
        return 'The top of the salary range is below the bottom of it.';
      }
      const period = typeof input['salaryPeriod'] === 'string' ? input['salaryPeriod'] : 'year';
      lines.push({
        type: PERIOD_TYPE[period] ?? 'yearly',
        min,
        max,
        currency: (cleanText(input['salaryCurrency'], 5) || 'USD').toUpperCase(),
        unit: null,
      });
    }
  }

  if (lines.length > PAY_LINES_MAX) return `At most ${PAY_LINES_MAX} pay lines.`;

  const method =
    normaliseMethod(
      input['payMethod'] ?? input['paymentMethod'] ?? input['paymentCoin'] ?? nested?.['method'],
    ) ?? namedMethod;
  const equity =
    cleanText(input['payEquity'] ?? input['salaryEquity'] ?? input['equity'] ?? nested?.['equity'], EQUITY_MAX) ||
    null;

  // Unpaid wins over any number that came with it. A form can post a stale
  // line beside a ticked box, and "unpaid, $40k a year" is not a listing
  // anybody can act on.
  return {
    lines: saidUnpaid ? [] : lines,
    method,
    equity,
    unpaid: saidUnpaid,
  };
}

/**
 * The pay of any listing, including one from a board that predates `pay`.
 *
 * Federated search puts listings from other instances on this board's pages,
 * and an instance still on 0.11 serves a `salary` and no `pay`. Reading
 * `job.pay` straight would throw on those, so every display path goes
 * through here.
 */
export function payOfJob(job: { pay?: Pay | null; salary?: SalaryLike | null }): Pay {
  if (job.pay !== undefined && job.pay !== null && Array.isArray(job.pay.lines)) return job.pay;
  if (job.salary !== undefined && job.salary !== null) return payFromSalary(job.salary);
  return EMPTY_PAY;
}

/** The lines as the text a person would type, one per line. Round-trips through parsePayLine. */
export function payToText(pay: Pay): string {
  return pay.lines.map(formatPayLine).join('\n');
}
