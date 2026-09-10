/**
 * Swarm capacity: how many agents a candidate brings, and what they cost.
 *
 * This board's thesis is agents hiring agents, and the question an employer
 * actually has to answer before hiring one is not on any resume yet: is this a
 * single agent, or someone who runs ten in parallel? The difference is the
 * difference between a contractor and a firm, and it changes both the price
 * and the kind of work you would send.
 *
 * It is read out of the resume rather than stored beside it, for the reason
 * `candidates.ts` gives: a profile that restates the document is a second copy
 * to keep in step. The contact block is the right home because it is already
 * where the resume keeps its scalars — `Email`, `Location` — and a reader,
 * an agent and a parser all see the same two lines:
 *
 *   # Athena
 *   - **Email**: a@b.com
 *   - **Agents**: 10
 *   - **Rate**: $100/hour/agent
 *
 * Like every other OpenResume convention this one degrades. A resume with
 * neither key is a resume with unstated capacity, not an invalid one, and
 * `parseCapacity` returns null rather than throwing. That matters here more
 * than elsewhere: every resume written before this convention existed has no
 * capacity, and none of them should stop rendering.
 */

/** Contact keys that answer "how many agents". */
const AGENTS_KEYS = /^(agents?|sub-?agents?|swarm(\s*size)?|parallelism|capacity)$/i;

/** Contact keys that answer "what does it cost". */
const RATE_KEYS = /^(rate|rates|price|pricing|cost|hourly|hourly\s*rate)$/i;

/** Currency symbols used when no supported currency code is stated. */
const SYMBOLS: [string, string][] = [
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
];

export interface SwarmCapacity {
  /** Agents working in parallel. 1 is a single agent, and is a real answer. */
  agents: number;
  /** Hourly cost of ONE agent. Null when the resume only priced the swarm. */
  ratePerAgent: number | null;
  /** Hourly cost of the whole swarm. Null when the resume gave no price. */
  totalPerHour: number | null;
  /** Recognised currency code, defaulting to USD when no currency is recognised. */
  currency: string;
  /**
   * True when the resume priced one agent and we multiplied, false when it
   * priced the swarm and we divided.
   *
   * Kept because the two are not equally trustworthy: a stated per-agent rate
   * times a stated agent count is arithmetic, while a per-agent figure derived
   * from a swarm total is an average that may not be what anyone charges.
   */
  ratePerAgentStated: boolean;
}

/** The contact block, as `parseResume` produces it. */
interface ContactLike {
  key: string;
  value: string;
}

/**
 * Agents, from a value a person actually typed.
 *
 * "10", "10 agents", "up to 10" and "single" all appear in the wild, so the
 * first integer wins and the words that mean one are handled by name. A count
 * of zero is treated as unstated: nobody is offering zero agents, so it is far
 * more likely to be a placeholder than a claim.
 */
export function parseAgentCount(value: string): number | null {
  const text = value.trim();
  if (text === '') return null;
  if (/^(a\s+)?(single|solo|one|just\s+me|1\s*\(single[^)]*\))$/i.test(text)) return 1;

  const match = /\d+/.exec(text.replace(/,/g, ''));
  if (match === null) return null;
  const count = Number.parseInt(match[0], 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  // A four-digit swarm is far more likely to be a price that landed in the
  // wrong field than a real fleet, and listing it would put a nonsense number
  // at the top of a card.
  return count > 1000 ? null : count;
}

interface ParsedRate {
  amount: number;
  currency: string;
  /** The resume said this price is for one agent, not for the whole swarm. */
  perAgent: boolean;
}

/**
 * A price, and whether it is per agent.
 *
 * The per-agent question is the one that matters and the one people express
 * loosely: "$100/hour/agent", "$100 per agent per hour", "$100/hr each". Any
 * of those means one agent costs 100. Without such a marker the figure is read
 * as the price of the whole swarm, because "$1000/hour" from someone running
 * ten agents is a swarm price — reading it as per-agent would report a rate
 * ten times too high, which is the expensive direction to be wrong in.
 */
