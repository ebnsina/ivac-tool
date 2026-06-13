<script>
  import { onMount } from 'svelte';
  import { scanBundle, gatherRoutes, extractWithConfigs, extractFromSample, emitCodec } from '$lib/extract-client.js';
  import { aiLocateConfigs, DEFAULT_MODEL } from '$lib/ai-client.js';

  let fileName = $state('');
  let source = $state('');
  let busy = $state(false);
  let dragOver = $state(false);
  let banner = $state(null);
  let res = $state(null);
  let showReport = $state(false);
  let copied = $state(false);
  let sessionTokens = $state(0);
  let sessionCost = $state(0);
  let rawToken = $state('');
  let encToken = $state('');
  let apiKey = $state('');
  let model = $state(DEFAULT_MODEL);
  let mounted = $state(false);

  onMount(() => {
    try { apiKey = localStorage.getItem('ivac_key') || ''; model = localStorage.getItem('ivac_model') || DEFAULT_MODEL; } catch {}
    mounted = true;
  });
  $effect(() => { if (mounted) try { localStorage.setItem('ivac_key', apiKey); localStorage.setItem('ivac_model', model); } catch {} });

  let verifiedCount = $derived(res?.codecs?.filter((c) => c.verified).length ?? 0);
  let ai = $derived(res?.ai ?? null);
  let usage = $derived(ai?.usage ?? null);
  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
  const usd = (n) => (n == null ? '—' : '$' + Number(n).toFixed(n < 0.01 ? 5 : 4));

  async function readFile(f) { if (!f) return; fileName = f.name; source = await f.text(); banner = null; res = null; }
  function onFile(e) { readFile(e.target.files?.[0]); }
  function onDrop(e) { e.preventDefault(); dragOver = false; readFile(e.dataTransfer?.files?.[0]); }

  async function generate() {
    banner = null; res = null; copied = false;
    if (!source.trim()) { banner = { kind: 'err', text: 'Choose or paste a bundle first.' }; return; }
    const hasSample = rawToken.trim() && encToken.trim();
    if (!hasSample && !apiKey.trim()) { banner = { kind: 'err', text: 'Enter your Anthropic API key, or provide a raw→encoded token sample.' }; return; }
    busy = true;
    try {
      const families = scanBundle(source).families;
      let codecs = [], message = '', aiState = { attempted: false, hasKey: !!apiKey.trim() };

      if (hasSample) {
        const r = await extractFromSample(source, { raw: rawToken.trim(), encoded: encToken.trim() }, families);
        codecs = r.codecs || [];
        message = codecs.some((c) => c.verified) ? (r.note || 'Matched real token sample.') : (r.note || r.err || 'No config reproduced the sample.');
      } else {
        aiState.attempted = true;
        const scan = scanBundle(source);
        const routes = gatherRoutes(source);
        try {
          const located = await aiLocateConfigs(source, scan.callSiteConfigs, routes, apiKey.trim(), model);
          aiState.usage = located.usage;
          if (!located.configs.length) { message = 'AI ran but could not locate a codec config in this bundle.'; }
          else {
            const r = await extractWithConfigs(source, located.configs, families);
            codecs = r.codecs || [];
            const v = codecs.filter((c) => c.verified).length;
            message = v ? `Recovered ${v} codec${v > 1 ? 's' : ''} (self-checked — confirm with a real token sample for certainty).`
              : (codecs.length ? 'Found candidates but none self-checked against the bundle.' : (r.err || "Couldn't recover a codec."));
          }
        } catch (e) { aiState.error = e.status ?? 'err'; aiState.message = e.message; message = e.message || 'AI request failed.'; }
      }

      const verified = codecs.filter((c) => c.verified);
      const code = verified.length ? emitCodec(codecs, families, fileName) : '';
      if (aiState.usage) { sessionTokens += (aiState.usage.inputTokens || 0) + (aiState.usage.outputTokens || 0); sessionCost += aiState.usage.costUSD || 0; }
      res = { ok: verified.length > 0, message, families, codecs, code, ai: aiState };
      banner = { kind: res.ok ? (hasSample ? 'ok' : 'warn') : (codecs.length ? 'warn' : 'err'), text: message };
      showReport = !res.ok;
    } catch (e) {
      banner = { kind: 'err', text: String(e?.message || e) };
    } finally { busy = false; }
  }

  async function copyCode() { if (!res?.code) return; try { await navigator.clipboard.writeText(res.code); copied = true; setTimeout(() => (copied = false), 1500); } catch { banner = { kind: 'err', text: 'Clipboard blocked — use Download.' }; } }
  function downloadCode() { if (!res?.code) return; const b = new Blob([res.code], { type: 'text/javascript' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'transform-string.js'; a.click(); URL.revokeObjectURL(a.href); }
</script>

<svelte:head><title>IVAC Codec Extractor</title></svelte:head>

<div class="page">
  <header class="hero">
    <div class="hero-inner">
      <div class="logo">IV</div>
      <div>
        <h1>IVAC Codec Extractor</h1>
        <p>Runs 100% in your browser — the bundle executes in a sandboxed iframe and (optionally) the AI call goes straight to Claude with your own key. No server, nothing uploaded.</p>
      </div>
    </div>
  </header>

  <main>
    <section class="card">
      <div class="card-head"><span class="num">1</span><h2>Upload bundle</h2></div>

      <label class="drop {dragOver ? 'over' : ''} {fileName ? 'filled' : ''}"
        ondragover={(e) => { e.preventDefault(); dragOver = true; }} ondragleave={() => (dragOver = false)} ondrop={onDrop}>
        <input type="file" accept=".js,.txt" onchange={onFile} hidden />
        <div class="drop-icon">{fileName ? '📄' : '⬆'}</div>
        <div class="drop-text">
          {#if fileName}<b>{fileName}</b><span>click to replace · or drop another</span>
          {:else}<b>Drop a bundle here</b><span>or click to choose a <code>.js</code> file</span>{/if}
        </div>
      </label>

      <details class="paste"><summary>or paste source</summary>
        <textarea bind:value={source} placeholder="paste bundle JS…" spellcheck="false"></textarea>
      </details>

      <details class="paste sample"><summary>have a real token sample? (100% accurate — no AI needed)</summary>
        <p class="sub-hint">Paste one <b>raw</b> token and its <b>server-encoded</b> form (from the app's Network tab). Pins the exact config deterministically — no key, no cost.</p>
        <input class="tin" bind:value={rawToken} placeholder="raw token (before transform)" spellcheck="false" />
        <input class="tin" bind:value={encToken} placeholder="encoded token (what the app sends)" spellcheck="false" />
      </details>

      <details class="paste key" open={mounted && !apiKey}><summary>Anthropic API key <em>(for AI mode — stored only in this browser)</em></summary>
        <p class="sub-hint">Used for a direct browser→Claude call. Saved to this browser's localStorage only — never sent anywhere else or baked into the site. Tip: set a spend cap on the key in the Anthropic console.</p>
        <input class="tin" type="password" bind:value={apiKey} placeholder="sk-ant-…" spellcheck="false" autocomplete="off" />
        <select class="tin" bind:value={model}>
          <option value="claude-sonnet-4-6">claude-sonnet-4-6 (recommended)</option>
          <option value="claude-opus-4-8">claude-opus-4-8 (smartest, slower)</option>
          <option value="claude-haiku-4-5">claude-haiku-4-5 (cheapest)</option>
        </select>
      </details>

      <div class="actions">
        <button class="primary" onclick={generate} disabled={busy}>
          {#if busy}<span class="spin"></span> Working…{:else}Generate{/if}
        </button>
      </div>
    </section>

    {#if banner}
      <div class="banner {banner.kind}"><span class="bi">{banner.kind === 'ok' ? '✓' : banner.kind === 'warn' ? '!' : '✕'}</span><span>{banner.text}</span></div>
    {/if}

    {#if res}
      {#if ai?.attempted}
        <section class="card">
          <div class="card-head"><span class="num">AI</span><h2>AI extraction</h2>
            <span class="ai-pill {usage ? 'ok' : ai.error ? 'err' : 'idle'}">{usage ? 'ran' : ai.error ? ('error ' + ai.error) : 'no result'}</span>
            {#if usage?.model}<span class="src">{usage.model}</span>{/if}
          </div>
          {#if ai.message && !usage}<div class="ai-status">{ai.message}</div>{/if}
          {#if usage}
            <div class="usage-grid">
              <div class="ug"><span class="ug-n">{fmt(usage.inputTokens)}</span><span class="ug-l">input tokens (run)</span></div>
              <div class="ug"><span class="ug-n">{fmt(usage.outputTokens)}</span><span class="ug-l">output tokens (run)</span></div>
              <div class="ug"><span class="ug-n">{usd(usage.costUSD)}</span><span class="ug-l">est. cost (run){#if usage.pricePerMTok}<br><span class="tiny">${usage.pricePerMTok.in}/${usage.pricePerMTok.out} per 1M</span>{/if}</span></div>
              <div class="ug"><span class="ug-n">{usd(sessionCost)}</span><span class="ug-l">est. cost this session</span></div>
            </div>
            <div class="usage-note">Cost is estimated locally (tokens × price). Billed to your Anthropic account; the key stays in this browser.</div>
          {/if}
        </section>
      {/if}

      {#if res.codecs?.length}
        <section class="card">
          <div class="card-head"><span class="num">2</span><h2>Recovered codecs</h2><span class="count">{verifiedCount}/{res.codecs.length} verified</span></div>
          {#each res.codecs as c}
            <div class="codec {c.verified ? 'good' : 'bad'}">
              <div class="codec-top"><b>{c.name}</b>
                {#if !c.verified}<span class="badge b-warn">unverified</span>
                {:else if c.source?.startsWith('sample')}<span class="badge b-ok">verified ✓ real token</span>
                {:else}<span class="badge b-warn" title="Self-consistent against the bundle, but NOT checked against a real server token — confirm with a token sample.">self-checked ⚠</span>{/if}
                <span class="meta">startAt {c.startAt} · length {c.length}{c.kind ? ' · ' + c.kind : ''}</span></div>
              <div class="kv">key <code>{c.key}</code></div>
              {#if c.shifts}<div class="kv">{c.kind === 'shift' ? 'shifts' : 'table'} <code>{c.shifts.join(',')}</code></div>{/if}
            </div>
          {/each}
        </section>
      {/if}

      {#if res.code}
        <section class="card">
          <div class="card-head"><span class="num">3</span><h2>transform-string.js</h2>
            <div class="head-actions"><button onclick={copyCode}>{copied ? 'Copied ✓' : 'Copy'}</button><button onclick={downloadCode}>Download</button></div></div>
          <pre>{res.code}</pre>
        </section>
      {/if}

      <section class="card subtle">
        <button class="report-toggle" onclick={() => (showReport = !showReport)}><span class="num sm">i</span> Diagnostics <span class="chev">{showReport ? '▲' : '▼'}</span></button>
        {#if showReport}
          <div class="report">
            <div class="rrow">families: <b>{res.families?.join(', ') || '—'}</b></div>
            {#each res.codecs ?? [] as c}<div class="mono">{c.verified ? '✓' : '✗'} {c.name} — startAt {c.startAt}, length {c.length} <span class="dim">({c.source})</span></div>{/each}
          </div>
        {/if}
      </section>
    {/if}
  </main>

  <footer><div class="foot-copy">© {new Date().getFullYear()} IVAC Codec Extractor · Developed by <a href="https://m.me/ebnsina.dev" target="_blank" rel="noopener noreferrer">ebnsina</a></div></footer>
</div>

<style>
  :global(:root){--panel:#fff;--ink:#0f1422;--mut:#6b7280;--line:#e6e8ee;--acc:#4f46e5;--acc2:#6366f1;--ok:#16a34a;--okbg:#ecfdf3;--warn:#b45309;--warnbg:#fffbeb;--err:#dc2626;--errbg:#fef2f2;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--font:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  :global(body){margin:0;background:#f4f5f8;font-family:var(--font);color:var(--ink);-webkit-font-smoothing:antialiased}
  *{box-sizing:border-box}
  .page{min-height:100vh;display:flex;flex-direction:column}
  .hero{background:linear-gradient(135deg,#13131f 0%,#1e1b3a 55%,#312e81 100%);color:#fff;padding:30px 24px 26px}
  .hero-inner{max-width:860px;margin:0 auto;display:flex;align-items:center;gap:16px}
  .logo{width:48px;height:48px;flex:none;display:grid;place-items:center;font-weight:800;border-radius:12px;background:linear-gradient(135deg,var(--acc),var(--acc2));box-shadow:0 6px 20px rgba(79,70,229,.45)}
  .hero h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.02em}
  .hero p{margin:4px 0 0;color:#c8cad3;font-size:13px;max-width:660px;line-height:1.5}
  main{max-width:860px;width:100%;margin:-12px auto 0;padding:0 24px 60px;display:flex;flex-direction:column;gap:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 22px;box-shadow:0 4px 24px rgba(16,24,40,.06)}
  .card.subtle{box-shadow:none;background:#fbfbfd}
  .card-head{display:flex;align-items:center;gap:10px;margin-bottom:16px}
  .card-head h2{margin:0;font-size:15px;font-weight:650;flex:1}
  .num{display:grid;place-items:center;min-width:24px;height:24px;padding:0 6px;font-size:12px;font-weight:700;color:#fff;background:var(--acc);border-radius:7px}
  .num.sm{min-width:20px;height:20px;font-size:11px;background:#9aa1ad}
  .count{font-size:12px;font-weight:600;color:var(--mut)}
  .head-actions{display:flex;gap:8px}
  .drop{display:flex;align-items:center;gap:14px;padding:18px;border:1.5px dashed var(--line);border-radius:12px;cursor:pointer;transition:.15s;background:#fafbfc}
  .drop:hover{border-color:#cbd0da}
  .drop.over{border-color:var(--acc);background:#eef2ff}
  .drop.filled{border-style:solid;background:#fff}
  .drop-icon{width:42px;height:42px;flex:none;display:grid;place-items:center;font-size:20px;border-radius:10px;background:#f1f2f6}
  .drop-text{display:flex;flex-direction:column;line-height:1.4}
  .drop-text b{font-size:14px}
  .drop-text span{font-size:12px;color:var(--mut)}
  .paste{margin-top:12px}
  .paste summary{cursor:pointer;font-size:12.5px;color:var(--mut)}
  .paste.sample summary,.paste.key summary{color:var(--acc);font-weight:600}
  .paste em{color:var(--mut);font-weight:400}
  .sub-hint{font-size:12px;color:var(--mut);margin:8px 0;line-height:1.5}
  textarea{width:100%;min-height:120px;margin-top:8px;font-family:var(--mono);font-size:12px;border:1px solid var(--line);border-radius:10px;padding:10px;resize:vertical;background:#fff}
  .tin{width:100%;margin-top:8px;font-family:var(--mono);font-size:12px;border:1px solid var(--line);border-radius:8px;padding:9px 11px;background:#fff}
  textarea:focus,.tin:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px rgba(79,70,229,.1)}
  .actions{margin-top:16px}
  button{cursor:pointer;border:1px solid var(--line);background:#fff;color:var(--ink);padding:9px 16px;border-radius:9px;font:inherit;font-weight:600;font-size:13px;transition:.12s}
  button:hover{background:#f3f4f7}
  button.primary{background:var(--acc);border-color:var(--acc);color:#fff;padding:11px 22px}
  button.primary:hover{background:#4338ca}
  button:disabled{opacity:.6;cursor:default}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:sp .6s linear infinite;vertical-align:-1px;margin-right:6px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .banner{display:flex;align-items:center;gap:11px;padding:13px 16px;border-radius:12px;font-size:13.5px;font-weight:500;border:1px solid}
  .banner .bi{width:22px;height:22px;flex:none;display:grid;place-items:center;border-radius:50%;font-size:12px;font-weight:800;color:#fff}
  .banner.ok{background:var(--okbg);border-color:#bbf7d0;color:#0a7a35}.banner.ok .bi{background:var(--ok)}
  .banner.warn{background:var(--warnbg);border-color:#fde7b0;color:#92500a}.banner.warn .bi{background:var(--warn)}
  .banner.err{background:var(--errbg);border-color:#fecaca;color:#b91c1c}.banner.err .bi{background:var(--err)}
  .codec{border:1px solid var(--line);border-radius:11px;padding:12px 14px;margin-top:10px;background:#fff}
  .codec.good{border-left:3px solid var(--ok)}.codec.bad{border-left:3px solid var(--warn)}
  .codec-top{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.codec-top b{font-size:14px}
  .badge{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:2px 8px;border-radius:999px}
  .b-ok{background:var(--okbg);color:#0a7a35}.b-warn{background:var(--warnbg);color:#92500a}
  .meta{font-size:12px;color:var(--mut)}
  .kv{margin-top:7px;font-size:11.5px;color:var(--mut)}
  .kv code{font-family:var(--mono);background:#f4f5f8;border:1px solid var(--line);border-radius:5px;padding:2px 6px;word-break:break-all;color:var(--ink)}
  pre{background:#0d1117;color:#c9d1d9;border-radius:11px;padding:16px;overflow:auto;font-family:var(--mono);font-size:12px;line-height:1.65;max-height:440px;margin:0}
  .src{font-size:11px;color:#9aa1ad;font-family:var(--mono)}
  .ai-pill{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:2px 9px;border-radius:999px}
  .ai-pill.ok{background:var(--okbg);color:#0a7a35}.ai-pill.err{background:var(--errbg);color:#b91c1c}.ai-pill.idle{background:#eef0f4;color:#7a818d}
  .ai-status{font-size:12.5px;color:var(--mut);background:#fafbfc;border:1px solid var(--line);border-radius:9px;padding:11px 13px}
  .usage-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
  .ug{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:#fff;display:flex;flex-direction:column;gap:3px}
  .ug-n{font-size:20px;font-weight:700;letter-spacing:-.02em}
  .ug-l{font-size:11.5px;color:var(--mut)}
  .tiny{font-size:10px;color:#9aa1ad}
  .usage-note{margin-top:14px;font-size:11.5px;color:var(--mut);line-height:1.5}
  .report-toggle{width:100%;display:flex;align-items:center;gap:10px;background:none;border:none;padding:2px;font-weight:600}
  .report-toggle:hover{background:none}
  .chev{margin-left:auto;color:var(--mut);font-size:11px}
  .report{margin-top:14px;display:flex;flex-direction:column;gap:6px}
  .rrow{font-size:12.5px}
  .mono{font-family:var(--mono);font-size:11.5px;word-break:break-all}
  .dim{color:var(--mut)}
  footer{margin-top:auto;text-align:center;padding:24px;color:#9aa1ad;font-size:12px}
  .foot-copy a{color:var(--acc);font-weight:600;text-decoration:none}
  .foot-copy a:hover{text-decoration:underline}
</style>
