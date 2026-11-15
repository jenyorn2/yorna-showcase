/* ─────────────────────────────────────────────────────────────
   FEATURE SWITCHES — an admin turns a part of YORNA on or off, live
   (Nov 2026).

   The requirement: an admin can switch any feature on or off — coins, gifts,
   boosts, creator tools, the seller dashboard, rooms — and open one for launch
   at any time; when a feature is off, everything about it is hidden. Decided:
     Q1 an Admin page, Features · Q2 off = hidden everywhere, its pages send
     people to Home · Q3 Off · Admins only · Everyone · Q4 Now or At a time
     (admins see it until then) · Q5 a New dot for 7 days and a What's new card
     on Home for 3 days · Q6 a feature cannot be open without what it needs ·
     Q8 KHQR and Seller plans locked · Q9 a change reaches everyone within a
     minute.

   ⭐ WHY THIS EXISTS BESIDE `config/launch-flags.ts`. Those are compile-time
   constants — a change is a deploy, 31 of 42 had no reader, and `coins: false`
   hid coin rewards while the coin shop and gifts stayed live. These are read at
   RUN time, from one SiteSetting row, by the doors, the pages and the server.

   ⚠ THREE KINDS OF ROW, AND ONLY ONE HAS A SWITCH:
     · `switch`  — wired: every door, page and server action reads it;
     · `next`    — always on; its switch is not wired yet, so the page shows the
                   state and offers no control (a switch that does nothing is
                   the defect this project keeps removing);
     · `locked`  — turning it on today would hurt somebody, or needs work first.

   ⚠ A LEAF (convention 8): no Prisma, no React. The read, the API, the admin
   page, the client hook and the guard all take their names from here.
───────────────────────────────────────────────────────────── */

export const FEATURE_KEYS = [
  'video', 'home', 'market', 'chat',
  'coins', 'gifts', 'boost', 'checkin',
  'creator', 'stories', 'live', 'pin',
  'seller', 'deals', 'khqr', 'plans',
  'rooms', 'notes',
] as const
export type FeatureKey = (typeof FEATURE_KEYS)[number]

export const FEATURE_STEPS = ['off', 'admins', 'everyone'] as const
export type FeatureStep = (typeof FEATURE_STEPS)[number]

export type FeatureMode = 'switch' | 'next' | 'locked'
export type FeatureGroup = 'pages' | 'money' | 'create' | 'sell' | 'social'

export interface FeatureInfo {
  key: FeatureKey
  group: FeatureGroup
  name: string
  what: string
  mode: FeatureMode
  /** What it cannot work without (Q6). */
  needs: readonly FeatureKey[]
  /** Pages that belong to it: closed → they send people to where the app opens (Home unless hidden). */
  routes: readonly string[]
  /** Where a person meets it, in words — the admin page's "Where it shows". */
  places: readonly string[]
  /** What the server refuses while it is closed. */
  server: readonly string[]
  /** Locked or not-yet-wired: why, in words. */
  reason?: string
  /** For `next` and `locked`: the state it is really in. */
  fixed?: FeatureStep
}

export const FEATURE_GROUPS: readonly [FeatureGroup, string][] = [
  ['pages', 'Pages'], ['money', 'Money & rewards'], ['create', 'Creating'], ['sell', 'Selling'], ['social', 'Social'],
]

const NEXT = 'Always on. Its switch is not wired yet — it is in the next build, so nothing here would change the app.'

