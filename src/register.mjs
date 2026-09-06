// SPDX-FileCopyrightText: 2026 SuplerMed
// SPDX-License-Identifier: MIT
//
// Column-semantics validator for a sign-off register.
//
// THE FAILURE THIS CATCHES. A register is a delimited file in which one column holds the
// signatory's professional identifier, one holds their name and one the date of sign-off.
// An unescaped delimiter inside an EARLIER field shifts every value one column to the
// right — and the signature quietly lands in a column that means something else. The row
// still parses. It still looks signed. It no longer proves what it is supposed to prove.
//
// WHAT WE DO NOT VALIDATE, and why. Not the number of fields: a stray delimiter in the
// LAST column (free-text notes) is harmless, because a tolerant parser folds the remainder
// into that column. Not the status vocabulary either: statuses are an open set written by
// humans, and an attempt to validate them once produced 729 false hits. We check exactly
// one precise invariant of the dangerous failure, which keeps the guard credible.
//
// THE ANCHOR IS A LITERAL IDENTIFIER, NOT A DIGIT PATTERN. A generic /\d{6,8}/ collides
// with every other number a register may legitimately quote (in our case PubMed ids), and
// each collision is a false alarm that teaches people to ignore the guard.
//
// STANDALONE, NOT "CONTAINS". A field that quotes the identifier inside a sentence
// ("verified against the national register of pharmacists, licence 10000001") is prose,
// not a signature — and a column shift moves WHOLE values, never glues them together, so
// after a shift the identifier still stands alone in its field. Following the STRUCTURE of
// the fault rather than keeping a list of exempt columns is what makes this rule hold.
// Measured on a live register on 2026-09-06 (5027 rows, 1901 of them signed): 307 rows
// quote the identifier somewhere inside prose, and ZERO have it standing alone outside its
// proper column.

import { parseLine } from './csv.mjs';

const isDate = (s) => /^\d{4}-\d{2}-\d{2}/.test(String(s || '').trim());

/**
 * @param {string[]} fileLines           physical lines of the register
 * @param {object}   opts
 * @param {string}   opts.identifier     literal signatory identifier, e.g. a licence number
 * @param {number}   opts.nameColumn     1-based column that must hold the signatory's name
 * @param {number}   opts.idColumn       1-based column that must hold the identifier
 * @param {number}   opts.dateColumn     1-based column that must hold the sign-off date
 * @param {number}   opts.columns        expected number of columns
 * @param {number}   [opts.proseColumn]  1-based free-text column excluded from the scan
 *                                       (defaults to the last column)
 * @param {string}   [opts.delimiter]
 * @param {string}   [opts.headerPrefix] first line is skipped when it starts with this
 * @param {number}   [opts.statusColumn] 1-based status column, for the advisory report only
 * @param {string}   [opts.signedStatus] status text denoting signed content, for the report
 */
export function validateRegister(fileLines, opts) {
  const {
    identifier, nameColumn, idColumn, dateColumn, columns,
    proseColumn = columns, delimiter = ';', headerPrefix = null,
    statusColumn = null, signedStatus = null,
  } = opts;
  if (!identifier) throw new Error('validateRegister: `identifier` is required');

  const standsAlone = (s) => String(s || '').trim() === identifier;
  const problems = [];
  let checked = 0, signed = 0;

  fileLines.forEach((line, i) => {
    if (!line.trim()) return;
    if (i === 0 && headerPrefix && line.startsWith(headerPrefix)) return;
    checked++;
    const f = parseLine(line, { delimiter });
    const report = (reason) => problems.push({ row: i + 1, reason, line: line.slice(0, 170) });

    if (f.length < columns) { report(`too few fields (${f.length} < ${columns}) — row truncated`); return; }

    // Signing columns: everything except the free-text column, which may legitimately
    // mention the identifier in prose.
    const signingFields = f.slice(0, proseColumn - 1);
    if (!signingFields.some(standsAlone)) return;   // no signature in this row
    signed++;

    const name = (f[nameColumn - 1] || '').trim();
    const date = (f[dateColumn - 1] || '').trim();
    if (!standsAlone(f[idColumn - 1])) {
      const at = signingFields.findIndex(standsAlone) + 1;
      report(`identifier is not in column ${idColumn} (found in column ${at}) — signature shifted`);
    } else if (!name) {
      report(`identifier in column ${idColumn}, but the name column ${nameColumn} is empty`);
    } else if (!isDate(date)) {
      report(`identifier in column ${idColumn}, but column ${dateColumn} ("${date}") is not a date`);
    }
  });

  const result = { ok: problems.length === 0, checked, signed, problems };
  if (statusColumn && signedStatus) result.statuses = statusReport(fileLines, { statusColumn, signedStatus, delimiter, headerPrefix });
  return result;
}

/**
 * Advisory only, never a gate.
 *
 * WHY IT EXISTS. Two people counted "how many rows were signed" on the same file on the
 * same day and got 80 and 81. Neither counted wrongly: one matched the status by EQUALITY,
 * the other by CONTAINMENT, and the register holds "VERIFIED-AFTER-CORRECTION" next to
 * "VERIFIED". Across a whole file the gap is far wider than one row. It matters which way
 * you err: equality UNDER-counts the rows that prove content is signed.
 */
export function statusReport(fileLines, { statusColumn, signedStatus, delimiter = ';', headerPrefix = null }) {
  const counts = new Map();
  fileLines.forEach((line, i) => {
    if (!line.trim()) return;
    if (i === 0 && headerPrefix && line.startsWith(headerPrefix)) return;
    const s = (parseLine(line, { delimiter })[statusColumn - 1] || '(empty)').trim();
    counts.set(s, (counts.get(s) || 0) + 1);
  });
  const containing = [...counts].filter(([s]) => s.includes(signedStatus));
  const byContainment = containing.reduce((n, [, c]) => n + c, 0);
  const byEquality = counts.get(signedStatus) || 0;
  return {
    distinct: counts.size,
    byContainment,
    byEquality,
    missedByEquality: containing.filter(([s]) => s !== signedStatus).map(([s, c]) => ({ status: s, count: c })),
    distribution: [...counts].sort((a, b) => b[1] - a[1]).map(([status, count]) => ({ status, count })),
  };
}
