// Server-side IVAC bundle extractor.
//
// Runs an obfuscated client bundle in a Node vm sandbox and recovers a clean,
// algorithm-agnostic codec (shift tables captured by probing the bundle's OWN
// encrypt function — never reconstructed). Handles multiple bundle shapes:
//
//   shape A ("hQ" style): config is an object literal
//      {secret:<expr>, startAt:N, length:M, version:K}
//      and a version->loader map resolves the per-version codec module.
//
//   shape B ("LF" style): config is split — the key is a module const passed at
//      the codec call site as int literals: encryptText(token, KEY, startAt, length).
//
// Strategy: collect candidate (codecModule, key, startAt, length) triples from
// every shape, run the bundle ONCE with all candidates injected for live
// evaluation, then probe + verify each. The app's call site / config literal is
// the ground truth for the key (encryptText is generic over the key, so it can
// only be read from how the app wires it — not guessed).
//
// NOTHING here runs client-side; the bundle and any API key stay on the server.

import vm from 'node:vm';

export const CHARSET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_';

// ---------------------------------------------------------------- helpers ----
// A captured codec MODEL is one of:
//   { kind:'shift',  len, shifts:[len] }        position keystream: out=(x+shift[i])%64
//   { kind:'sub',    len, table:[64] }           per-char substitution (same every position)
//   { kind:'tables', len, tables:[len][64] }     per-position substitution
// applyModel runs any of them in JS (sign +1 encode, -1 decode via inverse).
function applyModel(token, model, startAt, sign) {
  const len = model.len;
  const p = Math.max(0, Math.min(startAt, token.length));
  const w = Math.max(0, Math.min(len, Math.max(0, token.length - p)));
  if (w === 0) return token;
  const ch = token.slice(p, p + w).split('');
  for (let i = 0; i < w; i++) {
    const x = CHARSET.indexOf(ch[i]);
    if (x === -1) continue;
    let y;
    if (model.kind === 'shift') {
      y = (((x + sign * model.shifts[i]) % 64) + 64) % 64;
    } else {
      const tbl = model.kind === 'sub' ? model.table : model.tables[i];
      y = sign > 0 ? tbl[x] : tbl.indexOf(x);
    }
    ch[i] = CHARSET[y];
  }
  return token.slice(0, p) + ch.join('') + token.slice(p + w);
}

// Build a fresh browser-ish sandbox so the bundle reaches our injection.
function makeSandbox(extra) {
  const noop = () => {};
  let document;
  function makeEl() {
    return {
      nodeType: 1, style: {}, children: [], childNodes: [], parentNode: null,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      dataset: {}, textContent: '', innerHTML: '',
      appendChild: (c) => c, removeChild: noop, setAttribute: noop, getAttribute: () => null,
      addEventListener: noop, removeEventListener: noop, remove: noop, insertBefore: (c) => c,
      cloneNode: () => makeEl(), sheet: { insertRule: noop, cssRules: [] },
      querySelector: () => null, querySelectorAll: () => [], focus: noop, click: noop,
      get ownerDocument() { return document; },
    };
  }
  document = {
    nodeType: 9, createElement: () => makeEl(), createElementNS: () => makeEl(),
    createTextNode: () => makeEl(), createComment: () => makeEl(),
    querySelector: () => makeEl(), querySelectorAll: () => [], getElementById: () => makeEl(),
    getElementsByTagName: () => [], addEventListener: noop, removeEventListener: noop,
    documentElement: makeEl(), head: makeEl(), body: makeEl(), cookie: '',
    styleSheets: [], adoptedStyleSheets: [], implementation: { createHTMLDocument: () => document },
  };
  const storage = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop };
  const s = {
    console, Math, JSON, Date, Object, Array, String, Number, Boolean, RegExp, Symbol,
    Error, TypeError, RangeError, SyntaxError, Promise, Map, Set, WeakMap, WeakSet, Proxy,
    Reflect, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    btoa: (x) => Buffer.from(x, 'binary').toString('base64'),
    atob: (x) => Buffer.from(x, 'base64').toString('binary'),
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    queueMicrotask: noop, requestAnimationFrame: noop, cancelAnimationFrame: noop,
    fetch: () => Promise.reject(new Error('nonet')), TextEncoder, TextDecoder, URL, URLSearchParams,
    document, localStorage: storage, sessionStorage: storage,
    navigator: { userAgent: 'node', language: 'en', languages: ['en'] },
    location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', pathname: '/', search: '', hash: '' },
    history: { pushState: noop, replaceState: noop },
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    MutationObserver: function () { return { observe: noop, disconnect: noop, takeRecords: () => [] }; },
    IntersectionObserver: function () { return { observe: noop, disconnect: noop }; },
    ResizeObserver: function () { return { observe: noop, disconnect: noop }; },
    crypto: { getRandomValues: (a) => a, randomUUID: () => '0', subtle: {} },
    ...extra,
  };
  s.globalThis = s; s.self = s; s.window = s; s.top = s; s.parent = s; s.frames = s;
  s.addEventListener = noop; s.removeEventListener = noop; s.dispatchEvent = noop;
  s.alert = noop; s.confirm = () => false; s.prompt = () => null;
  return s;
}

