// SPDX-FileCopyrightText: 2026 SuplerMed
// SPDX-License-Identifier: MIT
//
// Quote-aware parser for one delimited line.
//
// WHY A SEPARATE MODULE. A register escapes an in-field delimiter by quoting the field
// ("magnesium; tetracyclines"). A naive split() breaks such rows and shifts every later
// column. In our own project that single mistake produced a false picture of the data
// TWICE: once as a false "signature in the wrong column" alarm, once as an apparently
// corrupt register (869 of 2458 rows reported with the wrong column count) while the
// validator, reading the same bytes correctly, reported zero problems.
//
// The tool that knows the format wins. So there is exactly one implementation, and it
// lives here.
//
// Format: a delimiter outside quotes separates fields; "" inside a quoted field is a
// literal quote character.

export function parseLine(line, { delimiter = ';', quote = '"' } = {}) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (inQuotes) {
      if (ch === quote && line[k + 1] === quote) { cur += quote; k++; }
      else if (ch === quote) inQuotes = false;
      else cur += ch;
    } else if (ch === quote) inQuotes = true;
    else if (ch === delimiter) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Escape one value so it survives a round trip through parseLine.
 * Writing is the other half of the problem: the cheapest way to keep a signature in the
 * right column is never to let an unescaped delimiter into an earlier field.
 */
export function escapeField(value, { delimiter = ';', quote = '"' } = {}) {
  const s = String(value ?? '');
  if (!s.includes(delimiter) && !s.includes(quote) && !s.includes('\n')) return s;
  return quote + s.split(quote).join(quote + quote) + quote;
}

export function formatLine(fields, opts = {}) {
  const { delimiter = ';' } = opts;
  return fields.map((f) => escapeField(f, opts)).join(delimiter);
}
