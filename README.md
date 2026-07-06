# Feed Reader

A self-hosted, minimal alternative to Feedly. No accounts, no tracking, no third-party services — just an RSS/Atom reader you run yourself, with subscriptions organized into categories, a 30-day read/unread retention window, and a "read later" queue.

## Features

- Subscribe to RSS/Atom feeds and organize them into categories (drag a feed onto a category to move it)
- Today / All / Read Later views, sortable newest- or oldest-first
- Automatic per-article thumbnail extraction, handling the many incompatible ways publishers embed images across real-world feeds
- Auto-refreshes every 15 minutes (paused while the tab is hidden, to avoid wasted fetches)
- Export your subscriptions to OPML
- All data — subscriptions, categories, read/saved state — lives in a SQLite database file owned by the server, not the browser, so it survives clearing browser data and isn't tied to one browser profile

## Architecture

- **`server/`** — Node/Express backend. Fetches and parses RSS/Atom feeds (working around the browser's CORS restrictions), extracts a thumbnail image per article, and owns all persistent data in a SQLite file at `server/data/feed-reader.db`.
- **`web/`** — Vite + React frontend. Talks to the backend over a small REST API and holds no data of its own.

See [SPEC.md](SPEC.md) for the full design and behavior spec, including the data model, retention rules, and known gaps.

## Running it

Requires [Node.js](https://nodejs.org/).

```bash
cd server && npm install && npm start   # backend — http://localhost:3001
cd web && npm install && npm run dev    # frontend — http://localhost:5173
```

Both need to be running at the same time — the frontend dev server proxies `/api/*` requests to the backend. Open **http://localhost:5173** in your browser (Firefox is the primary target; other browsers should work too).

The backend has no hot-reload: after changing anything under `server/src/`, stop it (`Ctrl+C`) and run `npm start` again to pick up the change. The frontend dev server hot-reloads normally.

## Notes

- Dev-only setup — there's no production build/deploy configuration.
- No automated tests.
