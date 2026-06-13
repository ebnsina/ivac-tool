// Browser -> Claude directly. The API key lives only in the user's browser
// (a UI field saved to localStorage); it is never in the build. Anthropic
// permits direct browser calls via the dangerous-direct-browser-access header.

export const PRICES = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-fable-5': { in: 10, out: 50 },
};
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

const SYSTEM = `You reverse-engineer an obfuscated JavaScript bundle for the IVAC visa client to find how it transforms tokens before sending them to the server. The transform is a windowed character codec over a 64-char alphabet, called as fn(token, key, startAt, length): only token[startAt, startAt+length) is changed.

KNOWN PATTERNS (from confirmed reverse-engineering — use to judge candidates):
- The app has a SIGN-IN token transform (route /auth/sign-in-v2 or /auth/signin) and a RESERVE token transform (route /slots/reserveSlot). Sometimes only one is present.
- Real windows are small: startAt 2-10, length 19-29. Each real codec has one key (a ~40-64 char string in a module-level variable), EXCEPT a sign-in variant that uses a hardcoded shift table and NO key.
- Cipher family varies (shift, polynomial, LFSR, LCG, Feistel) — you do NOT identify the family, only the call site: (key variable, startAt, length).

DECOY TO AVOID — the integrity/tamper self-check: it passes a LITERAL/CONSTANT string (a concat ending in digits like "...23" or containing "secret"/"tKey") as the 2nd arg, sits inside an if(...)throw guard, and uses an off window (e.g. startAt 9, length 19). NEVER return it.

You get candidate (startAt/length) windows, the API routes present, and code slices. Reason which candidates are REAL token transforms feeding a route, exclude the integrity decoy.

THE KEY: a single string variable holding ~40-64 chars of random letters/digits/symbols with NO spaces (e.g. "vd@+sy&b)fjogphl3#=3i(-uuqemhdk2%7zuybitu)!^)rcy5v"). It is NOT a CSS class list (no spaces, no "text-"/"px-"/"flex"/"leading-"), NOT a style or className string, NOT a URL or label. If the only candidate you can find is a CSS/style/whitespace string, that is wrong — omit it.

Return ONLY JSON, no prose:
{"configs":[{"keyVar":"<identifier holding the key>","startAt":<int>,"length":<int>,"label":"signin|reserve|<short>"}]}
- keyVar is a single JS identifier present in the slices (evaluated live to get the key); its value must be a no-space cipher key as described above.
- Return every real codec (usually 1-2). Omit rather than guess.`;

function gatherContext(src) {
  const win = [];
  const add = (idx, b, a, tag) => { if (idx < 0) return; win.push(`/* ${tag} */\n` + src.slice(Math.max(0, idx - b), idx + a)); };
  let m, re = /Object\.freeze\(Object\.defineProperty\(\{__proto__:null,\s*decryptText:[A-Za-z_$][\w$]*,\s*encryptText:[A-Za-z_$][\w$]*\}/g, n = 0;
  while ((m = re.exec(src)) && n < 3) { add(m.index, 160, 160, 'codec-export'); n++; }
  re = /[A-Za-z_$][\w$]*\([^()]{0,40},\s*[A-Za-z_$][\w$]*\s*,\s*\d{1,2}\s*,\s*\d{1,3}\)\)/g; n = 0;
  while ((m = re.exec(src)) && n < 6) { add(m.index, 120, 50, 'callsite'); n++; }
  re = /[A-Za-z_$][\w$]*\s*=\s*(?:[A-Za-z_$][\w$]*\([^()]*\)|"[^"]*")(?:\+(?:[A-Za-z_$][\w$]*\([^()]*\)|"[^"]*")){5,}/g; n = 0;
  while ((m = re.exec(src)) && n < 4) { add(m.index, 10, 200, 'key-concat'); n++; }
  let j = win.join('\n\n');
  return j.length > 22000 ? j.slice(0, 22000) : j;
}

export function friendlyAIError(status, raw = '') {
  if (status === 401) return 'API key is invalid or expired.';
  if (status === 403) return 'API key access denied.';
  if (status === 429) return 'Rate limit reached — wait a moment and retry.';
  if (status === 402 || /billing|credit/i.test(raw)) return 'Anthropic billing/credit issue — check your account balance.';
  if (status >= 500) return 'Anthropic service temporarily unavailable.';
  if (status === 0) return 'Could not reach Anthropic from the browser (network/CORS).';
  return 'AI request failed' + (raw ? ': ' + raw.slice(0, 140) : '.');
}

// Returns { configs:[{keyExpr,startAt,length,name}], usage } or throws {status,message}.
export async function aiLocateConfigs(src, candidates, routes, apiKey, model = DEFAULT_MODEL) {
  if (!apiKey) throw { status: 401, message: 'No API key provided.' };
  const context = gatherContext(src);
  const candStr = candidates.length
    ? candidates.map((c) => `{keyVar:${c.keyExpr}, startAt:${c.startAt}, length:${c.length}}`).join('\n')
    : '(none found — locate them yourself)';
  const userMsg =
    'API routes present:\n' + (routes.length ? routes.join(', ') : '(none)') +
    '\n\nCandidate call-site windows (the real codec is usually among these; some are decoys):\n' + candStr +
    '\n\nCode slices:\n\n```js\n' + context + '\n```\n\nReturn the JSON.';

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: 768, system: SYSTEM, messages: [{ role: 'user', content: userMsg }] }),
    });
  } catch (e) {
    throw { status: 0, message: friendlyAIError(0) };
  }
  if (!resp.ok) {
    let body = '';
    try { body = await resp.text(); } catch {}
    throw { status: resp.status, message: friendlyAIError(resp.status, body) };
  }
  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const it = data.usage?.input_tokens ?? null, ot = data.usage?.output_tokens ?? null;
  const p = PRICES[model];
  const usage = { model, inputTokens: it, outputTokens: ot, costUSD: p && it != null ? (it / 1e6) * p.in + (ot / 1e6) * p.out : null, pricePerMTok: p || null };

  let configs = [];
  const jm = text.match(/\{[\s\S]*\}/);
  if (jm) {
    try {
      const parsed = JSON.parse(jm[0]);
      const arr = Array.isArray(parsed.configs) ? parsed.configs : [];
      configs = arr
        .filter((c) => c && typeof c.keyVar === 'string' && /^[A-Za-z_$][\w$]*$/.test(c.keyVar) && Number.isInteger(c.startAt) && Number.isInteger(c.length))
        .map((c) => ({ keyExpr: c.keyVar, startAt: c.startAt, length: c.length, name: (c.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `codec_${c.startAt}_${c.length}` }));
    } catch {}
  }
  return { configs, usage };
}
