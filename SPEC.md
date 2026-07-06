# Feed Reader — Spec

A self-hosted, minimal alternative to Feedly. Local-first (no user accounts, no server-side database); built to run in Firefox first, with mobile-browser use as a secondary goal.

## Architecture

**`server/`** — Node/Express, stateless. No file-watching — restarting it (`Ctrl+C` then `npm start`) is required to pick up any backend code change; unlike the Vite frontend, there's no hot-reload here.
- One route: `GET /api/feed?url=<feedUrl>`. Fetches the given RSS/Atom URL server-side (avoids the browser CORS restriction that blocks fetching arbitrary third-party feeds directly from client JS), parses it with `rss-parser`, returns normalized JSON: `{ title, feedImageUrl, link, items: [{ title, link, guid, isoDate, contentSnippet, imageUrl }] }`.
- Validates `url` is present, a well-formed URL, and `http`/`https` only. Returns 400 on bad input, 502 if the fetch/parse itself fails.
- `contentSnippet` (used as the "one sentence more than the headline") comes straight from the feed's own description/summary field, truncated to 280 chars — no AI summarization involved.
- No database, no auth, no per-feed persistence. Every call re-fetches fresh.

**`web/`** — Vite + React SPA.
- Dev server proxies `/api/*` to `http://localhost:3001` (see `vite.config.js`), so the frontend never needs to know the backend's port directly.
- All actual data (subscriptions, categories, read/saved state, cached articles) lives in the browser via **IndexedDB** (through the `idb` package) — see `web/src/data/db.js`. There is no server-side database; the Express server is a pure fetch proxy.
- Mobile-first CSS with a single breakpoint at 768px: below it, sidebar stacks above content; above it, sidebar becomes a fixed 260px independently-scrolling left column.

## Images

Most RSS/Atom feeds embed a per-article image in one of several incompatible ways, with no single standard — `server/src/index.js`'s `itemImageUrl()` tries each, in order of how explicit the signal is:

