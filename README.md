<!--
SPDX-FileCopyrightText: 2026 SuplerMed
SPDX-License-Identifier: MIT
-->

# signoff-chain

**Make "a named person vouched for this exact text" a claim a machine can check.**

Plenty of published content carries a human guarantee: a pharmacist signs off a drug
interaction, a lawyer approves a notice, an editor clears a safety warning, a public body
publishes a register. The guarantee is usually stored as three columns — a name, a
licence number, a date — and then trusted forever.

Those three columns are weaker than they look. Content gets edited and the sign-off stays.
A stray delimiter shifts the signature into a column that means something else. Two copies
of a register get merged and rows quietly disappear. None of this raises an error; the row
still parses, still looks signed, and no longer proves what it is supposed to prove.

This is a small, dependency-free toolkit for closing those gaps. It does not decide whether
content is correct — a human still does that. It makes the gap between *what was signed*
and *what is served* detectable.

## Four parts

| Module | What it guarantees |
|---|---|
| `chain` | Rewriting or reordering history in an append-only register is detectable. |
| `register` | The signature really is in the signature column — no delimiter shift. |
| `triggers` | Editing signed content in the database revokes the sign-off automatically. |
| `critique` | An automated reviewer's objection is inadmissible unless it can be checked. |

Each is usable on its own. Nothing here talks to a network, reads configuration from the
environment, or has a runtime dependency: the four modules import only `node:fs`,
`node:crypto` and `node:path`.

## Install

```
npm install signoff-chain      # library
npx signoff --help             # command line
```

Requires Node.js **22.13** or newer (the test suite uses the built-in `node:sqlite`).

## 1. Tamper-evident register (`chain`)

Every line of the register is sealed with a digest that depends on all preceding lines, in
a sidecar `.chain` file. Change one historical row and every seal below it breaks.

```
npx signoff chain build   data/register.csv    # seal once
npx signoff chain verify  data/register.csv    # check
npx signoff chain extend  data/register.csv    # seal rows appended at the end
npx signoff chain merge   data/register.csv    # seal rows inserted in the middle
```

`verify` reports one of six states, and telling them apart is the whole design:

| State | Meaning | Verdict |
|---|---|---|
| `MATCH` | Nothing changed. | ok |
| `APPEND_ONLY` | Rows were added at the end. | ok — normal work |
| `INTERLEAVED` | The whole sealed history is present and in order, but rows landed in the middle. | ok — this is what merging two copies of a register looks like |
| `TAMPERED` | A sealed row vanished or changed. | **alarm** |
| `TRUNCATED` | As above, and the file got shorter. | **alarm** |
| `CHAIN_INVALID` | The chain file disagrees with itself. | **alarm about the chain, not the register** |

The `INTERLEAVED` state is the reason this is usable in practice. A guard that cries wolf
during ordinary work is switched off after the second false alarm, and then it protects
nothing at all — so "rows were merged in" has to be distinguishable from "a row was
changed", exactly, not approximately.

```js
import { lines, computeChain, compare } from 'signoff-chain/chain';
const sealed = computeChain(lines(before));
compare(sealed, lines(after));   // -> { state, ok, row?, diagnosis? }
```

**What this does not do, stated plainly.** This is detection, not prevention. Anyone who
can write to the register can also rewrite the chain file. It protects against silent
mistakes, concurrent overwrites and unnoticed edits — not against deliberate forgery. For
that you need a signature over a key that cannot be typed from memory.

## 2. Signature column validator (`register`)

An unescaped delimiter inside an earlier field shifts every later value one column right.
The signature lands somewhere else and nothing complains.

```
npx signoff register validate data/register.csv \
  --identifier 10000001 --columns 12 \
  --name-column 9 --id-column 10 --date-column 11 \
  --status-column 8 --signed-status VERIFIED
```

Two design choices make this precise rather than noisy:

* **The anchor is a literal identifier, not a digit pattern.** A generic `\d{6,8}` collides
  with every other number a register legitimately quotes — in our case PubMed identifiers —
  and each collision teaches people to ignore the guard.
* **Standing alone, not "contained".** A field that quotes the identifier inside a sentence
  is prose, not a signature; a column shift moves whole values and never glues them
  together, so after a shift the identifier still stands alone in its field. Following the
  *structure* of the fault beats maintaining a list of exempt columns. Measured on our own
  register on 6 September 2026 — 5 027 rows, 1 901 of them signed: 307 rows quote the
  identifier somewhere inside prose, and zero have it standing alone outside its column.

The status report is advisory and never a gate. It exists because two people counted the
signed rows in the same file on the same day and got different answers — one matched the
status by equality, the other by containment, and the register holds
`VERIFIED-AFTER-CORRECTION` next to `VERIFIED`. Equality *under*-counts the rows that prove
content is signed, which is the more damaging direction to be wrong in.

