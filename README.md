# Hermes Inbox — Even G2 plugin

A message inbox for the Even Realities G2 glasses. Hermes pushes a message into a
feed; the app reads that feed and renders it on the glasses. Right now the feed
contains **Hello World**.

```
Hermes  ──writes──►  public/messages.json  ──fetch──►  plugin (WebView on phone)
                                                              │  SDK bridge
                                                              ▼
                                                       Even G2 display
```

## What's here

| Path | Purpose |
|---|---|
| `src/main.ts` | the plugin: builds the page, renders the feed, handles input |
| `app.json` | Even Hub manifest (`com.hermes.g2inbox`) |
| `public/messages.json` | the feed Hermes writes to |
| `tools/send.py` | **the send path** — appends a message to the feed |
| `test/stub-sdk.ts` | faithful offline stand-in for the SDK (test only) |
| `test/harness.mjs` | 21 offline assertions over the app's logic |

`test/` never ships in the `.ehpk` — only `dist/` is packed, and the stub is a
build-time alias that appears nowhere in the real bundle.

## Sending a message

```bash
python3 tools/send.py "Hello World" --detail "Second line under the body"
python3 tools/send.py --list          # show the feed
python3 tools/send.py "urgent" --push http://192.168.1.100:8787/messages
```

The newest message in the feed is what the glasses show. `--push` posts to a
remote endpoint instead of the local file, for a phone that can't see this
filesystem.

## Running it

**Dev server + simulator** (layout and logic, no hardware):

```bash
npm install
npm run dev            # terminal 1 — Vite on :5173
npm run simulate       # terminal 2 — evenhub-simulator http://localhost:5173
```

Headless, for CI — the simulator exposes an HTTP control plane:

```bash
npm run dev
npm run simulate:headless          # adds --automation-port 9898
curl http://127.0.0.1:9898/api/ping
curl -o glasses.png http://127.0.0.1:9898/api/screenshot/glasses
```

`/api/screenshot/glasses` returns the 576×288 RGBA framebuffer. **Test lit pixels
with `alpha > 0`** — background and text both render as pure green, so an RGB
delta check tells you nothing.

**On real glasses** (QR sideload from the dev server):

```bash
hostname -I | awk '{print $1}'     # your LAN IP
npm run qr -- --url "http://<LAN-IP>:5173"
```

Tap **Scan QR** in the Even Realities App (Developer Mode must be on) and point
it at the terminal. Edits hot-reload without re-scanning.

**Private build:**

```bash
npm run pack        # -> hermes-inbox.ehpk
```

Upload the `.ehpk` through the dev portal to install on your own devices.

## Controls

| Input | Action |
|---|---|
| Tap | next (older) message; on the oldest, re-fetch the feed |
| Swipe up / down | move through messages |
| Double-tap | exit, with the system confirmation dialog (mode 1 — required on a root page) |

The feed is also polled every 20 s, so a message Hermes pushes appears without
touching the glasses.

## Remote feed mode

By default the app fetches `/messages.json` from its own origin — no network
permission needed, and it works with no connectivity.

To pull from a server you control instead, pass `?feed=<url>` and make **both**
of these true, or the request never leaves the WebView:

1. The origin is listed in `app.json` → `permissions[0].whitelist`. The shipped
   placeholder is `http://192.168.1.100:8787` — replace it with yours. Use
   `https://` in production; `http://` is for a LAN dev server only.
2. That server returns `Access-Control-Allow-Origin` (and for JSON bodies,
   handles the `OPTIONS` preflight).

The whitelist is **not** a CORS bypass — they are independent gates, and a
request that works in `curl` but fails here is almost always missing CORS
headers on the server.

## Design constraints this app respects

- Canvas is 576×288 per eye, 4-bit green. No HTML, no CSS — containers at
  absolute pixel coordinates.
- At most 8 non-image containers per page; exactly one has `isEventCapture: 1`.
- No `zOrderIndex` anywhere, or it must be set on **every** container — the app
  omits it and relies on declaration order.
- `textColor` is 0–4 (brightness, not colour); `borderColor` is 0–15. Title uses
  `textColor: 2`, body `textColor: 4`.
- `CLICK_EVENT` is `0`, and protobuf drops zero-value fields, so a single tap
  arrives with `eventType` **undefined**. The default is resolved inside the
  envelope check — `sysEvent?.eventType ?? CLICK_EVENT` would report a click on
  every scroll and exit frame.
- Double-tap is checked **before** click, and exits from any container.
- 1,000-char budget at page creation, 2,000 on `textContainerUpgrade`.

## Verifying

```bash
npm run verify     # bundle against the stub SDK + run 21 assertions
```

Covers page creation (container count, single event capturer, canvas bounds,
textColor range, all-or-nothing `zOrderIndex`), the rendered string, input
routing (undefined-as-click, scroll, double-tap exit from both envelopes,
scroll-not-exit), and the no-crash path when the feed fetch fails.

## Known limits

- The LVGL simulator (`@evenrealities/evenhub-simulator`) needs GTK3
  (`libgdk-3.so.0`). It could not be run in the container this was built in —
  no root to `apt-get install libgtk-3-0t64`. The offline harness above was used
  instead. Run `npm run simulate` on a normal desktop to see the real render.
- On-device behaviour still needs confirming on hardware; the simulator is
  explicitly not a hardware emulator.