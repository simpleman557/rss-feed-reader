# Spec: Fix a newly arrived article vanishing the moment it is read

<!-- Mode: bug fix. Small, so sections that don't apply are one line. -->

**Status:** Implemented
**Date:** 2026-10-23
**Scope in one sentence:** An article that arrived through a background refresh must stay in place, greyed out, when it is read, like every other article; today it disappears instantly.

## Open questions and assumptions

- **CONFIRMED (evidence, not a guess):** the cause is below. Server logs and the stored data for the reported article ("People are vibe coding their way to better TVs") match it exactly.
- **ASSUMPTION A1:** no other path drops a just-read article. The fix addresses the one found; if the bug still happens afterwards, that is a new finding, and the diagnostic-trail idea (off-by-default `?debug=1` recorder) is the fallback. No diagnostics were added.
- **RESOLVED:** articles that arrive in the background are remembered as they arrived (not as "unread"), so one already read on another device doesn't show up greyed out. See the Delete check in section 2.

## 1. Requirements

**User outcome:** Read an article from Today (or any unread list), come back, and see it greyed out where it was, until I refresh or move to another screen. This is already the designed behavior (main spec, "A just-read or just-un-saved article lingers in place"); it just doesn't hold for articles that arrived after the last explicit refresh.

**Observed vs expected**
- Expected: reading any unread article greys it out in place.
- Observed: on the phone, an article fetched by the silent catch-up refresh (which runs when the home-screen app resumes after 15+ minutes asleep) disappears the instant it is read. The desktop tab rarely hits this because it is rarely resumed from sleep.

**Root cause**
- `App.jsx` keeps a `snapshot` of every article's read/saved flags as of the last explicit "moved on" moment. A just-read article is kept visible only if the snapshot says it was unread.
- `reloadAll({ resetSnapshot: false })` (the silent refresh) replaces `articles` but leaves `snapshot` alone, so new articles have **no snapshot entry**.
- `wasUnreadInSnapshot(id)` returns `false` when there is no entry. A new article read before the next explicit refresh therefore counts as "already read" and is filtered out.
- Evidence: the article was inserted at 13:24:12Z by the phone's resume refresh (one set of list reloads, no page load), and read at 13:24:25Z. Articles inserted during a cold open (explicit, snapshot rebuilt) behave correctly.

**Functional requirements**
- After any reload, every article in `articles` has a snapshot entry. Entries that already exist are never changed by a silent refresh (so the lingering behavior is unchanged); only missing ones are added, recording the article's flags as they arrived.
- An explicit reload still replaces the whole snapshot, as today.
- Applies equally to the "saved" half (`wasSavedInSnapshot`), which has the same gap.

**Non-functional requirements**
- No extra network requests; no server change; no schema change.
- Reliability: nothing about stored read/saved state changes. This is display logic only.

**Non-goals**
- No change to when the list re-baselines (refresh button, navigation, cold open).
- No new diagnostics/logging. (Nothing to remove afterwards.)
- No change to Today's per-category cap of 10.

**Acceptance criteria: trust and quality**
- Data collected: none. Permissions: none. Accessibility: unchanged.
- Undo: marking read/saved is already reversible by the user; unchanged.

## 2. Architecture / Design

**Components:** `web/src/App.jsx` only (`reloadAll`, snapshot state). The merge rule moves into a tiny pure function, `mergeSnapshot(prev, articles)`, in a new `web/src/snapshot.js`, so it can be unit-tested without a browser.

