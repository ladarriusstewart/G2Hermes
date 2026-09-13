# G2Hermes

A notification feed for the **Even Realities G2**. Something on your network writes
notifications; the glasses render them.

This app ships with **no server, no credentials and no feed**. You point it at your
own endpoint.

```
your endpoint  ──►  feed.json  ──fetch──►  G2Hermes plugin  ──►  G2 display
```

## What it is

A notification feed, not a message list. Every notification carries a category, and
each producer owns exactly one category and replaces it wholesale — so adding a new
kind of notification means adding a producer, and the app itself never changes. It is
a generic renderer: it does not know or care what the notifications are about.

## Requirements

- Even Realities App **2.2.10+** (`min_app_version`, derived from SDK 0.0.15)
- Node.js ≥ 20 to build
- An HTTP endpoint you control that serves the feed with CORS headers

## Configure it

**1. Whitelist your origin.** In `app.json`, replace the placeholder:

```json
"permissions": [
  { "name": "network",
    "desc": "Fetches the notification feed from the endpoint you configure.",
    "whitelist": ["https://your-endpoint.example.com"] }
]
```

This list is enforced by the Even Realities App *before* the request leaves the
WebView. Two things to know, both of which shape the design:

- It takes **full origins only — no bare hostnames, no wildcards.**
- It is compiled into the `.ehpk`, so changing it means **rebuilding and reinstalling**.

**2. Set the endpoint.** Either set `ENDPOINT` in `src/main.ts` before building, or
store it at runtime as `g2hermes.endpoint` in `localStorage`.

Runtime is the interesting case: the SDK bridge exposes **no keyboard, no file system
and no clipboard**, so there is no way to type a URL on the device. The practical
runtime path is a **setup QR code** read with `captureImageFromCamera()` (the `camera`
permission), which hands the URL to `localStorage.setItem()`. A stored
`g2hermes.token` is sent as `Authorization: Bearer …` — a custom header, so your
server must answer the `OPTIONS` preflight as well.

**3. Your server must send CORS headers.** The whitelist is **not** a CORS bypass —
they are two independent gates. At minimum:

```
Access-Control-Allow-Origin: *
```

## Resolution order

First success wins; a failure falls through and the last good feed stays on screen:

1. `?feed=<url>` — manual override
2. `localStorage` `g2hermes.endpoint`
3. `ENDPOINT` in `src/main.ts`
4. `/feed.json` — an optional snapshot shipped alongside the app

## Feed format

```json
{
  "feed": "g2hermes",
  "version": 2,
  "updated": "2026-01-01T12:00:00Z",
  "notifications": [
    { "id": 3, "category": "system", "title": "Short title",
      "body": "Longer text.\nNewlines are preserved.", "priority": 2,
      "ts": "2026-01-01T12:00:00Z", "source": "producer name" }
  ]
}
```

- `notifications[0]` renders **first** and taps move toward the end of the array.
- `priority` ≥ 2 is surfaced in the meta line.
- `updated` is shown as the feed's own age, so a stale cached copy is visible.

## Controls

| Input | Action |
|---|---|
| Tap | next notification (at the end: refresh) |
| Swipe up / down | step through notifications |
| Double-tap | exit, with the system confirmation dialog (mode 1 — required on a root page) |

Polled every 60 s; a newly-arrived notification jumps to the front of the view.

## Design constraints this app respects

- Canvas is 576×288 per eye, 4-bit green. No HTML, no CSS — containers at absolute
  pixel coordinates.
- At most 8 non-image containers per page; exactly one has `isEventCapture: 1`.
- No `zOrderIndex` anywhere, or it must be set on **every** container — so it is
  omitted deliberately.
- Container names are capped at 16 chars — the title renders `G2HERMES · <category>`
  and is truncated to fit.
- 1,000-char budget at page creation, 2,000 on `textContainerUpgrade`.
- `app.json`'s `version` must be plain `x.y.z` — the packer rejects a prerelease
  suffix, so the beta identifier lives in the git tag, not the manifest.
- `localStorage` is the only durable store (no file system, no clipboard). It survives
  backgrounding and lock on both platforms; in-memory JS state does **not** survive
  Android suspension, so rebuild it on relaunch.

## Build and verify

```bash
npm install
npm run dev        # Vite dev server
npm run verify     # 24 assertions against a stub SDK — no hardware, no GTK3
npm run pack       # -> g2hermes.ehpk
```

`npm run verify` bundles `src/main.ts` against a faithful stub of the SDK (real enum
values from `index.d.ts`) and asserts container geometry, rendered strings and input
routing. It runs anywhere — no glasses required.

To sideload over your LAN:

```bash
npm run qr -- --url "http://<YOUR-LAN-IP>:5173"
```

## Known limits

- **Not verified on hardware.** No physical G2 was available to the author.
- **The LVGL simulator is not used here.** `@evenrealities/evenhub-simulator` needs GTK3
  (`libgdk-3.so.0`). Run `npm run simulate` on a normal desktop.
- **No runtime credential entry is implemented yet.** `localStorage` is read, but the
  camera-QR flow that would populate it is not built. Today the endpoint is effectively
  a build-time setting.
- **No secret is safe in this package.** Anything compiled into an `.ehpk` can be
  extracted, so never ship a long-lived credential inside the app; prefer a token your
  server can revoke.
- **The bundled `/feed.json` is a snapshot**, frozen at build time. It is a fallback,
  not a live source.
