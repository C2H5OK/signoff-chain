#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 SuplerMed
// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import { chainPath, lines, computeChain, writeChain, readChain, compare } from '../src/chain.mjs';
import { validateRegister } from '../src/register.mjs';
import { signatureRevokeTrigger, signatureAuthorTrigger } from '../src/triggers.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf('--' + name);
  return i > -1 ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes('--' + name);
const num = (name, fallback) => { const v = flag(name); return v === undefined ? fallback : Number(v); };

const usage = () => {
  console.log(`signoff — verifiable human sign-off for published content

  signoff chain build   <file> [--force] [--seed S]
  signoff chain verify  <file> [--seed S]
  signoff chain extend  <file>            rows appended at the end
  signoff chain merge   <file>            rows inserted in the middle (deliberate)

  signoff register validate <file> --identifier <literal> --columns <n>
        --name-column <n> --id-column <n> --date-column <n>
        [--prose-column <n>] [--delimiter <c>] [--header-prefix <s>]
        [--status-column <n>] [--signed-status <s>]

  signoff triggers <config.json>          print the SQL, apply it yourself

Exit code 0 means "no known tampering pattern found". It does not mean "correct".`);
};

function chainCmd() {
  const cmd = argv[1];
  const target = argv[2];
  if (!target) { usage(); process.exit(2); }
  const seed = flag('seed');
  const opts = seed ? { seed } : {};
  if (!fs.existsSync(target)) { console.error(`no such register: ${target}`); process.exit(2); }
  const CHAIN = chainPath(target);
  const L = lines(fs.readFileSync(target, 'utf8'));

  if (cmd === 'build') {
    if (fs.existsSync(CHAIN) && !has('force')) {
      console.error(`REFUSED: ${path.basename(CHAIN)} already exists.`);
      console.error('   Recomputing from scratch DESTROYS the evidence for everything sealed so far.');
      console.error('   To seal new rows use `extend`. To really start over pass --force.');
      process.exit(1);
    }
    const c = computeChain(L, opts);
    writeChain(CHAIN, c);
    console.log(`built a chain over ${L.length} lines -> ${path.basename(CHAIN)}`);
    console.log(`seal (last digest): ${c.at(-1)?.chain ?? '(empty file)'}`);
    process.exit(0);
  }

  if (!fs.existsSync(CHAIN)) {
    console.error(`no chain file: ${CHAIN}\n   Build it once: signoff chain build ${target}`);
    process.exit(2);
  }
  const sealed = readChain(CHAIN);
  const w = compare(sealed, L, opts);

  if (cmd === 'extend') {
    if (w.state === 'APPEND_ONLY') { writeChain(CHAIN, computeChain(L, opts)); console.log(`extended by ${w.added} rows (${w.sealed} -> ${w.present}).`); process.exit(0); }
    if (w.state === 'MATCH') { console.log('nothing to extend — the chain covers the whole file.'); process.exit(0); }
    if (w.state === 'INTERLEAVED') {
      console.error(`REFUSED: ${w.added} rows landed in the MIDDLE of the file (first at line ${w.firstInsertion}).`);
      console.error('   The whole history is intact — this looks like a merge of two copies, not tampering.');
      console.error(`   Seal it deliberately: signoff chain merge ${target}`);
      process.exit(1);
    }
    console.error(`REFUSED: ${w.state} at row ${w.row}. Extending would seal a change to history as truth.`);
    process.exit(1);
  }

  if (cmd === 'merge') {
    if (w.state === 'MATCH') { console.log('nothing to merge.'); process.exit(0); }
    if (w.state === 'APPEND_ONLY' || w.state === 'INTERLEAVED') {
      const where = w.state === 'INTERLEAVED' ? w.inserted : [];
      console.log(`-- MERGE -- ${w.state}, new rows: ${w.added}`);
      for (const n of where.slice(0, 20)) console.log(`   ${String(n).padStart(5)}: ${L[n - 1].slice(0, 110)}`);
      if (where.length > 20) console.log(`   ... and ${where.length - 20} more`);
      writeChain(CHAIN, computeChain(L, opts));
      console.log(`sealed ${L.length} lines. Everything sealed before the merge is preserved.`);
      process.exit(0);
    }
    console.error(`REFUSED: ${w.state} at row ${w.row} — ${w.diagnosis}. This is not a merge.`);
    process.exit(1);
  }

  console.log(`-- REGISTER CHAIN -- ${path.basename(target)}`);
  console.log(`lines in file: ${w.present}`);
  console.log(`sealed:        ${w.sealed}`);
  console.log(`state:         ${w.state}`);
  if (w.ok) {
    if (w.state === 'MATCH') console.log(`seal:          ${sealed.at(-1).chain}\n\nNo historical row was changed or removed.`);
    if (w.state === 'APPEND_ONLY') console.log(`new rows:      ${w.added} (appended at the end)\n\nHistory intact. Seal them: signoff chain extend ${target}`);
    if (w.state === 'INTERLEAVED') console.log(`new rows:      ${w.added} (inserted mid-file, first at line ${w.firstInsertion})\n\n${w.diagnosis}.\nSeal them: signoff chain merge ${target}`);
    process.exit(0);
  }
  console.error(`\n${w.state} — first divergence at row ${w.row}.\n   ${w.diagnosis}`);
  console.error(`   Find out what changed that row BEFORE recomputing the chain.`);
  process.exit(1);
}

function registerCmd() {
  const target = argv[2];
  if (!target || !fs.existsSync(target)) { console.error(`no such register: ${target}`); process.exit(2); }
  const L = fs.readFileSync(target, 'utf8').split('\n');
  const r = validateRegister(L, {
    identifier: flag('identifier'),
    columns: num('columns'),
    nameColumn: num('name-column'),
    idColumn: num('id-column'),
    dateColumn: num('date-column'),
    proseColumn: num('prose-column', num('columns')),
    delimiter: flag('delimiter', ';'),
    headerPrefix: flag('header-prefix', null),
    statusColumn: num('status-column', null),
    signedStatus: flag('signed-status', null),
  });
  for (const p of r.problems) console.log(`row ${p.row}: ${p.reason}\n   ${p.line}`);
  console.log(`\nchecked ${r.checked} rows (${r.signed} carrying a signature), shifted signatures: ${r.problems.length}`);
  if (r.statuses && r.statuses.byContainment !== r.statuses.byEquality) {
    console.log(`statuses: counting signed rows by CONTAINMENT gives ${r.statuses.byContainment}, by equality ${r.statuses.byEquality}`);
    for (const m of r.statuses.missedByEquality) console.log(`   equality misses: ${m.status} (${m.count})`);
  }
  process.exit(r.ok ? 0 : 1);
}

function triggersCmd() {
  const cfgPath = argv[1];
  if (!cfgPath || !fs.existsSync(cfgPath)) { console.error('usage: signoff triggers <config.json>'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  for (const t of cfg.revoke || []) console.log(signatureRevokeTrigger(t) + ';\n');
  for (const t of cfg.author || []) console.log(signatureAuthorTrigger(t) + ';\n');
}

const cmd = argv[0];
if (cmd === 'chain') chainCmd();
else if (cmd === 'register') registerCmd();
else if (cmd === 'triggers') triggersCmd();
else { usage(); process.exit(argv.length ? 2 : 0); }
