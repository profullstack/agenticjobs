import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResume } from '../src/markup/resume.ts';

function entry(range: string) {
  return parseResume(`# A\n\n## Experience\n\n### B\nEngineer (${range})\n`).sections[0]?.entries[0];
}

for (const dash of ['–', '—']) {
  for (const spaces of ['', ' ', '\u00a0']) {
    test(`resume range accepts ${JSON.stringify(spaces + dash + spaces)}`, () => {
      const parsed = entry(`2019${spaces}${dash}${spaces}2021`);
      assert.equal(parsed?.start, '2019');
      assert.equal(parsed?.end, '2021');
      assert.equal(parsed?.current, false);
    });
  }
  test(`unspaced ${dash} preserves dates and identifies a current role`, () => {
    const parsed = entry(`Mar 2020${dash}Present`);
    assert.equal(parsed?.start, 'Mar 2020');
    assert.equal(parsed?.end, 'Present');
    assert.equal(parsed?.current, true);
  });
}

test('ISO date hyphens stay within endpoints', () => {
  for (const range of ['2020-03-01 - 2024-06-30', '2020-03-01–2024-06-30']) {
    const parsed = entry(range);
    assert.equal(parsed?.start, '2020-03-01');
    assert.equal(parsed?.end, '2024-06-30');
  }
});

test('existing word separator and single dates remain unchanged', () => {
  assert.equal(entry('2019 to 2021')?.end, '2021');
  assert.equal(entry('2020-03-01')?.start, '2020-03-01');
  assert.equal(entry('2020-03-01')?.end, null);
});
