import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

/**
 * G2Hermes — a notification feed for the Even Realities G2.
 *
 * The feed is a flat list of notifications, each tagged with a category. The app
 * renders whatever it finds, newest first, so adding a feed generator on your own
 * server never requires an app change.
 *
 * This app ships with NO server, no credentials and no feed baked in. You point it
 * at your own endpoint.
 *
 * ## Configuring the endpoint
 *
 * Set `endpoint` in `app.json` — the same file as the network `whitelist` that
 * permits it — then rebuild. Both halves of network access live in one place
 * because they are useless apart: the whitelist is enforced *before* the request
 * leaves the WebView, so a mismatch fails silently on the device.
 *
 * `scripts/gen-endpoint.mjs` reads that field at build time and regenerates
 * `src/generated-endpoint.ts`, so the URL is compiled in rather than fetched. It
 * also refuses to build an endpoint whose origin is missing from the whitelist,
 * turning a silent device-side failure into a clear build error.
 *
 * `localStorage g2hermes.endpoint` still overrides at runtime, and a bearer token
 * is read from `localStorage` (`g2hermes.token`) — so no credential ever belongs
 * in `app.json`, which ships inside an extractable package.
 *
 * Resolution order, first success wins:
 *   1. ?feed=<url>                     — manual override
 *   2. localStorage g2hermes.endpoint  — set at runtime
 *   3. ENDPOINT                        — generated from app.json
 */
import { ENDPOINT } from './generated-endpoint'

const READY_MARKER = '[g2hermes] ready'
const STORE_ENDPOINT = 'g2hermes.endpoint'
const STORE_TOKEN = 'g2hermes.token'
const POLL_MS = 60_000
const CONTAINER_TITLE = 1
const CONTAINER_BODY = 2
const TITLE_MAX = 16

type Notification = {
  id: number
  category: string
  title: string
  body?: string
  priority?: number
  ts?: string
  source?: string
}
type Feed = { feed: string; version: number; updated?: string; notifications: Notification[] }

const FALLBACK: Feed = {
  feed: 'g2hermes',
  version: 2,
  notifications: [{
    id: 0, category: 'setup', title: 'Not configured',
    body: 'No feed endpoint is set.\n\nSet `endpoint` in app.json (keeping its origin in the whitelist) and rebuild — or store g2hermes.endpoint in localStorage at runtime.',
  }],
}

/** Read a value the WebView persisted. localStorage survives backgrounding and lock. */
function stored(key: string): string {
  try {
    return (globalThis.localStorage?.getItem(key) || '').trim()
  } catch {
    return ''
  }
}

type Source = { url: string; init?: RequestInit }

function feedSources(): Source[] {
  const out: Source[] = []
  const q = new URLSearchParams(location.search).get('feed')
  if (q && /^https?:\/\//i.test(q)) out.push({ url: q, init: withAuth() })

  const runtime = stored(STORE_ENDPOINT)
  if (runtime) out.push({ url: runtime, init: withAuth() })

  // ENDPOINT is generated from app.json's network.endpoint at build time, so
  // there is nothing to fetch for it — and, unlike a bundled config file, no way
  // for this source to fail for reasons of its own.
  if (ENDPOINT) out.push({ url: ENDPOINT, init: withAuth() })

  // A packager may ship a snapshot alongside the app; useful only as a last resort.
  out.push({ url: '/feed.json' })
  return out
}

/**
 * Attach the bearer token when one is stored. A custom header makes this a
 * non-simple request, so the server must answer the OPTIONS preflight too.
 */
function withAuth(): RequestInit {
  const token = stored(STORE_TOKEN)
  return token
    ? { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } }
    : { cache: 'no-store' }
}

