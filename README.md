# Feed Reader

A self-hosted, minimal alternative to Feedly. No accounts, no tracking, no third-party services — just an RSS/Atom reader you run yourself, with subscriptions organized into categories, a 30-day read/unread retention window, and a "read later" queue.

## Features

- Subscribe to RSS/Atom feeds and organize them into categories (drag a feed onto a category to move it — every feed always belongs to one, so there's no "Uncategorized" pile to lose track of)
- Today (a per-category digest of what's new), Read Later, and Read Articles as sidebar destinations, plus a plain unread list for any category or feed you select — all sortable newest- or oldest-first, and grouped by date ("Today", then calendar dates)
- Unread and saved counts next to All Feeds, Today, and Read Later in the sidebar
- Each feed's real site icon shown next to its articles and in the sidebar — discovered from the site itself (not a guessed favicon path or the feed's own often-unreliable declared image) and validated before use, so it's the actual logo rather than a broken image or an illegible wordmark banner
- Auto-refreshes every 15 minutes (paused while the tab is hidden, to avoid wasted fetches)
- A dense, focused interface (small rows, monospaced counts/timestamps, one accent color) with light/dark appearance, following your system by default — override it with the System / Light / Dark control at the bottom of the sidebar
- Export your subscriptions to OPML
- All data — subscriptions, categories, read/saved state — lives in a SQLite database file owned by the server, not the browser, so it survives clearing browser data and isn't tied to one browser profile. The file itself lives outside the app's install/code directory too (in your OS's normal per-app data location, e.g. `~/Library/Application Support/Feed Reader` on macOS), so updating or reinstalling the code never touches it

## Architecture

- **`server/`** — Node/Express backend. Fetches and parses RSS/Atom feeds (working around the browser's CORS restrictions), discovers and validates each feed's real site icon, owns all persistent data in a SQLite file kept outside the project directory (see SPEC.md's Data Directory section) with schema changes tracked by a small built-in migration system, and can serve the built frontend directly so the whole app runs as one process.
- **`web/`** — Vite + React frontend. Talks to the backend over a small REST API and holds no data of its own.

See [SPEC.md](SPEC.md) for the full design and behavior spec, including the data model, retention rules, and known gaps.

## Running it

Requires [Node.js](https://nodejs.org/). First time only, install dependencies in both halves:

```bash
cd server && npm install
cd ../web && npm install
```

**Day to day**, just double-click **`Feed Reader.command`** in the repo root — it starts the app and opens it in your default browser automatically once it's ready. Leave that window open while you're using the app; closing it (or Ctrl+C) stops the server. Running it again while it's already up just reopens the browser instead of starting a second copy.

Prefer the command line? The launcher is just a thin wrapper around:

```bash
npm start   # builds the frontend, then serves everything on http://localhost:3001
```

run from the repo root. This builds `web/` into static files and has the backend serve them alongside the API, so there's only one process/port to deal with. Open **http://localhost:3001** in your browser (Firefox is the primary target; other browsers should work too).

**While actively developing the frontend**, run the two dev servers separately instead, so frontend edits hot-reload instantly instead of requiring a rebuild:

```bash
cd server && npm start     # backend — http://localhost:3001
cd web && npm run dev      # frontend, hot-reloading — http://localhost:5173
```

Open **http://localhost:5173** in this mode — its dev server proxies `/api/*` requests to the backend. Either way, the backend itself has no hot-reload: after changing anything under `server/src/`, stop it (`Ctrl+C`) and start it again to pick up the change.

**Running the backend tests**:

```bash
cd server && npm test
```

## Notes

- Backend business logic (ordering/uniqueness rules, retention purge, guid-fragment dedup, icon-discovery validation) has automated test coverage — see SPEC.md's Testing section for what each file covers. The frontend doesn't have automated tests yet.
- A refresh occasionally takes a little longer than usual for a given feed — that's the app periodically (about once a month, per feed) re-checking the site's real icon in case it's changed, not a hang or a bug.
- Marking an article read (or un-saving it from Read Later) greys it out immediately but leaves it in place — it only actually disappears from that list once you hit Refresh (or reload the page), giving you a moment to reconsider before it's gone. Reloading the page also restores whichever destination/category/feed you were on, unless you close the tab entirely — that resets to the default view (Today).
