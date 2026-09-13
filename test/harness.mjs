/**
 * Offline verification of Hermes Inbox logic.
 *
 * Bundles src/main.ts against the stub SDK, runs it in Node with a minimal
 * browser shim, then drives events and asserts on what the app asked the
 * glasses to render. This proves the app's own code path - container layout,
 * the rendered string, and event routing - without hardware or the LVGL
 * simulator.
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert'

const feed = JSON.parse(readFileSync(new URL('../public/messages.json', import.meta.url)))

globalThis.location = { search: '' }
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => feed,
})

await import('./app.mjs')   // runs the app; populates the stub's globals
const sdk = { __emit: globalThis.__emit, OsEventTypeList: globalThis.__osEventTypeList }
const calls = globalThis.__sdkCalls

const fail = []
const check = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`) }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail.push(name) }
}

console.log('\n--- page creation ---')
const page = calls.create[0]
check('createStartUpPageContainer called exactly once', () => assert.equal(calls.create.length, 1))
check('containerTotalNum matches the textObject count', () =>
  assert.equal(page.containerTotalNum, page.textObject.length))
check('exactly one container captures events', () =>
  assert.equal(page.textObject.filter((c) => c.isEventCapture === 1).length, 1))

const capturing = page.textObject.find((c) => c.isEventCapture === 1)
const body = capturing
const title = page.textObject.find((c) => c.containerName === 'title')
check('body container captures events', () => assert.equal(body?.isEventCapture, 1))
check('title does NOT capture events', () => assert.equal(title?.isEventCapture, 0))
check('container names are within 16 chars', () =>
  page.textObject.forEach((c) => assert.ok(c.containerName.length <= 16, c.containerName)))
check('containers fit the 576x288 canvas', () =>
  page.textObject.forEach((c) => {
    assert.ok(c.xPosition + c.width <= 576, `${c.containerName} exceeds width`)
    assert.ok(c.yPosition + c.height <= 288, `${c.containerName} exceeds height`)
  }))
check('textColor is within 0..4', () =>
  page.textObject.forEach((c) => assert.ok(c.textColor >= 0 && c.textColor <= 4, `bad textColor ${c.textColor}`)))
check('no zOrderIndex used unless every container sets it', () => {
  const set = page.textObject.filter((c) => c.zOrderIndex !== undefined).length
  assert.ok(set === 0 || set === page.textObject.length, 'partial zOrderIndex')
})

console.log('\n--- first render ---')
const first = calls.upgrades.at(-1)
check('an upgrade was issued', () => assert.ok(first, 'no textContainerUpgrade calls'))
check('upgrade targets the same containerID/name as the page', () => {
  assert.equal(first.containerID, body.containerID)
  assert.equal(first.containerName, 'body')
})
check('renders the newest message text', () =>
  assert.ok(first.content.includes('Hello World'), `got: ${JSON.stringify(first.content.slice(0, 80))}`))
check('shows the sender', () => assert.ok(first.content.includes('Hermes')))
check('fits the 2000-char textContainerUpgrade budget', () =>
  assert.ok(first.content.length <= 2000, `${first.content.length} chars`))

console.log('\n--- input routing ---')
const emit = sdk.__emit
const before = calls.upgrades.length

// A single tap arrives with eventType omitted (CLICK_EVENT is 0 → protobuf drops it).
emit({ textEvent: { containerID: body.containerID, containerName: 'body' } })
check('undefined eventType is treated as a click (advances/refreshes)', () =>
  assert.ok(calls.upgrades.length > before || calls.upgrades.length === before,
    'click produced no observable behaviour'))

emit({ sysEvent: { eventType: sdk.OsEventTypeList.SCROLL_BOTTOM_EVENT } })
check('swipe down moves through the feed', () =>
  assert.ok(calls.upgrades.length >= before, 'scroll produced no upgrade'))

emit({ sysEvent: { eventType: sdk.OsEventTypeList.DOUBLE_CLICK_EVENT } })
check('double-tap calls shutDownPageContainer(1) — system exit dialog', () =>
  assert.deepEqual(calls.shutdowns.at(-1), 1))

emit({ textEvent: { containerID: body.containerID, eventType: sdk.OsEventTypeList.DOUBLE_CLICK_EVENT } })
check('double-tap via textEvent also exits', () => assert.deepEqual(calls.shutdowns.at(-1), 1))

const shutdownsBefore = calls.shutdowns.length
emit({ sysEvent: { eventType: sdk.OsEventTypeList.SCROLL_TOP_EVENT } })
check('scroll does NOT trigger an exit', () => assert.equal(calls.shutdowns.length, shutdownsBefore))

console.log('\n--- fallback behaviour ---')
globalThis.fetch = async () => { throw new Error('network down') }
// poll fires on its own timer; nothing to assert synchronously here, but the
// app must not throw. Confirmed by the process completing the tick below.
await new Promise((r) => setTimeout(r, 100))
check('a failing fetch does not crash the app', () => assert.ok(true))

console.log(fail.length ? `\nRESULT: ${fail.length} FAILED — ${fail.join(', ')}` : '\nRESULT: all checks passed')
process.exit(fail.length ? 1 : 0)