export const FEATURES: readonly FeatureInfo[] = [
  /* THE FOUR MAIN PAGES (Nov 2026, lib/nav/tabOrder). A closed page takes its
     tab, its swipe panel, its address and every door into it. Profile is not
     here: it can move but never hide (Q2). ⚠ Q3 — at least one of the four
     stays open to everyone; the writer refuses the last one. */
  { key: 'video', group: 'pages', name: 'Video', what: 'Full-screen clips you swipe through', mode: 'switch', needs: [],
    routes: ['/video'],
    places: ['The Video tab and its swipe panel', 'Video in the desktop rail'],
    server: [],
    reason: 'Videos people post still appear and play on Home.' },
  { key: 'home', group: 'pages', name: 'Home', what: 'Community: posts, stories and Rooms', mode: 'switch', needs: [],
    routes: ['/feed'],
    places: ['The Home tab and its swipe panel', 'Home in the desktop rail', 'The app opens on the page picked under Opens on'],
    server: [],
    reason: 'Posting still works from the + and from your profile.' },
  /* ⭐ MARKET OFF IS SHOPPING OFF (14 Nov 2026: turning Market off must turn
     off everything about shopping, everywhere).
     It used to take only the tab and the page, and said so ("Products … still
     open and can be bought"). Now it takes every door into shopping, the
     product, cart and checkout pages, the product cards on Home, and Seller
     Center with it (`seller` needs `market`); the server refuses a new order.
     ⚠ ORDERS ALREADY PLACED STAY REACHABLE by their link and notification —
     somebody paid for them — but their doors (My orders) are not drawn. */
  { key: 'market', group: 'pages', name: 'Market', what: 'Browse, buy and sell in the shops', mode: 'switch', needs: [],
    routes: ['/marketplace', '/products', '/category', '/browse', '/search', '/cart', '/checkout', '/account/wishlist'],
    places: [
      'The Market tab and its swipe panel', 'Market in the desktop rail',
      'Product pages, the cart and checkout',
      'Shop, Wishlist and My orders on your profile; Shop and Reviews on other people’s',
      'Product cards on Home, Video, stories and in a chat',
      'Market in Settings',
      'Seller Center and everything that needs it',
    ],
    server: ['Placing an order', 'Starting a deal in a chat'],
    reason: 'Orders already placed can still be opened from their notification or link — somebody paid for them. Seller Center closes with Market and comes back with it.' },
  { key: 'chat', group: 'pages', name: 'Chat', what: 'Messages, groups and deals', mode: 'switch', needs: [],
    routes: ['/inbox'],
    places: ['The Chat tab, its swipe panel and its unread dot', 'Chat in the desktop rail', 'Message buttons that open a chat'],
    server: ['Sending a message', 'Starting a conversation'] },
  { key: 'coins', group: 'money', name: 'Coins', what: 'Buy coins, spend them on gifts and boost', mode: 'switch', needs: [],
    routes: ['/coins'],
    places: ['The coin shop', 'The coins number and Coins tool on the Creator page', 'Coins in the Creating menu', 'Coins in the Market menu', '“Get coins” on Live and in Seller products'],
    server: ['Buying coins', 'Claiming coins'] },
  { key: 'gifts', group: 'money', name: 'Gifts', what: 'Send a gift on a video', mode: 'switch', needs: ['coins'],
    routes: ['/creator/gifts'],
    places: ['The gift button and tray on Video', 'The Gifts card and tool on the Creator page', 'Gifts in the Creating menu'],
    server: ['Sending a gift'] },
  /* Boost a post (Nov 2026) — anybody boosts their own post, so Boost no longer
     needs Seller. A PRODUCT boost still does: its route asks for both. */
  { key: 'boost', group: 'money', name: 'Boost', what: 'Spend coins to show your post — or a product — to more people', mode: 'switch', needs: ['coins'],
    routes: ['/boost'],
    places: ['Boost post on your own posts (the row under it, and ⋯)', 'Boost video in your own video’s Send sheet', 'The Boost button in Seller products'],
    server: ['Starting a boost'],
    reason: 'A boost already running keeps running until it ends — it was paid for.' },
  { key: 'checkin', group: 'money', name: 'Daily check-in', what: 'Coins for opening the app each day', mode: 'locked', needs: ['coins'], fixed: 'off',
    routes: [], places: ['The check-in page'], server: ['Claiming the day’s coins'],
    reason: 'Its page was archived in June 2026. Turning it on needs the page rebuilt first.' },
  { key: 'creator', group: 'create', name: 'Creator tools', what: 'Your plays, gifts and videos in one place', mode: 'switch', needs: [],
    routes: ['/creator'],
    places: ['The Creator page and its Gifts and Videos lists', 'The Creating band in ☰', '“Creator tools” in Settings and on your profile'],
    server: ['The creator screens'] },
  { key: 'stories', group: 'create', name: 'Stories', what: 'Photos and videos that last a day', mode: 'next', needs: [], fixed: 'everyone',
    routes: [], places: ['The story row on Home and Chat', 'The + on your photo', 'Story in the composer'], server: [], reason: NEXT },
  { key: 'live', group: 'create', name: 'Live watching', what: 'Watch a live stream', mode: 'next', needs: [], fixed: 'everyone',
    routes: [], places: ['The Live tab on Video', 'Live pages'], server: [], reason: NEXT },
  { key: 'pin', group: 'create', name: 'Product pin', what: 'Tag a product on a post, video or story', mode: 'locked', needs: ['seller'], fixed: 'off',
    routes: [], places: ['The Pin chip in the composer', 'The product card on posts, videos and stories'], server: ['Saving a pin'],
    reason: 'Hidden for launch in twelve places in the code. Turning it on is its own change, not a switch.' },
  { key: 'seller', group: 'sell', name: 'Seller Center', what: 'Open a shop and sell', mode: 'switch', needs: ['market'],
    routes: ['/seller'],
    places: ['The Seller Center and shop setup', 'The Selling band in ☰', '“Seller Center” or “Start selling” in Settings and on your profile', 'Sell a product in the composer and on the Creator page'],
    server: ['Every Seller Center action'],
    reason: 'Products already listed stay in Market. A shop with open orders cannot reach them while this is off. Needs Market: there is nowhere to sell without it.' },
  { key: 'deals', group: 'sell', name: 'Deals in chat', what: 'Offer a price and get paid inside a chat', mode: 'next', needs: ['seller'], fixed: 'everyone',
    routes: [], places: ['The deal bar and pay sheet in a chat'], server: [], reason: NEXT },
  { key: 'khqr', group: 'sell', name: 'KHQR payments', what: 'Pay by scanning a bank QR', mode: 'locked', needs: [], fixed: 'off',
    routes: [], places: ['KHQR at checkout, on the product page and in the cart'], server: ['Making a payment QR'],
    reason: 'PayWay is not connected. Turning this on would show buyers a QR code nobody can pay into.' },
  { key: 'plans', group: 'sell', name: 'Seller plans', what: 'Paid plans for shops', mode: 'locked', needs: [], fixed: 'off',
    routes: [], places: ['Plan in Seller Center'], server: ['The 14-day limit'],
    reason: 'There is no billing yet. Turning this on would hide a shop’s products after 14 days, with no way to pay.' },
  { key: 'rooms', group: 'social', name: 'Rooms', what: 'Group spaces on Home', mode: 'switch', needs: [],
    routes: [],
    places: ['The Rooms tab on Home', 'The rooms rail on wide screens'],
    server: ['Joining, leaving and posting in a room'] },
  { key: 'notes', group: 'social', name: 'Notes', what: 'A line above your face in the story row', mode: 'next', needs: ['stories'], fixed: 'everyone',
    routes: [], places: ['Notes above faces on Home and Chat'], server: [], reason: NEXT },
]