const dedupe = (arr, keyer) => {
  const seen = new Set(), out = [];
  for (const x of arr) { const k = keyer(x); if (seen.has(k)) continue; seen.add(k); out.push(x); }
  return out;
};

// ---------------------------------------------------- static candidate scan --
// Returns { codecModuleVars, literalConfigs, callSiteConfigs, versionMapVar, families }
export function scanBundle(src) {
  // codec module export objects: VAR=Object.freeze(Object.defineProperty({__proto__:null,decryptText:X,encryptText:Y}…
  const codecModuleVars = dedupe(
    [...src.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*Object\.freeze\(Object\.defineProperty\(\{__proto__:null,\s*decryptText:[A-Za-z_$][\w$]*,\s*encryptText:[A-Za-z_$][\w$]*\}/g)]
      .map((m) => m[1]),
    (v) => v,
  );

  // shape A: literal config objects with numeric startAt/length/version
  const literalConfigs = [...src.matchAll(/\{secret:([^{}]*?),startAt:(\d+),length:(\d+),version:(\d+)\}/g)]
    .map((m) => ({ keyExpr: m[1], startAt: +m[2], length: +m[3], version: +m[4] }));

  // shape A: version -> loader map: VAR={1:()=>…Promise.resolve…,2:()=>…}
  const mapMatch = src.match(/\b([A-Za-z_$][\w$]*)\s*=\s*\{1:\(\)=>[^{}]*?Promise\.resolve/);
  const versionMapVar = mapMatch ? mapMatch[1] : null;

  // shape B: call-site config — (…, KEYVAR, startAtInt, lengthInt))
  // KEYVAR is an identifier (a module const holding the key string).
  const callSiteConfigs = dedupe(
    [...src.matchAll(/,\s*([A-Za-z_$][\w$]*)\s*,\s*(\d{1,2})\s*,\s*(\d{1,3})\)\)/g)]
      .map((m) => ({ keyExpr: m[1], startAt: +m[2], length: +m[3] }))
      .filter((c) => c.startAt >= 0 && c.startAt <= 24 && c.length >= 6 && c.length <= 48),
    (c) => c.keyExpr + '|' + c.startAt + '|' + c.length,
  );

  // candidate KEY variables: identifiers assigned a long string / decoder-concat,
  // plus the key idents seen at call sites. These are evaluated live to get real
  // key values for sample-verification.
  const keyVars = dedupe([
    ...[...src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\([^()]*\)|"[^"]*")(?:\+(?:[A-Za-z_$][\w$]*\([^()]*\)|"[^"]*")){4,}/g)].map((m) => m[1]),
    ...callSiteConfigs.map((c) => c.keyExpr),
  ], (v) => v);

  const families = [];
  if (/3\.99/.test(src)) families.push('logistic-map');
  if (/%\s*67/.test(src)) families.push('polynomial-mod-67');
  if (!families.length) families.push('unknown');

  return { codecModuleVars, literalConfigs, callSiteConfigs, versionMapVar, keyVars, families };
}

