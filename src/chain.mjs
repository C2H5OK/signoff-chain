// SPDX-FileCopyrightText: 2026 SuplerMed
// SPDX-License-Identifier: MIT
//
// Hash chain over the physical lines of an append-only register.
//
// WHY. A register that records "who vouched for what, and when" is only worth as much as
// the guarantee that nobody quietly went back and changed row 900. A plain file on disk
// offers no such guarantee: an edit made last week looks exactly like no edit at all.
// This module makes rewriting history *detectable* — every line is sealed with a digest
// that depends on all preceding lines, so changing one row breaks every seal below it.
//
// WHAT IT DOES NOT DO, stated plainly: this is detection, not prevention. Anyone who can
// write to the register can also rewrite the chain file. It protects against silent
// mistakes, concurrent overwrites and unnoticed edits — not against deliberate forgery.
// For that you need signatures over a key the operator cannot type from memory.
//
// The unit is the PHYSICAL LINE, not the parsed record. Deliberately: we protect the bytes
// of the file, not one interpretation of its fields. A multi-line quoted field counts as
// several entries, which is irrelevant for tamper detection — and the parser must not
// become one more place where columns can be miscounted.

import fs from 'node:fs';
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

export const DEFAULT_SEED = 'signoff-chain-v1';
export const HEADER = '# signoff-chain v1 sha256 | <chain-digest> <line-digest>';

/** Path of the sidecar chain file for a register. */
export function chainPath(file) {
  return String(file).replace(/\.[^./\\]+$/, '') + '.chain';
}

/** Physical lines, ignoring a single trailing newline. */
export function lines(text) {
  return text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
}

/** For every line: the digest of that line, and the running chain digest. */
export function computeChain(fileLines, { seed = DEFAULT_SEED } = {}) {
  const out = [];
  let prev = sha(seed);
  for (const l of fileLines) {
    const lineDigest = sha(l);
    prev = sha(prev + '\n' + lineDigest);
    out.push({ chain: prev, line: lineDigest });
  }
  return out;
}

export function writeChain(path, chain) {
  fs.writeFileSync(path, [HEADER, ...chain.map((e) => `${e.chain} ${e.line}`)].join('\n') + '\n', 'utf8');
}

/**
 * Is the chain file consistent with ITSELF? Recompute the running digests from the stored
 * line digests: a chain file whose two columns disagree was not produced by this seed, or
 * was edited after the fact.
 *
 * FOUND BY ITS OWN TEST. Without this check a chain file with a doctored digest column
 * fell through to the subsequence test, which only looks at LINE digests — and those are
 * seed-independent. The result was the worst possible answer: a benign "rows were merged
 * in" verdict for a chain file that does not belong to this register at all.
 */
export function chainFileIsConsistent(sealed, { seed = DEFAULT_SEED } = {}) {
  let prev = sha(seed);
  for (const e of sealed) {
    prev = sha(prev + '\n' + e.line);
    if (prev !== e.chain) return false;
  }
  return true;
}

export function readChain(path) {
  return fs.readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [chain, line] = l.split(' '); return { chain, line }; });
}

// Are all sealed lines still present, in the same order? Greedy match on line digests.
// This is an EXACT test, not a heuristic: if the subsequence survived, then no sealed line
// was altered or removed — only new lines were added.
function subsequence(sealed, live) {
  const inserted = [];
  let j = 0;
  for (const digest of sealed) {
    while (j < live.length && live[j] !== digest) { inserted.push(j + 1); j++; }
    if (j === live.length) return { found: false, missing: digest, inserted };
    j++;
  }
  for (; j < live.length; j++) inserted.push(j + 1);
  return { found: true, inserted };
}

// Five states. Telling them apart is what decides whether the guard survives contact with
// real work: a guard that cries wolf during normal operation is ignored after the second
// time, and then it protects nothing at all.
//
//   MATCH        full coverage, nothing changed
//   APPEND_ONLY  the sealed chain is a prefix: rows were added at the end (normal)
//   INTERLEAVED  the whole history is present and in order, but rows landed in the middle
//                (normal after merging two copies of the register — needs `merge`, not `extend`)
//   TAMPERED     a sealed line vanished or changed (ALARM)
//   TRUNCATED    as above, and the file got shorter (ALARM)
//   CHAIN_INVALID the sidecar disagrees with itself: wrong seed, or the chain file was
//                edited (ALARM — says nothing about the register, only about the chain)
export function compare(sealed, fileLines, { seed = DEFAULT_SEED } = {}) {
  const live = computeChain(fileLines, { seed });

  // Fast path: exact prefix. Here the CHAIN digests must match, which is a stronger
  // condition than the subsequence test and covers almost every run.
  const prefixOk = sealed.length <= live.length
    && sealed.every((e, i) => e.chain === live[i].chain);
  if (prefixOk) {
    return fileLines.length === sealed.length
      ? { state: 'MATCH', ok: true, sealed: sealed.length, present: fileLines.length }
      : { state: 'APPEND_ONLY', ok: true, added: fileLines.length - sealed.length,
          sealed: sealed.length, present: fileLines.length };
  }

  // The prefix check failed. Before blaming the register, make sure the accuser is sound:
  // an inconsistent chain file cannot testify about anything.
  if (!chainFileIsConsistent(sealed, { seed })) {
    return {
      state: 'CHAIN_INVALID', ok: false,
      diagnosis: 'the chain file disagrees with itself — wrong seed, or the chain file was edited',
      sealed: sealed.length, present: fileLines.length,
    };
  }

  const s = subsequence(sealed.map((e) => e.line), live.map((e) => e.line));
  if (s.found) {
    return {
      state: 'INTERLEAVED', ok: true,
      inserted: s.inserted,
      added: s.inserted.length,
      firstInsertion: s.inserted[0] || null,
      diagnosis: 'entire sealed history present and in order — rows were inserted in the middle',
      sealed: sealed.length, present: fileLines.length,
    };
  }

  const lostAt = sealed.findIndex((e) => e.line === s.missing);
  return {
    state: fileLines.length < sealed.length ? 'TRUNCATED' : 'TAMPERED',
    ok: false,
    row: lostAt + 1,
    diagnosis: 'sealed content of this row VANISHED or was modified',
    sealed: sealed.length, present: fileLines.length,
  };
}
