// SPDX-FileCopyrightText: 2026 SuplerMed
// SPDX-License-Identifier: MIT
//
// Admissibility check for objections raised by an automated reviewer.
//
// THE PROBLEM. A machine reviewer is wrong with exactly the same confidence with which it
// is right. In one review round over a batch of texts, our reviewers raised a dozen real
// problems and three false ones, phrased identically: that a dose in an already-signed
// entry was an intravenous antidote protocol (the cited consensus recommends it orally);
// that a government fact sheet described a death (it describes a regulator's reservations);
// that a database query returned no results (it returns eight). Had the first one been
// applied without checking, the "correction" would have degraded a text a human had signed.
//
// THE RULE. An objection without a quote is inadmissible. Two things are required at once:
//
//   * `quote` — a VERBATIM fragment of the reviewed text. We check it mechanically: the
//     fragment must occur in the text. This is the only part of a reviewer's judgement that
//     can be verified deterministically, and it catches an objection to a sentence that
//     does not exist.
//   * `basis` — a verbatim sentence from the source that supports the objection, or an
//     explicit statement that the source does not contain it. A pointer to an identifier
//     ("PMID exists", "the opinion was published") is NOT a basis: it says the source is
//     real, not that it says what the objection claims.
//
// THIS IS NOT A JUDGEMENT OF MERIT. It filters out objections that cannot be checked, and
// nothing more. An objection with a correct quote can still be false; against signed
// content it is verified at the source before any record is touched.

const CORRECTED = /^\s*(corrected|fixed)/i;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[„“”»«]/g, '"').trim().toLowerCase();

// A quote SUPPLIED BY THE REVIEWER often arrives wrapped in quotation marks, because that
// is how people write quotations. The enclosing pair is punctuation around the fragment,
// not part of it — and rejecting such an objection punishes the reviewer for being tidy.
// We strip at most ONE matching enclosing pair, never anything inside, so a genuine
// mismatch still fails.
const normQuoted = (s) => norm(s).replace(/^"(.*)"$/s, '$1').trim();

// Phrases that pose as a basis while saying only "the identifier exists".
const APPARENT_BASIS = /^(?:\s*(?:PMID|DOI|PMC)\s*:?\s*[\d./a-z-]+\s*)$|(?:\bexists\b|\bis real\b|\bwas published\b|\bI confirm the existence\b)/i;

/**
 * @param {Array}  objections  reviewer output
 * @param {string} text        the reviewed text (concatenated fields)
 * @param {object} [opts]
 * @param {boolean} [opts.requireTextAfterCorrection=true]
 * @returns {{ok: boolean, notes: Array<{index:number, reason:string, objection:object}>, missingSection?: boolean}}
 */
export function validateObjections(objections, text, opts = {}) {
  const { requireTextAfterCorrection = true } = opts;
  const notes = [];
  if (objections == null) {
    return { ok: true, missingSection: true,
      notes: [{ index: 0, reason: 'no objections section — it is unknown whether the reviewers raised anything', objection: null }] };
  }
  if (!Array.isArray(objections)) {
    return { ok: false, notes: [{ index: 0, reason: 'objections is not a list', objection: null }] };
  }

  const t = norm(text);
  objections.forEach((o, i) => {
    const index = i + 1;
    if (!o || typeof o !== 'object') { notes.push({ index, reason: 'objection is not an object', objection: o }); return; }
    const quote = normQuoted(o.quote);
    const corrected = CORRECTED.test(String(o.resolution || ''));

    // AN OBJECTION ABOUT AN OMISSION HAS NOTHING TO QUOTE — and this is not a convenience
    // exemption but a repair of a flaw that rejected the MOST DANGEROUS class of objection
    // as unverifiable. You cannot quote a sentence that is not there, and a missing sentence
    // is often the gravest defect: a warning left out, an animal study reported without
    // saying so, a dose given without its upper limit. The quote requirement protects
    // against INVENTED objections, so it applies to what stands — not to what is absent.
    // The proof for an omission is different and checked below: `whatIsMissing` must say
    // what is not there. A quote stays ALLOWED (sometimes it is apt: "a warning belongs at
    // this sentence") and then it must still occur in the text.
    if (o.missing === true && !quote) {
      /* omission without a quote: admissible by definition */
    } else if (!quote) {
      notes.push({ index, reason: 'objection WITHOUT a quote from the reviewed text — impossible to tell what it refers to', objection: o });
    } else if (!corrected) {
      if (!t.includes(quote)) {
        notes.push({ index, reason: `the quote "${String(o.quote).slice(0, 70)}…" DOES NOT OCCUR in the reviewed text`, objection: o });
      }
    } else if (requireTextAfterCorrection) {
      // AN OBJECTION MARKED AS CORRECTED: the old wording is EXPECTED to be gone, so the
      // presence check would punish exactly the diligent case. Measured on two drafts: the
      // one that recorded quotes from the text BEFORE the fix (what the reviewer actually
      // criticised) failed 10 of 11 checks, while the one that recorded the wording AFTER
      // the fix passed 4 of 4. Both read the instruction the same way. The perverse result
      // was that the more faithfully a draft repaired what reviewers found, the more it
      // looked fabricated. So we check something different and stronger: did the declared
      // correction ACTUALLY land, and did the criticised wording actually go away?
      const after = normQuoted(o.textAfterCorrection);
      if (!after) {
        notes.push({ index, reason: 'objection resolved as corrected does not supply `textAfterCorrection` — impossible to check whether the correction landed', objection: o });
      } else if (!t.includes(after)) {
        notes.push({ index, reason: `the declared correction "${String(o.textAfterCorrection).slice(0, 70)}…" DOES NOT OCCUR in the final text — resolved as corrected, but the correction is absent`, objection: o });
      } else if (t.includes(quote)) {
        notes.push({ index, reason: `the text STILL contains the criticised wording "${String(o.quote).slice(0, 70)}…" despite the resolution "corrected"`, objection: o });
      }
    }

    const basis = String(o.basis || '').trim();
    if (o.missing === true) {
      if (!String(o.whatIsMissing || '').trim()) {
        notes.push({ index, reason: 'objection about an omission does not say WHAT is missing from the document', objection: o });
      }
    } else if (!basis) {
      notes.push({ index, reason: 'objection without a basis — no sentence from the source and no explicit `missing` flag', objection: o });
    } else if (APPARENT_BASIS.test(basis)) {
      notes.push({ index, reason: `the basis only states that the source exists ("${basis.slice(0, 60)}") — that is not an assessment of coverage`, objection: o });
    }
  });

  return { ok: notes.length === 0, notes };
}

/**
 * Is a "pass" verdict standing next to an unresolved blocking objection?
 *
 * A blocking objection that WAS CORRECTED is not a contradiction — that is what a
 * correction round is for. The contradiction is a pass next to a blocking objection that
 * was rejected or left unresolved. Without this distinction a draft that repaired both of
 * its blocking objections was reported as inconsistent, pointing human attention at the
 * healthy draft instead of the sick one.
 */
export function verdictConsistency(verdict = {}, objections = []) {
  const blocking = (Array.isArray(objections) ? objections : [])
    .filter((o) => o && (o.blocking === true || /block/i.test(String(o.weight || ''))))
    .filter((o) => !CORRECTED.test(String(o.resolution || '')));
  const passed = Object.values(verdict).every((v) => String(v).includes('pass'));
  return passed && blocking.length
    ? { ok: false, reason: `verdict=pass despite ${blocking.length} blocking objection(s) with no correction` }
    : { ok: true };
}
