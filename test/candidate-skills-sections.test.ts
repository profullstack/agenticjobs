import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toCandidateSummary } from '../dist/core/candidates.js';
import { parseResume } from '../dist/markup/resume.js';

// A resume that splits its skills across two sections: "Skills" for
// languages and "Technical Skills" for tooling. Both titles normalise to
// the same 'skills' kind, so a reader that takes only the first matching
// section loses the second list entirely.
const markdown = `# Example Candidate

## Skills

- JavaScript
- Python

## Experience

### Dev | Example Co
*2020 - Present*

- Built things.

## Technical Skills

- Docker
- PostgreSQL
`;

function candidate() {
  return toCandidateSummary({
    id: 'r',
    userId: 'u',
    slug: 'example',
    title: 'Example Candidate',
    markdown,
    parsed: parseResume(markdown),
    visibility: 'public',
    publicSlug: 'example',
    sourceName: null,
    createdAt: '',
    updatedAt: '',
  });
}

test('skills from every skills-kind section reach the candidate card', () => {
  const summary = candidate();
  assert.deepEqual(summary.skills, ['JavaScript', 'Python', 'Docker', 'PostgreSQL']);
});

test('a repeated skills heading later in the document is not dropped', () => {
  const repeated = `# Example Candidate

## Skills

- JavaScript

## Skills

- Rust
`;
  const summary = toCandidateSummary({
    id: 'r',
    userId: 'u',
    slug: 'example',
    title: 'Example Candidate',
    markdown: repeated,
    parsed: parseResume(repeated),
    visibility: 'public',
    publicSlug: 'example',
    sourceName: null,
    createdAt: '',
    updatedAt: '',
  });
  assert.deepEqual(summary.skills, ['JavaScript', 'Rust']);
});