// ------------------------------------------------- run bundle + capture refs --
// Injects, just before the closing IIFE, a capture of: codec module vars, the
// version map, literal-config evaluations, and call-site key evaluations.
// `extraConfigs` lets the AI fallback feed additional {keyExpr,startAt,length}.
function runAndCapture(src, scan, extraConfigs = [], aiOnly = false) {
  const ci = src.lastIndexOf('}()');
  if (ci === -1) throw new Error('bundle is not a self-executing IIFE (no trailing }())');

  // In aiOnly mode we ignore the deterministic config scan entirely and trust
  // ONLY the AI-located configs (still evaluated + verified by the real bundle).
  const litExprs = aiOnly ? [] : scan.literalConfigs.map((c, i) =>
    `try{__L[${i}]={key:(${c.keyExpr}),startAt:${c.startAt},length:${c.length},version:${c.version}}}catch(e){}`);
  const allCall = aiOnly ? extraConfigs : [...scan.callSiteConfigs, ...extraConfigs];
  const callExprs = allCall.map((c, i) =>
    `try{__C[${i}]={key:(${c.keyExpr}),startAt:${c.startAt},length:${c.length}}}catch(e){}`);

  const keyExprs = (scan.keyVars || []).map((v) =>
    `try{__K[${JSON.stringify(v)}]=${v}}catch(e){}`);
  const inject =
    ';try{' +
    'globalThis.__MODS={' + scan.codecModuleVars.map((v) => `${JSON.stringify(v)}:${v}`).join(',') + '};' +
    (scan.versionMapVar ? `globalThis.__MAP=${scan.versionMapVar};` : 'globalThis.__MAP=null;') +
    'globalThis.__L={};' + litExprs.join('') +
    'globalThis.__C={};' + callExprs.join('') +
    'globalThis.__K={};' + keyExprs.join('') +
    '}catch(e){globalThis.__E=String(e)};';

  const patched = src.slice(0, ci) + inject + src.slice(ci);
  const sandbox = makeSandbox({ __MODS: null, __MAP: null, __L: null, __C: null, __K: null, __E: null });
  try {
    vm.runInNewContext(patched, sandbox, { timeout: 6000 });
  } catch (e) {
    // App often throws after our capture ran (integrity checks / React) — fine.
  }
  return { sandbox, allCall };
}

// Probe a codec module by feeding a window of each of the 64 alphabet chars and
// reading the output per position. This captures the FULL behaviour — whether
// it's a position keystream, a per-char substitution, or per-position tables —
// instead of assuming a single +shift form. Returns a model, or null if the
// function isn't an invertible windowed transform over the alphabet.
function captureModel(mod, key, startAt, length) {
  if (!mod || typeof mod.encryptText !== 'function') return null;
  try {
    const N = length;
    const tables = Array.from({ length: N }, () => new Array(64));
    for (let v = 0; v < 64; v++) {
      const probe = 'x'.repeat(startAt) + CHARSET[v].repeat(N);
      const win = mod.encryptText(probe, key, startAt, N).slice(startAt, startAt + N);
      if (win.length !== N) return null;
      for (let i = 0; i < N; i++) {
        const o = CHARSET.indexOf(win[i]);
        if (o < 0) return null;
        tables[i][v] = o;
      }
    }
    // each position must be a bijection (so decode is well-defined)
    for (let i = 0; i < N; i++) if (new Set(tables[i]).size !== 64) return null;

    // classify, most-specific first
    // (a) pure position shift: tables[i][v] === (v + k_i) mod 64
    let isShift = true;
    const shifts = [];
    for (let i = 0; i < N && isShift; i++) {
      const k = tables[i][0] % 64;
      for (let v = 0; v < 64; v++) if (tables[i][v] !== (v + k) % 64) { isShift = false; break; }
      shifts.push(k);
    }
    if (isShift) return { kind: 'shift', len: N, shifts };

    // (b) position-independent substitution: every position has the same table
    let posIndep = true;
    for (let i = 1; i < N && posIndep; i++) for (let v = 0; v < 64; v++) if (tables[i][v] !== tables[0][v]) { posIndep = false; break; }
    if (posIndep) return { kind: 'sub', len: N, table: tables[0] };

    // (c) general per-position tables
    return { kind: 'tables', len: N, tables };
  } catch (e) {
    return null;
  }
}

