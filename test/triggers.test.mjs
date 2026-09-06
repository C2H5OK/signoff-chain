// SPDX-FileCopyrightText: 2026 SuplerMed
// SPDX-License-Identifier: MIT
//
// These run against a real in-memory SQLite database. A generated SQL string that has
// never been executed is a guess, not a guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { signatureRevokeTrigger, signatureAuthorTrigger } from '../src/triggers.mjs';

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE articles (
    id INTEGER PRIMARY KEY, title TEXT, body TEXT, price REAL,
    published INTEGER DEFAULT 0, verified_by TEXT, verified_at TEXT)`);
  d.exec(`CREATE TABLE audit (id INTEGER PRIMARY KEY, task TEXT, status TEXT, message TEXT)`);
  return d;
}
const SPEC = {
  table: 'articles', contentColumns: ['title', 'body'],
  signatoryColumn: 'verified_by', timestampColumn: 'verified_at',
  audit: { table: 'audit', task: 'signature_guard' },
};
const get = (d) => d.prepare('SELECT * FROM articles WHERE id = 1').get();

test('known positive: editing signed content without a new timestamp revokes the signature', () => {
  const d = db();
  d.exec(signatureRevokeTrigger(SPEC));
  d.exec(`INSERT INTO articles VALUES (1,'T','B',10,1,'A. Nowak 10000001','2026-09-01')`);
  d.exec(`UPDATE articles SET body = 'B EDITED' WHERE id = 1`);
  const r = get(d);
  assert.equal(r.verified_by, null);
  assert.equal(r.verified_at, null);
  assert.equal(d.prepare('SELECT COUNT(*) c FROM audit').get().c, 1, 'the revocation leaves a trace');
});

test('known negative: a deliberate re-verification keeps the signature', () => {
  const d = db();
  d.exec(signatureRevokeTrigger(SPEC));
  d.exec(`INSERT INTO articles VALUES (1,'T','B',10,1,'A. Nowak 10000001','2026-09-01')`);
  d.exec(`UPDATE articles SET body = 'B REVISED', verified_at = '2026-09-06' WHERE id = 1`);
  assert.equal(get(d).verified_by, 'A. Nowak 10000001');
});

test('known negative: an operational field is not signed content — a price update is silent', () => {
  const d = db();
  d.exec(signatureRevokeTrigger(SPEC));
  d.exec(`INSERT INTO articles VALUES (1,'T','B',10,1,'A. Nowak 10000001','2026-09-01')`);
  d.exec(`UPDATE articles SET price = 12 WHERE id = 1`);
  assert.equal(get(d).verified_by, 'A. Nowak 10000001');
});

test('known negative: a row that was never signed is left alone', () => {
  const d = db();
  d.exec(signatureRevokeTrigger(SPEC));
  d.exec(`INSERT INTO articles VALUES (1,'T','B',10,1,'','2026-09-01')`);
  d.exec(`UPDATE articles SET body = 'anything' WHERE id = 1`);
  assert.equal(get(d).body, 'anything', 'the update itself must still go through');
});

test('known positive: raising the published flag with no author is refused', () => {
  const d = db();
  d.exec(signatureAuthorTrigger({ table: 'articles', flagColumn: 'published', signatoryColumn: 'verified_by' }));
  d.exec(`INSERT INTO articles VALUES (1,'T','B',10,0,NULL,NULL)`);
  assert.throws(() => d.exec(`UPDATE articles SET published = 1 WHERE id = 1`), /Signature without an author/);
});

test('known negative: rows already flagged keep working — the trigger watches the transition', () => {
  const d = db();
  d.exec(signatureAuthorTrigger({ table: 'articles', flagColumn: 'published', signatoryColumn: 'verified_by' }));
  d.exec(`INSERT INTO articles VALUES (1,'T','B',10,1,NULL,NULL)`);
  d.exec(`UPDATE articles SET price = 99 WHERE id = 1`);
  assert.equal(get(d).price, 99);
});

test('identifiers are refused rather than interpolated', () => {
  assert.throws(() => signatureRevokeTrigger({ ...SPEC, table: 'articles; DROP TABLE audit' }), /unsafe SQL identifier/);
  assert.throws(() => signatureRevokeTrigger({ ...SPEC, contentColumns: [] }), /non-empty array/);
});

test('a quote in the audit message does not break the generated SQL', () => {
  const d = db();
  d.exec(signatureRevokeTrigger({ ...SPEC, audit: { ...SPEC.audit, task: "guard's check" } }));
  d.exec(`INSERT INTO articles VALUES (1,'T','B',10,1,'A. Nowak','2026-09-01')`);
  d.exec(`UPDATE articles SET title = 'X' WHERE id = 1`);
  assert.equal(d.prepare('SELECT task FROM audit').get().task, "guard's check");
});
