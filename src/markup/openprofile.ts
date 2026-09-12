/**
 * OpenProfile.md, derived from a resume.
 *
 * A resume says what somebody has done; a profile says who and where they
 * are. This board keeps only the resume, so the profile is computed from it
 * on every request and never stored: the name, the identity block, the
 * headline, every link the contact block and a Links section carry, and the
 * skills as topics. Nothing here is typed in a second time.
 *
 * It is a rendering of the redacted or whole resume it is handed, so the
 * same gate that keeps an address off the page for an anonymous reader keeps
 * it out of this file. Pass the resume as the viewer is allowed to see it.
 *
 *   # Name                        <- the resume's h1
 *   - **Kind**: agent             <- from a Kind key, or Agents capacity
 *   - **Web**: https://...        <- the contact block, minus the links
 *   - **Resume**: .../resume.md   <- this board's copy
 *   Headline                      <- the resume's headline
 *   ## Accounts                   <- every http(s) link the resume carries
 *   ## Topics                     <- the skills
 *   ## Operator                   <- an "Operated by" key, for an agent
 *
 * The convention is docs/openprofile.md.
 */

import type { OpenResume, ResumeContact } from './resume.ts';

export interface ProfileSource {
  /** The name shown in the directory, already cleaned. */
  name: string;
  /** The resume as the viewer may see it: redacted for an anonymous reader. */
  parsed: OpenResume | null;
  /** Skills, already extracted the way the directory extracts them. */
  topics: string[];
  /** Where this board serves the resume file. */
  resumeUrl: string;
}

/** Identity keys that carry over as written, in the order they are shown. */
const IDENTITY_KEYS =
  /^(kind|type|handle|web|website|site|homepage|email|e-mail|location|based|city|pronouns|timezone|time zone|languages?|avatar|photo|pay|wallet|phone|tel|mobile)$/i;

/** Keys whose value names the person answerable for an agent. */
const OPERATOR_KEYS = /^(operator|operated by|run by|owner|maintained by)$/i;

/** Keys that mean "how many of me there are". */
const AGENTS_KEYS = /^(agents|sub-agents|subagents|swarm|parallelism|capacity)$/i;

const KIND_KEYS = /^(kind|type)$/i;

/** A website key, whichever spelling the resume used. */
const WEB_KEYS = /^(web|website|site|homepage)$/i;

function isHttp(href: string | null): boolean {
  return href !== null && /^https?:\/\//i.test(href);
}

/**
 * `agent`, `person` or `organization` from what the resume says about itself,
 * or nothing. Nothing is a real answer: the spec says a reader reports an
 * unstated kind rather than guessing one, so this file does not guess either.
 */
function kindOf(contact: ResumeContact[]): string | null {
  const stated = contact.find((item) => KIND_KEYS.test(item.key));
  if (stated !== undefined) {
    const value = stated.value.trim().toLowerCase();
    if (/^(agent|bot)$/.test(value)) return 'agent';
    if (/^(person|human|individual)$/.test(value)) return 'person';
    if (/^(org|organization|organisation|company|team)$/.test(value)) return 'organization';
    return null;
  }
  // A resume that says how many of it run in parallel is an agent's resume.
  // Only a stated count counts; the capacity convention is explicit that an
  // unstated one is not "one".
  const agents = contact.find((item) => AGENTS_KEYS.test(item.key));
  if (agents !== undefined && /^\s*\d+/.test(agents.value)) return 'agent';
  return null;
}

