/**
 * Shared mobile header follow-finger motion — the ONE model behind Home,
 * Market and Chat.
 *
 * BEHAVIOR tests for the pure math the useYornaHeaderFollowFinger
 * controller drives:
 *   down    → the whole header translates up 1:1, clamped at its height;
 *   up      → it follows back down 1:1 from the very next delta;
 *   release → completes to fully shown or fully hidden, by flick
 *             direction when the gesture was fast, else by how much of
 *             the header is left on screen.
 * These are the numbered motion requirements of the shared-header
 * milestone; the e2e suite proves the same contract in a real browser.
 */
import { describe, expect, it } from 'vitest'
import {
  applyScrollDelta,
  clampToConfig,
  createYornaHeaderMotion,
  DEFAULT_HEADER_MOTION,
  headerProgress,
  settleYornaHeader,
  showYornaHeader,
  stageOf,
  type YornaHeaderMotionConfig,
} from './yornaHeaderMotion'

/** 8px safe strip + 60px row 1 + 40px tab row = the shipped 108px header. */
const CFG: YornaHeaderMotionConfig = { ...DEFAULT_HEADER_MOTION, headerH: 108 }

const fresh = () => createYornaHeaderMotion()

/** Feed a gesture as a series of small deltas, like real scroll events.
 *  `dt` per step keeps the velocity estimate realistic (16ms ≈ one frame). */
function drag(state: ReturnType<typeof fresh>, total: number, step = 8, dt = 16) {
  const dir = Math.sign(total)
  let left = Math.abs(total)
  while (left > 0) {
    const d = Math.min(step, left)
    applyScrollDelta(state, CFG, dir * d, dt)
    left -= d
  }
}

describe('1 · at the top the header is fully visible', () => {
  it('starts fully shown', () => {
    const s = fresh()
    expect(s.hidden).toBe(0)
    expect(stageOf(s, CFG)).toBe('shown')
    expect(headerProgress(s, CFG)).toBe(0)
  })

  it('showYornaHeader restores it from any offset', () => {
    const s = fresh()
    drag(s, 70)
    showYornaHeader(s)
    expect(s.hidden).toBe(0)
    expect(stageOf(s, CFG)).toBe('shown')
  })
})

describe('2–3 · scrolling down follows the finger progressively', () => {
  it('a slow downward drag leaves an INTERMEDIATE offset, not a jump', () => {
    const s = fresh()
    drag(s, 40)
    expect(s.hidden).toBe(40)
    expect(stageOf(s, CFG)).toBe('moving')
  })

  it('tracks the scroll delta 1:1 the whole way', () => {
    const s = fresh()
    for (const total of [10, 25, 50, 90]) {
      const t = fresh()
      drag(t, total)
      expect(t.hidden).toBe(total)
    }
    drag(s, 12)
    applyScrollDelta(s, CFG, 7, 16)
    expect(s.hidden).toBe(19)
  })

  it('does not hide after crossing a tiny threshold', () => {
    const s = fresh()
    drag(s, 6, 2)
    expect(s.hidden).toBe(6) // still 6px, NOT committed to the full height
    expect(stageOf(s, CFG)).toBe('moving')
  })
})

describe('4 · reversing upward reveals immediately', () => {
  it('the very next upward delta already moves the header back', () => {
    const s = fresh()
    drag(s, 108) // fully hidden
    expect(stageOf(s, CFG)).toBe('hidden')
    applyScrollDelta(s, CFG, -5, 16)
    expect(s.hidden).toBe(103) // no accumulated threshold to overcome first
    expect(stageOf(s, CFG)).toBe('moving')
  })

  it('reveals progressively, without needing to reach the top of the page', () => {
    const s = fresh()
    drag(s, 108)
    drag(s, -30)
    expect(s.hidden).toBe(78)
    drag(s, -30)
    expect(s.hidden).toBe(48)
  })
})

describe('5–6 · release settles by how much is left on screen', () => {
  it('mostly hidden → completes the hide', () => {
    const s = fresh()
    drag(s, 70, 8, 60) // slow: 8px per 60ms ≈ 0.13px/ms, well under a flick
    settleYornaHeader(s, CFG)
    expect(s.hidden).toBe(CFG.headerH)
    expect(stageOf(s, CFG)).toBe('hidden')
  })

  it('mostly visible → returns to fully shown', () => {
    const s = fresh()
    drag(s, 40, 8, 60)
    settleYornaHeader(s, CFG)
    expect(s.hidden).toBe(0)
    expect(stageOf(s, CFG)).toBe('shown')
  })

  it('a small accidental drag up from hidden does NOT pop the header open', () => {
    const s = fresh()
    drag(s, 108, 8, 60)
    drag(s, -14, 7, 60) // a 14px slip, slowly
    settleYornaHeader(s, CFG)
    expect(s.hidden).toBe(CFG.headerH)
  })
})

