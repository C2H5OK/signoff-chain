// SPDX-FileCopyrightText: 2026 SuplerMed
// SPDX-License-Identifier: MIT
//
// Every guard here is tested with a KNOWN POSITIVE and a KNOWN NEGATIVE. A green run that
// has never been shown to go red proves the tool is blind, not that the file is clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lines, computeChain, compare, chainPath } from '../src/chain.mjs';

const seal = (arr) => computeChain(arr);

test('known negative: an untouched file matches', () => {
  const a = ['h;e;a;d', 'row 1', 'row 2'];
  assert.equal(compare(seal(a), a).state, 'MATCH');
});

test('known positive: editing a sealed row is reported as TAMPERED', () => {
  const a = ['head', 'row 1', 'row 2'];
  const b = ['head', 'row 1 EDITED', 'row 2'];
  const r = compare(seal(a), b);
  assert.equal(r.state, 'TAMPERED');
  assert.equal(r.ok, false);
  assert.equal(r.row, 2, 'points at the first divergent row');
});

test('known positive: removing a sealed row is reported as TRUNCATED', () => {
  const a = ['head', 'row 1', 'row 2', 'row 3'];
  const b = ['head', 'row 1', 'row 3'];
  const r = compare(seal(a), b);
  assert.equal(r.state, 'TRUNCATED');
  assert.equal(r.ok, false);
});

test('appending at the end is normal work, not an alarm', () => {
  const a = ['head', 'row 1'];
  const b = ['head', 'row 1', 'row 2'];
  const r = compare(seal(a), b);
  assert.equal(r.state, 'APPEND_ONLY');
  assert.equal(r.ok, true);
  assert.equal(r.added, 1);
});

test('inserting in the middle is INTERLEAVED, not tampering — history is intact', () => {
  const a = ['head', 'row 1', 'row 2'];
  const b = ['head', 'row 1', 'row 1.5', 'row 2'];
  const r = compare(seal(a), b);
  assert.equal(r.state, 'INTERLEAVED');
  assert.equal(r.ok, true);
  assert.deepEqual(r.inserted, [3]);
});

test('REORDERING sealed rows is tampering — the chain protects order, not just content', () => {
  const a = ['head', 'row 1', 'row 2'];
  const b = ['head', 'row 2', 'row 1'];
  assert.equal(compare(seal(a), b).ok, false);
});

test('a different seed does not validate someone else’s chain', () => {
  const a = ['head', 'row 1'];
  assert.equal(compare(computeChain(a, { seed: 'A' }), a, { seed: 'B' }).ok, false);
});

test('a trailing newline does not count as an extra line', () => {
  assert.deepEqual(lines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(lines('a\nb'), ['a', 'b']);
  assert.deepEqual(lines('a\nb\n\n'), ['a', 'b', '']);
});

test('chainPath replaces the extension and does not touch directories', () => {
  assert.equal(chainPath('data/register.csv'), 'data/register.chain');
  assert.equal(chainPath('/var/lib/my.app/register.csv'), '/var/lib/my.app/register.chain');
});

test('known positive: a chain file whose digest column was doctored is CHAIN_INVALID', () => {
  const a = ['head', 'row 1', 'row 2'];
  const sealed = computeChain(a).map((e, i) => (i === 1 ? { ...e, chain: 'deadbeef' } : e));
  const r = compare(sealed, a);
  assert.equal(r.state, 'CHAIN_INVALID');
  assert.equal(r.ok, false);
});

test('an empty register seals and verifies without throwing', () => {
  assert.equal(compare(computeChain([]), []).state, 'MATCH');
});
