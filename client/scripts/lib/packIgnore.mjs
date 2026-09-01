// DevTools `packOptions.ignore` semantics, evaluated statically.
//
// Extracted so exactly one implementation answers "would DevTools pack this file?" —
// `scripts/checkWechatPackage.mjs` rule 4 asks it about a built artifact, and
// `test/wechatAssetUrlShape.test.ts` asks it about the checked-in config in the default suite
// (milliseconds, no 20s build). Two copies of this matcher would recreate the very bug it exists
// to catch: two files each self-consistent, disagreeing about the same contract.
//
// The first version of rule 4 asked a PROXY question — "does the ignore list name the `cdn`
// folder?" — which is only the spelling that had actually shipped. `{"type":"suffix","value":
// ".png"}` excludes 300 assets and that proxy sails through green. Hence the real question, per
// file: is this path excluded, and by which entry.
//
// Supported `type` values are the six DevTools documents: folder / file / suffix / prefix / glob /
// regexp. A pattern this matcher cannot evaluate is neither guessed "packed" nor guessed
// "excluded" — `unsupportedEntries()` reports it so the caller can fail loudly and say what to
// extend. Guessing either way is how a gate starts lying.

/** Path/pattern values arrive in whatever spelling a human typed. One shape to compare. */
function normalize(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Glob metacharacters this matcher implements. Anything else is reported, never guessed. */
const UNSUPPORTED_GLOB = /[[\]{}()!+@]/;

function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` crosses separators; `**/` should also match zero directories, so `**/x` hits `x`.
        i++;
        if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; } else { out += '.*'; }
      } else {
        out += '[^/]*'; // a single `*` stops at a separator
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Entries this matcher declines to evaluate: an unknown `type`, an unparseable `regexp`, or a glob
 * using syntax it does not implement. Callers should fail on a non-empty result rather than treat
 * the entry as inert.
 */
export function unsupportedEntries(ignore) {
  const out = [];
  for (const entry of Array.isArray(ignore) ? ignore : []) {
    const type = entry?.type;
    const value = normalize(entry?.value);
    if (!['folder', 'file', 'suffix', 'prefix', 'glob', 'regexp'].includes(type)) {
      out.push({ entry, why: `unknown packOptions.ignore type ${JSON.stringify(type)}` });
    } else if (type === 'glob' && UNSUPPORTED_GLOB.test(value)) {
      out.push({ entry, why: `glob uses syntax this gate does not implement (${value})` });
    } else if (type === 'regexp') {
      try { new RegExp(value); } catch (e) { out.push({ entry, why: `unparseable regexp (${e.message})` }); }
    }
  }
  return out;
}

/**
 * The `packOptions.ignore` entry that keeps `relPath` (package-root-relative, `/`-separated) out
 * of the package, or `null` when nothing does. Suffix/prefix are matched against the basename as
 * well as the whole path — DevTools is loose about which, and over-reporting an exclusion here
 * only ever produces a louder gate, never a quieter one.
 */
export function ignoredBy(relPath, ignore) {
  const path = normalize(relPath);
  const base = path.split('/').pop() ?? '';
  for (const entry of Array.isArray(ignore) ? ignore : []) {
    const value = normalize(entry?.value);
    if (!value) continue;
    switch (entry?.type) {
      case 'folder': if (path === value || path.startsWith(`${value}/`)) return entry; break;
      case 'file': if (path === value) return entry; break;
      case 'suffix': if (path.endsWith(value) || base.endsWith(value)) return entry; break;
      case 'prefix': if (path.startsWith(value) || base.startsWith(value)) return entry; break;
      case 'glob': if (!UNSUPPORTED_GLOB.test(value) && globToRegExp(value).test(path)) return entry; break;
      case 'regexp': {
        let re = null;
        try { re = new RegExp(value); } catch { /* reported by unsupportedEntries */ }
        if (re?.test(path)) return entry;
        break;
      }
      default: break; // reported by unsupportedEntries
    }
  }
  return null;
}

/** One-line rendering of an entry, for error messages. */
export function describeEntry(entry) {
  return `{"type":"${entry?.type}","value":"${entry?.value}"}`;
}