export const FEATURE_BY_KEY = Object.fromEntries(FEATURES.map(f => [f.key, f])) as Record<FeatureKey, FeatureInfo>

/* ── the stored state ─────────────────────────────────────────────────── */

export interface FeatureSwitch {
  step: FeatureStep
  /** ISO. Set → admins see it now, everyone from this instant (Q4). */
  opensAt: string | null
  /** ISO. When it last opened to everyone — the New dot and card count from here. */
  openedAt: string | null
  /** Q5: tell people when it opens. */
  dot: boolean
  card: boolean
}
export type FeatureSwitches = Record<FeatureKey, FeatureSwitch>

/**
 * Today's app, written as switches — so deploying this changes NOTHING until
 * an admin touches a row. Every wired feature is live today; `openedAt` is
 * null, so nothing is marked New on day one.
 */
export function defaultSwitch(k: FeatureKey): FeatureSwitch {
  const f = FEATURE_BY_KEY[k]
  return { step: f.mode === 'switch' ? 'everyone' : (f.fixed ?? 'off'), opensAt: null, openedAt: null, dot: true, card: true }
}
export const FEATURE_SWITCHES_DEFAULT: FeatureSwitches =
  Object.fromEntries(FEATURE_KEYS.map(k => [k, defaultSwitch(k)])) as FeatureSwitches