1. `media:thumbnail` — an explicit "this is the thumbnail" tag (e.g. BBC).
2. `media:content` — only when it's actually declared as an image (`medium="image"` or a `type` starting `image/`), so a video/audio `media:content` entry isn't mistaken for a picture (e.g. NYT).
3. `itunes:image` — per-item podcast art; `rss-parser` decorates this automatically whenever the feed declares the itunes namespace, no extra config needed.
4. `enclosure` — only when its `type` is `image/*`, so a podcast's audio enclosure isn't misread as an image.
5. The first `<img>` found in the item's full HTML content (`content:encoded`, e.g. NPR — this field isn't exposed by `rss-parser` by default and needed explicit `customFields` config to access).
6. The first `<img>` found in plain `description` HTML (e.g. The Verge, which doesn't populate `content:encoded` at all).
7. `null` if none of the above yield anything.

Some feeds (e.g. TechCrunch) simply contain no image data in any of these forms — the image only exists as an Open Graph tag on the live webpage. Getting that would mean fetching and scraping every article's HTML on every refresh: much heavier, slower, and more fragile than parsing the feed itself, so it's explicitly out of scope; those feeds correctly fall through to the feed-level image instead.

**Feed-level image** (`feedImageUrl`): `feed.image.url` (RSS 2.0's `<channel><image>`, populated automatically by `rss-parser`) if present, else a same-origin `favicon.ico` built from `feed.link` (the site's real homepage, not the feed-hosting service's domain, e.g. not `feeds.feedburner.com`).

**Rendering** (`ArticleItem.jsx`): a `sources = [article.imageUrl, feedImageUrl, PLACEHOLDER_ICON].filter(Boolean)` array with a `stage` counter that advances on `<img onError>` — so a URL that's present but broken (e.g. a podcast's audio enclosure literally can't decode as an image) gracefully falls through the same priority chain rather than just showing a broken-image icon. `PLACEHOLDER_ICON` is a small inline SVG data URI, no separate asset file.

**Important caveat**: `upsertArticles` never overwrites an existing article record (see Data Model below) — so an article already sitting in IndexedDB keeps whatever `imageUrl` it got on first fetch, permanently. Backend image-extraction improvements only benefit *new* articles fetched after the improvement; there's no backfill for already-stored ones.

## Data Model (IndexedDB, db name `feed-reader`)

**`categories`** — `{ id, name, order }`
- `name` must be unique, case-insensitive, trimmed.
- `"Uncategorized"` (any case) is reserved — cannot be used as a real category name.
- `order` is a float, auto-managed (see Ordering below); auto-healed/renormalized to clean integers if ever found missing.

**`feeds`** — `{ id, url, categoryId, title, feedImageUrl, order }`
- `categoryId` is `null` for Uncategorized, otherwise a category id.
- `title` starts out equal to `url` at creation time (a placeholder) and is overwritten with the feed's real title on first successful refresh; `feedImageUrl` is populated the same way, on the same refresh, via `syncFeedMetadata` — and re-synced unconditionally on *every* subsequent refresh (not gated on the title having changed), since the image can change independent of the title.
- `title` uniqueness is enforced **per category/bucket only** (two feeds can share a name if they're in different categories), and only on explicit user-driven rename — not on the automatic title-sync-from-refresh.
- **`url` (normalized) must be globally unique across all feeds, regardless of category.** Normalization (`normalizeFeedUrl` in `db.js`): lowercases the host, treats `http`/`https` as equivalent, strips one trailing slash from the path. Deliberately does **not** lowercase the path or touch the query string (some feeds legitimately depend on `?format=rss`-style params) — so `www.` vs. bare domain, or a differing query string, are treated as genuinely different feeds and allowed through. Violating this throws `"This feed URL has already been added."`, caught in `Sidebar.jsx` and shown via `window.alert`.
- `order` is scoped per bucket (per `categoryId`); values may overlap numerically across different buckets since they're never compared cross-bucket.

**`articles`** — `{ id, feedId, title, link, isoDate, insertedAt, contentSnippet, imageUrl, read, readAt, saved, unsavedAt }`
- `id` = `` `${feedId}::${guid || link}` `` — this is what makes refresh idempotent.
- `insertedAt` is set once, at first insert — a fallback anchor for the retention rule below when `isoDate` is missing/unparseable.
- `readAt` is set the moment `read` flips `false → true` (i.e. on click-to-open; there's no separate "mark read" affordance, and no "mark unread" UI either, so the reverse transition never currently happens).
- `unsavedAt` is set the moment `saved` flips `true → false`.
- Refreshing a feed (`upsertArticles`) never overwrites an existing article — `read`/`readAt`/`saved`/`unsavedAt`/`imageUrl` are preserved permanently across refreshes; only genuinely new guids get inserted.
- Deleting a feed cascades: deletes all of its articles too.

### Ordering (categories and feeds)

There is currently **no manual drag-to-reorder and no sort buttons** anywhere in the UI (both were built, then intentionally removed — see Recent History below). Ordering is fully automatic:
- On **create**: new item is inserted at the alphabetically-correct position relative to the current order (not a full re-sort of everyone else).
- On **rename**: the renamed item is repositioned alphabetically among its current siblings (again, not a full re-sort).
- Moving a feed to a different category (drag-and-drop) **appends it to the end** of the new bucket — it is not re-alphabetized into its new home.
- A periodic "normalize" pass squashes fractional order values back down to clean sequential integers after each mutation.

## Retention & Purge

Storage is bounded by actually deleting articles (not a view-level filter), via `purgeExpiredArticles()` in `db.js`. **Saved articles (`saved === true`) are always exempt**, regardless of age.

For every non-saved article, compute an anchor timestamp:
```
base   = isoDate if present and valid, else insertedAt
anchor = max(base, readAt if set, unsavedAt if set)
```
Deleted once `now > anchor + 30 days`. So: never-read articles expire 30 days after publish; read articles get 30 days from the moment they were read (not published); an article that was saved and later unsaved gets a fresh 30-day grace period from the moment it was unsaved, regardless of how old it already was — this guarantees an accidental unsave can never delete something with zero grace period.

**Trigger**: runs inside `refreshAllFeeds()` (`feeds.js`), so it fires on every manual Refresh, every auto-refresh tick, and once immediately on app mount (see Auto-refresh below). Because expired articles are actually gone, Today/All/Read Articles need no extra date-range filtering. Read Later is entirely unaffected by retention, by design.

## Auto-refresh

A `useEffect` in `App.jsx` (mount-only, empty deps) calls the same `handleRefresh` the manual button uses, immediately on mount — this matters because a cold open after the tab was closed for a while would otherwise show stale data for the first interval period. It then starts a 15-minute `setInterval`. A `visibilitychange` listener **clears and recreates** the interval (not just skips ticks) on hidden/visible, so a backgrounded tab doesn't burn fetches, and becoming visible again restarts a fresh 15-minute countdown rather than resuming a possibly-already-elapsed one.

## Export (OPML)

Client-side only (`web/src/data/opml.js`'s `buildOPML(categories, feeds)`, a pure XML-string function with `escapeXml` for `&`/`<`/`>`/`"`). "Export OPML" button sits in the sidebar directly below "+ Add Category". Categories become `<outline text="Name">` wrappers containing one `<outline type="rss" text="FeedTitle" xmlUrl="FeedURL"/>` per feed; Uncategorized feeds are emitted as top-level outlines with no wrapper. Subscriptions only — read/saved/timestamps/order don't survive an export. **Import is not implemented.**

## Sidebar (top to bottom)

1. **All Feeds** — clears any category/feed selection and exits Read Articles mode. The default/home view.
2. **Read Articles** — shows every article where `read === true`, app-wide, ignoring whatever category/feed was previously selected; sorts on `readAt` (not `isoDate`) — see Sort below. Selecting any category, feed, or All Feeds exits this mode.
3. **Uncategorized** — feeds with no category. Only rendered if it currently has feeds, **or** a feed is actively being dragged (so it can appear as a valid drop target to decategorize something, even if it would otherwise be empty). Has its own collapse toggle and "+" add-feed button.
4. A visual divider.
5. **Category list** (alphabetical, auto-ordered as described above). Each category row has, revealed on hover: a collapse/expand chevron (▾/▸, always visible unlike the others), an "add feed" (+) button opening an inline URL-only form scoped to that category, and an edit (✎) button opening an inline panel with rename + "Delete category" (deleting a category does **not** delete its feeds — they fall back to Uncategorized).
6. **Feeds within each category** — each is a draggable button (drag onto a different category header, or onto Uncategorized, to recategorize it — dropping is the only interaction; there is no drag-to-reorder within a list). Each feed has its own edit (✎) button opening a panel with rename, a read-only display of the feed's actual RSS URL, and "Delete feed" (also deletes that feed's articles).
7. **+ Add Category** button, then **Export OPML** button, at the bottom of the category list.

Both category and feed rename/create actions validate uniqueness (name, and — for feeds — normalized URL) and the reserved name client-side, surfacing violations via a blocking `window.alert`. Deletions require `window.confirm`.

## Main content area (top bar + article list)

**Top bar**, left to right:
- View tabs: **Today** / **All** / **Read Later**.
  - *Today*: unread articles published today, bounded by local-timezone midnight on the article's `isoDate`. An article with a missing/unparseable `isoDate` never appears here (still shows in All).
  - *All*: unread articles (once opened, an article leaves this view — see Read Articles above).
  - *Read Later*: saved articles, regardless of read status or age — the only view unaffected by both the read-hides-it rule and the 30-day retention purge.
- Sort dropdown: Newest first / Oldest first. Chooses only the *direction*; the *timestamp sorted on* is owned by the active view — `readAt` in Read Articles, `isoDate` everywhere else. So "Newest first" means most-recently-*read* first in Read Articles, most-recently-*published* first everywhere else.
- Refresh button — re-fetches every subscribed feed concurrently, merges new articles in, runs the retention purge, shows an error banner if any feed(s) failed (count only). A feed that fails on its *initial* add is still kept (not rolled back).

**Article item**: a thumbnail image (see Images above, with graceful fallback), title (opens the real article in a new tab and marks it read on click — no separate "mark read" affordance), feed name + formatted date, the one-sentence snippet, and a save/★ toggle for Read Later.

## Recent history worth knowing

- Manual drag-to-reorder for **categories** and a pair of "Sort categories / Sort feeds (A→Z / Z→A)" buttons were built, iterated on (including a redesign into a segmented-pill control), then **fully removed** as a debugging step — the user reported the redesigned buttons weren't rendering any differently despite hard refreshes and full server restarts, and removing the feature entirely was used to test whether *any* code change was reaching their browser. The removal did show up, confirming the earlier mystery (styling not updating) was environment-specific, not a code bug — still unresolved and flagged to revisit if reordering/sorting UI comes back.
- Manual drag-to-reorder for **feeds within a bucket** was also built then removed — feed drag-and-drop is now solely for recategorizing, not reordering.
- If/when sorting or reordering controls are revisited, the underlying data model (per-bucket `order` fields, `findAlphabeticalOrder`, `normalizeCategoryOrder`, `normalizeFeedBucketOrder` in `db.js`) already supports it — only the UI layer was stripped.
- **Duplicate feed URLs across categories** were originally allowed by design, then deliberately reversed in favor of global uniqueness once the implications (independent read/saved state per duplicate) were worked through.
- **Per-article images** went through two passes: the first (spec'd) version only checked `enclosure` and `media:content`, which left most real-world feeds (NPR, BBC, The Verge) showing only the generic feed icon. Empirically testing against six real feeds side-by-side surfaced the actual variety of publisher conventions, leading to the six-tier fallback chain documented above. TechCrunch remains a hard gap (no image data in its feed in any form) — a deliberate, documented limitation, not an oversight.

## Known gaps / not implemented

- Clicking the "Uncategorized" label does not filter the article list to just uncategorized feeds (unlike clicking a real category) — it's a static label, not a button.
- No way to add a brand-new feed with no category directly if Uncategorized is currently hidden (empty) — you'd add it to a category first, then drag it onto the (drag-revealed) Uncategorized zone.
- No persistence of sidebar collapse/expand state across page reloads (resets to all-expanded).
- No backfill mechanism for existing articles' `imageUrl`/`feedImageUrl` when extraction logic improves — only new articles benefit (see Images above).
- **OPML import** — deliberately deferred; export-only for now.
- **Search** — wanted, but scope (titles only? full text? saved articles only?) not yet decided.
- **Unread counts, keyboard shortcuts, "mark all as read"** — considered as enhancements, not yet decided on or built.
- **In-app "reader view" (full article content)** — considered and explicitly rejected; snippet + open-in-new-tab is the intended experience.
- **Article-webpage scraping for images** (e.g. Open Graph tags) — explicitly out of scope; too heavy/fragile for a per-refresh operation. See Images above.
- No automated tests.
- No production build/deploy configuration — dev-only (`npm run dev` / `npm start`).

## Running it

```bash
cd server && npm start     # http://localhost:3001
cd web && npm run dev      # http://localhost:5173
```
Open `http://localhost:5173` in Firefox. Both must be running simultaneously; the web dev server proxies API calls to the backend. The backend has no hot-reload — restart it manually after any change to `server/src/index.js`.
