/**
 * Faithful stand-in for @evenrealities/even_hub_sdk, used ONLY for offline
 * verification of this app's logic. Enum values and constructor shapes are
 * copied from the real SDK's index.d.ts. Nothing here ships in the .ehpk.
 */

export enum OsEventTypeList {
  CLICK_EVENT = 0,
  SCROLL_TOP_EVENT = 1,
  SCROLL_BOTTOM_EVENT = 2,
  DOUBLE_CLICK_EVENT = 3,
  FOREGROUND_ENTER_EVENT = 4,
  FOREGROUND_EXIT_EVENT = 5,
  ABNORMAL_EXIT_EVENT = 6,
  SYSTEM_EXIT_EVENT = 7,
  IMU_DATA_REPORT = 8,
  LONG_PRESS_EVENT = 9,
  LONG_PRESS_RELEASE_EVENT = 10,
}

export const calls = {
  create: [] as any[],
  upgrades: [] as any[],
  shutdowns: [] as number[],
  logs: [] as string[],
}
;(globalThis as any).__sdkCalls = calls
;(globalThis as any).__osEventTypeList = OsEventTypeList

export class TextContainerProperty {
  constructor(props: Record<string, any>) { Object.assign(this, props) }
}
export class TextContainerUpgrade {
  constructor(props: Record<string, any>) { Object.assign(this, props) }
}
export class CreateStartUpPageContainer {
  constructor(props: Record<string, any>) { Object.assign(this, props) }
}

let handler: ((e: any) => void) | null = null

const bridge = {
  async createStartUpPageContainer(c: any) {
    calls.create.push(c)
    return 0 // success
  },
  async textContainerUpgrade(c: any) {
    calls.upgrades.push(c)
    return true
  },
  async shutDownPageContainer(mode?: number) {
    calls.shutdowns.push(mode ?? -1)
    return true
  },
  onEvenHubEvent(cb: (e: any) => void) {
    handler = cb
    return () => { handler = null }
  },
}

export async function waitForEvenAppBridge() {
  return bridge as any
}

/** Test-only: push an event through the app's single subscription. */
export function __emit(event: any) {
  if (!handler) throw new Error('app never subscribed to onEvenHubEvent')
  handler(event)
}
;(globalThis as any).__emit = __emit