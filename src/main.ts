import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

/**
 * Hermes Inbox — displays messages sent by Hermes on the Even G2.
 *
 * Feed resolution order:
 *   1. ?feed=<url> query param (must be whitelisted in app.json for remote origins)
 *   2. /messages.json — same-origin static file served alongside the app
 *
 * The bundled file means the app never shows a blank screen, even with no
 * network permission granted. Remote mode is opt-in.
 */

const READY_MARKER = '[hermes-glasses] ready'
const LOCAL_FEED = '/messages.json'
const POLL_MS = 20_000
const CONTAINER_TITLE = 1
const CONTAINER_BODY = 2

type Message = { id: number; text: string; detail?: string; ts?: string }
type Feed = { from: string; messages: Message[] }

const FALLBACK: Feed = {
  from: 'Hermes',
  messages: [{ id: 0, text: 'Hello World', detail: 'Bundled fallback — the feed could not be reached.' }],
}

function feedUrl(): string {
  const q = new URLSearchParams(location.search).get('feed')
  return q && /^https?:\/\//i.test(q) ? q : LOCAL_FEED
}

const bridge = await waitForEvenAppBridge()

// Two text containers. Declaration order is stacking order here (no zOrderIndex
// on the page, so the SDK keeps declaration order). Only the body captures input.
const titleContainer = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 40,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 6,
  containerID: CONTAINER_TITLE,
  containerName: 'title',
  content: 'HERMES INBOX',
  textColor: 2,
  isEventCapture: 0,
})

const bodyContainer = new TextContainerProperty({
  xPosition: 0,
  yPosition: 44,
  width: 576,
  height: 244,
  borderWidth: 1,
  borderColor: 5,
  paddingLength: 8,
  containerID: CONTAINER_BODY,
  containerName: 'body',
  content: 'Connecting to feed...',
  textColor: 4,
  isEventCapture: 1,
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
let lastRendered = ''

function render(): void {
  const m = feed.messages[index]
  if (!m) {
    paint('No messages yet.\n\nDouble-tap to exit.')
    return
  }
  const meta = [
    `from ${feed.from}`,
    m.ts ? new Date(m.ts).toISOString().slice(5, 16).replace('T', ' ') + 'Z' : null,
    `${index + 1}/${feed.messages.length}`,
  ].filter(Boolean).join('  ·  ')

  const body = `${m.text}\n\n${m.detail ?? ''}\n\n${meta}\nTap: next  ·  Double-tap: exit`
  paint(body)
}

function paint(content: string): void {
  if (content === lastRendered) return
  lastRendered = content
  bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: CONTAINER_BODY,
      containerName: 'body',
      content,
    }),
  )
}

async function loadFeed(reason: string): Promise<void> {
  const url = feedUrl()
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as Feed
    if (!data?.messages?.length) throw new Error('feed has no messages')
    const previousNewest = feed.messages[0]?.id
    feed = data
    if (data.messages[0].id !== previousNewest) index = 0
    console.log(`${READY_MARKER} feed loaded (${reason}) — ${data.messages.length} message(s)`)
  } catch (err) {
    console.error(`${READY_MARKER} feed fetch failed (${reason}):`, err)
  }
  render()
}

await loadFeed('boot')
setInterval(() => void loadFeed('poll'), POLL_MS)

/**
 * CLICK_EVENT is 0 and protobuf omits zero-value fields, so a single tap
 * arrives with eventType undefined. Resolve the default INSIDE the envelope
 * check — reading `sysEvent?.eventType ?? CLICK_EVENT` would report a click on
 * every scroll, exit and audio frame.
 */
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

bridge.onEvenHubEvent((event) => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  // Double-tap must exit from anywhere — it is a root-level check, and it has
  // to be tested BEFORE click (checking click first would swallow it).
  // Mode 1 shows the system exit-confirmation dialog, required on the root page.
  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
    return
  }

  if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
    index = Math.max(0, index - 1)
    render()
    return
  }
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    index = Math.min(feed.messages.length - 1, index + 1)
    render()
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    if (index + 1 < feed.messages.length) {
      index += 1
      render()
    } else {
      void loadFeed('tap-refresh')
    }
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    console.log(`${READY_MARKER} exit event`)
  }
})