import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

/**
 * G2Con — notifications from Hermes, rendered on the Even G2.
 *
 * The feed is a flat list of notifications, each tagged with a category
 * (`mlb`, `system`, ...). Categories are how this grows: every feed generator
 * owns one category and replaces it wholesale. The app renders whatever is in
 * the list, newest first, so adding a feed needs no app change.
 *
 * Feed resolution:
 *   1. ?feed=<url> query param (must be whitelisted in app.json for remote origins)
 *   2. /feed.json — same-origin static file served alongside the app
 */

const READY_MARKER = '[g2con] ready'
const LOCAL_FEED = '/feed.json'
const POLL_MS = 20_000
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
type Feed = { feed: string; version: number; notifications: Notification[] }

const FALLBACK: Feed = {
  feed: 'g2con',
  version: 2,
  notifications: [{
    id: 0, category: 'system', title: 'No feed',
    body: 'Could not reach the feed. Showing the bundled fallback so the screen is not blank.',
  }],
}

function feedUrl(): string {
  const q = new URLSearchParams(location.search).get('feed')
  return q && /^https?:\/\//i.test(q) ? q : LOCAL_FEED
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
  content: 'G2CON', textColor: 2, isEventCapture: 0,
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
    upgrade(CONTAINER_TITLE, 'title', 'G2CON')
    upgrade(CONTAINER_BODY, 'body', 'No notifications.\n\nDouble-tap to exit.')
    return
  }

  upgrade(CONTAINER_TITLE, 'title', `G2CON · ${n.category}`.slice(0, TITLE_MAX))

  const meta = [
    n.category,
    ageOf(n.ts),
    `${index + 1}/${list.length}`,
    n.priority && n.priority >= 2 ? `p${n.priority}` : null,
  ].filter(Boolean).join('  ·  ')

  upgrade(CONTAINER_BODY, 'body',
    `${n.title}\n\n${n.body ?? ''}\n\n${meta}\nTap: next  ·  Double-tap: exit`)
}

async function loadFeed(reason: string): Promise<void> {
  try {
    const res = await fetch(feedUrl(), { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as Feed
    if (!Array.isArray(data?.notifications)) throw new Error('feed has no notifications array')
    const prevNewest = feed.notifications[0]?.id
    feed = data
    if (data.notifications[0]?.id !== prevNewest) index = 0  // new arrival -> jump to it
    console.log(`${READY_MARKER} feed loaded (${reason}) — ${data.notifications.length} notification(s)`)
  } catch (err) {
    console.error(`${READY_MARKER} feed fetch failed (${reason}):`, err)
  }
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