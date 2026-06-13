# IVAC Codec Extractor (SvelteKit)

Upload an obfuscated IVAC client bundle → the **server** runs it in a sandboxed
Node VM, captures the real codec, and returns clean, standalone
`transform-string.js`. The bundle execution and the Anthropic API key stay
server-side — nothing sensitive ships to the browser.

## Why it survives bundle changes

It never reconstructs the cipher. It captures the **shift numbers the bundle's
own `encryptText` produces** (by probing it with an all-`0` window) and bakes
those. New keystream algorithm, new key, new version → re-upload, done.

Two recovery tiers:

1. **Deterministic** (`src/lib/server/extractor.js`) — runs the bundle, grabs
   the `encryptText`/`decryptText` exports, and recovers each `(key, startAt,
   length)` from whichever shape the build uses:
   - object-literal config + version map (`hQ` style)
   - call-site int literals + key const (`LF` style)

   Every codec is **verified** against the bundle's own functions before emit.

2. **AI fallback** (`src/lib/server/ai.js`) — only if Tier 1 finds nothing
   verified. Claude reads small slices of the bundle and points at the config
   wiring (key variable + `startAt`/`length`). The bundle still computes the
   real key; the AI output is still probed + verified. Requires
   `ANTHROPIC_API_KEY`; without it the app just reports `AI available: false`.

The app's call site is the only ground truth for the key (`encryptText` is
generic over the key), which is exactly why this needs to read the app's wiring
— deterministically when possible, with AI as backstop.

## Run

```bash
pnpm install
cp .env.example .env        # optional: add ANTHROPIC_API_KEY to enable AI fallback
pnpm dev                    # http://localhost:5173
```

Production:

```bash
pnpm build
pnpm start                  # node build, BODY_SIZE_LIMIT=64M for large bundles
```

## Security notes

- The uploaded bundle is **executed** server-side in an isolated `vm` context
  with a stub DOM and no network. Only process bundles you trust.
- The Anthropic key is read via `$env/dynamic/private` and never sent to the
  client.
- Server-only logic lives under `src/lib/server/`, which SvelteKit refuses to
  bundle into client code.

## Layout

```
src/
  routes/
    +page.svelte              upload UI (client)
    api/extract/+server.js    POST handler (server) — orchestrates tier 1 + 2
  lib/server/
    extractor.js              run bundle, capture codec, probe, verify, emit
    ai.js                     Claude fallback (config locator)
```