const iso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null)
const isStep = (v: unknown): v is FeatureStep => typeof v === 'string' && (FEATURE_STEPS as readonly string[]).includes(v)

/**
 * Any stored value → a whole, valid set of switches.
 * ⚠ `next` and `locked` rows ALWAYS read as their fixed state, whatever is
 * stored — a hand-edited row cannot open KHQR, and cannot close Stories that
 * nothing here knows how to close.
 */
export function featureSwitchesOf(v: unknown): FeatureSwitches {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out = {} as FeatureSwitches
  for (const k of FEATURE_KEYS) {
    const d = defaultSwitch(k)
    const r = (o[k] && typeof o[k] === 'object' ? o[k] : {}) as Record<string, unknown>
    const f = FEATURE_BY_KEY[k]
    out[k] = f.mode !== 'switch' ? d : {
      step: isStep(r.step) ? r.step : d.step,
      opensAt: iso(r.opensAt),
      openedAt: iso(r.openedAt),
      dot: typeof r.dot === 'boolean' ? r.dot : d.dot,
      card: typeof r.card === 'boolean' ? r.card : d.card,
    }
  }
  return out
}

/* ── who can use it, now ──────────────────────────────────────────────── */

export interface FeatureViewer { isAdmin: boolean }

/** The switch itself, ignoring what it needs. */
function ownOpen(s: FeatureSwitch, viewer: FeatureViewer, now: number): boolean {
  if (s.step === 'off') return false
  if (s.step === 'admins') return viewer.isAdmin
  if (s.opensAt && Date.parse(s.opensAt) > now) return viewer.isAdmin
  return true
}

/**
 * Whether this viewer can use a feature right now.
 * ⭐ Q6: a feature needs what it needs — Coins closed closes Gifts and Boost
 * too, whatever their own rows say. The rows are kept, so turning Coins back on
 * brings them back exactly as they were.
 */
export function isFeatureOpen(k: FeatureKey, s: FeatureSwitches, viewer: FeatureViewer, now: number, seen: FeatureKey[] = []): boolean {
  if (seen.includes(k)) return false
  if (!ownOpen(s[k], viewer, now)) return false
  return FEATURE_BY_KEY[k].needs.every(n => isFeatureOpen(n, s, viewer, now, [...seen, k]))
}

export function openFeatureKeys(s: FeatureSwitches, viewer: FeatureViewer, now: number): FeatureKey[] {
  return FEATURE_KEYS.filter(k => isFeatureOpen(k, s, viewer, now))
}

/** The features that need this one (they close with it). */
export function dependentsOf(k: FeatureKey): FeatureKey[] {
  return FEATURES.filter(f => f.needs.includes(k)).map(f => f.key)
}

const RANK: Record<FeatureStep, number> = { off: 0, admins: 1, everyone: 2 }

/**
 * Q6 at the WRITE: a step a feature may not be raised to, because something it
 * needs is lower. Returns the names in the way, or [] when the step is allowed.
 */
