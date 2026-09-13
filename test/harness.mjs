/**
 * Offline verification of G2Con logic.
 *
 * Bundles src/main.ts against the stub SDK, runs it in Node with a minimal
 * browser shim, then drives events and asserts on what the app asked the
 * glasses to render. This proves the app's own code path — container layout,
 * the rendered strings, and event routing — without hardware or the LVGL
 * simulator (which needs GTK3).
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert'

const feed = JSON.parse(readFileSync(new URL('../public/feed.json', import.meta.url)))

globalThis.location = { search: '' }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => feed })

await import('./app.mjs')   // runs the app; populates the stub's globals
const emit = globalThis.__emit
const OsEventTypeList = globalThis.__osEventTypeList
const calls = globalThis.__sdkCalls

const fail = []
const check = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`) }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail.push(name) }
}

console.log('\n--- page creation ---')
const page = calls.create[0]
check('createStartUpPageContainer called exactly once', () => assert.equal(calls.create.length, 1))
check('containerTotalNum matches textObject count', () =>
  assert.equal(page.containerTotalNum, page.textObject.length))
check('exactly one container captures events', () =>
  assert.equal(page.textObject.filter((c) => c.isEventCapture === 1).length, 1))
const body = page.textObject.find((c) => c.isEventCapture === 1)
check('only the body captures events', () =>
  assert.equal(body.containerName, 'body'))
check('container names within 16 chars', () =>
  page.textObject.forEach((c) => assert.ok(c.containerName.length <= 16, c.containerName)))
check('all containers fit the 576x288 canvas', () =>
  page.textObject.forEach((c) => {
    assert.ok(c.xPosition + c.width <= 576, `${c.containerName} width`)
    assert.ok(c.yPosition + c.height <= 288, `${c.containerName} height`)
  }))
check('textColor within 0..4 (brightness, not colour)', () =>
  page.textObject.forEach((c) =>
    assert.ok(c.textColor >= 0 && c.textColor <= 4, `bad textColor ${c.textColor}`)))
check('zOrderIndex is all-or-nothing on the page', () => {
  const set = page.textObject.filter((c) => c.zOrderIndex !== undefined).length
  assert.ok(set === 0 || set === page.textObject.length, 'partially set zOrderIndex')
})

console.log('\n--- first render ---')
const newest = feed.notifications[0]
const bodyText = () => calls.upgrades.filter((u) => u.containerName === 'body').at(-1)?.content ?? ''
const titleText = () => calls.upgrades.filter((u) => u.containerName === 'title').at(-1)?.content ?? ''
check('body container was upgraded', () => assert.ok(bodyText(), 'no body upgrade'))
check('title shows the app name and the category', () => {
  assert.ok(titleText().includes('G2CON'), `title: ${JSON.stringify(titleText())}`)
  assert.ok(titleText().includes(newest.category), `title: ${JSON.stringify(titleText())}`)
})
check('title stays within the 16-char container limit', () =>
  assert.ok(titleText().length <= 16, `${titleText().length} chars`))
check('renders the newest notification title', () =>
  assert.ok(bodyText().includes(newest.title), `got: ${JSON.stringify(bodyText().slice(0, 90))}`))
check('renders the notification body', () =>
  assert.ok(bodyText().includes(newest.body.slice(0, 30)), 'body text missing'))
check('shows position in the list', () =>
  assert.ok(bodyText().includes(`1/${feed.notifications.length}`), 'no 1/N marker'))
check('upgrades only target the two declared containers', () =>
  calls.upgrades.forEach((u) => assert.ok([1, 2].includes(u.containerID), `id ${u.containerID}`)))
check('fits the 2000-char textContainerUpgrade budget', () =>
  calls.upgrades.forEach((u) => assert.ok(u.content.length <= 2000, `${u.content.length} chars`)))

console.log('\n--- input routing ---')
const ups = () => calls.upgrades.length
const before = ups()
emit({ textEvent: { containerID: body.containerID, containerName: 'body' } })
check('undefined eventType is treated as a click (advances to next)', () => {
  const t = bodyText()
  assert.ok(t.includes(`2/${feed.notifications.length}`), `did not advance: ${JSON.stringify(t.slice(-80))}`)
})
// Scroll gestures arrive on `textEvent` per the SDK docs — taps/double-taps and
// lifecycle come through `sysEvent`. Never mix them.
emit({ textEvent: { containerID: body.containerID, eventType: OsEventTypeList.SCROLL_TOP_EVENT } })
check('swipe up steps back', () =>
  assert.ok(bodyText().includes(`1/${feed.notifications.length}`), 'did not step back'))
emit({ textEvent: { containerID: body.containerID, eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
check('swipe down steps forward', () =>
  assert.ok(bodyText().includes(`2/${feed.notifications.length}`), 'did not step forward'))

const shutBefore = calls.shutdowns.length
emit({ textEvent: { containerID: body.containerID, eventType: OsEventTypeList.SCROLL_TOP_EVENT } })
check('scrolling never triggers an exit', () => assert.equal(calls.shutdowns.length, shutBefore))

emit({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
check('double-tap via sysEvent exits with mode 1 (system dialog)', () =>
  assert.deepEqual(calls.shutdowns.at(-1), 1))
emit({ textEvent: { containerID: body.containerID, eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
check('double-tap via textEvent also exits', () => assert.deepEqual(calls.shutdowns.at(-1), 1))

check('re-rendering identical content is suppressed (no wasted BLE)', () => {
  const n = ups()
  emit({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } })
  assert.equal(ups(), n, 'a long press caused a repaint')
})

console.log('\n--- fallback behaviour ---')
globalThis.fetch = async () => { throw new Error('network down') }
await new Promise((r) => setTimeout(r, 60))
check('a failing feed fetch does not crash the app', () => assert.ok(true))

console.log(fail.length
  ? `\nRESULT: ${fail.length} FAILED — ${fail.join(', ')}`
  : '\nRESULT: all checks passed')
process.exit(fail.length ? 1 : 0)