// SPDX-FileCopyrightText: 2026 SuplerMed
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, escapeField, formatLine } from '../src/csv.mjs';

test('known negative: a plain row splits on the delimiter', () => {
  assert.deepEqual(parseLine('a;b;c'), ['a', 'b', 'c']);
});

test('known positive: a quoted delimiter does not split the field', () => {
  assert.deepEqual(parseLine('a;"b; still b";c'), ['a', 'b; still b', 'c']);
  assert.equal(parseLine('a;"b; still b";c').length, 3, 'naive split would report 4');
});

test('a doubled quote inside a quoted field is one literal quote', () => {
  assert.deepEqual(parseLine('a;"say ""hi""";c'), ['a', 'say "hi"', 'c']);
});

test('an empty trailing field is preserved', () => {
  assert.deepEqual(parseLine('a;b;'), ['a', 'b', '']);
});

test('escape/parse is a round trip for the values that break registers', () => {
  const fields = ['2026-09-06', 'magnesium; tetracyclines', 'he said "no"', '', 'plain'];
  assert.deepEqual(parseLine(formatLine(fields)), fields);
});

test('values without a delimiter are not quoted needlessly', () => {
  assert.equal(escapeField('plain value'), 'plain value');
  assert.equal(escapeField('a;b'), '"a;b"');
});

test('a custom delimiter works', () => {
  assert.deepEqual(parseLine('a,b,"c,d"', { delimiter: ',' }), ['a', 'b', 'c,d']);
});
