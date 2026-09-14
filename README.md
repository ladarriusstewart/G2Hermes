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

**Do it in one file: `app.json`.** The endpoint and the whitelist that permits it sit
together in the `network` permission, because they are useless apart:

```json
"permissions": [
  { "name": "network",
    "desc": "Fetches the notification feed from the endpoint you configure.",
    "endpoint": "https://your-endpoint.example.com/feed.json",
    "whitelist": ["https://your-endpoint.example.com"] }
]
```

Then `npm run pack` and reinstall.

**Why one file.** The whitelist is enforced by the Even Realities App *before* the
request leaves the WebView, and it takes **full origins only — no bare hostnames, no
wildcards.** A URL whose origin isn't listed fails silently on the device: the feed
just never loads. Keeping both values adjacent is what makes that mismatch visible
while editing, and `scripts/gen-endpoint.mjs` makes it impossible to ship — see below.

Two constraints that shape the design:

- The whitelist is compiled into the `.ehpk`, so changing it means **rebuilding and
  reinstalling**.
- **Never put a credential in `app.json`.** The package is extractable, so a token
  belongs in `localStorage` (`g2hermes.token`), sent as `Authorization: Bearer <token>`
  — a custom header, so your server must answer the `OPTIONS` preflight too.

### The build refuses to ship a mismatch

`endpoint` is read at build time by `scripts/gen-endpoint.mjs`, which regenerates
`src/generated-endpoint.ts`. If the endpoint's origin is missing from the whitelist,
**the build fails** with the exact line to add:

```
[endpoint] app.json would fail on the device.

           endpoint : https://your-endpoint.example.com/feed.json
           origin   : https://your-endpoint.example.com
           whitelist: https://your-endpoint.example.com

           The whitelist is enforced before the request leaves the WebView and
           accepts full origins only — no wildcards. Add this to app.json:

             "whitelist": [ "https://your-endpoint.example.com" ]
```

An empty `endpoint` is valid: the app renders a "Not configured" card instead.

Precedence, first success wins:

1. `?feed=<url>` — manual override
2. `localStorage` `g2hermes.endpoint` — set at runtime
3. `app.json` `endpoint` — compiled in at build time

Runtime remains the interesting case: the SDK bridge exposes **no keyboard, no file
system and no clipboard**, so there is no way to type a URL on the device. The
practical runtime path is a **setup QR code** read with `captureImageFromCamera()`
(the `camera` permission), which hands the URL to `localStorage.setItem()`. Setting
`app.json` at build time avoids all of that.

**Your server must send CORS headers.** The whitelist is **not** a CORS bypass —
they are two independent gates. At minimum:

```
Access-Control-Allow-Origin: *
```

## How the endpoint reaches the app

`scripts/gen-endpoint.mjs` runs before `dev`, `build` and `verify`. It reads
`app.json`, validates it, and writes `src/generated-endpoint.ts`:

```ts
export const ENDPOINT = "https://your-endpoint.example.com/feed.json"
```

`src/main.ts` imports that constant, so the URL is **compiled in, not fetched** —
there is no config request at boot and no way for this source to fail on its own.
Details worth knowing:

- **Only `network.endpoint` is read.** Other keys are ignored; extra fields the SDK
  may add later won't break it.
- **An empty or absent `endpoint` is valid.** The app falls through to the next
  source and, if none work, renders the "Not configured" card — it never crashes and
  never clears a feed already on screen.
- **Validation is a build gate.** An unparseable URL, or one whose origin isn't
  whitelisted, fails the build with the fix printed. You cannot ship a package that
  would fail on the device.
- **`src/generated-endpoint.ts` is generated, never edited or committed.**
- **Changing the endpoint needs a rebuild**, since it is compiled in.

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
npm run verify     # 28 assertions against a stub SDK — no hardware, no GTK3
npm run pack       # -> g2hermes.ehpk
```

`npm run gen` (run automatically before `dev`, `build` and `verify`) turns `app.json`'s
`endpoint` into `src/generated-endpoint.ts`. Run it alone to check your manifest
without doing a full build.

`npm run verify` bundles `src/main.ts` against a faithful stub of the SDK (real enum
values from `index.d.ts`) and asserts container geometry, rendered strings, input
routing, and that the endpoint compiled in from `app.json` is what gets fetched. It runs
anywhere — no glasses required.

To sideload over your LAN:

```bash
npm run qr -- --url "http://<YOUR-LAN-IP>:5173"
```

## Known limits

- **Not verified on hardware.** No physical G2 was available to the author.
- **The LVGL simulator is not used here.** `@evenrealities/evenhub-simulator` needs GTK3
  (`libgdk-3.so.0`). Run `npm run simulate` on a normal desktop.
- **No runtime credential entry is implemented yet.** `localStorage` is read, but the
  camera-QR flow that would populate it is not built. A bearer token must therefore be
  injected by other means today; the *endpoint* no longer depends on this, since it
  lives in `app.json` and is compiled in.
- **No secret is safe in this package.** Anything compiled into an `.ehpk` can be
  extracted, so never ship a long-lived credential inside the app; prefer a token your
  server can revoke.
- **The bundled `/feed.json` is a snapshot**, frozen at build time. It is a fallback,
  not a live source — `app.json`'s `endpoint` is the supported way to point the app at a feed.