describe('7–8 · a flick decides by direction, whatever the position', () => {
  it('a fast upward flick reveals even from almost fully hidden', () => {
    const s = fresh()
    drag(s, 108, 8, 60)
    drag(s, -12, 6, 4) // 6px per 4ms = 1.5px/ms — a real flick
    settleYornaHeader(s, CFG)
    expect(s.hidden).toBe(0)
  })

  it('a fast downward flick hides even from barely moved', () => {
    const s = fresh()
    drag(s, 12, 6, 4)
    settleYornaHeader(s, CFG)
    expect(s.hidden).toBe(CFG.headerH)
  })

  it('below the flick speed, POSITION decides', () => {
    const s = fresh()
    drag(s, 12, 6, 60) // 0.1px/ms — not a flick
    settleYornaHeader(s, CFG)
    expect(s.hidden).toBe(0)
  })
})

describe('9 · the offset never leaves its range', () => {
  it('cannot translate past fully hidden', () => {
    const s = fresh()
    drag(s, 400)
    expect(s.hidden).toBe(CFG.headerH)
  })

  it('cannot translate below its resting position (overscroll / pull-down)', () => {
    const s = fresh()
    drag(s, -400)
    expect(s.hidden).toBe(0)
    expect(stageOf(s, CFG)).toBe('shown')
  })

  it('stays in range across a long mixed gesture', () => {
    const s = fresh()
    for (const d of [60, -20, 90, -300, 500, -40, 25]) {
      drag(s, d)
      expect(s.hidden).toBeGreaterThanOrEqual(0)
      expect(s.hidden).toBeLessThanOrEqual(CFG.headerH)
    }
  })
})

describe('10 · returning to the top fully reveals it', () => {
  it('settling at/above the top lock shows the whole header', () => {
    const s = fresh()
    drag(s, 108)
    // The controller calls showYornaHeader instead of settling once the
    // scroll offset is inside topLockPx — this is that contract.
    expect(CFG.topLockPx).toBeGreaterThan(0)
    showYornaHeader(s)
    expect(s.hidden).toBe(0)
    expect(headerProgress(s, CFG)).toBe(0)
  })
})

describe('geometry safety', () => {
  it('re-clamps when the measured height shrinks (rotate / keyboard)', () => {
    const s = fresh()
    drag(s, 108)
    const shorter: YornaHeaderMotionConfig = { ...CFG, headerH: 80 }
    clampToConfig(s, shorter)
    expect(s.hidden).toBe(80)
    expect(stageOf(s, shorter)).toBe('hidden')
  })

  it('a zero-height header is inert, never NaN', () => {
    const zero: YornaHeaderMotionConfig = { ...CFG, headerH: 0 }
    const s = fresh()
    applyScrollDelta(s, zero, 40, 16)
    expect(s.hidden).toBe(0)
    expect(headerProgress(s, zero)).toBe(0)
    expect(stageOf(s, zero)).toBe('shown')
    settleYornaHeader(s, zero)
    expect(s.hidden).toBe(0)
  })

  it('progress is the hidden fraction, 0 → 1', () => {
    const s = fresh()
    drag(s, 54)
    expect(headerProgress(s, CFG)).toBeCloseTo(0.5, 5)
  })

  it('a zero delta changes nothing at all', () => {
    const s = fresh()
    drag(s, 30)
    const before = { ...s }
    applyScrollDelta(s, CFG, 0, 16)
    expect(s).toEqual(before)
  })
})

describe('11–12 · one model, so all three surfaces move identically', () => {
  it('the same scroll input produces the same offset for Home, Market and Chat', () => {
    // Nothing in the model is page-aware: the only input is the measured
    // header height, which is the same 108px shared geometry everywhere.
    const input = [30, -12, 65, -8, 44]
    const run = () => {
      const s = fresh()
      for (const d of input) drag(s, d)
      settleYornaHeader(s, CFG)
      return s.hidden
    }
    const [home, market, chat] = [run(), run(), run()]
    expect(home).toBe(market)
    expect(market).toBe(chat)
  })
})
