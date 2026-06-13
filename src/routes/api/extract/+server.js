// Server-only endpoint. The bundle is executed and the API key is used HERE,
// on the server — never shipped to the browser. The client only POSTs the
// bundle text and receives the generated codec + a report.
//
// Everything is wrapped so the endpoint NEVER 500-crashes on bad input, a
// runaway bundle, or an AI/rate-limit failure: it always returns a structured
// JSON body the UI can render as a friendly message.

import { json } from '@sveltejs/kit';
import { extract, extractFromSample, emitCodec, scanBundle } from '$lib/server/extractor.js';
import { aiAvailable, aiLocateConfigs, friendlyAIError, readRateLimit } from '$lib/server/ai.js';

// This endpoint runs the uploaded bundle in a Node `vm` sandbox — it MUST use
// the Node serverless runtime (not Edge), and needs headroom for the bundle
// execution + AI call.
export const config = { runtime: 'nodejs20.x', maxDuration: 10 };

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'Request body was not valid JSON.' }, { status: 400 });
  }

  const src = typeof body?.source === 'string' ? body.source : '';
  const fname = typeof body?.filename === 'string' ? body.filename : '';
  const useAI = body?.useAI !== false; // default on

  if (!src || src.length < 100) {
    return json({ ok: false, error: 'Please choose or paste a bundle file first.' }, { status: 400 });
  }
  if (src.length > 30 * 1024 * 1024) {
    return json({ ok: false, error: 'That bundle is too large (over 30 MB). This codec lives in the app bundle, which is normally a few MB.' }, { status: 413 });
  }

  const sample = body?.sample && typeof body.sample.raw === 'string' && typeof body.sample.encoded === 'string'
    && body.sample.raw.trim() && body.sample.encoded.trim()
    ? { raw: body.sample.raw.trim(), encoded: body.sample.encoded.trim() } : null;

  const report = { stages: [] };
  const aiInfo = { attempted: false, available: aiAvailable() };
  const fail = (message) => { report.ai = aiInfo; if (!aiInfo.message) aiInfo.message = message; return json({ ok: false, message, families: [], report, codecs: [], code: '' }); };

  // ---- SAMPLE MODE: deterministic 100% — verify against a real raw->encoded
  //      token pair. No AI, no decoy ambiguity. ----
  if (sample) {
    let result;
    try { result = extractFromSample(src, sample); }
    catch (e) { return fail('Could not analyze the bundle: ' + String(e?.message || e).slice(0, 160)); }
    report.stages.push({ tier: 'sample', ok: result.ok,
      codecs: result.codecs.map((c) => ({ name: c.name, startAt: c.startAt, length: c.length, verified: c.verified, source: c.source })),
      notes: result.notes });
    report.ai = { attempted: false, available: aiAvailable(), message: 'Sample-verified against the real token — AI not needed.' };
    const code = result.codecs.length ? emitCodec(result, fname) : '';
    return json({
      ok: result.ok,
      message: result.ok ? result.notes[0] : (result.notes[0] || 'No config reproduced the sample.'),
      families: result.families || [], report,
      codecs: result.codecs.map((c) => ({ name: c.name, startAt: c.startAt, length: c.length, version: c.version, verified: c.verified, source: c.source, key: c.key, kind: c.kind, shifts: c.preview })),
      code,
    });
  }

  // ---- AI-ONLY. The AI locates the codec config (key / startAt / length); the
  //      bundle is then executed to compute the real key and VERIFY the result.
  //      There is no deterministic config-scan path. ----
  if (!aiAvailable()) {
    aiInfo.error = 'no_key';
    return fail('No Anthropic API key on the server. This tool is AI-only — set ANTHROPIC_API_KEY to use it.');
  }

  aiInfo.attempted = true;
  let aiConfigs;
  try {
    // ground the AI with the static call-site candidates so it reasons over real
    // windows instead of guessing
    let candidates = [];
    try { candidates = scanBundle(src).callSiteConfigs; } catch (e) { /* ignore */ }
    const located = await aiLocateConfigs(src, candidates);
    aiConfigs = located.configs;
    aiInfo.proposed = aiConfigs.length;
    aiInfo.usage = located.usage;
  } catch (e) {
    const f = friendlyAIError(e);
    aiInfo.error = f.code;
    const rl = readRateLimit(e?.headers);
    if (rl) aiInfo.usage = { model: null, inputTokens: null, outputTokens: null, rateLimit: rl };
    return fail(f.message);
  }

  if (!aiConfigs.length) return fail('AI ran but could not locate a codec config in this bundle.');

  let result;
  try {
    result = await extract(src, aiConfigs, { aiOnly: true });
  } catch (e) {
    return fail('AI located a config, but the bundle could not be analyzed: ' + String(e?.message || e).slice(0, 160));
  }
  report.stages.push({
    tier: 'ai',
    ok: result.ok,
    families: result.families,
    codecs: result.codecs.map((c) => ({ name: c.name, startAt: c.startAt, length: c.length, version: c.version, verified: c.verified, source: c.source })),
    notes: result.notes,
  });
  report.ai = aiInfo;

  const verified = result.codecs.filter((c) => c.verified);
  let codeOut = '';
  try {
    codeOut = result.codecs.length ? emitCodec(result, fname) : '';
  } catch (e) {
    // emitting should never fail, but don't let it sink the whole response
    codeOut = '';
  }

  // Top-level, human-readable status for the UI banner. (AI runs silently in
  // the background — never surfaced to the user.)
  let message;
  if (verified.length) {
    message = `Recovered ${verified.length} verified codec${verified.length > 1 ? 's' : ''}.`;
  } else if (result.codecs.length) {
    message = 'Found codec candidates, but none verified against the bundle — so nothing was emitted. The cipher may have changed in a way not yet handled.';
  } else {
    message = "Couldn't recover a codec from this bundle. Make sure it's the correct IVAC client bundle.";
  }

  return json({
    ok: verified.length > 0,
    message,
    families: result.families,
    report,
    codecs: result.codecs.map((c) => ({
      name: c.name, startAt: c.startAt, length: c.length, version: c.version,
      verified: c.verified, source: c.source, key: c.key, kind: c.kind, shifts: c.preview,
    })),
    code: codeOut,
  });
}
