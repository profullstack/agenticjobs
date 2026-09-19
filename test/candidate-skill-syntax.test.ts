import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allTags, toCandidateSummary, withTags } from '../dist/core/candidates.js';
import { parseResume } from '../dist/markup/resume.js';

function candidate(skills: string) {
  const markdown = `# Example Candidate\n\n## Skills\n\n${skills}\n`;
  return toCandidateSummary({
    id: 'r', userId: 'u', slug: 'example', title: 'Example Candidate', markdown,
    parsed: parseResume(markdown), visibility: 'public', publicSlug: 'example',
    sourceName: null, createdAt: '', updatedAt: '',
  });
}

for (const label of ['Languages:', '**Languages:**', '**Languages**:']) {
  test(`skill filters accept a category written as ${label}`, () => {
    const summary = candidate(`- ${label} TypeScript, Rust`);
    assert.deepEqual(summary.skills, ['TypeScript', 'Rust']);
    assert.deepEqual(withTags([summary], ['typescript', 'rust']), [summary]);
  });
}

test('plus bullets produce the same skills and tag counts as other list markers', () => {
  const summary = candidate('+ TypeScript\n* Rust\n- typescript\n+ **Tools**: Docker, Git');
  assert.deepEqual(summary.skills, ['TypeScript', 'Rust', 'Docker', 'Git']);
  assert.deepEqual(withTags([summary], ['typescript', 'docker']), [summary]);
  assert.deepEqual(allTags([summary]).find((entry) => entry.tag === 'TypeScript'), {
    tag: 'TypeScript', count: 1,
  });
});

test('removing a list marker preserves plus and hash characters in skill names', () => {
  const summary = candidate('+ C++\n- C#\n* F#\n+ C++');
  assert.deepEqual(summary.skills, ['C++', 'C#', 'F#']);
  assert.deepEqual(withTags([summary], ['c++', 'c#']), [summary]);
});
