/**
 * Swarm capacity: the number an employer shops on.
 *
 * The case that matters most is the per-agent marker. "$1,000/hour" and
 * "$100/hour/agent" from the same ten-agent candidate describe the same money,
 * and reading either one as the other is wrong by a factor of ten — in the
 * direction that quotes an employer a price nobody charges.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCapacity, parseAgentCount, parseCapacity, parseRate } from '../dist/core/capacity.js';
import { capacityAlertMessage } from '../dist/core/capacity-alert.js';
import { parseResume } from '../dist/markup/resume.js';

const contact = (pairs: [string, string][]) =>
  pairs.map(([key, value]) => ({ key, value, href: null }));

test('a swarm priced per agent multiplies up to the total', () => {
  const capacity = parseCapacity(
    contact([
      ['Agents', '10'],
      ['Rate', '$100/hour/agent'],
    ]),
  );
  assert.equal(capacity?.agents, 10);
  assert.equal(capacity?.ratePerAgent, 100);
  assert.equal(capacity?.totalPerHour, 1000);
  assert.equal(capacity?.ratePerAgentStated, true);
});

test('a swarm priced as a whole divides down to the per-agent rate', () => {
  const capacity = parseCapacity(
    contact([
      ['Agents', '10'],
      ['Rate', '$1,000/hour'],
    ]),
  );
  assert.equal(capacity?.totalPerHour, 1000);
  assert.equal(capacity?.ratePerAgent, 100);
  // The distinction the caller needs: this rate was derived, not quoted.
  assert.equal(capacity?.ratePerAgentStated, false);
});

test('an unmarked rate is never read as per-agent', () => {
  // The expensive mistake: reading "$1,000/hour" as per-agent would report a
  // $10,000/hour swarm.
  const capacity = parseCapacity(
    contact([
      ['Agents', '10'],
      ['Rate', '$1000 per hour'],
    ]),
  );
  assert.equal(capacity?.totalPerHour, 1000);
});

test('the ways people write "one agent" all mean one', () => {
  for (const value of ['1', 'single', 'Solo', 'one', 'just me']) {
    assert.equal(parseAgentCount(value), 1, value);
  }
});

test('a rate with no agent count is not capacity', () => {
  // A price whose unit is unknown is a guess an employer would budget against.
  assert.equal(parseCapacity(contact([['Rate', '$100/hour']])), null);
});

test('an agent count with no rate is still capacity', () => {
  const capacity = parseCapacity(contact([['Agents', '4']]));
  assert.equal(capacity?.agents, 4);
  assert.equal(capacity?.totalPerHour, null);
  assert.match(formatCapacity(capacity!), /rate on request/);
});

test('aliases are accepted for both keys', () => {
  const capacity = parseCapacity(
    contact([
      ['Sub-agents', '3'],
      ['Pricing', '$50/hr each'],
    ]),
  );
  assert.equal(capacity?.agents, 3);
  assert.equal(capacity?.totalPerHour, 150);
});

test('a nonsense agent count is unstated rather than listed', () => {
  // A four-digit "swarm" is a price that landed in the wrong field.
  assert.equal(parseAgentCount('5000'), null);
  assert.equal(parseAgentCount('0'), null);
  assert.equal(parseAgentCount(''), null);
});

test('currency is reported, not assumed to be dollars', () => {
  const capacity = parseCapacity(
    contact([
      ['Agents', '2'],
      ['Rate', '€80/hour/agent'],
    ]),
  );
  assert.equal(capacity?.currency, 'EUR');
  assert.match(formatCapacity(capacity!), /EUR/);
});

test('a single agent is formatted without a redundant total', () => {
  const capacity = parseCapacity(
    contact([
      ['Agents', '1'],
      ['Rate', '$100/hour'],
    ]),
  );
  assert.equal(formatCapacity(capacity!), '1 agent · $100/hr');
});

test('a swarm shows both the each and the total', () => {
  const capacity = parseCapacity(
    contact([
      ['Agents', '10'],
      ['Rate', '$100/hour/agent'],
    ]),
  );
  assert.equal(formatCapacity(capacity!), '10 agents · $100/hr each · $1,000/hr total');
});

test('an unparseable rate does not throw away the agent count', () => {
  const capacity = parseCapacity(
    contact([
      ['Agents', '6'],
      ['Rate', 'negotiable'],
    ]),
  );
  assert.equal(capacity?.agents, 6);
  assert.equal(capacity?.totalPerHour, null);
});

test('parseRate finds the per-agent marker in the shapes people write', () => {
  for (const value of ['$100/hour/agent', '$100 per agent per hour', '$100/hr each']) {
    assert.equal(parseRate(value)?.perAgent, true, value);
  }
  assert.equal(parseRate('$100/hour')?.perAgent, false);
});

/**
 * The headline leak.
 *
 * This was live: a resume opening `**Operated by:** X (someone@example.com)`
 * put the literal `**` and a real address into the public candidate directory,
 * which is explicit elsewhere that the contact block stays out of the summary.
 */
test('a headline is stripped of markup, not just trimmed at the ends', () => {
  const resume = parseResume('# Athena\n\n**Security agent** for hire\n');
  assert.equal(resume.headline, 'Security agent for hire');
});

test('a headline containing an email address is dropped', () => {
  const resume = parseResume('# Athena\n\n**Operated by:** DevilX (someone@example.com)\n');
  assert.equal(resume.headline, null);
});

test('the ask shows both the swarm and the single-agent shape', () => {
  const message = capacityAlertMessage({
    to: 'a@b.test',
    name: 'Athena',
    boardName: 'Agentic Jobs',
    profileUrl: 'https://board.test/candidates/athena',
    editUrl: 'https://board.test/me/resumes/athena',
    specUrl: 'https://board.test/docs/openresume#capacity',
  });
  assert.match(message.subject, /capacity/i);
  // A person who has to read a spec to answer a one-question email does not.
  assert.match(message.text, /\*\*Agents\*\*: 10/);
  assert.match(message.text, /\*\*Agents\*\*: 1\n/);
  assert.match(message.text, /stays listed/);
  assert.match(message.html, /board\.test\/me\/resumes\/athena/);
});

/**
 * The address that was actually escaping.
 *
 * Redaction only withheld preamble *bullets* that parsed as contact fields, so
 * an address written as prose under the name went out to every signed-out
 * reader — and to the four download formats, which all render this same
 * Markdown.
 */
test('an email in preamble prose is withheld, not just one in a bullet', async () => {
  const { redactContactChannels, CONTACT_WITHHELD } = await import('../dist/markup/resume.js');
  const source = '# Athena\n\n**Operated by:** DevilX (bb8654838@example.com)\n';
  const { markdown, redacted } = redactContactChannels(source);

  assert.equal(redacted, true);
  assert.ok(!markdown.includes('bb8654838@example.com'), 'the address must not survive');
  assert.match(markdown, new RegExp(CONTACT_WITHHELD));
  // The sentence around it is the candidate's own description and still reads.
  assert.match(markdown, /Operated by/);
});

test('a signed-in copy keeps the address', async () => {
  const { resumeForViewer } = await import('../dist/core/candidates.js');
  const markdown = '# Athena\n\n**Operated by:** DevilX (bb8654838@example.com)\n';
  const view = resumeForViewer({ markdown, parsed: null }, true);
  assert.equal(view.redacted, false);
  assert.match(view.markdown, /bb8654838@example\.com/);
});
