/**
 * Drafting a listing from a brief.
 *
 * The governing rule under test: the model fills in a form and nothing else.
 * Whatever it returns is checked against the same lists the form's own selects
 * are built from, and anything it invents about pay is dropped rather than
 * shown to an employer who might not notice it.
 *
 * No key and no network: the provider call takes its fetch as an argument.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentWriterProblem,
  draftListing,
  fieldsFromModelJson,
  writerProvider,
} from '../dist/core/agentwriter.js';

const CONFIG = {
  boardName: 'Test Board',
  anthropicApiKey: null,
  openaiApiKey: null,
  writerModel: null,
};

const FULL = JSON.stringify({
  title: 'Senior Go Engineer',
  description: 'You will own the payments service.',
  employmentType: 'full-time',
  workplace: 'remote',
  seniority: 'senior',
  location: 'European timezones',
  tags: ['Backend', 'payments'],
  stack: ['Go', 'Postgres'],
  requirements: ['- Has shipped Go in production.', 'Comfortable on call.'],
  responsibilities: ['Own the payments service.'],
});

test('a drafted listing comes back as form values', () => {
  const values = fieldsFromModelJson(FULL);
  assert.equal(values['title'], 'Senior Go Engineer');
  assert.equal(values['employmentType'], 'full-time');
  assert.equal(values['seniority'], 'senior');
  // The form takes these comma separated and lowercased, which is how a person
  // edits them once they are in the box.
  assert.equal(values['tags'], 'backend, payments');
  assert.equal(values['stack'], 'go, postgres');
  // And these one per line, with any bullet the model added stripped.
  assert.equal(values['requirements'], 'Has shipped Go in production.\nComfortable on call.');
});

test('a value the board does not recognise is dropped, never corrected', () => {
  // Bending "Full Time" into "full-time" would be fine; bending "flexible"
  // into the nearest legal value would put a choice on the page that the
  // employer never made and might not notice.
  const values = fieldsFromModelJson(
    JSON.stringify({ title: 'A Role', employmentType: 'flexible', workplace: 'anywhere' }),
  );
  assert.equal(values['employmentType'], undefined);
  assert.equal(values['workplace'], undefined);
  assert.equal(values['title'], 'A Role');
});

test('pay is never invented', () => {
  // The rule that matters most. A candidate who applies because of a number
  // nobody agreed to has been misled by this board.
  const silent = fieldsFromModelJson(JSON.stringify({ title: 'A Role', description: 'Work.' }));
  assert.equal(silent['salaryMin'], undefined);
  assert.equal(silent['salaryMax'], undefined);

  // And a non-number in the field is not a number.
  const vague = fieldsFromModelJson(
    JSON.stringify({ title: 'A Role', salaryMin: 'competitive', salaryMax: null }),
  );
  assert.equal(vague['salaryMin'], undefined);
  assert.equal(vague['salaryMax'], undefined);

  const stated = fieldsFromModelJson(JSON.stringify({ title: 'A Role', salaryMin: 120000 }));
  assert.equal(stated['salaryMin'], '120000');
});

test('unpaid arrives ticked, and never alongside a range', () => {
  const values = fieldsFromModelJson(
    JSON.stringify({ title: 'Intern', salaryUnpaid: true, salaryMin: 40000 }),
  );
  assert.equal(values['salaryUnpaid'], 'on');
  assert.equal(values['salaryMin'], undefined, 'the same rule the rest of the board follows');
});

test('a fenced reply is still a reply', () => {
  // Both providers were asked for a bare object and usually send one. Failing
  // the whole request over a markdown fence would be the wrong place to be
  // strict.
  const values = fieldsFromModelJson('```json\n{"title":"Fenced Role"}\n```');
  assert.equal(values['title'], 'Fenced Role');

  const chatty = fieldsFromModelJson('Sure, here you go:\n{"title":"Chatty Role"}\nHope that helps.');
  assert.equal(chatty['title'], 'Chatty Role');
});

test('a reply with no listing in it is a problem, not empty values', () => {
  assert.throws(() => fieldsFromModelJson('I cannot help with that.'), AgentWriterProblem);
  assert.throws(() => fieldsFromModelJson('{"tags":["backend"]}'), AgentWriterProblem);
});

test('the configured key decides the provider, and neither means off', () => {
  assert.equal(writerProvider(CONFIG), null, 'off is the default');
  assert.equal(writerProvider({ ...CONFIG, openaiApiKey: 'sk-x' }), 'openai');
  assert.equal(writerProvider({ ...CONFIG, anthropicApiKey: 'sk-y' }), 'anthropic');
  assert.equal(
    writerProvider({ ...CONFIG, anthropicApiKey: 'sk-y', openaiApiKey: 'sk-x' }),
    'anthropic',
    'a board with both has to pick one, and it has to pick the same one every time',
  );
});

test('the Anthropic request is the shape that API takes', async () => {
  let sent = { url: '', headers: {}, body: {} };
  const fake = async (url, init) => {
    sent = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ content: [{ type: 'text', text: FULL }] }), {
      status: 200,
    });
  };

  const values = await draftListing(
    'Senior Go engineer, remote, payments.',
    { boardName: 'Test Board', orgName: 'Acme' },
    { ...CONFIG, anthropicApiKey: 'sk-test' },
    fake,
  );

  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.headers['x-api-key'], 'sk-test');
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');
  assert.equal(sent.body['model'], 'claude-opus-5');
  assert.ok(String(sent.body['messages'][0].content).includes('Acme'));
  assert.equal(values['title'], 'Senior Go Engineer');
});

test('the OpenAI request uses max_completion_tokens, which is what it takes now', async () => {
  let body = {};
  const fake = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: FULL } }] }), {
      status: 200,
    });
  };

  await draftListing(
    'Senior Go engineer, remote, payments.',
    { boardName: 'Test Board', orgName: null },
    { ...CONFIG, openaiApiKey: 'sk-test' },
    fake,
  );

  assert.equal(body['model'], 'gpt-5.2');
  assert.equal(body['max_completion_tokens'], 4000, 'max_tokens is rejected by these models');
  assert.equal(body['response_format'].type, 'json_object');
});

test('a refusal is a 200, so the status is not evidence of an answer', async () => {
  const refused = async () =>
    new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 });

  await assert.rejects(
    draftListing('Something the model will not write.', { boardName: 'B', orgName: null },
      { ...CONFIG, anthropicApiKey: 'sk-test' }, refused),
    AgentWriterProblem,
  );
});

test("the provider's own error text never reaches the page", async () => {
  // It is written for whoever holds the key, not for the employer typing a
  // brief, and it can carry account details that do not belong on a public
  // page.
  const rejected = async () =>
    new Response(JSON.stringify({ error: { message: 'Your account org-secret-1234 is over quota' } }), {
      status: 401,
    });

  await assert.rejects(
    draftListing('A real brief about a real job.', { boardName: 'B', orgName: null },
      { ...CONFIG, openaiApiKey: 'sk-test' }, rejected),
    (error) => {
      assert.ok(error instanceof AgentWriterProblem);
      assert.ok(!error.message.includes('org-secret-1234'), error.message);
      assert.match(error.message, /key was rejected/);
      return true;
    },
  );
});

test('a brief too short to work with never reaches the model', async () => {
  let called = false;
  const fake = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };
  await assert.rejects(
    draftListing('hi', { boardName: 'B', orgName: null },
      { ...CONFIG, openaiApiKey: 'sk-test' }, fake),
    AgentWriterProblem,
  );
  assert.equal(called, false, 'and costs the board nothing');
});