**Data flow:** silent refresh (and any other `reloadAll()` call that doesn't ask for a reset, such as the reload after adding a feed or category: harmless, it only adds missing entries) → `reloadAll({ resetSnapshot: false })` → `setArticles(arts)` and now also `setSnapshot(prev => mergeSnapshot(prev, arts))`. Explicit refresh/cold open → unchanged (`setSnapshot(fresh map)`).

**Impact check:** touches the unread browse list, Today digest, Read Later (`wasSavedInSnapshot`). Nothing else reads the snapshot. Contract kept: "background refresh never prunes what you're looking at."

**Delete check:** the alternative of making a missing entry mean "was unread" is a one-line change but wrongly shows articles that were read on another device before they arrived (they would appear greyed in the list). Rejected.

## 3. Data model / schema

No change. Snapshot stays an in-memory `Map<id, { read, saved }>`.

Rule that must always hold: *for every article in `articles`, the snapshot has an entry; existing entries are only replaced by an explicit reload.*

## 4. Interface contracts

| Interface | Inputs | Outputs | Errors | Who may call |
|---|---|---|---|---|
| `mergeSnapshot(prev, articles)` | previous Map, fresh article array | new Map: all `prev` entries kept, missing ids added as `{ read, saved }` from `articles` | none (pure) | `reloadAll` |

Entries for articles no longer in `articles` may be kept or dropped; dropping them is preferred so the Map doesn't grow without bound.

## 5. Error handling and edge cases

| Scenario | Expected behavior | Test |
|---|---|---|
| New article arrives via silent refresh, then is read | Stays in place, greyed out | IT-1, UT-1 |
| Article read on desktop, then arrives on phone via silent refresh | Not shown in the unread list (arrived read) | UT-2 |
| Article already in snapshot (read earlier this sitting), silent refresh runs | Entry unchanged; still lingers | UT-3 |
| New article saved then un-saved before next explicit refresh | Lingers in Read Later like others | UT-4 |
| Article deleted by retention | Entry dropped | UT-5 |
| Explicit refresh | Snapshot fully replaced, lingering articles drop | existing behavior |

## 6. Integration tests

- [x] IT-1: Playwright (both desktop and mobile projects, `web/e2e/shared.spec.js`): open Today; advance the fake clock 16 minutes so the 15-minute timer fires a silent refresh that brings in a new article (route-mocked); click it; the row is still present with the `read` style. Written first and seen to fail before the fix. The phone's resume-from-sleep catch-up calls the same `handleRefresh({ explicit: false })`, so this covers both triggers.
- [x] IT-2: Existing Playwright suite still passes (page load and timer don't force a refresh; lingering behavior for older articles).

## 7. Unit tests

Run with Node's built-in test runner (`node --test`), no new dependency.

All in `web/test/snapshot.test.js`.

- [x] UT-1: ids missing from `prev` are added with the article's flags ("arrives after the last baseline").
- [x] UT-2: a missing id whose article is already `read: true` is recorded as read ("arrives already read").
- [x] UT-3: ids present in `prev` keep their old values even if `articles` differ ("never moved on by a silent refresh").
- [x] UT-4: `saved` flag handled the same way ("arrives saved"). Un-saving a newly arrived article is not tested separately: it uses the same shared path.
- [x] UT-5: ids not in `articles` are dropped ("no longer in the list").

## 8. Dependencies

None added.

## 9. Deployment, configuration, and rollout

- Runs as part of the web build on Cloud Run (`docs/DEPLOY.md`). No config. Release mode: direct (display-only, small, reversible by redeploy).
- Reaching the phone: `index.html` is served `no-cache`, so the home-screen app picks it up the next time it loads fresh. Fully close the app (swipe it away) and reopen it once. No reinstall.
- **Rollback trigger:** if any article that used to linger now vanishes, or the unread list shows articles already read elsewhere, redeploy the previous revision.
- Signals to watch: use the app normally for a few days; the e2e suite in CI.
- Docs to update: main spec's lingering paragraph (note that arrivals are baselined too); CHANGELOG if one exists.

## Change log

- 2026-10-23: initial draft after log/data analysis of the reported article.
- 2026-10-23: approved and implemented. Unit tests UT-1..UT-5 (`web/test/snapshot.test.js`, run with `npm run test:unit`, also added to CI) and IT-1 (`web/e2e/shared.spec.js`, failed before the fix, passes after). UT-2..UT-4 passed on first run: they pin behaviour the first implementation already had. Not yet deployed.
