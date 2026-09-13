# G2Hermes

Notifications from Hermes, rendered on the Even Realities G2 glasses.

```
feed generator (tools/feeds/*.py)  ──►  public/feed.json  ──fetch──►  G2Hermes plugin
        one per category                                                   │
                                                                           ▼
                                                                     G2 display
```

G2Hermes is a **notification feed**, not a message list. Every notification carries a
category, and each generator owns exactly one category and replaces it wholesale.
That is the whole extension model: adding a feed means adding a generator — the
app itself never changes.

| Category | Generator | What it pushes |
|---|---|---|
| `mlb` | `tools/feeds/mlb.py` | moneyline predictions for today's games |
| `system` | `tools/notify.py` | manual / heartbeat notifications |

## Layout

| Path | Purpose |
|---|---|
| `src/main.ts` | the plugin — page, render, input routing |
| `app.json` | Even Hub manifest (`com.hermes.g2hermes`) |
| `public/feed.json` | the feed the glasses read |
| `tools/notify.py` | notification store — the single writer, importable or CLI |
| `tools/feeds/mlb.py` | MLB moneyline feed |
| `test/stub-sdk.ts` | faithful offline stand-in for the SDK (test only) |
| `test/harness.mjs` | 24 offline assertions |

`test/` never ships — only `dist/` is packed, and the stub is a build-time alias
that appears nowhere in the real bundle.

## Pushing a notification

```bash
python3 tools/notify.py --category system --title "Hello World" --body "..." --priority 2
python3 tools/notify.py --list
python3 tools/notify.py --clear --category mlb
python3 tools/notify.py --push http://192.168.1.100:8787/notify --category system --title "..."
```

## The MLB moneyline feed

```bash
python3 tools/feeds/mlb.py              # write today's slate into the feed
python3 tools/feeds/mlb.py --dry-run    # print it, write nothing
python3 tools/feeds/mlb.py --no-weather # skip park wind lookups
```

One notification per game, ordered by the model's disagreement with the market,
plus a summary at the front. Each carries the two-way fair line, the market price
on both sides with the bookmaker offering it, the pitcher tilt, and a value
read against the price you'd actually get.

### The model

```
p_model(home) = clamp( p_market(home) + pitcher_tilt , 0.05 , 0.95 )
pitcher_tilt  = clamp((ERA_away − ERA_home) × 0.030, −0.080, +0.080)
```

The starting point is the de-vigged market consensus, because the market already
prices team strength, home field, bullpens, lineups and rest. The script's only
contribution is a transparent re-weighting on the two announced starters.

**This is a re-derivation, not claimed alpha.** `0.030` and `0.080` are hand-set,
not fitted against outcomes. Treat the output as a second opinion on the price.

Reported per game:

- **`model − market`** — how my view differs from the market's view (percentage points).
- **value** — model probability minus the probability implied by the best *available*
  price. This is the number that matters for whether a price is worth taking, and
  it's different from `model − market` because the best price is better than consensus.

Both can be **negative**, which is informative: Milwaukee at 59% against a market
64% means the model thinks the favourite is overpriced, and the notification says
so rather than dressing it up as a pick.

### In the feed but not in the probability

- **Injuries.** Pulled per game from **ESPN's injuries JSON API**
  (`site.api.espn.com/apis/site/v2/sports/baseball/mlb/injuries`) and reported as
  context beside the number — named players, their status, and a `+N more` count.
  They are deliberately *not* folded into the tilt: "how many points is losing
  player X worth" needs a fitted model, and a hand-waved constant would be worse
  than none. Reporting them next to the number lets a human apply the judgement.

  Note it uses the **JSON API, not the injuries web page**. `espn.com/mlb/injuries`
  is client-rendered, so a plain fetch of that page returns the app shell with zero
  injury content — the tables only exist after JS runs. The JSON endpoint carries the
  same data *with* the team attribution the rendered page doesn't expose.

  Long-term statuses (60-day IL) are excluded from the note; they aren't news for
  today's game and they would bury the short-term absences that actually move a lineup.

- **Wind.** A strong out-to-centre wind raises scoring for *both* teams, so it moves
  the run environment, not the winner. It appears as context ("13 mph out to centre")
  and never touches the tilt. Winds under 10 mph are reported as too light to matter
  rather than being labelled by direction, which would imply an effect that isn't there.

### Coming from outside

- `references/parks.md` (in the `mlb-daily-briefing` skill) supplies park coordinates,
  roof type and home-plate-to-centre-field bearings for the wind read.
