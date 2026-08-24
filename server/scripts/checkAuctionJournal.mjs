#!/usr/bin/env node
// Drift gate for the 2026-08-24 auction settlement journal (claudedocs/server.md "拍卖行成交原子性").
//
// The auction house is the one flow in this codebase whose atomicity boundary spans three processes and
// four databases — coins in commercial, the listing here, the item and the seller's proceeds in meta — so
// it cannot be wrapped in a Mongo transaction and instead runs on a durable journal (auctionsvc's
// `auctionOrders`): record the intent, then re-drive the owed steps until they land.
//
// A journal is worth exactly nothing if a new flow can move coins or items without recording that it owes
// them. That is not a hypothetical: the code this replaced fired its mail sends inline and swallowed the
// failures, so one meta 500 silently destroyed a seller's proceeds. Nor is key discipline a hypothetical —
// both money-losing bugs found in that audit were malformed idempotency keys rather than missing locks
// (`auction_buy:{id}` carried no buyer; two same-amount bids from one bidder shared a key and refunded a
// charge that had only happened once).
//
// Neither property is expressible in the type system, so they are enforced here as five file-scope rules:
// each cross-service capability lives in exactly one file, and every `auction_…` key is minted in exactly
// one file. Deliberately a shallow syntactic check — a reviewer can verify a "which file is this call in"
// rule by eye, and the failure mode that matters is somebody adding a fourth call site.
//
// Two restrictions carried over from checkAbsoluteWrites.mjs, both learned the hard way:
//
//  * Comments are stripped first. Every rule below is *documented* in prose that necessarily quotes the
//    forbidden shapes (this file included). A gate that fails on its own documentation gets deleted.
//  * The gate is mutation-tested against fixtures (auctionsvc/test/check-auction-journal.test.ts): one
//    clean tree that must pass, and one deliberate violation per rule that must fail, each asserted by
//    rule id. A gate that cannot fail is worse than no gate, because it reads as coverage.
//
// Usage: node scripts/checkAuctionJournal.mjs   (cwd = server/)
//        --root=<dir> points at a different server/ tree (used by the mutation test's fixtures).

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg ? resolve(rootArg.slice('--root='.length)) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = join(ROOT, 'auctionsvc', 'src');

/**
 * One capability per row: what may not be called, and the single file allowed to call it.
 *
 * `defined` is the client module that declares and implements the capability — the interface, the HTTP
 * body, the null fallback. Those mentions are structural, not call sites, so they are exempt.
 */
const RULES = [
  {
    id: 'spend',
    what: 'commercial coin debit',
    pattern: /\bcommercial\.spend\s*\(/g,
    allowed: 'auctionService/journalSteps.ts',
    defined: ['commercialClient.ts'],
    why: 'a charge nobody recorded cannot be refunded, redelivered, or even found',
  },
  {
    id: 'mail',
    what: 'meta system mail',
    pattern: /\bsendSystemMail\s*\(/g,
    allowed: 'auctionService/delivery.ts',
    defined: ['mailClient.ts'],
    why: 'this is how items and coins reach players; an unrecorded send that fails is an asset destroyed',
  },
  {
    id: 'inventory',
    what: 'meta inventory escrow/grant',
    pattern: /\bmeta\.(?:escrow|grant)[A-Za-z]*\s*\(|\bmeta\.deductMaterial\s*\(/g,
    allowed: 'auctionService/journalSteps.ts',
    defined: ['metaClient.ts'],
    why: 'an escrow with no journal row is an item that left an inventory with nothing owing it back',
  },
  {
    id: 'deliver',
    what: 'delivery helper',
    pattern: /\bdeliver(?:Item|Coins)\s*\(/g,
    allowed: 'auctionService/journalSteps.ts',
    defined: ['auctionService/delivery.ts'],
    why: 'the delivery helpers are journal step executors; calling them directly bypasses the retry that makes a failed hand-over recoverable',
  },
  {
    id: 'key',
    what: 'idempotency key literal',
    // Any `auction_…` string: the prefix every commercial orderId / mail dispatchKey in this service carries.
    pattern: /auction_[a-z]/g,
    allowed: 'auctionService/journalPlans.ts',
    defined: [],
    why: 'a hand-built key is how a buyer-less purchase key and a shared bid key both got shipped',
  },
];

/**
 * Blank out comments, preserving offsets so reported line numbers stay accurate. Not a real tokenizer: it
 * does not track string literals, so a `//` inside a string would start a "comment". Acceptable here — the
 * consequence is a missed candidate, never a false alarm.
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

if (!existsSync(SCAN)) {
  console.error(`checkAuctionJournal(): nothing to scan at ${SCAN}`);
  process.exit(2);
}

const violations = [];
/** rule id → did the allowed file actually still contain the capability. Guards against a rule quietly going dead. */
const seenInAllowed = new Map(RULES.map((r) => [r.id, false]));

for (const abs of walk(SCAN)) {
  const rel = relative(SCAN, abs).split(sep).join('/');
  // The generated router is codegen output; it never touches assets and is not hand-edited.
  if (rel.startsWith('generated/')) continue;
  const text = stripComments(readFileSync(abs, 'utf8'));

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(text)) !== null) {
      if (rel === rule.allowed) {
        seenInAllowed.set(rule.id, true);
        continue;
      }
      if (rule.defined.includes(rel)) continue;
      violations.push({
        rule: rule.id,
        file: `auctionsvc/src/${rel}`,
        line: text.slice(0, m.index).split('\n').length,
        snippet: m[0].trim(),
        what: rule.what,
        allowed: rule.allowed,
        why: rule.why,
      });
    }
  }
}

const dead = [...seenInAllowed.entries()].filter(([, seen]) => !seen).map(([id]) => id);

if (violations.length === 0 && dead.length === 0) {
  console.log(`checkAuctionJournal(): scanned auctionsvc/src, ${RULES.length} capability rules all live, 0 unjournaled call sites.`);
  process.exit(0);
}

if (dead.length > 0) {
  console.error('FAILED — a rule no longer matches anything in the file that is supposed to own it, so it');
  console.error('         is silently enforcing nothing. Either the capability moved (point `allowed` at its');
  console.error('         new home) or it is gone (delete the rule). See claudedocs/server.md "拍卖行成交原子性".');
  for (const id of dead) {
    const rule = RULES.find((r) => r.id === id);
    console.error(`  • ${id}: expected ${rule.what} in auctionsvc/src/${rule.allowed}`);
  }
}

if (violations.length > 0) {
  console.error('FAILED — auction side effect outside the settlement journal (see claudedocs/server.md "拍卖行成交原子性"):');
  for (const v of violations) {
    console.error(`  • ${v.file}:${v.line}  ${v.snippet}`);
    console.error(`      ${v.what} belongs in auctionsvc/src/${v.allowed} — ${v.why}`);
  }
}
process.exit(1);