// verify a captured model reproduces the bundle's own encrypt + roundtrips
function verify(mod, key, startAt, length, model) {
  try {
    const tok = '1.' + 'aB3xZ-_qrs0u'.repeat(18);
    const real = mod.encryptText(tok, key, startAt, length);
    const baked = applyModel(tok, model, startAt, +1);
    if (real !== baked) return false;
    const back = typeof mod.decryptText === 'function'
      ? mod.decryptText(baked, key, startAt, length)
      : applyModel(baked, model, startAt, -1);
    return back === tok;
  } catch (e) {
    return false;
  }
}

// short numeric preview for the UI (first few values of the model)
function modelPreview(model) {
  if (!model) return null;
  if (model.kind === 'shift') return model.shifts;
  if (model.kind === 'sub') return model.table;
  return model.tables[0];
}

// --------------------------------------------------------- main extraction ----
// Returns { ok, families, codecs:[{name,key,startAt,length,version,shifts,verified,source}], notes, needsAI }
export async function extract(src, extraConfigs = [], opts = {}) {
  const aiOnly = !!opts.aiOnly;
  const scan = scanBundle(src);
  const notes = [];
  if (!scan.codecModuleVars.length) {
    return { ok: false, families: scan.families, codecs: [], needsAI: true,
      notes: ['No codec module (frozen {encryptText,decryptText}) found.'] };
  }

  const { sandbox, allCall } = runAndCapture(src, scan, extraConfigs, aiOnly);
  const mods = sandbox.__MODS || {};
  const modVars = Object.keys(mods).filter((k) => mods[k] && typeof mods[k].encryptText === 'function');
  if (!modVars.length) {
    return { ok: false, families: scan.families, codecs: [], needsAI: true,
      notes: ['Codec modules did not resolve at runtime' + (sandbox.__E ? ' (' + sandbox.__E + ')' : '') + '.'] };
  }

  const codecs = [];
  const push = (rec) => {
    if (rec.model) rec.preview = modelPreview(rec.model);
    const dup = codecs.find((c) => c.key === rec.key && c.startAt === rec.startAt && c.length === rec.length);
    if (!dup) codecs.push(rec);
  };
  const nameFor = (c) =>
    c.version != null ? (c.startAt === 8 && c.length === 29 ? 'signin' : c.startAt === 6 && c.length === 17 ? 'reserve' : 'v' + c.version)
      : (c.startAt === 8 && c.length === 29 ? 'signin' : c.startAt === 6 && c.length === 17 ? 'reserve' : `codec_${c.startAt}_${c.length}`);

  // --- shape A: literal configs resolved via version map (skipped in aiOnly) ---
  const lit = aiOnly ? {} : (sandbox.__L || {});
  for (const k of Object.keys(lit)) {
    const c = lit[k];
    if (!c || typeof c.key !== 'string') continue;
    let mod = null;
    if (sandbox.__MAP && typeof sandbox.__MAP[c.version] === 'function') {
      try { mod = await sandbox.__MAP[c.version](); } catch (e) { /* ignore */ }
    }
    // fall back to any captured module that yields a windowed cipher
    const tryMods = mod ? [mod] : modVars.map((v) => mods[v]);
    for (const mm of tryMods) {
      const model = captureModel(mm, c.key, c.startAt, c.length);
      if (model) {
        push({ name: nameFor(c), key: c.key, startAt: c.startAt, length: c.length, version: c.version,
          model, kind: model.kind, verified: verify(mm, c.key, c.startAt, c.length, model), source: mod ? 'literal+versionMap' : 'literal+probe' });
        break;
      }
    }
  }

  // --- shape B: call-site configs (key var + int literals) ---
  // Prefer the module/config pairing that actually VERIFIES, so a decoy module
  // that merely "captures" but fails roundtrip doesn't win over the real one.
  const call = sandbox.__C || {};
  const cleanLabel = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  for (const k of Object.keys(call)) {
    const c = call[k];
    if (!c || typeof c.key !== 'string' || c.key.length < 8) continue;
    const hint = allCall[+k] || {};
    const label = cleanLabel(hint.label);
    const name = label ? label : nameFor(c);
    let best = null;
    for (const v of modVars) {
      const model = captureModel(mods[v], c.key, c.startAt, c.length);
      if (!model) continue;
      const verified = verify(mods[v], c.key, c.startAt, c.length, model);
      const rec = { name, key: c.key, startAt: c.startAt, length: c.length, version: null,
        model, kind: model.kind, verified, confidence: hint.confidence ?? null,
        source: extraConfigs.length ? 'ai+callsite' : 'callsite' };
      if (verified) { best = rec; break; }
      if (!best) best = rec;
    }
    if (best) push(best);
  }

  const verifiedCount = codecs.filter((c) => c.verified).length;
  if (!verifiedCount) notes.push('No verified codec from deterministic scan.');
  return {
    ok: verifiedCount > 0,
    families: scan.families,
    codecs: codecs.sort((a, b) => Number(b.verified) - Number(a.verified)),
    needsAI: verifiedCount === 0,
    notes,
    scan: { codecModuleVars: scan.codecModuleVars, versionMapVar: scan.versionMapVar,
      literalConfigs: scan.literalConfigs.length, callSiteConfigs: scan.callSiteConfigs.length },
  };
}

