// SPDX-FileCopyrightText: 2026 SuplerMed
// SPDX-License-Identifier: MIT
//
// SQLite triggers that keep a stored signature honest.
//
// THE PROBLEM. A row carries "verified by X on date D". Someone edits the content and
// leaves the timestamp alone — a routine UPDATE, no error, no warning. From that moment
// the record claims that X vouched for text X never saw. Nothing in the application layer
// notices, because the application layer is exactly what was bypassed.
//
// WHY IN THE DATABASE AND NOT IN A TEST. A static test reads the code in your repository.
// An audit of our own production machine found 43 .js files that existed only on the
// server — one-off remediations, imports, cleanups. One of them trimmed prefixes in
// product names and, as a side effect of an unrelated UPDATE, set the "verified" flag on
// every row it touched. No guard living in the repository can see a file that is not in
// the repository. The gate has to stand where nobody can walk around it: in the database,
// where it also applies to a manual UPDATE typed at the console.
//
// TWO DESIGN CHOICES THAT DECIDE WHETHER THIS IS USABLE:
//
//  1. The revoke trigger fires only on a REAL signature (signatory column non-empty). Rows
//     flagged as published by some import, with no human author, are untouched.
//  2. The content column list is exactly the content a human vouched for. Prices, images,
//     stock flags and other operational fields are NOT on it, so routine imports do not
//     strip signatures. Getting this list wrong in either direction is the whole game:
//     too wide and the guard fires constantly and gets disabled, too narrow and it misses
//     the edit that matters.
//
// The escape hatch is deliberate and must stay: whoever re-verifies on purpose sets the
// timestamp in the SAME statement, and the trigger stays quiet. Re-verification is a human
// act, not a workaround.

const ident = (name) => {
  const s = String(name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`unsafe SQL identifier: ${s}`);
  return s;
};
const sqlText = (s) => `'` + String(s).split(`'`).join(`''`) + `'`;

/**
 * Revoke the signature when signed content changes without a new sign-off timestamp.
 *
 * @param {object} o
 * @param {string} o.table
 * @param {string[]} o.contentColumns   columns a human actually vouched for
 * @param {string} o.signatoryColumn    e.g. 'verified_by'
 * @param {string} o.timestampColumn    e.g. 'verified_at'
 * @param {string} [o.idColumn]         primary key, default 'id'
 * @param {string} [o.name]             trigger name
 * @param {object} [o.audit]            {table, taskColumn, statusColumn, messageColumn, task, status}
 * @returns {string} CREATE TRIGGER statement
 */
export function signatureRevokeTrigger(o) {
  const table = ident(o.table);
  const sig = ident(o.signatoryColumn);
  const ts = ident(o.timestampColumn);
  const id = ident(o.idColumn || 'id');
  const name = ident(o.name || `trg_${table}_signature_revoke`);
  if (!Array.isArray(o.contentColumns) || !o.contentColumns.length) {
    throw new Error('signatureRevokeTrigger: contentColumns must be a non-empty array');
  }
  const changed = o.contentColumns
    .map(ident)
    .map((c) => `IFNULL(NEW.${c},'') <> IFNULL(OLD.${c},'')`)
    .join('\n         OR ');

  let body = `UPDATE ${table} SET ${sig} = NULL, ${ts} = NULL WHERE ${id} = NEW.${id};`;
  if (o.audit) {
    const a = o.audit;
    body += `\n        INSERT INTO ${ident(a.table)}(${ident(a.taskColumn || 'task')}, ${ident(a.statusColumn || 'status')}, ${ident(a.messageColumn || 'message')})\n`
      + `        VALUES(${sqlText(a.task || 'signature_guard')}, ${sqlText(a.status || 'error')},\n`
      + `               ${sqlText(`Signature revoked on ${o.table}:`)} || NEW.${id} || ${sqlText(' — content changed without a new sign-off timestamp. The record is withheld until re-verification.')});`;
  }

  return `CREATE TRIGGER IF NOT EXISTS ${name}
      AFTER UPDATE ON ${table} FOR EACH ROW
      WHEN OLD.${sig} IS NOT NULL AND TRIM(OLD.${sig}) <> ''
       AND NEW.${ts} IS OLD.${ts}
       AND (${changed})
      BEGIN
        ${body}
      END`;
}

/**
 * Refuse to raise a "published/verified" flag without naming an author.
 *
 * Watches the TRANSITION 0 -> 1, not the state. Watching the state would abort every
 * unrelated UPDATE on rows that are already flagged — in our case thousands of rows
 * flagged by an importer — and the first price refresh would take the site down.
 */
export function signatureAuthorTrigger(o) {
  const table = ident(o.table);
  const flag = ident(o.flagColumn);
  const sig = ident(o.signatoryColumn);
  const name = ident(o.name || `trg_${table}_signature_author`);
  const message = o.message || `Signature without an author: ${o.flagColumn}=1 requires ${o.signatoryColumn}.`;
  return `CREATE TRIGGER IF NOT EXISTS ${name}
      BEFORE UPDATE ON ${table} FOR EACH ROW
      WHEN NEW.${flag} = 1
       AND IFNULL(OLD.${flag}, 0) <> 1
       AND (NEW.${sig} IS NULL OR TRIM(NEW.${sig}) = '')
      BEGIN
        SELECT RAISE(ABORT, ${sqlText(message)});
      END`;
}
