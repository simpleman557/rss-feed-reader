# Feed Reader

A self-hosted, minimal alternative to Feedly. No accounts, no tracking, no third-party services — just an RSS/Atom reader you run yourself, with subscriptions organized into categories, a 30-day read/unread retention window, and a "read later" queue.

## Features

- Subscribe to RSS/Atom feeds and organize them into categories (drag a feed onto a category to move it)
- Today (a per-category digest of what's new), Read Later, and Read Articles as sidebar destinations, plus a plain unread list for any category or feed you select — all sortable newest- or oldest-first, and grouped by date ("Today", then calendar dates)
- Unread and saved counts next to All Feeds, Today, and Read Later in the sidebar
- Automatic per-article thumbnail extraction, handling the many incompatible ways publishers embed images across real-world feeds
- Auto-refreshes every 15 minutes (paused while the tab is hidden, to avoid wasted fetches)
- A dense, focused interface (small rows, monospaced counts/timestamps, one accent color) with light/dark appearance, following your system by default — override it with the System / Light / Dark control at the bottom of the sidebar
- Export your subscriptions to OPML
- All data — subscriptions, categories, read/saved state — lives in a SQLite database file owned by the server, not the browser, so it survives clearing browser data and isn't tied to one browser profile

## Architecture

- **`server/`** — Node/Express backend. Fetches and parses RSS/Atom feeds (working around the browser's CORS restrictions), extracts a thumbnail image per article, owns all persistent data in a SQLite file at `server/data/feed-reader.db`, and can serve the built frontend directly so the whole app runs as one process.
- **`web/`** — Vite + React frontend. Talks to the backend over a small REST API and holds no data of its own.

See [SPEC.md](SPEC.md) for the full design and behavior spec, including the data model, retention rules, and known gaps.

## Running it

Requires [Node.js](https://nodejs.org/). First time only, install dependencies in both halves:

```bash
cd server && npm install
cd ../web && npm install
```

**Day to day**, run it as a single process from the repo root:

```bash
npm start   # builds the frontend, then serves everything on http://localhost:3001
```

This builds `web/` into static files and has the backend serve them alongside the API, so there's only one process/port to deal with. Open **http://localhost:3001** in your browser (Firefox is the primary target; other browsers should work too).

**While actively developing the frontend**, run the two dev servers separately instead, so frontend edits hot-reload instantly instead of requiring a rebuild:

```bash
cd server && npm start     # backend — http://localhost:3001
cd web && npm run dev      # frontend, hot-reloading — http://localhost:5173
```

Open **http://localhost:5173** in this mode — its dev server proxies `/api/*` requests to the backend. Either way, the backend itself has no hot-reload: after changing anything under `server/src/`, stop it (`Ctrl+C`) and start it again to pick up the change.

## Notes

- No automated tests.