// ---------------------------------------------- sample-verified extraction ----
// Given a real (raw -> encoded) token pair captured from the app, find the EXACT
// (key, startAt, length) whose captured model reproduces the pair. This is the
// only 100%-certain method: it's checked against the real server transform, so
// decoys/integrity windows that merely self-verify are ruled out.
export function extractFromSample(src, sample) {
  const raw = String(sample?.raw || '');
  const encoded = String(sample?.encoded || '');
  if (!raw || !encoded) return { ok: false, codecs: [], notes: ['Provide both raw and encoded token.'] };
  if (raw.length !== encoded.length) {
    return { ok: false, codecs: [], notes: ['raw and encoded differ in length — not a windowed transform (wrong pair?).'] };
  }
  // diff region → window bounds
  let lo = -1, hi = -1;
  for (let i = 0; i < raw.length; i++) if (raw[i] !== encoded[i]) { if (lo < 0) lo = i; hi = i; }
  if (lo < 0) return { ok: false, codecs: [], notes: ['raw and encoded are identical — nothing transformed.'] };

  const scan = scanBundle(src);
  // A codec module is needed only for SUBSTITUTION ciphers (to probe the full
  // alphabet). Position-shift ciphers are solved from the pair alone, so a
  // missing module is NOT fatal — we fall through to derived-shift below.
  let modVars = [];
  let sandbox = null;
  if (scan.codecModuleVars.length) {
    ({ sandbox } = runAndCapture(src, scan, [], false));
    const mods = sandbox.__MODS || {};
    modVars = Object.keys(mods).filter((k) => mods[k] && typeof mods[k].encryptText === 'function');
  }
  const mods = sandbox?.__MODS || {};

  // candidate keys: evaluated key vars + any call-site/literal keys captured
  const keys = new Set();
  for (const v of Object.values(sandbox?.__K || {})) if (typeof v === 'string' && v.length >= 16 && v.length <= 96) keys.add(v);
  for (const c of Object.values(sandbox?.__C || {})) if (c && typeof c.key === 'string') keys.add(c.key);
  for (const c of Object.values(sandbox?.__L || {})) if (c && typeof c.key === 'string') keys.add(c.key);

  // candidate windows: call-site pairs + the diff-derived window (+ a little slack
  // for window chars that map to themselves at the edges)
  const windows = new Map();
  const addWin = (sa, ln) => { if (sa >= 0 && ln > 0 && sa + ln <= raw.length) windows.set(sa + '/' + ln, { startAt: sa, length: ln }); };
  for (const c of scan.callSiteConfigs) addWin(c.startAt, c.length);
  addWin(lo, hi - lo + 1);
  for (let s = Math.max(0, lo - 2); s <= lo; s++) for (let extra = 0; extra <= 6; extra++) addWin(s, hi - s + 1 + extra);

  for (const mv of modVars) {
    const mod = mods[mv];
    for (const key of keys) {
      for (const { startAt, length } of windows.values()) {
        let model;
        try { model = captureModel(mod, key, startAt, length); } catch (e) { continue; }
        if (!model) continue;
        let out;
        try { out = applyModel(raw, model, startAt, +1); } catch (e) { continue; }
        if (out === encoded) {
          // confirmed against the real server token
          const name = startAt === 8 && length === 29 ? 'signin' : startAt === 6 && length === 17 ? 'reserve' : `codec_${startAt}_${length}`;
          const rec = { name, key, startAt, length, version: null, model, kind: model.kind,
            verified: true, source: 'sample', preview: modelPreview(model) };
          return { ok: true, families: scan.families, codecs: [rec], notes: [`Matched real token sample at startAt ${startAt}, length ${length}.`] };
        }
      }
    }
  }
  // Fallback: no codec MODULE reproduced the pair. If the transform is a position
  // shift (e.g. a baked standalone signin function with a hardcoded shift table
  // and no key), a single pair fully defines it — derive it directly. shift[i] =
  // (encIdx - rawIdx) mod 64 over the diff window; this reproduces the pair by
  // construction and is correct for ALL tokens iff the cipher is a position shift.
  {
    const sa = lo, length = hi - lo + 1;
    const shifts = [];
    let okShift = true;
    for (let i = 0; i < length; i++) {
      const x = CHARSET.indexOf(raw[sa + i]);
      const y = CHARSET.indexOf(encoded[sa + i]);
      if (x < 0 || y < 0) { okShift = false; break; }
      shifts.push(((y - x) % 64 + 64) % 64);
    }
    if (okShift) {
      const model = { kind: 'shift', len: length, shifts };
      const name = sa === 8 && length === 29 ? 'signin' : sa === 6 && length === 17 ? 'reserve' : `codec_${sa}_${length}`;
      return { ok: true, families: scan.families,
        codecs: [{ name, key: '(no key — derived from sample)', startAt: sa, length, version: null, model, kind: 'shift', verified: true, source: 'sample-derived-shift', preview: shifts }],
        notes: [`No codec module reproduced the sample; derived a position-shift model directly from the pair (startAt ${sa}, length ${length}). This is exact IF the cipher is a position shift (baked-table ciphers like signin are) — confirm with a second token if unsure.`] };
    }
  }

  return { ok: false, families: scan.families, codecs: [],
    notes: [`No (key, window) among ${keys.size} keys × ${windows.size} windows reproduced the sample, and it isn't a plain position shift. The key may be lazy-loaded, or it's a substitution codec not exposed as a module (would need multiple sample pairs).`] };
}