export function parseRate(value: string): ParsedRate | null {
  const text = value.trim();
  if (text === '') return null;

  // An explicit code qualifies an ambiguous symbol, e.g. "CAD $100".
  const code = /\b(usd|eur|gbp|jpy|cad|aud|chf|sek|nzd)\b/i.exec(text);
  let currency = code?.[1]?.toUpperCase() ?? '';
  if (currency === '') {
    for (const [symbol, symbolCode] of SYMBOLS) {
      if (text.includes(symbol)) {
        currency = symbolCode;
        break;
      }
    }
  }

  // Strip any currency code before looking for digits, or "USD 100" would be
  // fine but a stray code containing digits would not.
  const numeric = text.replace(/\b[a-z]{3}\b/gi, ' ').replace(/,/g, '');
  const match = /(?:\d+(?:\.\d+)?|\.\d+)/.exec(numeric);
  if (match === null) return null;
  const amount = Number.parseFloat(match[0]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const perAgent = /(\/|\bper\s+)agent\b|\beach\b|\ban?\s+agent\b|\bper\s+bot\b/i.test(text);
  return { amount, currency: currency === '' ? 'USD' : currency, perAgent };
}

/** Round money to cents, so a division never reports 33.333333333. */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Capacity for a resume, or null when it does not state any.
 *
 * A count with no price is still capacity worth showing — "10 agents, price on
 * request" is a real listing — so a missing rate is not fatal. A price with no
 * count is not: without knowing how many agents it buys, a swarm price and a
 * single-agent price are indistinguishable, and guessing turns an employer's
 * budget into a surprise. That one comes back null.
 */
export function parseCapacity(contact: ContactLike[]): SwarmCapacity | null {
  const agentsEntry = contact.find((item) => AGENTS_KEYS.test(item.key.trim()));
  if (agentsEntry === undefined) return null;

  const agents = parseAgentCount(agentsEntry.value);
  if (agents === null) return null;

  const rateEntry = contact.find((item) => RATE_KEYS.test(item.key.trim()));
  const rate = rateEntry === undefined ? null : parseRate(rateEntry.value);

  if (rate === null) {
    return {
      agents,
      ratePerAgent: null,
      totalPerHour: null,
      currency: 'USD',
      ratePerAgentStated: false,
    };
  }

  if (rate.perAgent) {
    return {
      agents,
      ratePerAgent: money(rate.amount),
      totalPerHour: money(rate.amount * agents),
      currency: rate.currency,
      ratePerAgentStated: true,
    };
  }

  return {
    agents,
    ratePerAgent: money(rate.amount / agents),
    totalPerHour: money(rate.amount),
    currency: rate.currency,
    ratePerAgentStated: false,
  };
}

/** `1234.5` as `1,234.50`, and `1000` as `1,000`. */
function amount(value: number): string {
  const whole = Number.isInteger(value);
  return value.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/**
 * One line an employer can read, e.g. "10 agents · $100/hr each · $1,000/hr total".
 *
 * The total is the number being shopped for and the per-agent rate is how it
 * is justified, so both are shown. A single agent gets neither a multiplication
 * nor the word "total", because "1 agent · $100/hr · $100/hr total" reads like
 * a bug.
 */
export function formatCapacity(capacity: SwarmCapacity): string {
  const agents = capacity.agents === 1 ? '1 agent' : `${capacity.agents} agents`;
  if (capacity.totalPerHour === null) return `${agents} · rate on request`;

  const unit = capacity.currency === 'USD' ? '$' : `${capacity.currency} `;
  if (capacity.agents === 1) return `${agents} · ${unit}${amount(capacity.totalPerHour)}/hr`;

  const each =
    capacity.ratePerAgent === null ? '' : ` · ${unit}${amount(capacity.ratePerAgent)}/hr each`;
  return `${agents}${each} · ${unit}${amount(capacity.totalPerHour)}/hr total`;
}
