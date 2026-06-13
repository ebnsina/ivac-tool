<script>
  let fileName = $state('');
  let source = $state('');
  let busy = $state(false);
  let dragOver = $state(false);
  let banner = $state(null);   // { kind: 'ok'|'warn'|'err', text }
  let res = $state(null);      // server response
  let showReport = $state(false);
  let copied = $state(false);
  let sessionTokens = $state(0);
  let sessionCost = $state(0);
  let rawToken = $state('');
  let encToken = $state('');

  let verifiedCount = $derived(res?.codecs?.filter((c) => c.verified).length ?? 0);
  let ai = $derived(res?.report?.ai ?? null);
  let usage = $derived(ai?.usage ?? null);

  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
  const usd = (n) => (n == null ? '—' : '$' + Number(n).toFixed(n < 0.01 ? 5 : 4));

  async function readFile(f) {
    if (!f) return;
    fileName = f.name;
    source = await f.text();
    banner = null;
    res = null;
  }
  function onFile(e) { readFile(e.target.files?.[0]); }
  function onDrop(e) { e.preventDefault(); dragOver = false; readFile(e.dataTransfer?.files?.[0]); }

  async function generate() {
    banner = null;
    res = null;
    copied = false;
    if (!source.trim()) { banner = { kind: 'err', text: 'Choose or paste a bundle first.' }; return; }
    busy = true;
    try {
      const r = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source, filename: fileName,
          sample: rawToken.trim() && encToken.trim() ? { raw: rawToken.trim(), encoded: encToken.trim() } : undefined,
        }),
      });
      let data;
      try { data = await r.json(); }
      catch { banner = { kind: 'err', text: `Server returned an unexpected response (HTTP ${r.status}).` }; return; }

      if (!r.ok && data?.error) { banner = { kind: 'err', text: data.error }; res = data?.report ? data : null; return; }
      res = data;
      const u = data?.report?.ai?.usage;
      if (u) {
        sessionTokens += (u.inputTokens || 0) + (u.outputTokens || 0);
        sessionCost += u.costUSD || 0;
      }
      banner = {
        kind: data.ok ? 'ok' : (data.codecs?.length ? 'warn' : 'err'),
        text: data.message || (data.ok ? 'Done.' : 'No codec recovered.'),
      };
      showReport = !data.ok;
    } catch (e) {
      banner = { kind: 'err', text: 'Could not reach the server. Is it still running?' };
    } finally {
      busy = false;
    }
  }

  async function copyCode() {
    if (!res?.code) return;
    try { await navigator.clipboard.writeText(res.code); copied = true; setTimeout(() => (copied = false), 1500); }
    catch { banner = { kind: 'err', text: 'Clipboard blocked by the browser — use Download instead.' }; }
  }
  function downloadCode() {
    if (!res?.code) return;
    const b = new Blob([res.code], { type: 'text/javascript' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = 'transform-string.js';
    a.click();
    URL.revokeObjectURL(a.href);
  }
</script>

<svelte:head><title>IVAC Codec Extractor</title></svelte:head>

<div class="page">
  <header class="hero">
    <div class="hero-inner">
      <div class="logo">IV</div>
      <div>
        <h1>IVAC Codec Extractor</h1>
        <p>AI-powered. Upload an obfuscated client bundle — the AI locates the codec config and the bundle is run sandboxed on the server to verify it. Nothing sensitive touches the browser.</p>
      </div>
    </div>
  </header>

  <main>
    <!-- INPUT -->
    <section class="card">
      <div class="card-head"><span class="num">1</span><h2>Upload bundle</h2></div>

      <label
        class="drop {dragOver ? 'over' : ''} {fileName ? 'filled' : ''}"
        ondragover={(e) => { e.preventDefault(); dragOver = true; }}
        ondragleave={() => (dragOver = false)}
        ondrop={onDrop}
      >
        <input type="file" accept=".js,.txt" onchange={onFile} hidden />
        <div class="drop-icon">{fileName ? '📄' : '⬆'}</div>
        <div class="drop-text">
          {#if fileName}<b>{fileName}</b><span>click to replace · or drop another</span>
          {:else}<b>Drop a bundle here</b><span>or click to choose a <code>.js</code> file</span>{/if}
        </div>
      </label>

      <details class="paste">
        <summary>or paste source</summary>
        <textarea bind:value={source} placeholder="paste bundle JS…" spellcheck="false"></textarea>
      </details>

      <details class="paste sample">
        <summary>have a real token sample? (100% accurate — skips AI guessing)</summary>
        <p class="sample-hint">Paste one <b>raw</b> token and its <b>server-encoded</b> form (from the app's Network tab). The tool finds the exact config that maps one to the other — no AI, no decoy ambiguity.</p>
        <input class="tin" bind:value={rawToken} placeholder="raw token (before transform)" spellcheck="false" />
        <input class="tin" bind:value={encToken} placeholder="encoded token (what the app sends)" spellcheck="false" />
      </details>

      <div class="actions">
        <button class="primary" onclick={generate} disabled={busy}>
          {#if busy}<span class="spin"></span> Working…{:else}Generate{/if}
        </button>
      </div>
    </section>

    <!-- BANNER -->
    {#if banner}
      <div class="banner {banner.kind}">
        <span class="bi">{banner.kind === 'ok' ? '✓' : banner.kind === 'warn' ? '!' : '✕'}</span>
        <span>{banner.text}</span>
      </div>
    {/if}

    {#if res}
      <!-- AI STATUS + USAGE -->
      {#if ai}
        <section class="card">
          <div class="card-head">
            <span class="num">AI</span><h2>AI extraction</h2>
            <span class="ai-pill {usage && (usage.inputTokens != null) ? 'ok' : ai.error ? 'err' : ai.attempted ? 'ok' : 'idle'}">
              {usage && usage.inputTokens != null ? 'ran' : ai.error ? ai.error : ai.attempted ? 'attempted' : ai.available ? 'idle' : 'no key'}
            </span>
            {#if usage?.model}<span class="src">{usage.model}</span>{/if}
          </div>

          {#if ai.message && !(usage && usage.inputTokens != null)}
            <div class="ai-status">{ai.message}</div>
          {/if}

          {#if usage}
            <div class="usage-grid">
              <div class="ug"><span class="ug-n">{fmt(usage.inputTokens)}</span><span class="ug-l">input tokens (this run)</span></div>
              <div class="ug"><span class="ug-n">{fmt(usage.outputTokens)}</span><span class="ug-l">output tokens (this run)</span></div>
              <div class="ug"><span class="ug-n">{usd(usage.costUSD)}</span><span class="ug-l">est. cost (this run){#if usage.pricePerMTok}<br><span class="tiny">${usage.pricePerMTok.in}/${usage.pricePerMTok.out} per 1M</span>{/if}</span></div>
              <div class="ug"><span class="ug-n">{fmt(sessionTokens)}</span><span class="ug-l">tokens this session</span></div>
              <div class="ug"><span class="ug-n">{usd(sessionCost)}</span><span class="ug-l">est. cost this session</span></div>
            </div>
            {#if usage.rateLimit}
              {@const rl = usage.rateLimit}
              <div class="rl-head">Rate-limit window remaining</div>
              <div class="usage-grid">
                {#if rl.tokensLimit != null || rl.tokensRemaining != null}
                  <div class="ug"><span class="ug-n">{fmt(rl.tokensRemaining)}<span class="ug-of">/ {fmt(rl.tokensLimit)}</span></span><span class="ug-l">tokens remaining</span>
                    {#if rl.tokensLimit}<div class="bar"><i style="width:{Math.max(0, Math.min(100, 100 * (rl.tokensRemaining ?? 0) / rl.tokensLimit))}%"></i></div>{/if}
                  </div>
                {/if}
                {#if rl.requestsLimit != null || rl.requestsRemaining != null}
                  <div class="ug"><span class="ug-n">{fmt(rl.requestsRemaining)}<span class="ug-of">/ {fmt(rl.requestsLimit)}</span></span><span class="ug-l">requests remaining</span>
                    {#if rl.requestsLimit}<div class="bar"><i style="width:{Math.max(0, Math.min(100, 100 * (rl.requestsRemaining ?? 0) / rl.requestsLimit))}%"></i></div>{/if}
                  </div>
                {/if}
                {#if rl.tokensReset}<div class="ug"><span class="ug-n sm">{rl.tokensReset}</span><span class="ug-l">window resets</span></div>{/if}
              </div>
            {/if}
            <div class="usage-note">Cost is <b>estimated locally</b> (tokens × model price), not billed figures. The rate-limit window is a rolling per-minute budget, not your account balance — Anthropic's API doesn't expose dollar balance; see <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener noreferrer">console billing</a>.</div>
          {/if}
        </section>
      {/if}

      <!-- CODECS -->
      {#if res.codecs?.length}
        <section class="card">
          <div class="card-head">
            <span class="num">2</span><h2>Recovered codecs</h2>
            <span class="count">{verifiedCount}/{res.codecs.length} verified</span>
          </div>
          {#each res.codecs as c}
            <div class="codec {c.verified ? 'good' : 'bad'}">
              <div class="codec-top">
                <b>{c.name}</b>
                <span class="badge {c.verified ? 'b-ok' : 'b-warn'}">{c.verified ? 'verified' : 'unverified'}</span>
                <span class="meta">startAt {c.startAt} · length {c.length}{c.version != null ? ' · v' + c.version : ''}{c.kind ? ' · ' + c.kind : ''}</span>
              </div>
              <div class="kv">key <code>{c.key}</code></div>
              {#if c.shifts}<div class="kv">{c.kind === 'shift' ? 'shifts' : 'table'} <code>{c.shifts.join(',')}</code></div>{/if}
            </div>
          {/each}
        </section>
      {/if}

      <!-- CODE -->
      {#if res.code}
        <section class="card">
          <div class="card-head">
            <span class="num">3</span><h2>transform-string.js</h2>
            <div class="head-actions">
              <button onclick={copyCode}>{copied ? 'Copied ✓' : 'Copy'}</button>
              <button onclick={downloadCode}>Download</button>
            </div>
          </div>
          <pre>{res.code}</pre>
        </section>
      {/if}

      <!-- REPORT -->
      <section class="card subtle">
        <button class="report-toggle" onclick={() => (showReport = !showReport)}>
          <span class="num sm">i</span> Diagnostics <span class="chev">{showReport ? '▲' : '▼'}</span>
        </button>
        {#if showReport}
          <div class="report">
            <div class="rrow">families: <b>{res.families?.join(', ') || '—'}</b></div>
            {#each res.report?.stages ?? [] as st}
              <div class="stage">
                <div class="stage-head">tier <b>{st.tier}</b> — {st.ok ? 'ok' : 'no verified codec'}</div>
                {#each st.codecs ?? [] as c}<div class="mono">{c.verified ? '✓' : '✗'} {c.name} — startAt {c.startAt}, length {c.length} <span class="dim">({c.source})</span></div>{/each}
                {#if st.notes?.length}<div class="mono dim">{st.notes.join(' · ')}</div>{/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  </main>

  <footer>
    <div class="foot-copy">
      © {new Date().getFullYear()} IVAC Codec Extractor · Developed by
      <a href="https://m.me/ebnsina.dev" target="_blank" rel="noopener noreferrer">ebnsina</a>
    </div>
  </footer>
</div>

<style>
  :global(:root){
    --bg:#0b0d12; --panel:#fff; --ink:#0f1422; --mut:#6b7280; --line:#e6e8ee;
    --acc:#9b1b3a; --acc2:#c2334f; --ok:#16a34a; --okbg:#ecfdf3; --warn:#b45309;
    --warnbg:#fffbeb; --err:#dc2626; --errbg:#fef2f2;
    --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
    --font:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  }
  :global(body){margin:0;background:#f4f5f8;font-family:var(--font);color:var(--ink);-webkit-font-smoothing:antialiased}
  *{box-sizing:border-box}
  .page{min-height:100vh;display:flex;flex-direction:column}

  .hero{background:linear-gradient(135deg,#15171f 0%,#241019 55%,#3a0f1f 100%);color:#fff;padding:30px 24px 26px}
  .hero-inner{max-width:860px;margin:0 auto;display:flex;align-items:center;gap:16px}
  .logo{width:48px;height:48px;flex:none;display:grid;place-items:center;font-weight:800;border-radius:12px;
    background:linear-gradient(135deg,var(--acc),var(--acc2));box-shadow:0 6px 20px rgba(155,27,58,.45)}
  .hero h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.02em}
  .hero p{margin:4px 0 0;color:#c8cad3;font-size:13px;max-width:640px;line-height:1.5}

  main{max-width:860px;width:100%;margin:-12px auto 0;padding:0 24px 60px;display:flex;flex-direction:column;gap:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 22px;
    box-shadow:0 4px 24px rgba(16,24,40,.06)}
  .card.subtle{box-shadow:none;background:#fbfbfd}
  .card-head{display:flex;align-items:center;gap:10px;margin-bottom:16px}
  .card-head h2{margin:0;font-size:15px;font-weight:650;flex:1}
  .num{display:grid;place-items:center;min-width:24px;height:24px;padding:0 6px;font-size:12px;font-weight:700;color:#fff;
    background:var(--acc);border-radius:7px}
  .num.sm{min-width:20px;height:20px;font-size:11px;font-style:normal;background:#9aa1ad}
  .count{font-size:12px;font-weight:600;color:var(--mut)}
  .head-actions{display:flex;gap:8px}

  .drop{display:flex;align-items:center;gap:14px;padding:18px;border:1.5px dashed var(--line);border-radius:12px;
    cursor:pointer;transition:.15s;background:#fafbfc}
  .drop:hover{border-color:#cbd0da}
  .drop.over{border-color:var(--acc);background:#fbeef1}
  .drop.filled{border-style:solid;background:#fff}
  .drop-icon{width:42px;height:42px;flex:none;display:grid;place-items:center;font-size:20px;border-radius:10px;background:#f1f2f6}
  .drop-text{display:flex;flex-direction:column;line-height:1.4}
  .drop-text b{font-size:14px}
  .drop-text span{font-size:12px;color:var(--mut)}

  .paste{margin-top:12px}
  .paste summary{cursor:pointer;font-size:12.5px;color:var(--mut)}
  .sample summary{color:var(--acc);font-weight:600}
  .sample-hint{font-size:12px;color:var(--mut);margin:8px 0 8px;line-height:1.5}
  .tin{width:100%;margin-top:8px;font-family:var(--mono);font-size:12px;border:1px solid var(--line);border-radius:8px;padding:9px 11px;background:#fff}
  .tin:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px rgba(155,27,58,.1)}
  textarea{width:100%;min-height:120px;margin-top:8px;font-family:var(--mono);font-size:12px;border:1px solid var(--line);
    border-radius:10px;padding:10px;resize:vertical;background:#fff}
  textarea:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px rgba(155,27,58,.1)}

  .actions{margin-top:16px}
  button{cursor:pointer;border:1px solid var(--line);background:#fff;color:var(--ink);padding:9px 16px;border-radius:9px;
    font:inherit;font-weight:600;font-size:13px;transition:.12s}
  button:hover{background:#f3f4f7}
  button.primary{background:var(--acc);border-color:var(--acc);color:#fff;padding:11px 22px}
  button.primary:hover{background:#82122c}
  button:disabled{opacity:.6;cursor:default}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;
    border-radius:50%;animation:sp .6s linear infinite;vertical-align:-1px;margin-right:6px}
  @keyframes sp{to{transform:rotate(360deg)}}

  .banner{display:flex;align-items:center;gap:11px;padding:13px 16px;border-radius:12px;font-size:13.5px;font-weight:500;border:1px solid}
  .banner .bi{width:22px;height:22px;flex:none;display:grid;place-items:center;border-radius:50%;font-size:12px;font-weight:800;color:#fff}
  .banner.ok{background:var(--okbg);border-color:#bbf7d0;color:#0a7a35}
  .banner.ok .bi{background:var(--ok)}
  .banner.warn{background:var(--warnbg);border-color:#fde7b0;color:#92500a}
  .banner.warn .bi{background:var(--warn)}
  .banner.err{background:var(--errbg);border-color:#fecaca;color:#b91c1c}
  .banner.err .bi{background:var(--err)}

  .codec{border:1px solid var(--line);border-radius:11px;padding:12px 14px;margin-top:10px;background:#fff}
  .codec.good{border-left:3px solid var(--ok)}
  .codec.bad{border-left:3px solid var(--warn)}
  .codec-top{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
  .codec-top b{font-size:14px}
  .badge{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:2px 8px;border-radius:999px}
  .b-ok{background:var(--okbg);color:#0a7a35}
  .b-warn{background:var(--warnbg);color:#92500a}
  .meta{font-size:12px;color:var(--mut)}
  .kv{margin-top:7px;font-size:11.5px;color:var(--mut)}
  .kv code{font-family:var(--mono);background:#f4f5f8;border:1px solid var(--line);border-radius:5px;padding:2px 6px;word-break:break-all;color:var(--ink)}

  pre{background:#0d1117;color:#c9d1d9;border-radius:11px;padding:16px;overflow:auto;font-family:var(--mono);
    font-size:12px;line-height:1.65;max-height:440px;margin:0}

  .src{font-size:11px;color:#9aa1ad;font-family:var(--mono)}
  .ai-pill{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:2px 9px;border-radius:999px}
  .ai-pill.ok{background:var(--okbg);color:#0a7a35}
  .ai-pill.err{background:var(--errbg);color:#b91c1c}
  .ai-pill.idle{background:#eef0f4;color:#7a818d}
  .ai-status{font-size:12.5px;color:var(--mut);background:#fafbfc;border:1px solid var(--line);border-radius:9px;padding:11px 13px}
  .usage-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
  .ug{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:#fff;display:flex;flex-direction:column;gap:3px}
  .ug-n{font-size:20px;font-weight:700;letter-spacing:-.02em}
  .ug-n.sm{font-size:13px;font-weight:600;font-family:var(--mono)}
  .ug-of{font-size:13px;font-weight:500;color:var(--mut);margin-left:4px}
  .ug-l{font-size:11.5px;color:var(--mut)}
  .tiny{font-size:10px;color:#9aa1ad}
  .bar{height:5px;border-radius:3px;background:#eef0f4;overflow:hidden;margin-top:6px}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,var(--acc),var(--acc2))}
  .rl-head{font-size:12px;font-weight:600;color:var(--mut);margin:16px 0 8px}
  .usage-note{margin-top:14px;font-size:11.5px;color:var(--mut);line-height:1.5}
  .usage-note a{color:var(--acc);font-weight:600;text-decoration:none}
  .usage-note a:hover{text-decoration:underline}

  .report-toggle{width:100%;display:flex;align-items:center;gap:10px;background:none;border:none;padding:2px;font-weight:600}
  .report-toggle:hover{background:none}
  .chev{margin-left:auto;color:var(--mut);font-size:11px}
  .report{margin-top:14px;display:flex;flex-direction:column;gap:10px}
  .rrow{font-size:12.5px}
  .stage{border:1px solid var(--line);border-radius:9px;padding:10px 12px;background:#fff}
  .stage-head{font-size:12.5px;margin-bottom:5px}
  .mono{font-family:var(--mono);font-size:11.5px;word-break:break-all;margin-top:2px}
  .dim{color:var(--mut)}

  footer{margin-top:auto;text-align:center;padding:24px;color:#9aa1ad;font-size:11.5px;display:flex;flex-direction:column;gap:4px}
  .foot-copy{font-size:12px;color:#7a818d}
  .foot-copy a{color:var(--acc);font-weight:600;text-decoration:none}
  .foot-copy a:hover{text-decoration:underline}
</style>