/** The contact block as identity lines, without the links that become Accounts. */
function identityLines(contact: ResumeContact[], resumeUrl: string): string[] {
  const lines: string[] = [];
  const kind = kindOf(contact);
  if (kind !== null) lines.push(`- **Kind**: ${kind}`);

  for (const item of contact) {
    if (KIND_KEYS.test(item.key) || OPERATOR_KEYS.test(item.key)) continue;
    // A bare [GitHub](url) bullet is an account, not an identity pair.
    if (item.key === item.value && isHttp(item.href)) continue;
    if (item.key === 'note') continue;
    if (!IDENTITY_KEYS.test(item.key) && !AGENTS_KEYS.test(item.key) && !/^rate$/i.test(item.key)) {
      // Unknown keys are kept as written; that is rule two of the convention.
      lines.push(`- **${item.key}**: ${item.value}`);
      continue;
    }
    const key = WEB_KEYS.test(item.key) ? 'Web' : item.key;
    const value =
      WEB_KEYS.test(item.key) && isHttp(item.href) ? (item.href ?? item.value) : item.value;
    lines.push(`- **${key}**: ${value}`);
  }

  lines.push(`- **Resume**: ${resumeUrl}`);
  return lines;
}

/** Every http(s) link the resume carries, as `- [label](url)`, deduplicated. */
function accountLines(parsed: OpenResume): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const add = (label: string, href: string): void => {
    const key = href.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(`- [${label.replace(/[[\]]/g, '')}](${href})`);
  };

  for (const item of parsed.contact) {
    if (item.href === null || !isHttp(item.href)) continue;
    // The home page is identity, not an account; it already sits under Web.
    if (WEB_KEYS.test(item.key)) continue;
    add(item.key, item.href);
  }

  const links = parsed.sections.find((section) => section.kind === 'links');
  if (links !== undefined) {
    for (const line of links.markdown.split('\n')) {
      const bullet = line.replace(/^\s*[-*]\s+/, '').trim();
      const md = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/i.exec(bullet);
      if (md !== null) {
        add((md[1] ?? '').trim(), md[2] ?? '');
        continue;
      }
      const bare = /^(https?:\/\/\S+)/i.exec(bullet);
      if (bare !== null) {
        const href = bare[1] ?? '';
        let label = href;
        try {
          label = new URL(href).hostname.replace(/^www\./, '');
        } catch {
          // Keep the URL as its own label.
        }
        add(label, href);
      }
    }
  }
  return lines;
}

/** The Operator section for an agent, from an "Operated by" style key. */
function operatorLines(contact: ResumeContact[]): string[] {
  const item = contact.find((entry) => OPERATOR_KEYS.test(entry.key));
  if (item === undefined) return [];
  if (item.href !== null && isHttp(item.href))
    return [`- **Name**: ${item.value}`, `- **Profile**: ${item.href}`];
  const withEmail = /^(.*?)\s*[(<]?\s*([^\s@()<>]+@[^\s@()<>]+\.[^\s@()<>]+)\s*[)>]?\s*$/.exec(
    item.value,
  );
  if (withEmail !== null && (withEmail[1] ?? '').trim() !== '') {
    return [`- **Name**: ${(withEmail[1] ?? '').trim()}`, `- **Email**: ${withEmail[2] ?? ''}`];
  }
  if (item.href !== null && item.href.startsWith('mailto:')) {
    return [`- **Email**: ${item.value}`];
  }
  return [`- **Name**: ${item.value}`];
}

/**
 * The profile as Markdown. The Markdown is the document; there is no other
 * representation of it on this board.
 */
export function openProfileFromResume(source: ProfileSource): string {
  const contact = source.parsed?.contact ?? [];
  const blocks: string[] = [`# ${source.name}`];

  blocks.push(identityLines(contact, source.resumeUrl).join('\n'));

  const headline = source.parsed?.headline?.replace(/\*\*|__/g, '').trim();
  if (headline !== undefined && headline !== '' && !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(headline)) {
    blocks.push(headline);
  }

  const accounts = source.parsed === null ? [] : accountLines(source.parsed);
  if (accounts.length > 0) blocks.push(['## Accounts', '', ...accounts].join('\n'));

  const topics = source.topics.map((topic) => topic.trim()).filter((topic) => topic !== '');
  if (topics.length > 0) blocks.push(['## Topics', '', `- ${topics.join(', ')}`].join('\n'));

  const operator = operatorLines(contact);
  if (operator.length > 0) blocks.push(['## Operator', '', ...operator].join('\n'));

  return `${blocks.join('\n\n')}\n`;
}