function ageOf(ts?: string): string {
  if (!ts) return ''
  const then = Date.parse(ts)
  if (Number.isNaN(then)) return ''
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / (60 * 24))}d ago`
}

const bridge = await waitForEvenAppBridge()

// Two text containers, declaration order = stacking order (no zOrderIndex, which
// is all-or-nothing per page and therefore omitted deliberately). Only the body
// captures input.
const titleContainer = new TextContainerProperty({
  xPosition: 0, yPosition: 0, width: 576, height: 40,
  borderWidth: 0, borderColor: 5, paddingLength: 6,
  containerID: CONTAINER_TITLE, containerName: 'title',
  content: 'G2HERMES', textColor: 2, isEventCapture: 0,
})

const bodyContainer = new TextContainerProperty({
  xPosition: 0, yPosition: 44, width: 576, height: 244,
  borderWidth: 1, borderColor: 5, paddingLength: 8,
  containerID: CONTAINER_BODY, containerName: 'body',
  content: 'Connecting…', textColor: 4, isEventCapture: 1,
})

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [titleContainer, bodyContainer],
  }),
)

if (result !== 0) {
  // 1 = invalid params, 2 = oversize, 3 = out of memory
  console.error(`${READY_MARKER} FAILED — createStartUpPageContainer returned ${result}`)
} else {
  console.log(`${READY_MARKER} page created`)
}

let feed: Feed = FALLBACK
let index = 0
const painted = new Map<string, string>()

function upgrade(id: number, name: string, content: string): void {
  // textContainerUpgrade no-ops on a containerID/containerName mismatch, and
  // re-sending identical content is wasted BLE traffic.
  if (painted.get(name) === content) return
  painted.set(name, content)
  bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: id, containerName: name, content,
  }))
}

function render(): void {
  const list = feed.notifications
  const n = list[index]

  if (!n) {
    upgrade(CONTAINER_TITLE, 'title', 'G2HERMES')
    upgrade(CONTAINER_BODY, 'body', 'No notifications.\n\nDouble-tap to exit.')
    return
  }

  // The title container is 40 px tall across 576 px, so roughly 16 characters fit.
  // Categories are chosen by whoever produces the feed and can be arbitrarily long,
  // so `G2HERMES · <category>` would eat the whole budget and truncate the very word
  // that identifies the notification. When it does not fit, drop the app name — the
  // wearer knows what app they opened; the category is the informative part.
  const label = `G2HERMES · ${n.category}`
  upgrade(CONTAINER_TITLE, 'title',
    label.length <= TITLE_MAX ? label : n.category.slice(0, TITLE_MAX))

  // Show the feed's own publish time next to the notification's age: when a cache
  // sits between the server and here, "how stale is this" is the question a glance
  // should answer.
  const meta = [
    ageOf(n.ts),
    feed.updated ? `feed ${ageOf(feed.updated)}` : null,
    `${index + 1}/${list.length}`,
    n.priority && n.priority >= 2 ? `p${n.priority}` : null,
  ].filter(Boolean).join('  ·  ')

  upgrade(CONTAINER_BODY, 'body',
    `${n.title}\n\n${n.body ?? ''}\n\n${meta}\nTap: next  ·  Double-tap: exit`)
}

async function loadFeed(reason: string): Promise<void> {
  for (const source of feedSources()) {
    try {
      const res = await fetch(source.url, source.init ?? { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as Feed
      if (!Array.isArray(data?.notifications)) throw new Error('feed has no notifications array')
      const prevNewest = feed.notifications[0]?.id
      feed = data
      if (data.notifications[0]?.id !== prevNewest) index = 0  // new arrival -> jump to it
      console.log(`${READY_MARKER} feed loaded (${reason}) from ${source.url} — ${data.notifications.length} notification(s)`)
      render()
      return
    } catch (err) {
      // Keep the last good feed on screen and fall through to the next source.
      console.warn(`${READY_MARKER} source failed (${reason}): ${source.url}`, err)
    }
  }
  console.error(`${READY_MARKER} every feed source failed (${reason})`)
  render()
}

await loadFeed('boot')
setInterval(() => void loadFeed('poll'), POLL_MS)

/**
 * CLICK_EVENT is 0 and protobuf omits zero-value fields, so a single tap arrives
 * with eventType undefined. The default must be resolved INSIDE the envelope
 * check — `sysEvent?.eventType ?? CLICK_EVENT` would report a click on every
 * scroll, exit and audio frame.
 */
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

bridge.onEvenHubEvent((event) => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  // Root-level check, before click: checking click first would swallow it.
  // Mode 1 shows the system exit-confirmation dialog, required on a root page.
  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
    return
  }

  if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
    index = Math.max(0, index - 1); render(); return
  }
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    index = Math.min(feed.notifications.length - 1, index + 1); render(); return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    if (index + 1 < feed.notifications.length) {
      index += 1; render()
    } else {
      void loadFeed('tap-refresh').then(() => { index = 0; render() })
    }
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    console.log(`${READY_MARKER} exit event`)
  }
})
