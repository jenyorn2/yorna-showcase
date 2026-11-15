/* ─────────────────────────────────────────────────────────────
   YORNA HEADER MOTION — the ONE follow-finger model for the shared
   mobile page header (Home · Market · Chat).

   Pure math: no DOM, no React, no timers. The controller
   (useYornaHeaderFollowFinger) feeds scroll deltas in and writes the
   resulting pixel offset to a CSS variable.

   CONTRACT (single unit)
   The whole header — safe-area strip, row 1, the tab row and its
   divider — moves as ONE block. There is no independent search-row
   stage: two resting positions only.

     shown  (hidden = 0)        entire header on screen
     hidden (hidden = headerH)  entire header translated off the top

   Between them the offset follows the scroll 1:1 and may rest at any
   intermediate value while the finger is down — that partial state is
   the point of the interaction, not a transient.

     DOWN  hidden grows 1:1 with the scroll delta, clamped at headerH.
     UP    hidden shrinks 1:1, clamped at 0. Reversal applies on the
           very next delta — no accumulated threshold, no delay.
     TOP   at/above topLockPx the header is forced fully shown.

   RELEASE  settle() picks one of the two resting positions:
     · a flick decides by DIRECTION when |velocity| ≥ flickVelocity
       (fast up reveals, fast down hides) regardless of position;
     · otherwise position decides — past settleHiddenAt of the height
       it completes the hide, else it returns.
   This is what keeps a small accidental drag from popping the header
   open: nudging 20px up from fully hidden leaves it ~80% hidden and
   below the flick speed, so it settles back to hidden.

   This model REPLACES the Home-only staged model (search row hiding
   first, tabs-only resting stage, 128px reveal-intent hold). Home,
   Market and Chat now produce identical offsets for identical input.
───────────────────────────────────────────────────────────── */

export type YornaHeaderStage = 'shown' | 'hidden' | 'moving'

export type YornaHeaderMotionConfig = {
  /** Measured height of the whole header block (px) — the full travel. */
  headerH: number
  /** Scroll offset at/below which the header is always fully shown. */
  topLockPx: number
  /** Fraction of headerH hidden at/above which a release completes the
   *  hide (0..1). Below it the header returns. */
  settleHiddenAt: number
  /** |px per ms| at which a release is treated as a flick and DIRECTION
   *  decides the settle instead of position. */
  flickVelocity: number
}

export type YornaHeaderMotionState = {
  /** 0 (fully shown) … headerH (fully hidden). */
  hidden: number
  /** Direction of the most recent movement. */
  direction: 'up' | 'down' | 'idle'
  /** Smoothed signed speed, px/ms: + hiding (scrolling down), − revealing. */
  velocity: number
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** Velocity smoothing — one EMA weight, so a single jittery sample can
 *  neither trigger nor block a flick on its own. */
const VELOCITY_SMOOTHING = 0.7

export const DEFAULT_HEADER_MOTION: Omit<YornaHeaderMotionConfig, 'headerH'> = {
  topLockPx: 2,
  // Just past half: releasing with most of the header gone completes the
  // hide, releasing with most of it on screen brings it back.
  settleHiddenAt: 0.5,
  // 0.5px/ms ≈ 500px/s. A deliberate flick clears it easily; the slow
  // drift of a finger repositioning on the glass does not.
  flickVelocity: 0.5,
}

export function createYornaHeaderMotion(): YornaHeaderMotionState {
  return { hidden: 0, direction: 'idle', velocity: 0 }
}

/** Force the header fully on screen (scroll top, focus, tab entry). */
export function showYornaHeader(state: YornaHeaderMotionState): void {
  state.hidden = 0
  state.direction = 'idle'
  state.velocity = 0
}

/** Header height can change (resize / orientation / keyboard) — keep the
 *  offset inside the new travel. */
export function clampToConfig(state: YornaHeaderMotionState, cfg: YornaHeaderMotionConfig): void {
  state.hidden = clamp(state.hidden, 0, Math.max(0, cfg.headerH))
}

/**
 * Feed one scroll delta (positive = the page scrolled DOWN) into the model.
 * `dtMs` is the time since the previous sample and is used only for the
 * velocity estimate; pass 0 to leave velocity untouched (tests stepping
 * synthetically, or a coalesced frame with no clock).
 *
 * The caller has already filtered programmatic jumps and the top lock.
 */
export function applyScrollDelta(
  state: YornaHeaderMotionState,
  cfg: YornaHeaderMotionConfig,
  delta: number,
  dtMs = 0
): void {
  if (delta === 0) return
  state.direction = delta > 0 ? 'down' : 'up'
  state.hidden = clamp(state.hidden + delta, 0, Math.max(0, cfg.headerH))
  if (dtMs > 0) {
    const sample = delta / dtMs
    state.velocity = state.velocity * (1 - VELOCITY_SMOOTHING) + sample * VELOCITY_SMOOTHING
  }
}

/**
 * The gesture ended (finger lifted, or wheel/momentum went quiet). Complete
 * to whichever resting position the flick direction — or failing that the
 * visible fraction — calls for.
 */
export function settleYornaHeader(state: YornaHeaderMotionState, cfg: YornaHeaderMotionConfig): void {
  const travel = Math.max(0, cfg.headerH)
  if (travel === 0) {
    state.hidden = 0
  } else if (state.velocity >= cfg.flickVelocity) {
    state.hidden = travel // fast downward flick — commit the hide
  } else if (state.velocity <= -cfg.flickVelocity) {
    state.hidden = 0 // fast upward flick — reveal
  } else {
    state.hidden = state.hidden >= travel * cfg.settleHiddenAt ? travel : 0
  }
  state.direction = 'idle'
  state.velocity = 0
}

/** 0 → 1 hidden fraction. Drives any opacity/scrim tied to the header. */
export function headerProgress(state: YornaHeaderMotionState, cfg: YornaHeaderMotionConfig): number {
  return cfg.headerH > 0 ? clamp(state.hidden / cfg.headerH, 0, 1) : 0
}

/** Classify the offset (0.5px tolerance for float drift). */
export function stageOf(state: YornaHeaderMotionState, cfg: YornaHeaderMotionConfig): YornaHeaderStage {
  if (cfg.headerH <= 0) return 'shown'
  if (state.hidden <= 0.5) return 'shown'
  if (state.hidden >= cfg.headerH - 0.5) return 'hidden'
  return 'moving'
}
