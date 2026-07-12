# Feed Reader — Spec

A self-hosted, minimal alternative to Feedly. Local-first in the sense of no user accounts and no third-party services — but persistence lives in a SQLite database owned by the server, not the browser, so subscriptions and read state survive clearing browser data and aren't tied to one browser profile. Built to run in Firefox first, with mobile-browser use as a secondary goal.

## Architecture

**`server/`** — Node/Express. No file-watching — restarting it (`Ctrl+C` then `npm start`) is required to pick up any backend code change; unlike the Vite frontend, there's no hot-reload here.
- Owns all persistent data — categories, feeds, articles, read/saved state — in a single SQLite file, `feed-reader.db` (via `better-sqlite3`), kept in an OS-appropriate user data directory *outside* the project/install directory — see Data Directory below. `server/src/db.js` opens the connection, creates the schema (`CREATE TABLE IF NOT EXISTS`, idempotent on every start — no migration framework, since this is a fresh build with no prior data to preserve across schema changes), and holds every business rule (ordering, uniqueness, retention purge) that used to live in the browser's `db.js`.
- `GET /api/feed?url=<feedUrl>` — fetches the given RSS/Atom URL server-side (avoids the browser CORS restriction that blocks fetching arbitrary third-party feeds directly from client JS), parses it with `rss-parser`, returns normalized JSON: `{ title, feedImageUrl, link, items: [{ title, link, guid, isoDate, contentSnippet, imageUrl }] }`. Validates `url` is present, a well-formed URL, and `http`/`https` only; 400 on bad input, 502 if the fetch/parse itself fails. The actual parsing/image-extraction logic lives in `server/src/feedParser.js`, shared with the refresh routes below so there's one implementation, not two.
- `contentSnippet` (used as the "one sentence more than the headline") comes straight from the feed's own description/summary field, truncated to 280 chars — no AI summarization involved.
- Persistence routes under `/api/categories`, `/api/feeds`, `/api/articles`, and `/api/refresh` — see **API** below.
- `fetchAndParseFeed()` fetches the feed XML itself via Node's built-in `fetch()` (with a browser-like `User-Agent`) and hands the text to `rss-parser`'s `parseString()`, rather than letting `rss-parser` fetch the URL itself (it uses Node's older `http`/`https` module internally). Some sites (e.g. Cricinfo) block that older client outright regardless of headers sent — confirmed to be connection/TLS fingerprinting, not a `User-Agent` check, since Node's `fetch()` gets through with no special headers at all. Sites running an active bot-challenge system (e.g. ESPN's main site, which returns an empty `202` with `x-amzn-waf-action: challenge`) are a separate, harder wall this doesn't solve — that needs a real JS-executing browser to pass, which is out of scope here.
- Optionally serves the built frontend too (`express.static` on `web/dist`, only mounted when that directory exists) — see Running It below for the single-process vs. two-process dev workflows this supports.

**`web/`** — Vite + React SPA.
- Dev server proxies `/api/*` to `http://localhost:3001` (see `vite.config.js`), so the frontend never needs to know the backend's port directly.
- Holds no persistent data of its own. `web/src/data/db.js` is a thin `fetch()`-based client exposing the exact same function names/signatures the UI has always called (`getCategories()`, `addFeed()`, `markRead()`, etc.) — only the implementation changed, from local IndexedDB calls to HTTP requests, so `App.jsx`/`Sidebar.jsx`/`ArticleList.jsx`/`ArticleItem.jsx`/`TopBar.jsx` needed no changes at all. `web/src/data/feeds.js` similarly wraps the two refresh endpoints.
- Mobile-first CSS with a single breakpoint at 768px: below it, sidebar stacks above content; above it, sidebar becomes a fixed 260px independently-scrolling left column.

## API

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/categories` | — | array of categories |
| POST | `/api/categories` | `{ name }` | `{ id }` |
| PATCH | `/api/categories/:id` | `{ name }` | 204 |
| DELETE | `/api/categories/:id` | — | 204 |
| GET | `/api/feeds` | — | array of feeds |
| POST | `/api/feeds` | `{ url, categoryId }` | `{ id }` |
| PATCH | `/api/feeds/:id` | `{ title }` | 204 |
| PATCH | `/api/feeds/:id/category` | `{ categoryId }` | 204 |
| DELETE | `/api/feeds/:id` | — | 204 |
| POST | `/api/feeds/:id/refresh` | — | `{ title, feedImageUrl, link, items }` |
| GET | `/api/articles` | — | array of articles |
| PATCH | `/api/articles/:id/read` | `{ read }` | 204 |
| PATCH | `/api/articles/:id/saved` | — | `{ saved }` |
| POST | `/api/refresh` | — | `{ count, errors }` |

Validation errors (duplicate/reserved category name, duplicate feed URL, duplicate manually-renamed feed title) respond `400 { error: "message" }`, using the same message text the app has always shown; `web/src/data/db.js` throws `Error(body.error)` on any non-OK response so the existing `window.alert`-on-catch handling in `Sidebar.jsx` keeps working unchanged.

`POST /api/refresh` (hit by both the manual Refresh button and the auto-refresh timer) and `POST /api/feeds/:id/refresh` (hit right after adding a feed) do the entire fetch-and-persist cycle server-side — the browser no longer orchestrates a per-feed loop itself, since both the fetching and the storage now live on the server anyway.

## Images

Most RSS/Atom feeds embed a per-article image in one of several incompatible ways, with no single standard — `server/src/feedParser.js`'s `itemImageUrl()` tries each, in order of how explicit the signal is:

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

**Important caveat**: `upsertArticles` never overwrites an existing article record (see Data Model below) — so an article already sitting in the database keeps whatever `imageUrl` it got on first fetch, permanently. Backend image-extraction improvements only benefit *new* articles fetched after the improvement; there's no backfill for already-stored ones.

## Data Directory

`feed-reader.db` lives outside the project/install directory entirely, so updating or reinstalling the code never touches your data — the same reasoning real desktop apps use (e.g. macOS keeps app data in `~/Library/Application Support/`, not inside the `.app` bundle). Computed once in `server/src/dataDir.js`, in priority order:

1. `FEED_READER_DATA_DIR` environment variable, if set — an explicit override for anyone who wants the file somewhere specific (a synced folder, an external drive, etc).
2. Otherwise, an OS-appropriate default: `~/Library/Application Support/Feed Reader` on macOS, `%APPDATA%/Feed Reader` on Windows, `$XDG_DATA_HOME/feed-reader` (or `~/.local/share/feed-reader`) on Linux.

**One-time migration**: earlier versions stored the database inside the project directory (`server/data/feed-reader.db`). On startup, if nothing exists yet at the new location but the old file does, `dataDir.js` moves it (and its `-wal`/`-shm` SQLite sidecar files, which can hold not-yet-checkpointed writes) to the new location automatically, logging what it did — existing subscriptions and read/saved state survive the upgrade untouched. This is a one-shot check (skipped once a file exists at the new location), not an ongoing sync.

## Data Model (SQLite)

**`categories`** — `{ id, name, order }`
- `name` must be unique, case-insensitive, trimmed.
- `"Uncategorized"` (any case) is reserved — cannot be used as a real category name.
- `order` is a `REAL` column, auto-managed (see Ordering below); `NOT NULL` from creation, so — unlike the original IndexedDB version — there's no missing-value healing to worry about on read.

**`feeds`** — `{ id, url, categoryId, title, feedImageUrl, order }`
- `categoryId` is `NULL` for Uncategorized, otherwise a category id, with `ON DELETE SET NULL` — deleting a category automatically un-categorizes its feeds via the foreign key, no manual iteration needed.
- `title` starts out equal to `url` at creation time (a placeholder) and is overwritten with the feed's real title **only on the very first successful refresh** (while `title` still equals `url`) via `syncFeedMetadata` — every subsequent refresh leaves `title` alone, so neither the auto-synced title nor a later manual rename is ever silently reverted by a refresh. `feedImageUrl` has no such placeholder state and is unconditionally re-synced on *every* refresh, since the image can change independent of the title.
- If the title being auto-synced on that first refresh would collide with another feed's title already in the same category bucket (two different feeds can legitimately share a real-world title, e.g. two editions of the same publication), it's automatically disambiguated with a `" (2)"`, `" (3)"`, etc. suffix (`uniqueTitleInBucket` in `db.js`) rather than silently producing two identically-named feeds.
- `title` uniqueness is otherwise enforced **per category/bucket only** (two feeds can share a name if they're in different categories), and explicitly on user-driven rename (`renameFeed` throws on a collision) — the auto-sync path above uses disambiguation instead of throwing, since there's no user present to show an error to.
- **`url` (normalized) must be globally unique across all feeds, regardless of category.** Normalization (`normalizeFeedUrl` in `db.js`): lowercases the host, treats `http`/`https` as equivalent, strips one trailing slash from the path. Deliberately does **not** lowercase the path or touch the query string (some feeds legitimately depend on `?format=rss`-style params) — so `www.` vs. bare domain, or a differing query string, are treated as genuinely different feeds and allowed through. Violating this throws `"This feed URL has already been added."`, caught in `Sidebar.jsx` and shown via `window.alert`.
- `order` is scoped per bucket (per `categoryId`); values may overlap numerically across different buckets since they're never compared cross-bucket.

**`articles`** — `{ id, feedId, title, link, isoDate, insertedAt, contentSnippet, imageUrl, read, readAt, saved, unsavedAt }`
- `id` = `` `${feedId}::${guid || link}` `` (a `TEXT PRIMARY KEY`, not an autoincrement number) — this is what makes refresh idempotent, and it's also used directly as the React list key and click-handler argument on the frontend, so it must stay a string.
- `insertedAt` is set once, at first insert — a fallback anchor for the retention rule below when `isoDate` is missing/unparseable.
- `readAt` is set the moment `read` flips `false → true` (i.e. on click-to-open; there's no separate "mark read" affordance, and no "mark unread" UI either, so the reverse transition never currently happens).
- `unsavedAt` is set the moment `saved` flips `true → false`.
- Refreshing a feed (`upsertArticles`) never overwrites an existing article — `read`/`readAt`/`saved`/`unsavedAt`/`imageUrl` are preserved permanently across refreshes; only genuinely new guids get inserted.
- `feedId` has `ON DELETE CASCADE` — deleting a feed automatically deletes all of its articles via the foreign key.

### Ordering (categories and feeds)

There is currently **no manual drag-to-reorder and no sort buttons** anywhere in the UI (both were built, then intentionally removed — see Recent History below). Ordering is fully automatic:
- On **create**: new item is inserted at the alphabetically-correct position relative to the current order (not a full re-sort of everyone else).
- On **rename**: the renamed item is repositioned alphabetically among its current siblings (again, not a full re-sort).
- Moving a feed to a different category (drag-and-drop) **appends it to the end** of the new bucket — it is not re-alphabetized into its new home.
- A periodic "normalize" pass squashes fractional order values back down to clean sequential integers after each mutation, wrapped in a `db.transaction(...)` so it's all-or-nothing.

## Retention & Purge

Storage is bounded by actually deleting articles (not a view-level filter), via `purgeExpiredArticles()` in `server/src/db.js`. **Saved articles (`saved === true`) are always exempt**, regardless of age.

For every non-saved article, compute an anchor timestamp:
```
base   = isoDate if present and valid, else insertedAt
anchor = max(base, readAt if set, unsavedAt if set)
```
Deleted once `now > anchor + 30 days`. So: never-read articles expire 30 days after publish; read articles get 30 days from the moment they were read (not published); an article that was saved and later unsaved gets a fresh 30-day grace period from the moment it was unsaved, regardless of how old it already was — this guarantees an accidental unsave can never delete something with zero grace period.

**Trigger**: runs server-side inside `POST /api/refresh` (`server/src/routes/refresh.js`), so it fires on every manual Refresh and every auto-refresh tick, including the one that fires immediately on app mount (see Auto-refresh below). Because expired articles are actually gone, the browse list/Today/Read Articles need no extra date-range filtering. Read Later is entirely unaffected by retention, by design.

## Auto-refresh

A `useEffect` in `App.jsx` (mount-only, empty deps) calls the same `handleRefresh` the manual button uses, immediately on mount — this matters because a cold open after the tab was closed for a while would otherwise show stale data for the first interval period. It then starts a 15-minute `setInterval`. A `visibilitychange` listener **clears and recreates** the interval (not just skips ticks) on hidden/visible, so a backgrounded tab doesn't burn fetches, and becoming visible again restarts a fresh 15-minute countdown rather than resuming a possibly-already-elapsed one. Each tick is a single `POST /api/refresh` call — the server does the per-feed looping.

## Export (OPML)

Client-side only (`web/src/data/opml.js`'s `buildOPML(categories, feeds)`, a pure XML-string function with `escapeXml` for `&`/`<`/`>`/`"`), unaffected by the storage migration since it only ever operates on already-loaded `categories`/`feeds` arrays. "Export OPML" button sits in the sidebar directly below "+ Add Category". Categories become `<outline text="Name">` wrappers containing one `<outline type="rss" text="FeedTitle" xmlUrl="FeedURL"/>` per feed; Uncategorized feeds are emitted as top-level outlines with no wrapper. Subscriptions only — read/saved/timestamps/order don't survive an export. **Import is not implemented.**

## Sidebar (top to bottom)

1. **All Feeds** — clears any category/feed selection and switches to the plain unread browse list (what the removed "All" tab used to show). The default/home view.
2. **Today** — a digest, not a filter combinable with a category/feed selection (see Today below for details).
3. **Read Later** — saved articles, app-wide, ignoring whatever category/feed was previously selected (like Read Articles below) — regardless of read status or age, the only view unaffected by both the read-hides-it rule and the 30-day retention purge.
4. **Read Articles** — shows every article where `read === true`, app-wide, ignoring whatever category/feed was previously selected; sorts on `readAt` (not `isoDate`) — see Sort below.
5. Selecting any category, feed, or All Feeds exits Today/Read Later/Read Articles and switches to the plain unread browse list, scoped to whatever was selected (or unscoped, for All Feeds).
6. **Uncategorized** — feeds with no category. Only rendered if it currently has feeds, **or** a feed is actively being dragged (so it can appear as a valid drop target to decategorize something, even if it would otherwise be empty). Has its own collapse toggle and "+" add-feed button. Collapsed by default, like every category (see below).
7. A visual divider.
8. A small uppercase **"Categories"** section label (`.sidebar-section-label`), only rendered if there's at least one category.
9. **Category list** (alphabetical, auto-ordered as described above). Each category row has, revealed on hover: a collapse/expand chevron (▾/▸, always visible unlike the others), an "add feed" (+) button opening an inline URL-only form scoped to that category, and an edit (✎) button opening an inline panel with rename + "Delete category" (deleting a category does **not** delete its feeds — they fall back to Uncategorized). Categories (and Uncategorized) start **collapsed by default** — nothing expands until its chevron is clicked, and this resets on every reload since expand/collapse state isn't persisted (see Known Gaps).
10. **Feeds within each category** — each is a draggable button (drag onto a different category header, or onto Uncategorized, to recategorize it — dropping is the only interaction; there is no drag-to-reorder within a list), showing the feed's logo (`feedImageUrl`, falling back to the same placeholder icon article thumbnails use if missing or broken) before its title. Each feed has its own edit (✎) button opening a panel with rename, a read-only display of the feed's actual RSS URL, and "Delete feed" (also deletes that feed's articles).
11. **+ Add Category** button, standalone. Below it, a **"Customization"** section label over a single rounded card (`.sidebar-section-card`) containing two stacked rows: **Export OPML**, then the **appearance control** (System / Light / Dark — see Appearance below). Grouping these two together under one label/card, separate from "+ Add Category", was a deliberate request — see Recent History.

**All Feeds**, **Today**, and **Read Later** each show a right-aligned, monospaced unread/saved count (`counts` in `App.jsx`, `.sb-count` in the CSS) — hidden when zero. `all`/`today` count unread articles (matching each view's own filter); `saved` counts everything in Read Later regardless of read status, matching that view's own definition.

Both category and feed rename/create actions validate uniqueness (name, and — for feeds — normalized URL) and the reserved name, surfacing violations via a blocking `window.alert` fed by the API's `400 { error }` responses. Deletions require `window.confirm`.

## Today

A digest rather than a filtered list: unread articles published today (bounded by local-timezone midnight on the article's `isoDate`; an article with a missing/unparseable `isoDate` never appears here), grouped by category (`App.jsx`'s `todayGroups`, rendered by `TodayDigest.jsx`):
- Named categories are sorted alphabetically; an "Uncategorized" group is appended last if any uncategorized feed has an eligible article.
- Each group is capped to its **10** most-recent-or-oldest eligible articles, per the active Sort direction (see below) — Sort governs both which 10 make the cut and their order within the group.
- Each named category's heading is a button that jumps straight into that category's normal full unread list (exiting Today). The Uncategorized group's heading is a plain, non-clickable label, consistent with the sidebar's own Uncategorized label (see Known Gaps).
- Ranking is by recency, not popularity — RSS feeds carry no click/pageview data, and there's no reliable free source for a link's real internet-wide "hits."

## Main content area (top bar + article list)

**Top bar**, left to right:
- Sort dropdown: Newest first / Oldest first. Chooses only the *direction*; the *timestamp sorted on* is owned by the active view — `readAt` in Read Articles, `isoDate` everywhere else, including within each of Today's per-category groups.
- Refresh button — triggers `POST /api/refresh`, which re-fetches every subscribed feed concurrently server-side, merges new articles in, runs the retention purge, and returns an error count if any feed(s) failed. A feed that fails on its *initial* add is still kept (not rolled back).

There are no view tabs in the top bar — Today, Read Later, and Read Articles all live in the sidebar (see above).

**Date-grouped list** (`ArticleList.jsx`): the browse list, Read Later, and Read Articles all split an already-sorted article list into contiguous same-calendar-day sections under a heading — "Today", then e.g. "July 10, 2026", "July 9, 2026" — instead of one flat list. Grouping uses whichever timestamp field the active view is already sorted on (`readAt` in Read Articles, `isoDate` elsewhere), so the groups and the sort stay consistent; flipping Newest/Oldest changes both the order *and* which day's articles surface first. Today's own per-category digest (see Today above) does **not** get date headings — every article there is already "today" by definition, so a repeated single heading per category would be redundant; it opts out by simply not passing a grouping accessor.

**Article item** (dense, one line — see Visual design below): a small thumbnail (see Images above, with graceful fallback), an ellipsized title (opens the real article in a new tab and marks it read on click — no separate "mark read" affordance) with a one-line ellipsized snippet underneath, the feed name and a monospaced time (just the time — the date already lives in the group heading above) right-aligned, and a save/★ toggle for Read Later that's revealed on hover (always visible once saved, or on touch devices).

## Appearance (light / dark)

The app supports both light and dark, and by default **follows the OS/browser appearance** (`prefers-color-scheme`). A **System / Light / Dark** segmented control at the bottom of the sidebar (below "Export OPML") lets you override that:
- **System** (default) tracks the OS automatically; **Light** / **Dark** force that appearance regardless of the OS.
- The choice **persists** in `localStorage` (`web/src/theme.js`) and is applied **before first paint** by a tiny inline script in `web/index.html`, so a forced Light/Dark doesn't flash the wrong theme on load. "System" is represented by the *absence* of the stored key, so the inline script only ever has to look for an explicit light/dark.

**Implementation**: colors are CSS custom properties defined once in `web/src/index.css` using the `light-dark()` function, with `color-scheme` driving which half each token resolves to. "System" leaves `color-scheme: light dark` (OS decides); forcing a mode sets a `data-theme` attribute on `<html>` that overrides `color-scheme` to `light` or `dark`. Because every token is a `light-dark()` pair, flipping appearance is a single `color-scheme` change — there's no duplicated dark-mode token block to keep in sync. The control itself exposes `aria-pressed` per option; full dark mode is treated as an accessibility/eye-comfort feature, not just aesthetics.

## Visual design ("Console")

The current visual identity is deliberately dense and focused rather than card-heavy — closer to Linear/Arc than to a typical "cards with shadows" feed reader. It was chosen from three prototyped directions (a from-scratch design-comparison artifact built with the app's own real content) — the other two (a softer Apple-materials look, and a serif-headline editorial layout) were rejected in favor of this one; see Recent History.

- **Palette**: cool near-neutral greys (not pure grey — a slight blue-cool bias) with a single indigo/violet accent (`--accent`), strongest in dark mode. Replaces an earlier system-blue Apple-style accent. All tokens still flow through the `light-dark()` system described above.
- **Type**: a monospaced face (`--mono`, `ui-monospace`/SF Mono/JetBrains Mono) is used specifically for *data* — unread/saved counts, date-group headings, per-article times — so numbers and timestamps read as data rather than prose; everything else stays on the system sans.
- **Article rows are flush, not cards**: no border/shadow at rest; hovering a row raises a subtle surface fill + 1px inset hairline (`.article-item:hover`). A saved article gets a permanent thin accent stripe on its left edge (`.article-item.saved`), visible whether or not it's hovered.
- **Progressive disclosure of the save toggle**: the ★/☆ button is invisible at rest on pointer devices and appears on row hover or keyboard focus (always visible once an article is saved, and always visible on touch, since there's no hover to reveal it there).
- **Refresh is visually primary** — the only accent-filled button in the top bar, since it's the one action most likely to be reached for repeatedly.

## Recent history worth knowing

- **Storage moved from browser IndexedDB to a server-side SQLite database** (`better-sqlite3`, `server/data/feed-reader.db`), so subscriptions and read/saved state persist independent of the browser and survive clearing browser data or switching browsers. All business logic (ordering, uniqueness, retention purge) was ported from the browser's `db.js` essentially unchanged; refresh orchestration moved server-side too (`POST /api/refresh`, `POST /api/feeds/:id/refresh`), since both the feed-fetching and the persistence now live on the server anyway. The frontend's component layer (`App.jsx` and below) needed zero changes — only `web/src/data/db.js` and `feeds.js` were rewritten, keeping identical function signatures.
- **Found via real use after that migration**: `syncFeedMetadata` was unconditionally overwriting a feed's title from the RSS feed's own `<title>` on *every* refresh, which silently reverted any manual rename the next time you clicked Refresh or reloaded the page (which auto-refreshes on mount). Fixed by only adopting the feed's title on the very first successful refresh (while it's still the URL placeholder) and never touching it again afterward.
- **Also found**: two different feeds can legitimately share a real-world title (e.g. two editions of the same publication's feed), and the auto-sync path had no uniqueness check — only manual renames did — so two feeds could end up identically named in the same category with no way to tell them apart except by opening each one's edit panel. Fixed with automatic `" (2)"`-style disambiguation on the auto-sync path, matching (but not replacing) the hard-uniqueness manual renames already enforced.
- Manual drag-to-reorder for **categories** and a pair of "Sort categories / Sort feeds (A→Z / Z→A)" buttons were built, iterated on (including a redesign into a segmented-pill control), then **fully removed** as a debugging step — the user reported the redesigned buttons weren't rendering any differently despite hard refreshes and full server restarts, and removing the feature entirely was used to test whether *any* code change was reaching their browser. The removal did show up, confirming the earlier mystery (styling not updating) was environment-specific, not a code bug — still unresolved and flagged to revisit if reordering/sorting UI comes back.
- Manual drag-to-reorder for **feeds within a bucket** was also built then removed — feed drag-and-drop is now solely for recategorizing, not reordering.
- If/when sorting or reordering controls are revisited, the underlying data model (per-bucket `order` fields, `findAlphabeticalOrder`, `normalizeCategoryOrder`, `normalizeFeedBucketOrder` in `db.js`) already supports it — only the UI layer was stripped.
- **Duplicate feed URLs across categories** were originally allowed by design, then deliberately reversed in favor of global uniqueness once the implications (independent read/saved state per duplicate) were worked through.
- **Per-article images** went through two passes: the first (spec'd) version only checked `enclosure` and `media:content`, which left most real-world feeds (NPR, BBC, The Verge) showing only the generic feed icon. Empirically testing against six real feeds side-by-side surfaced the actual variety of publisher conventions, leading to the six-tier fallback chain documented above. TechCrunch remains a hard gap (no image data in its feed in any form) — a deliberate, documented limitation, not an oversight.
- **Feed fetching hardened against connection-fingerprint bot-blocking**: some sites (Cricinfo) returned a flat `403` to `rss-parser`'s built-in fetching no matter what `User-Agent` was sent, traced to TLS/connection fingerprinting rather than headers — fixed by fetching via Node's built-in `fetch()` instead and handing the XML to `rss-parser` to just parse (see Architecture above). A different site (ESPN's main site) turned out to be behind an active AWS WAF JS challenge, which requires a real browser to solve — explicitly not something to build around; that feed was just removed.
- **Sidebar categories (and Uncategorized) now collapse by default** instead of starting all-expanded — the tracked state inverted from "which sections are collapsed" (default: none) to "which sections have been explicitly expanded" (default: none), so anything untouched, including categories that load in after mount or get added later, starts collapsed.
- **Feed logos** were added to the sidebar before each feed's name, reusing the same placeholder-icon fallback (extracted into `web/src/placeholderIcon.js`) already used for article thumbnails.
- **Today redesigned from a flat filtered list into a per-category digest**, and the top-bar view tabs (Today/All/Read Later) were removed in favor of sidebar nav items alongside Read Articles. This was prompted by a request to rank each category's top 10 by "hits" — since that data doesn't exist for RSS feeds, ranking is by recency instead (confirmed with the user). Read Later became a global view (like Read Articles) rather than a filter combinable with a category/feed selection, matching its new position in the sidebar.
- **Single-process running mode added**: a root `package.json`'s `npm start` builds `web/` and has the Express server serve the result directly, so the app can run as one process on one port instead of two dev servers — prompted by wanting to stop running two separate services day-to-day. The two-process dev workflow (Vite's hot-reloading dev server + the backend) is unchanged and still the way to actively develop the frontend.
- **Frontend fundamentals + visual pass** (from a design review): reliability — `reloadAll` now catches failures and shows a "couldn't reach the server" banner instead of a silent blank shell; accessibility — secondary sidebar controls stay visible on touch devices (`@media (hover: hover)` rather than hover-only, which was unreachable on touch), larger tap targets on coarse pointers, `aria-pressed`/`aria-expanded`/`aria-current` on the relevant controls, WCAG-AA muted-text contrast, a `:focus-visible` ring, and a `prefers-reduced-motion` guard. Alongside these, a presentation pass toward an Apple-ish look: full dark mode (see Appearance), the system-blue accent, a soft tinted selection instead of a solid blue bar, a translucent blurred top bar, subtle card elevation, and gentler motion. Frontend security posture was reviewed and left as-is (already sound: escaped text, `rel="noreferrer"` on article links, no `dangerouslySetInnerHTML`).
- **Appearance control added** (see Appearance): a System / Light / Dark chooser in the sidebar, since following the OS was the only option before and a web app shouldn't force an OS-wide theme change to darken one app. Implemented over CSS `light-dark()` so it layered cleanly onto the dark-mode work above.
- **Export OPML and the appearance control grouped under a "Customization" card**: on request, moved out from being two standalone sidebar buttons into a single labeled, rounded card (Export OPML as the top row, the theme control as the bottom row), matching the clean rounded-segmented-control look the user liked. "+ Add Category" was deliberately left alone, positioned and styled exactly as before.
- **Article lists grouped by date** ("Today", then calendar dates like "July 10, 2026"): the browse list, Read Later, and Read Articles now split into contiguous same-day sections instead of one flat list, grouped by whichever timestamp field the view already sorts on. Today's per-category digest opts out (every article there is already "today").
- **Visual identity modernized to "Console"** (see Visual design): chosen from three prototyped directions shown side-by-side in a design-comparison artifact built from the app's own real content — a softer Apple-materials look and a serif editorial layout were the other two, both passed over for this denser, Linear/Arc-style option. Landed alongside a genuinely new feature, not just restyling: unread/saved counts on the All Feeds/Today/Read Later sidebar destinations, closing a previously-listed gap.
- **Database moved out of the project directory** (see Data Directory): motivated by wanting the data separable from the code/install for backup purposes. A true "choose a folder" picker was considered and dropped as more machinery than the benefit justified for a single-user local tool (would need its own UI); landed on an OS-appropriate default (`~/Library/Application Support/Feed Reader` on macOS) plus a `FEED_READER_DATA_DIR` env var escape hatch, with a one-time automatic migration of the existing `server/data/feed-reader.db` so nothing already-subscribed was lost. Verified against the real, already-in-use database (row counts for every table compared before/after) before this shipped, not just a fresh test database.
- **Double-click launcher added** (`Feed Reader.command`, see Running It): the actual ask was "stop needing a terminal window and `npm start` every time," not a distributable installer — a real bundled/standalone executable (Node SEA, `pkg`, Electron, etc.) was considered and set aside, since `better-sqlite3` is a compiled native module that complicates bundling a true standalone binary, and there is no present need to hand this to anyone without Node already set up. A plain shell script that starts the existing single-process server and opens the default browser once it responds gets the same day-to-day result for a fraction of the complexity.

## Known gaps / not implemented

- Clicking the "Uncategorized" label — in the sidebar, or in Today's digest — does not filter/link to just uncategorized feeds (unlike clicking a real category) — it's a static label, not a button, in both places.
- No way to add a brand-new feed with no category directly if Uncategorized is currently hidden (empty) — you'd add it to a category first, then drag it onto the (drag-revealed) Uncategorized zone.
- No persistence of sidebar collapse/expand state across page reloads (resets to all-collapsed, the current default — see Recent History).
- No backfill mechanism for existing articles' `imageUrl`/`feedImageUrl` when extraction logic improves — only new articles benefit (see Images above).
- No schema migration framework — `server/src/db.js` runs idempotent `CREATE TABLE IF NOT EXISTS` on every start, which is sufficient for a fresh build with no data to preserve across schema changes, but would need real migrations before changing the schema on a database that already has real data in it.
- **OPML import** — deliberately deferred; export-only for now.
- **Search** — wanted, but scope (titles only? full text? saved articles only?) not yet decided.
- **Keyboard shortcuts, "mark all as read"** — considered as enhancements, not yet decided on or built. (Unread/saved counts *are* now implemented — see Sidebar.)
- **In-app "reader view" (full article content)** — considered and explicitly rejected; snippet + open-in-new-tab is the intended experience.
- **Article-webpage scraping for images** (e.g. Open Graph tags) — explicitly out of scope; too heavy/fragile for a per-refresh operation. See Images above.
- No automated tests.
- No real deployment tooling (no Dockerfile, process manager config, HTTPS/reverse-proxy setup) — `npm start` from the repo root builds the frontend and runs it as a single local process, but that's still "run it on your own machine," not a hardened production deploy.

## Running it

**Double-click launcher** (`Feed Reader.command`, repo root): the easiest day-to-day option — no terminal typing required. Double-clicking it in Finder opens a Terminal window that starts the app (`npm start` under the hood) and, once it responds, opens `http://localhost:3001` in your default browser automatically. If the app is already running, it just re-opens the browser instead of starting a second instance. Leave that Terminal window open while you use the app — closing it (or Ctrl+C) stops the server. It's a plain shell script (no bundling, no installer, no native dependencies of its own), executable via its own file permission bit, checked into the repo like any other file — see Recent History for why this was chosen over a true bundled/standalone executable.

**Single-process mode** (root `package.json`): `npm start` from the repo root runs `vite build` in `web/` (producing `web/dist`) then starts the server, which serves `web/dist` via `express.static` alongside the API — one process, one port (`http://localhost:3001`), no Vite dev server involved. The static-serving block in `server/src/index.js` only activates if `web/dist` exists (checked with `fs.existsSync`), so it's silently a no-op — just an informational console log — when it doesn't, which is what keeps this from interfering with the two-process dev workflow below. The launcher above is just this command with a one-time-typed, double-clickable wrapper around it.

**Two-process dev mode** (hot-reloading frontend):
```bash
cd server && npm start     # http://localhost:3001 — see Data Directory above for where feed-reader.db lives
cd web && npm run dev      # http://localhost:5173
```
Open `http://localhost:5173` in Firefox. Both must be running simultaneously; the web dev server proxies API calls to the backend. The backend has no hot-reload either way — restart it manually after any change under `server/src/`.
