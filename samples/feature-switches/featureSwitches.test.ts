/**
 * FEATURE SWITCHES (Nov 2026, lib/features). The properties: deploying it
 * changes nothing (the defaults are today's app); a locked or not-yet-wired
 * row can never be opened or closed by a stored value or a request; a feature
 * is closed when anything it needs is closed (Coins off closes Gifts and
 * Boost); Admins only and a set time open it to admins first; the New dot and
 * the What's new card count from the opening and stop on time; the save refuses
 * what the page refuses; every Seller Center route refuses while it is off.
 */
/*
 * ⚠ AN EXCERPT. The project's file has ten blocks; these are the ones that test
 * this module on its own, copied unchanged. The other five check the rest of the
 * app — that every wired route is a real page, that every Seller Center handler
 * asks the switch first, that the admin's save refuses what the page refuses —
 * and need the whole repository.
 */
import { describe, it, expect } from 'vitest'
import {
  FEATURE_KEYS, FEATURE_SWITCHES_DEFAULT, featureSwitchesOf, isFeatureOpen, needsInTheWay, isFeatureNew,
  whatsNewFeature, featuresForPath, dependentsOf, type FeatureSwitches, type FeatureKey,
} from './featureSwitches'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 7, 12)
const PERSON = { isAdmin: false }, ADMIN = { isAdmin: true }
const with_ = (patch: Partial<Record<FeatureKey, Partial<FeatureSwitches[FeatureKey]>>>): FeatureSwitches =>
  featureSwitchesOf(Object.fromEntries(FEATURE_KEYS.map(k => [k, { ...FEATURE_SWITCHES_DEFAULT[k], ...(patch[k] ?? {}) }])))

describe('a stored value cannot open a lock or close what is not wired', () => {
  it('locked and always-on rows read as their fixed state whatever is stored', () => {
    const s = featureSwitchesOf({ khqr: { step: 'everyone' }, plans: { step: 'everyone' }, stories: { step: 'off' }, notes: { step: 'off' } })
    expect(s.khqr.step).toBe('off'); expect(s.plans.step).toBe('off')
    expect(s.stories.step).toBe('everyone'); expect(s.notes.step).toBe('everyone')
  })
  it('a broken row reads as today', () => {
    const s = featureSwitchesOf({ coins: { step: 'sometimes', opensAt: 'not a date', dot: 'yes' }, gifts: 7 })
    expect(s.coins).toEqual(FEATURE_SWITCHES_DEFAULT.coins); expect(s.gifts).toEqual(FEATURE_SWITCHES_DEFAULT.gifts)
  })
})

describe('Q6 — a feature needs what it needs', () => {
  it('Coins off closes Gifts and Boost, and turning Coins back on brings them back as they were', () => {
    const off = with_({ coins: { step: 'off' } })
    expect(isFeatureOpen('gifts', off, PERSON, NOW)).toBe(false)
    expect(isFeatureOpen('boost', off, ADMIN, NOW)).toBe(false)
    expect(off.gifts.step).toBe('everyone')
    expect(isFeatureOpen('gifts', with_({}), PERSON, NOW)).toBe(true)
    expect(dependentsOf('coins').sort()).toEqual(['boost', 'checkin', 'gifts'])
  })
  /* Re-pinned Nov 2026 — Boost a post: anybody boosts their OWN post, so the
     switch no longer needs Seller. A PRODUCT boost still does — its route asks
     for both (`featureClosedResponse('seller', 'boost')`). */
  it('Seller Center off leaves Boost open for posts; Coins off closes it', () => {
    expect(isFeatureOpen('boost', with_({ seller: { step: 'off' } }), PERSON, NOW)).toBe(true)
    expect(isFeatureOpen('boost', with_({ coins: { step: 'off' } }), PERSON, NOW)).toBe(false)
  })
  it('a feature cannot be raised above what it needs', () => {
    const s = with_({ coins: { step: 'admins' } })
    expect(needsInTheWay('gifts', 'everyone', s)).toEqual(['Coins'])
    expect(needsInTheWay('gifts', 'admins', s)).toEqual([])
    expect(needsInTheWay('gifts', 'off', with_({ coins: { step: 'off' } }))).toEqual([])
  })
})

describe('Q3 · Q4 — admins first', () => {
  it('Admins only: an admin can use it, nobody else can', () => {
    const s = with_({ rooms: { step: 'admins' } })
    expect(isFeatureOpen('rooms', s, ADMIN, NOW)).toBe(true)
    expect(isFeatureOpen('rooms', s, PERSON, NOW)).toBe(false)
  })
  it('At a time: admins see it until then, everybody from that minute', () => {
    const at = new Date(NOW + DAY).toISOString()
    const s = with_({ rooms: { step: 'everyone', opensAt: at } })
    expect(isFeatureOpen('rooms', s, ADMIN, NOW)).toBe(true)
    expect(isFeatureOpen('rooms', s, PERSON, NOW)).toBe(false)
    expect(isFeatureOpen('rooms', s, PERSON, NOW + DAY)).toBe(true)
  })
})

describe('Q5 — telling people, and stopping on time', () => {
  const opened = with_({ rooms: { openedAt: new Date(NOW).toISOString() }, coins: { openedAt: new Date(NOW - DAY).toISOString() } })
  it('the New dot lasts 7 days from the opening, and only while it is open', () => {
    expect(isFeatureNew('rooms', opened, PERSON, NOW + 6 * DAY)).toBe(true)
    expect(isFeatureNew('rooms', opened, PERSON, NOW + 7 * DAY)).toBe(false)
    expect(isFeatureNew('rooms', with_({ rooms: { openedAt: new Date(NOW).toISOString(), dot: false } }), PERSON, NOW)).toBe(false)
    expect(isFeatureNew('rooms', with_({ rooms: { openedAt: new Date(NOW).toISOString(), step: 'off' } }), PERSON, NOW)).toBe(false)
  })
  it('the What’s new card is the newest opening, for 3 days, and none before a scheduled opening', () => {
    expect(whatsNewFeature(opened, PERSON, NOW + DAY)).toBe('rooms')
    expect(whatsNewFeature(opened, PERSON, NOW + 3 * DAY)).toBeNull()
    const later = with_({ rooms: { opensAt: new Date(NOW + DAY).toISOString(), openedAt: new Date(NOW + DAY).toISOString() } })
    expect(whatsNewFeature(later, PERSON, NOW)).toBeNull()
  })
})

describe('pages', () => {
  it('a page belongs to every feature whose route it is under', () => {
    expect(featuresForPath('/creator/gifts').sort()).toEqual(['creator', 'gifts'])
    expect(featuresForPath('/seller/products')).toEqual(['seller'])
    expect(featuresForPath('/coins')).toEqual(['coins'])
    expect(featuresForPath('/feed')).toEqual(['home'])
    expect(featuresForPath('/account')).toEqual([])
  })
})
