// AI fallback (Tier 2). Runs ONLY when the deterministic extractor can't find a
// verified codec. Claude reads small, relevant slices of the bundle and returns
// the config WIRING — the key variable/expression + startAt + length the app
// passes to encryptText. The bundle's own decoder then computes the real key
// (AI only points; it never produces the key itself), and every AI-proposed
// config is still probed + verified against the bundle before being emitted.
//
// Requires ANTHROPIC_API_KEY in the server environment. If absent, this throws
// a clear error and the caller reports "AI fallback unavailable".

import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';

// $env/dynamic/private reads runtime env (works in dev from .env and in prod
// from real env vars); fall back to process.env for non-SvelteKit callers.
const API_KEY = () => env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const MODEL = env.IVAC_AI_MODEL || process.env.IVAC_AI_MODEL || 'claude-sonnet-4-6';

// Per-1M-token pricing (USD), input / output. Source: Anthropic pricing.
const PRICES = {
  'claude-opus-4-8': { in: 5.0, out: 25.0 },
  'claude-opus-4-7': { in: 5.0, out: 25.0 },
  'claude-opus-4-6': { in: 5.0, out: 25.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'claude-fable-5': { in: 10.0, out: 50.0 },
};
function estimateCostUSD(model, inputTokens, outputTokens) {
  const p = PRICES[model];
  if (!p || inputTokens == null || outputTokens == null) return null;
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}

// Collect compact context windows around the codec wiring so we don't ship 2MB.
function gatherContext(src) {
  const windows = [];
  const add = (idx, before, after, tag) => {
    if (idx < 0) return;
    windows.push(`/* ${tag} @${idx} */\n` + src.slice(Math.max(0, idx - before), idx + after));
  };
  // codec module export(s)
  let m, re = /Object\.freeze\(Object\.defineProperty\(\{__proto__:null,\s*decryptText:[A-Za-z_$][\w$]*,\s*encryptText:[A-Za-z_$][\w$]*\}/g;
  let n = 0;
  while ((m = re.exec(src)) && n < 4) { add(m.index, 200, 200, 'codec-export'); n++; }
  // codec module var usages -> loaders + call sites. Grab the var names first.
  const modVars = [...src.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*Object\.freeze\(Object\.defineProperty\(\{__proto__:null,\s*decryptText:/g)].map((x) => x[1]);
  for (const v of modVars.slice(0, 6)) {
    const loaderRe = new RegExp('\\(\\)=>\\w+\\(\\(\\)=>Promise\\.resolve\\(\\)\\.then\\(\\(\\)=>' + v + '\\)\\)', 'g');
    let lm; let c = 0;
    while ((lm = loaderRe.exec(src)) && c < 2) { add(lm.index, 60, 600, 'codec-loader:' + v); c++; }
  }
  // any 4-arg-ish call with two int literals (likely encrypt(token,key,startAt,length))
  re = /[A-Za-z_$][\w$]*\([^()]{0,40},\s*[A-Za-z_$][\w$]*\s*,\s*\d{1,2}\s*,\s*\d{1,3}\)\)/g; n = 0;
  while ((m = re.exec(src)) && n < 6) { add(m.index, 120, 60, 'callsite'); n++; }
  // long key-like concat consts
  re = /[A-Za-z_$][\w$]*\s*=\s*(?:[A-Za-z_$][\w$]*\([^()]*\)|"[^"]*")(?:\+(?:[A-Za-z_$][\w$]*\([^()]*\)|"[^"]*")){5,}/g; n = 0;
  while ((m = re.exec(src)) && n < 4) { add(m.index, 10, 220, 'key-concat'); n++; }

  let joined = windows.join('\n\n');
  if (joined.length > 22000) joined = joined.slice(0, 22000);
  return joined;
}

// Find API-route strings so the AI can correlate codecs to the flows that use them.
function gatherRoutes(src) {
  return [...new Set(
    [...src.matchAll(/(auth\/sign-?in[\w-]*|auth\/signup|slots\/reserveSlot|slots\/[\w-]+|auth\/[\w-]+)/g)].map((m) => m[1]),
  )].slice(0, 12);
}

const SYSTEM = `You reverse-engineer an obfuscated JavaScript bundle for the IVAC visa client to find how it transforms tokens before sending them to the server. The transform is a windowed character codec over a 64-char alphabet, called as fn(token, key, startAt, length): only token[startAt, startAt+length) is changed; the rest passes through.

KNOWN PATTERNS (from confirmed reverse-engineering of this app — use them to judge candidates):
- The app has a SIGN-IN token transform (route /auth/sign-in-v2 or /auth/signin) and a RESERVE token transform (route /slots/reserveSlot). Sometimes only one is present.
- Real windows are small: startAt is typically 2–10, length 19–29. Each real codec has ONE key (a ~40-64 char string held in a module-level variable, often built by concatenating string-decoder calls) — EXCEPT a sign-in variant that uses a hardcoded shift table and NO key.
- The cipher family varies by version (position shift, keyed shift, or a Feistel/permutation substitution) — you do NOT need to identify the family, only the call site: (key variable, startAt, length).

DECOY TO AVOID — the integrity/tamper self-check. It calls the same codec but:
- passes a LITERAL/CONSTANT string (a concatenation ending in digits like "...23", or containing "secret"/"tKey"/a version marker) as the 2nd argument — NOT a token variable;
- sits inside an \`if(...) throw new Error(...)\` guard;
- uses an off, larger offset window (e.g. startAt 9, length 19). NEVER return this one.

You are given: candidate (startAt/length) windows the static scanner found, the API-route strings present, and code slices. Reason about which candidates are REAL token transforms feeding a server route, which is the integrity decoy, and which are unrelated. Prefer windows that match the KNOWN PATTERNS and sit near a route string or a request body. If two candidates look plausible, return the one whose 2nd argument is a token-like variable and whose window matches the patterns.

Return ONLY JSON, no prose:
{"configs":[{"keyVar":"<identifier holding the key>","startAt":<int>,"length":<int>,"label":"signin|reserve|<short>","confidence":0-1}]}
- keyVar must be a single JS identifier present in the slices (we evaluate it live to get the real key). If a codec uses a hardcoded shift table with no key, set keyVar to "" and we will skip it.
- Return EVERY real codec (usually 1–2). Omit a config rather than guess; set confidence honestly.`;

export function aiAvailable() {
  return !!API_KEY();
}

// Read Anthropic rate-limit headers (Web Headers or plain object) into a usage
// snapshot. NOTE: this is the rolling RATE-LIMIT window (per-minute budget),
// not a dollar/credit balance — the API does not expose account balance on a
// normal key (that's only in the Console). Returns null if no headers.
export function readRateLimit(headers) {
  if (!headers) return null;
  const get = typeof headers.get === 'function' ? (k) => headers.get(k) : (k) => headers[k];
  const num = (k) => { const v = get(k); return v == null || v === '' ? null : Number(v); };
  const rl = {
    requestsLimit: num('anthropic-ratelimit-requests-limit'),
    requestsRemaining: num('anthropic-ratelimit-requests-remaining'),
    requestsReset: get('anthropic-ratelimit-requests-reset') || null,
    tokensLimit: num('anthropic-ratelimit-tokens-limit'),
    tokensRemaining: num('anthropic-ratelimit-tokens-remaining'),
    tokensReset: get('anthropic-ratelimit-tokens-reset') || null,
    inputTokensLimit: num('anthropic-ratelimit-input-tokens-limit'),
    inputTokensRemaining: num('anthropic-ratelimit-input-tokens-remaining'),
    outputTokensLimit: num('anthropic-ratelimit-output-tokens-limit'),
    outputTokensRemaining: num('anthropic-ratelimit-output-tokens-remaining'),
    retryAfter: num('retry-after'),
  };
  return Object.values(rl).some((v) => v != null) ? rl : null;
}

// Map any thrown error from the SDK / network into a short, user-facing message.
// Returns { code, message } — never throws.
export function friendlyAIError(e) {
  const status = e?.status;
  const name = e?.name || '';
  const raw = String(e?.message || e || 'unknown error');
  if (/ANTHROPIC_API_KEY not set/.test(raw)) return { code: 'no_key', message: 'AI fallback is off — no Anthropic API key configured on the server.' };
  if (status === 401 || /authentication/i.test(name)) return { code: 'auth', message: 'Anthropic API key is invalid or expired. Check ANTHROPIC_API_KEY.' };
  if (status === 429 || /rate.?limit/i.test(name)) return { code: 'rate_limit', message: 'Anthropic rate limit reached. Wait a moment and try again.' };
  if (status === 402 || /billing/i.test(raw)) return { code: 'billing', message: 'Anthropic billing/credit issue — check your account balance.' };
  if (status === 403) return { code: 'forbidden', message: 'Anthropic API access denied for this key.' };
  if (status >= 500) return { code: 'server', message: 'Anthropic service is temporarily unavailable. Try again shortly.' };
  if (/APIConnectionError|fetch failed|ENOTFOUND|ECONNREFUSED|network|timeout/i.test(name + raw))
    return { code: 'network', message: "Couldn't reach Anthropic — check the server's network connection." };
  if (/no JSON|JSON parse/i.test(raw)) return { code: 'parse', message: 'AI responded but the result could not be parsed. Try again.' };
  return { code: 'unknown', message: 'AI fallback failed: ' + raw.slice(0, 160) };
}

// Returns { configs:[{keyExpr,startAt,length,label}], usage }.
// `candidates` are the static call-site windows (from scanBundle) used to ground
// the AI's reasoning instead of letting it guess blind.
export async function aiLocateConfigs(src, candidates = []) {
  if (!aiAvailable()) throw new Error('ANTHROPIC_API_KEY not set — AI fallback unavailable.');
  const client = new Anthropic({ apiKey: API_KEY() });
  const context = gatherContext(src);
  const routes = gatherRoutes(src);
  const candStr = candidates.length
    ? candidates.map((c) => `{keyVar:${c.keyExpr}, startAt:${c.startAt}, length:${c.length}}`).join('\n')
    : '(none found by the static scanner — locate the call sites yourself)';
  const userMsg =
    'API-route strings present in the bundle:\n' + (routes.length ? routes.join(', ') : '(none found)') +
    '\n\nCandidate call-site windows the static scanner found (the real codec is usually among these; some are decoys/integrity checks):\n' + candStr +
    '\n\nCode slices from the bundle:\n\n```js\n' + context + '\n```\n\n' +
    'Reason about which candidates are the real token transforms (correlate to the routes; exclude the integrity decoy) and return the JSON.';
  // .withResponse() also gives us the raw Response so we can read rate-limit headers.
  const { data: msg, response } = await client.messages
    .create({
      model: MODEL,
      max_tokens: 768,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    })
    .withResponse();
  const inputTokens = msg?.usage?.input_tokens ?? null;
  const outputTokens = msg?.usage?.output_tokens ?? null;
  const usage = {
    model: MODEL,
    inputTokens,
    outputTokens,
    costUSD: estimateCostUSD(MODEL, inputTokens, outputTokens),
    pricePerMTok: PRICES[MODEL] || null,
    rateLimit: readRateLimit(response?.headers),
  };
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  // Parse problems are non-fatal: keep usage, return no configs (deterministic stands).
  let configs = [];
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const arr = Array.isArray(parsed.configs) ? parsed.configs : [];
      configs = arr
        .filter((c) => c && typeof c.keyVar === 'string' && /^[A-Za-z_$][\w$]*$/.test(c.keyVar)
          && Number.isInteger(c.startAt) && Number.isInteger(c.length))
        .map((c) => ({ keyExpr: c.keyVar, startAt: c.startAt, length: c.length,
          label: typeof c.label === 'string' ? c.label : null,
          confidence: typeof c.confidence === 'number' ? c.confidence : null }));
    } catch { /* keep configs = [] */ }
  }
  return { configs, usage };
}
