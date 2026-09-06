// SPDX-FileCopyrightText: 2026 SuplerMed
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateObjections, verdictConsistency } from '../src/critique.mjs';

const TEXT = 'Magnesium reduces the absorption of tetracyclines. Separate the doses by two hours.';

test('known negative: a well-formed objection is admissible', () => {
  const r = validateObjections([{
    quote: 'Separate the doses by two hours.',
    basis: 'The summary of product characteristics states an interval of at least two hours.',
  }], TEXT);
  assert.equal(r.ok, true);
});

test('known positive: an objection quoting a sentence that is not there is rejected', () => {
  const r = validateObjections([{ quote: 'Magnesium cures diabetes.', basis: 'no such claim in the source' }], TEXT);
  assert.equal(r.ok, false);
  assert.match(r.notes[0].reason, /DOES NOT OCCUR/);
});

test('known positive: "the identifier exists" is not a basis', () => {
  for (const basis of ['PMID 12345678', 'the study exists', 'the opinion was published']) {
    const r = validateObjections([{ quote: 'Separate the doses by two hours.', basis }], TEXT);
    assert.equal(r.ok, false, `should reject basis: ${basis}`);
    assert.match(r.notes[0].reason, /only states that the source exists/);
  }
});

test('an objection about an OMISSION needs no quote, but must say what is missing', () => {
  const ok = validateObjections([{ missing: true, whatIsMissing: 'no warning about combining with SSRIs' }], TEXT);
  assert.equal(ok.ok, true);
  const bad = validateObjections([{ missing: true }], TEXT);
  assert.equal(bad.ok, false);
  assert.match(bad.notes[0].reason, /does not say WHAT is missing/);
});

test('a corrected objection is checked on the NEW wording, not the old one', () => {
  const fixed = 'Magnesium reduces the absorption of tetracyclines. Separate the doses by at least two hours.';
  const ok = validateObjections([{
    quote: 'Separate the doses by two hours.',
    textAfterCorrection: 'Separate the doses by at least two hours.',
    resolution: 'corrected',
    basis: 'the SmPC says "at least"',
  }], fixed);
  assert.equal(ok.ok, true, 'the diligent case must not look fabricated');
});

test('known positive: "corrected" while the criticised wording still stands is caught', () => {
  const r = validateObjections([{
    quote: 'Separate the doses by two hours.',
    textAfterCorrection: 'Separate the doses by two hours.',
    resolution: 'corrected',
    basis: 'the SmPC says "at least"',
  }], TEXT);
  assert.equal(r.ok, false);
  assert.match(r.notes[0].reason, /STILL contains the criticised wording/);
});

test('known positive: a correction that never landed is caught', () => {
  const r = validateObjections([{
    quote: 'Separate the doses by two hours.',
    textAfterCorrection: 'Separate the doses by four hours.',
    resolution: 'corrected',
    basis: 'the SmPC says four hours',
  }], TEXT);
  assert.equal(r.ok, false);
  assert.match(r.notes[0].reason, /DOES NOT OCCUR in the final text/);
});

test('a missing objections section is flagged but does not fail the batch', () => {
  const r = validateObjections(null, TEXT);
  assert.equal(r.ok, true);
  assert.equal(r.missingSection, true);
});

test('quote matching ignores whitespace and typographic quotes', () => {
  const r = validateObjections([{
    quote: '„Separate   the doses\nby two hours.”',
    basis: 'the SmPC states an interval of two hours',
  }], TEXT);
  assert.equal(r.ok, true);
});

test('verdict consistency: pass next to an unresolved blocking objection is a contradiction', () => {
  assert.equal(verdictConsistency({ logic: 'pass', language: 'pass' }, [{ blocking: true }]).ok, false);
  assert.equal(verdictConsistency({ logic: 'pass', language: 'pass' }, [{ blocking: true, resolution: 'corrected' }]).ok, true);
  assert.equal(verdictConsistency({ logic: 'fail', language: 'pass' }, [{ blocking: true }]).ok, true);
});

test('stripping enclosing quotes does not hide a real mismatch', () => {
  const r = validateObjections([{ quote: '"Magnesium cures diabetes."', basis: 'not in the source' }], TEXT);
  assert.equal(r.ok, false);
  assert.match(r.notes[0].reason, /DOES NOT OCCUR/);
});

test('an inner quotation mark is preserved', () => {
  const text = 'The label says "at least two hours" in bold.';
  const r = validateObjections([{ quote: 'says "at least two hours" in bold', basis: 'the SmPC agrees' }], text);
  assert.equal(r.ok, true);
});