// ------------------------------------------------------- emit codec source ----
// Emits ONLY verified codecs. Assigns unique names so two configs that share a
// startAt/length don't collide into duplicate `const` declarations. Picks the
// right runtime per captured model kind (shift / sub / per-position tables).
export function emitCodec(result, fname = '') {
  const ok = result.codecs.filter((c) => c.verified && c.model);
  if (!ok.length) return '';

  // unique names
  const used = new Set();
  for (const c of ok) {
    let base = c.name, name = base, n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name);
    c.emitName = name;
  }
  const kinds = new Set(ok.map((c) => c.model.kind));

  let s = `// AUTO-GENERATED by IVAC extractor${fname ? ' from ' + fname : ''}
// Behaviour captured from the bundle's own codec (probed over the full alphabet)
// and verified against it — stays correct even if the cipher changes. Re-run on
// a new bundle to refresh. Generator families seen: ${result.families.join(', ')}

const CHARSET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_';

`;
  if (kinds.has('shift')) {
    s += `// position keystream: out = (x + shift[i]) mod 64
function applyShift(token, shifts, startAt, sign) {
  const p = Math.max(0, Math.min(startAt, token.length));
  const w = Math.max(0, Math.min(shifts.length, Math.max(0, token.length - p)));
  if (w === 0) return token;
  const ch = token.slice(p, p + w).split('');
  for (let i = 0; i < w; i++) {
    const x = CHARSET.indexOf(ch[i]);
    if (x !== -1) ch[i] = CHARSET[(((x + sign * shifts[i]) % 64) + 64) % 64];
  }
  return token.slice(0, p) + ch.join('') + token.slice(p + w);
}

`;
  }
  if (kinds.has('sub')) {
    s += `// per-character substitution: out = table[x] (same map at every position)
function applySub(token, table, startAt, length, sign) {
  const p = Math.max(0, Math.min(startAt, token.length));
  const w = Math.max(0, Math.min(length, Math.max(0, token.length - p)));
  if (w === 0) return token;
  const ch = token.slice(p, p + w).split('');
  for (let i = 0; i < w; i++) {
    const x = CHARSET.indexOf(ch[i]);
    if (x !== -1) ch[i] = CHARSET[sign > 0 ? table[x] : table.indexOf(x)];
  }
  return token.slice(0, p) + ch.join('') + token.slice(p + w);
}

`;
  }
  if (kinds.has('tables')) {
    s += `// per-position substitution: out = tables[i][x]
function applyTables(token, tables, startAt, sign) {
  const p = Math.max(0, Math.min(startAt, token.length));
  const w = Math.max(0, Math.min(tables.length, Math.max(0, token.length - p)));
  if (w === 0) return token;
  const ch = token.slice(p, p + w).split('');
  for (let i = 0; i < w; i++) {
    const x = CHARSET.indexOf(ch[i]);
    if (x !== -1) ch[i] = CHARSET[sign > 0 ? tables[i][x] : tables[i].indexOf(x)];
  }
  return token.slice(0, p) + ch.join('') + token.slice(p + w);
}

`;
  }

  const exports = [];
  for (const c of ok) {
    const U = c.emitName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const m = c.model;
    s += `// ${c.emitName}${c.version != null ? ' (v' + c.version + ')' : ''} — ${m.kind}, startAt ${c.startAt}, length ${c.length}, key ${JSON.stringify(c.key)}\n`;
    if (m.kind === 'shift') {
      s += `const ${U}_SHIFTS = [${m.shifts.join(',')}];\n`;
      s += `const ${c.emitName}Encrypt = (t) => applyShift(t, ${U}_SHIFTS, ${c.startAt}, +1);\n`;
      s += `const ${c.emitName}Decrypt = (t) => applyShift(t, ${U}_SHIFTS, ${c.startAt}, -1);\n\n`;
      exports.push(`  ${c.emitName}Encrypt, ${c.emitName}Decrypt, ${U}_SHIFTS`);
    } else if (m.kind === 'sub') {
      s += `const ${U}_TABLE = [${m.table.join(',')}];\n`;
      s += `const ${c.emitName}Encrypt = (t) => applySub(t, ${U}_TABLE, ${c.startAt}, ${c.length}, +1);\n`;
      s += `const ${c.emitName}Decrypt = (t) => applySub(t, ${U}_TABLE, ${c.startAt}, ${c.length}, -1);\n\n`;
      exports.push(`  ${c.emitName}Encrypt, ${c.emitName}Decrypt, ${U}_TABLE`);
    } else {
      s += `const ${U}_TABLES = ${JSON.stringify(m.tables)};\n`;
      s += `const ${c.emitName}Encrypt = (t) => applyTables(t, ${U}_TABLES, ${c.startAt}, +1);\n`;
      s += `const ${c.emitName}Decrypt = (t) => applyTables(t, ${U}_TABLES, ${c.startAt}, -1);\n\n`;
      exports.push(`  ${c.emitName}Encrypt, ${c.emitName}Decrypt, ${U}_TABLES`);
    }
  }

  const helpers = ['CHARSET', kinds.has('shift') && 'applyShift', kinds.has('sub') && 'applySub', kinds.has('tables') && 'applyTables'].filter(Boolean);
  s += 'export {\n  ' + helpers.join(', ') + ',\n' + exports.join(',\n') + '\n};\n';
  return s;
}