## 3. Sign-off revoking triggers (`triggers`)

Generates SQLite triggers you apply yourself.

```js
import { signatureRevokeTrigger } from 'signoff-chain/triggers';
db.exec(signatureRevokeTrigger({
  table: 'articles',
  contentColumns: ['title', 'abstract', 'body'],   // what a human actually vouched for
  signatoryColumn: 'verified_by',
  timestampColumn: 'verified_at',
  audit: { table: 'audit_log', task: 'signature_guard' },
}));
```

Edit signed content without setting a new timestamp and the sign-off is dropped, so the
record is withheld until someone re-verifies it. Whoever re-verifies deliberately sets the
timestamp in the *same* statement, and the trigger stays quiet — that escape hatch is the
point, not a loophole.

**Why in the database rather than in a test.** A static test reads the code in your
repository. An audit of our own production machine (July 2026) found 43 `.js` files that
existed only on the server — one-off remediations, imports, cleanups. One of them trimmed
prefixes in product names and, as a side effect of an unrelated `UPDATE`, set the
"verified" flag on every row it touched. No guard living in the repository can see a file
that is not in the repository. The gate has to stand where nobody can walk around it,
including a manual `UPDATE` typed at the console.

Two calibration rules decide whether this is usable:

* it fires only on a **real** signature, so rows flagged by an importer with no human
  author are untouched;
* the content column list is **only** the content a human vouched for — prices, images and
  stock flags are not on it, so routine imports do not strip signatures.

`signatureAuthorTrigger` covers the other direction: refusing to raise a "published" flag
with no author named. It watches the transition 0 → 1 rather than the state, because
watching the state would abort every unrelated update on rows that are already flagged.

## 4. Admissibility of automated objections (`critique`)

If part of your review is done by a machine, its objections need a filter — because a
machine reviewer is wrong with exactly the same confidence with which it is right.

An objection is inadmissible unless it carries both:

* `quote` — a verbatim fragment of the reviewed text, checked mechanically against that
  text. This is the only part of a reviewer's judgement that can be verified
  deterministically, and it catches an objection to a sentence that does not exist.
* `basis` — a verbatim sentence from the source, or an explicit statement that the source
  does not contain one. "The identifier exists" is not a basis: it says the source is real,
  not that it says what the objection claims.

```js
import { validateObjections } from 'signoff-chain/critique';
validateObjections(objections, reviewedText);   // -> { ok, notes: [{ index, reason }] }
```

Two exceptions are load-bearing and were both discovered by measurement:

* **An objection about an omission has nothing to quote.** You cannot quote a sentence that
  is not there, and a missing sentence is often the gravest defect — a warning left out, an
  animal study reported without saying so, a dose given without its upper limit. Requiring
  a quote there rejected the most dangerous class of objection as unverifiable. Its proof
  is different: `whatIsMissing` must say what is absent.
* **An objection marked as corrected is checked on the new wording.** The old wording is
  *expected* to be gone. Before this split, the more faithfully a draft repaired what the
  reviewers found, the more fabricated it looked: a draft that recorded quotes from before
  the fix failed 10 of 11 checks, while one that recorded the wording after the fix passed
  4 of 4. Both had followed the same instruction. So the check became stronger instead:
  did the declared correction actually land, and did the criticised wording actually go?

This module filters out objections that cannot be checked. It does **not** judge whether an
objection is right. An objection with a valid quote can still be false; against signed
content, verify it at the source before touching the record.

## Tests

```
npm test
```

47 tests. Every guard is exercised with a **known positive and a known negative** — a green
run that has never been shown to go red proves the tool is blind, not that the file is
clean. The trigger tests run against a real in-memory SQLite database, because a generated
SQL string that has never been executed is a guess, not a guard.

Two defects were found by those tests while this package was being extracted, and are fixed
here: a chain file with a doctored digest column used to be reported as a benign merge, and
an objection whose quote was wrapped in quotation marks — the way people normally write
quotations — was rejected.

## Where it comes from

Extracted from the internal tooling of [SuplerMed](https://suplermed.pl), a Polish
supplement information service where every piece of medical content is signed by a
pharmacist under their professional licence number, and where the sign-off register is the
project's legal shield. The rules encoded here are not hypothetical: each one was written
after the corresponding failure actually happened.

The service itself, its database and its content are not part of this package.

## Use of generative AI

Disclosed in line with
[NLnet's policy on generative AI](https://nlnet.nl/foundation/policies/generativeAI/).

The code in this package was extracted and rewritten with the assistance of a large
language model (Claude, Anthropic), working from existing internal tooling written for the
SuplerMed project. A human author reviewed every line, ran the tests, and is accountable
for the design decisions, the calibration rules and the accuracy of everything stated in
this file. The measurements quoted in the documentation come from the production system,
not from the model.

## Licence

MIT — see [LICENSE](LICENSE). Files carry SPDX headers.