- The odds and schedule come from the `the-odds-api` skill's client via that skill's
  `slate.py`.

## Running it

**Dev server + simulator** (layout and logic, no hardware):

```bash
npm install
npm run dev            # terminal 1 — Vite on :5173
npm run simulate       # terminal 2 — evenhub-simulator http://localhost:5173
```

Headless, for CI — the simulator exposes an HTTP control plane:

```bash
npm run simulate:headless          # adds --automation-port 9898
curl http://127.0.0.1:9898/api/ping
curl -o glasses.png http://127.0.0.1:9898/api/screenshot/glasses
```

`/api/screenshot/glasses` returns the 576×288 RGBA framebuffer. **Test lit pixels
with `alpha > 0`** — background and text both render as pure green, so an RGB delta
tells you nothing.

**On real glasses** (QR sideload):

```bash
hostname -I | awk '{print $1}'
npm run qr -- --url "http://<LAN-IP>:5173"
```

Tap **Scan QR** in the Even Realities App (Developer Mode on) and point it at the
terminal. Edits hot-reload without re-scanning.

**Private build:** `npm run pack` → `g2hermes.ehpk`, uploaded through the dev portal.

## Controls

| Input | Action |
|---|---|
| Tap | next notification; on the oldest, re-fetch the feed |
| Swipe up / down | step through notifications |
| Double-tap | exit, with the system confirmation dialog (mode 1 — required on a root page) |

The feed is polled every 20 s, and a newly-arrived notification jumps to the front
of the view automatically.

## Remote feed mode

By default the app fetches `/feed.json` from its own origin — no network permission
needed, and it works with no connectivity.

To pull from a server you control, pass `?feed=<url>` and make **both** true, or the
request never leaves the WebView:

1. The origin is in `app.json` → `permissions[0].whitelist`. The shipped placeholder
   is `http://192.168.1.100:8787`; replace it with yours. `https://` in production;
   `http://` is for a LAN dev server only.
2. That server returns `Access-Control-Allow-Origin` (and handles the `OPTIONS`
   preflight for JSON bodies).

The whitelist is **not** a CORS bypass — two independent gates. A request that works
in `curl` but fails here is almost always missing CORS headers server-side.

## Design constraints this app respects

- Canvas is 576×288 per eye, 4-bit green. No HTML, no CSS — containers at absolute
  pixel coordinates.
- At most 8 non-image containers per page; exactly one has `isEventCapture: 1`.
- No `zOrderIndex` anywhere, or it must be set on **every** container — so it is
  omitted and declaration order is used.
- `textColor` is 0–4 (brightness, not colour); `borderColor` is 0–15.
- `CLICK_EVENT` is `0`, and protobuf drops zero-value fields, so a single tap arrives
  with `eventType` **undefined**. The default is resolved inside the envelope check —
  `sysEvent?.eventType ?? CLICK_EVENT` would report a click on every scroll and exit frame.
- Scroll gestures arrive on `textEvent`; taps, double-taps and lifecycle on `sysEvent`.
  They are never mixed.
- Double-tap is checked **before** click, and exits from either envelope.
- Container names are capped at 16 chars — the title renders `G2HERMES · <category>` and
  is truncated to fit.
- 1,000-char budget at page creation, 2,000 on `textContainerUpgrade`.
- `app.json`'s `version` must be plain `x.y.z` — the packer rejects a semver
  prerelease suffix, so `1.0.0-beta.1` fails validation with
  `version: must be in x.y.z format`. The manifest therefore carries `1.0.0` and the
  beta identifier lives in the git tag and the GitHub release, not in the manifest.

## Verifying

```bash
npm run verify     # bundle against the stub SDK + run 24 assertions
```

Covers page creation (container count, single event capturer, canvas bounds,
`textColor` range, all-or-nothing `zOrderIndex`), the rendered strings (title shows
the category, body shows the notification and its position), input routing
(undefined-as-click, scroll stepping in both directions, double-tap exit from both
envelopes, scroll-never-exits, repaint suppression), and the no-crash path when the
feed fetch fails.

## Known limits

- The LVGL simulator (`@evenrealities/evenhub-simulator`) needs GTK3
  (`libgdk-3.so.0`) and could not run in the container this was built in — no root to
  install it. The offline harness above was used instead. Run `npm run simulate` on a
  normal desktop for the real render.
- Nothing has been confirmed on physical glasses; the simulator is explicitly not a
  hardware emulator, and neither is the harness.
- The MLB model is not backtested. Its inputs are the market, the two starters' season
  ERAs, and (as context only) park wind.
