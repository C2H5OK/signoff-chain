// SPDX-FileCopyrightText: 2026 SuplerMed
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegister } from '../src/register.mjs';
import { parseLine, formatLine } from '../src/csv.mjs';

const ID = '10000001';   // fictional licence number
const HEAD = 'date;subject;kind;ref;sources;method;findings;status;name;licence;verified_at;notes';
const SCHEMA = { identifier: ID, columns: 12, nameColumn: 9, idColumn: 10, dateColumn: 11, headerPrefix: 'date;' };
const row = (f) => f.join(';');

test('known negative: a clean signed row passes', () => {
  const r = validateRegister([HEAD, row(['2026-09-06', 'magnesium', 'interaction', '81', 'PMID 123', 'read', 'ok', 'VERIFIED', 'A. Nowak', ID, '2026-09-06', 'no remarks'])], SCHEMA);
  assert.equal(r.ok, true);
  assert.equal(r.signed, 1);
});

test('known positive: an unescaped delimiter in an earlier field shifts the signature', () => {
  // "magnesium; tetracyclines" written WITHOUT quotes: one extra field, everything shifts right.
  const bad = '2026-09-06;magnesium; tetracyclines;interaction;81;PMID 123;read;ok;VERIFIED;A. Nowak;' + ID + ';2026-09-06;no remarks';
  const r = validateRegister([HEAD, bad], SCHEMA);
  assert.equal(r.ok, false);
  assert.match(r.problems[0].reason, /signature shifted/);
  assert.equal(r.problems[0].row, 2);
});

test('the same value QUOTED keeps the signature in place', () => {
  const good = formatLine(['2026-09-06', 'magnesium; tetracyclines', 'interaction', '81', 'PMID 123', 'read', 'ok', 'VERIFIED', 'A. Nowak', ID, '2026-09-06', 'no remarks']);
  assert.equal(parseLine(good).length, 12);
  assert.equal(validateRegister([HEAD, good], SCHEMA).ok, true);
});

test('the identifier quoted INSIDE prose is not a signature — no false alarm', () => {
  // A sources field citing the national register, with the signing columns deliberately empty.
  const r = validateRegister([HEAD, row(['2026-09-06', 'letter', 'outreach', '-', 'national register of pharmacists, licence ' + ID, 'read', '-', 'PENDING', '', '', '', 'awaiting review'])], SCHEMA);
  assert.equal(r.ok, true);
  assert.equal(r.signed, 0, 'prose mention must not count as a signature');
});

test('the free-text column may contain the identifier standing alone', () => {
  const r = validateRegister([HEAD, row(['2026-09-06', 'x', 'y', '-', '-', '-', '-', 'PENDING', '', '', '', ID])], SCHEMA);
  assert.equal(r.ok, true);
  assert.equal(r.signed, 0);
});

test('a signature without a name, or with a non-date, is reported', () => {
  const noName = validateRegister([HEAD, row(['2026-09-06', 'x', 'y', '-', '-', '-', '-', 'VERIFIED', '', ID, '2026-09-06', ''])], SCHEMA);
  assert.match(noName.problems[0].reason, /name column .* is empty/);
  const noDate = validateRegister([HEAD, row(['2026-09-06', 'x', 'y', '-', '-', '-', '-', 'VERIFIED', 'A. Nowak', ID, 'yesterday', ''])], SCHEMA);
  assert.match(noDate.problems[0].reason, /is not a date/);
});

test('a truncated row is reported before anything else', () => {
  const r = validateRegister([HEAD, '2026-09-06;x;y'], SCHEMA);
  assert.match(r.problems[0].reason, /too few fields/);
});

test('status report: equality under-counts what containment finds', () => {
  const rows = [HEAD,
    row(['2026-09-06', 'a', 'y', '-', '-', '-', '-', 'VERIFIED', 'A. Nowak', ID, '2026-09-06', '']),
    row(['2026-09-06', 'b', 'y', '-', '-', '-', '-', 'VERIFIED-AFTER-CORRECTION', 'A. Nowak', ID, '2026-09-06', '']),
    row(['2026-09-06', 'c', 'y', '-', '-', '-', '-', 'PENDING', '', '', '', '']),
  ];
  const r = validateRegister(rows, { ...SCHEMA, statusColumn: 8, signedStatus: 'VERIFIED' });
  assert.equal(r.statuses.byEquality, 1);
  assert.equal(r.statuses.byContainment, 2);
  assert.deepEqual(r.statuses.missedByEquality, [{ status: 'VERIFIED-AFTER-CORRECTION', count: 1 }]);
});

test('a missing identifier is refused rather than silently passing everything', () => {
  assert.throws(() => validateRegister([HEAD], { ...SCHEMA, identifier: '' }), /identifier/);
});
