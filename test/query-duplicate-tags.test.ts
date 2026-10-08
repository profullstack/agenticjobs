import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuery, queryToParams } from '../src/schema/query.ts';

test('a tag repeated across tag and tags, in any case or spacing, is one filter', () => {
  const query = parseQuery(new URLSearchParams('tag=Rust&tag= go &tags=rust, GO ,RUST,typescript'));
  assert.deepEqual(query.tags, ['rust', 'go', 'typescript']);
  assert.equal(queryToParams(query).get('tags'), 'rust,go,typescript');
});

test('a repeated tag does not push the last unique filter past the cap', () => {
  const query = parseQuery(
    new URLSearchParams(
      'tag=Rust&tags=rust,typescript,go,python,java,sql,react,node,docker,solana',
    ),
  );
  assert.deepEqual(query.tags, [
    'rust',
    'typescript',
    'go',
    'python',
    'java',
    'sql',
    'react',
    'node',
    'docker',
    'solana',
  ]);
});

test('more than ten unique tags are still capped at the first ten', () => {
  const tags = Array.from({ length: 12 }, (_, index) => `t${index}`);
  const query = parseQuery(new URLSearchParams({ tags: ['t0', ...tags].join(',') }));
  assert.deepEqual(query.tags, tags.slice(0, 10));
});

test('deduplicated tags round-trip and leave the other filters alone', () => {
  const query = parseQuery(
    new URLSearchParams(
      'q=parser&workplace=remote&tag=API&tags=api,remote&salaryMin=90000&org=acme&sort=salary&limit=10&offset=20',
    ),
  );
  assert.equal(query.q, 'parser');
  assert.equal(query.workplace, 'remote');
  assert.equal(query.salaryMin, 90000);
  assert.equal(query.org, 'acme');
  assert.equal(query.sort, 'salary');
  assert.equal(query.limit, 10);
  assert.equal(query.offset, 20);
  assert.deepEqual(query.tags, ['api', 'remote']);
  assert.deepEqual(parseQuery(queryToParams(query)), query);
});
