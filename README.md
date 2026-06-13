# IVAC Codec Extractor

Recovers a clean, verified token codec from an obfuscated IVAC client bundle —
**100% in the browser**. No server, no backend, no upload. Host it as static
files anywhere (GitHub Pages, Cloudflare Pages, any shared host).

## How it works
- The obfuscated bundle executes in a **sandboxed `<iframe>`** in your browser.
- The codec is **probed there** over the full 64-char alphabet, capturing its
  behaviour as `shift` / per-char `sub` / per-position `tables` — so it survives
  cipher changes (logistic, polynomial, LFSR, LCG, Feistel all handled).
- Two modes:
  - **Sample mode (recommended, 100%)** — paste a real `raw → encoded` token
    pair (from the app's Network tab). Deterministic, no AI, no key, no cost.
  - **AI mode** — the call goes **browser → Claude directly** with *your own*
    API key. The key is stored only in this browser's `localStorage`; it is
    never in the build or sent anywhere else. Set a spend cap on the key.

## Run / build
```bash
pnpm install
pnpm dev                 # http://localhost:5173
pnpm build               # static site in build/
```
Deploy the `build/` folder to any static host (or upload it to shared hosting).

## Notes
- AI mode needs an Anthropic API key you paste into the UI (browser-only).
- Sample mode needs nothing — it's the fast, free, exact path.
- Nothing is uploaded; the bundle and key never leave your machine.
