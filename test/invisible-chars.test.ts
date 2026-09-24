import assert from 'node:assert/strict';
import test from 'node:test';
import { clean } from '../dist/schema/text.js';

const ch = String.fromCodePoint;

test('C1 controls are flattened like C0', () => {
  // U+009B is CSI: it begins an ANSI sequence on terminals that honour C1,
  // exactly what the ESC at U+001B is stripped for. A stranger's job title
  // reaching `agenticjobs search` output could inject terminal sequences.
  assert.equal(clean('a\u009b[31mred\u0085b', 500), 'a [31mred b');
  // OSC (U+009D) is the other escape initiator - titles, links, colours.
  assert.ok(!clean('x\u009dy', 500).includes('\u009d'));
  // And in the multiline shape a description takes.
  assert.ok(!clean('x\u009dy', 500, { multiline: true }).includes('\u009d'));
});

test('bidirectional marks do not reach a terminal or a page', () => {
  // U+202E reverses what the reader sees: "apply\u202Etsoh" displays with
  // the tail backwards. On a board that prints a stranger's title in the
  // TUI and renders it into pages, that is text lying about what it says.
  const marks = [
    0x202a,
    0x202b,
    0x202c,
    0x202d,
    0x202e, // embeddings, pops, override
    0x2066,
    0x2067,
    0x2068,
    0x2069, // isolates
    0x200e,
    0x200f,
    0x061c, // LRM, RLM, ALM
  ];
  for (const mark of marks.map((code) => ch(code))) {
    assert.ok(!clean(`x${mark}y`, 500).includes(mark), `U+${mark.codePointAt(0)!.toString(16)}`);
  }
});

test('zero-width and tag characters cannot smuggle invisible text', () => {
  // Zero-width characters are invisible in every renderer. The tag
  // characters U+E0000-E007F encode ASCII invisibly - the channel used to
  // hide instructions inside text an agent reads, on a board built for
  // agents to read listings. Neither survives clean().
  for (const mark of [0x200b, 0x2060, 0xfeff, 0xe0001, 0xe0041].map((code) => ch(code))) {
    assert.ok(
      !clean(`read${mark}this`, 500).includes(mark),
      `U+${mark.codePointAt(0)!.toString(16)}`,
    );
  }
  // An invisible character inside a word is dropped, not spaced: a zero
  // width in "word" leaves "word", not "wor d".
  assert.equal(clean(`wor${ch(0x200b)}d`, 500), 'word');
});

test('the joiners real text needs survive', () => {
  // ZWJ and ZWNJ are the two format characters that are how text is
  // correctly written - emoji sequences, Persian and Indic typography -
  // rather than hidden content. Stripping them would break real names.
  assert.equal(clean(`a${ch(0x200d)}b`, 500), `a${ch(0x200d)}b`);
  assert.equal(clean(`a${ch(0x200c)}b`, 500), `a${ch(0x200c)}b`);
  assert.equal(clean('👨‍👩‍👧', 500), '👨‍👩‍👧');
});

test('the length cap cannot split a surrogate pair', () => {
  // slice() counts UTF-16 units, so a cap landing inside an emoji left the
  // high half dangling - a lone surrogate that stores and renders as U+FFFD.
  // toPlainText already drops the dangling half; the cap here does the same.
  assert.equal(clean(`ab${ch(0x1f9e0)}cd`, 3), 'ab');
  // The pair survives whole when it fits.
  assert.equal(clean(`ab${ch(0x1f9e0)}cd`, 4), `ab${ch(0x1f9e0)}`);
  // A lone surrogate already present in the source is dropped, not stored.
  assert.equal(clean(`x${ch(0xd83e)}y`, 500), 'xy');
  assert.equal(clean(`x${ch(0xdc00)}y`, 500), 'xy');
});
