import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateApplication } from '../dist/core/applications.js';

const schema = {
  fields: [
    { name: 'name', label: 'Name', type: 'text' as const, required: true, maxLength: 120 },
  ],
};

test('a disclose policy requires the agent field instead of accepting omission', () => {
  const missing = validateApplication(schema, { name: 'Ada' }, 'disclose');
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.deepEqual(missing.problems, [
    {
      field: 'agent',
      message: 'This employer asks applications written with an agent to say so.',
    },
  ]);

  const valid = validateApplication(
    schema,
    { name: 'Ada', agent: { name: 'test-agent', supervised: true } },
    'disclose',
  );
  assert.equal(valid.ok, true);
});