export function needsInTheWay(k: FeatureKey, step: FeatureStep, s: FeatureSwitches): string[] {
  return FEATURE_BY_KEY[k].needs.filter(n => RANK[s[n].step] < RANK[step]).map(n => FEATURE_BY_KEY[n].name)
}

/* ── telling people (Q5) ──────────────────────────────────────────────── */

const DAY = 86_400_000
export const NEW_DOT_DAYS = 7
export const WHATS_NEW_DAYS = 3

/** The instant it opened to everyone, if it has. */
function openedTime(s: FeatureSwitch): number | null {
  const t = s.openedAt ? Date.parse(s.openedAt) : NaN
  return Number.isFinite(t) ? t : null
}

/** A New dot on its doors: open to this viewer, and opened in the last 7 days. */
export function isFeatureNew(k: FeatureKey, s: FeatureSwitches, viewer: FeatureViewer, now: number): boolean {
  const t = openedTime(s[k])
  return s[k].dot && t !== null && now >= t && now - t < NEW_DOT_DAYS * DAY && isFeatureOpen(k, s, viewer, now)
}

/** The What's new card on Home: the most recently opened feature that asks for one, inside 3 days. */
export function whatsNewFeature(s: FeatureSwitches, viewer: FeatureViewer, now: number): FeatureKey | null {
  let best: FeatureKey | null = null, at = -Infinity
  for (const k of FEATURE_KEYS) {
    const t = openedTime(s[k])
    if (!s[k].card || t === null || now < t || now - t >= WHATS_NEW_DAYS * DAY || !isFeatureOpen(k, s, viewer, now)) continue
    if (t > at) { at = t; best = k }
  }
  return best
}

/** Where the What's new card's Try it goes. */
export const FEATURE_TRY_HREF: Partial<Record<FeatureKey, string>> = {
  video: '/video', home: '/feed', market: '/marketplace', chat: '/inbox',
  coins: '/coins', gifts: '/video', boost: '/seller/products', creator: '/creator', seller: '/seller', rooms: '/feed',
}

/* ── pages ────────────────────────────────────────────────────────────── */

/** Every wired feature a path belongs to. ⚠ ALL of them, not the longest
 *  match: /creator/gifts is Creator tools AND Gifts (and so Coins), and closing
 *  any one of them closes the page. */
export function featuresForPath(path: string): FeatureKey[] {
  return FEATURES.filter(f => f.mode === 'switch' && f.routes.some(r => path === r || path.startsWith(r + '/'))).map(f => f.key)
}

/** The four main pages, as features (lib/nav/tabOrder). */
export const PAGE_FEATURES = ['video', 'home', 'market', 'chat'] as const satisfies readonly FeatureKey[]

/** Open to EVERYONE right now — not "admins only", not scheduled for later. */
export function openToEveryone(s: FeatureSwitch, now: number): boolean {
  return s.step === 'everyone' && !(s.opensAt && Date.parse(s.opensAt) > now)
}

/**
 * Q3 at the WRITE: closing this page would leave no main page open to
 * everyone (the app would be only Profile). Returns the refusal, or null.
 */
export function lastPageInTheWay(k: FeatureKey, next: FeatureSwitch, s: FeatureSwitches, now: number): string | null {
  if (!(PAGE_FEATURES as readonly string[]).includes(k) || openToEveryone(next, now)) return null
  const others = PAGE_FEATURES.filter(p => p !== k && openToEveryone(s[p], now))
  return others.length ? null : 'One of Video, Home, Market or Chat has to stay open to everyone, or the app would be only Profile.'
}

/** The message every refused server action answers with. */
export const FEATURE_OFF_MESSAGE = (k: FeatureKey) => `${FEATURE_BY_KEY[k].name} is switched off right now.`

/** The SiteSetting row that holds the switches. */
export const FEATURE_SWITCHES_KEY = 'featureSwitches'
/** Q9: how long a read may be reused before the row is asked again. */
export const FEATURE_SWITCHES_TTL_SECONDS = 60
