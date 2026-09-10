import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allTags, toCandidateSummary, withTags } from '../dist/core/candidates.js';
import { parseResume } from '../dist/markup/resume.js';
import { CandidateList } from '../dist/views/candidates.js';

const SKILLS = ['JavaScript', 'TypeScript', 'Python', 'Go', 'SQL', 'Docker', 'Linux', 'React', 'Rust'];
const markdown = `# Example Candidate\n\n## Skills\n\n${[...SKILLS, 'rust'].map((skill) => `- ${skill}`).join('\n')}\n`;

function candidate() {
  return toCandidateSummary({
    id: 'r', userId: 'u', slug: 'example', title: 'Example Candidate', markdown,
    parsed: parseResume(markdown), visibility: 'public', publicSlug: 'example',
    sourceName: null, createdAt: '', updatedAt: '',
  });
}

test('all distinct resume skills remain available to filters and the skill index', () => {
  const summary = candidate();
  assert.deepEqual(summary.skills, SKILLS);
  assert.deepEqual(withTags([summary], ['javascript', 'rust']), [summary]);
  assert.deepEqual(withTags([summary], ['rust', 'missing']), []);
  assert.deepEqual(allTags([summary]).find((entry) => entry.tag === 'Rust'), {
    tag: 'Rust', count: 1,
  });
});

test('directory cards show eight badges while the skill index includes the rest', () => {
  const summary = { ...candidate(), skills: SKILLS };
  const html = String(CandidateList({
    candidates: [summary], publicUrl: 'https://example.test', index: allTags([summary]),
  }));
  const [cards, index] = html.split('<h2 class="card-title">Every skill listed here</h2>');
  assert.ok(cards);
  assert.ok(index);
  assert.equal((cards.match(/class="badge badge-outline"/g) ?? []).length, 8);
  assert.ok(!cards.includes('>Rust</a>'));
  assert.match(index, /href="\/candidates\?tags=Rust">Rust 1<\/a>/);
});
