// Lightweight schema/data migrations, tracked with SQLite's built-in `PRAGMA
// user_version` — a single integer stored in the database file itself, meant for
// exactly this purpose, so no extra table or dependency is needed. A full framework
// (Prisma/Knex-style, with rollback and branching support) would be solving for a
// multi-environment risk profile this single-user local app doesn't have.
//
// Each migration is a `{ version, name, run(db) }`. On startup, `runMigrations` reads
// the stored version, runs only the migrations numbered higher than it (in order), and
// bumps the version after each one succeeds — all inside one transaction per migration,
// so a failure leaves the database at its last-known-good version instead of half
// applied. There's no rollback tooling: a migration that throws crashes the app on
// startup (loud failure beats silently running against a schema the code doesn't
// expect) — for a single-user tool, backing up the database file first (already this
// project's practice before any risky change) is the accepted substitute.
//
// Every migration below is also internally idempotent (checks before altering) even
// though the version tracker alone would normally make that redundant. That's because
// this system is being retrofitted onto a database that already picked up some of these
// exact changes via older, ad-hoc guards before this file existed — the version starts
// at 0 for that database even though migrations 1 and 2 already happened in substance,
// so each one has to be safe to run again as a no-op.

function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}

const MIGRATIONS = [
  {
    version: 1,
    name: "initial schema",
    run(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          "order" REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS feeds (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT NOT NULL,
          categoryId INTEGER REFERENCES categories(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          feedImageUrl TEXT,
          "order" REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS articles (
          id TEXT PRIMARY KEY,
          feedId INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          link TEXT,
          isoDate TEXT,
          insertedAt TEXT NOT NULL,
          contentSnippet TEXT,
          imageUrl TEXT,
          read INTEGER NOT NULL DEFAULT 0,
          readAt TEXT,
          saved INTEGER NOT NULL DEFAULT 0,
          unsavedAt TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_articles_feedId ON articles(feedId);
        CREATE INDEX IF NOT EXISTS idx_articles_isoDate ON articles(isoDate);
      `);
    },
  },
  {
    version: 2,
    name: "add feeds.siteUrl",
    run(db) {
      // Stores the feed's real homepage (parsed from the RSS <link> element), used by
      // faviconResolver.js to fetch that page's own declared <link rel="icon"> tags
      // rather than guessing a favicon.ico path off the feed URL.
      if (!hasColumn(db, "feeds", "siteUrl")) {
        db.exec("ALTER TABLE feeds ADD COLUMN siteUrl TEXT");
      }
    },
  },
  {
    version: 3,
    name: "dedupe fragment-suffixed article ids",
    run(db) {
      // Before feedParser.js stripped revision fragments from guids, some feeds (e.g.
      // BBC's) reused the same guid for a live-updated article but appended an
      // incrementing "#0", "#8", etc. each time it was edited — each edit could insert
      // a duplicate row differing only by that fragment. Merges every such group down
      // to one row per de-fragmented id: read/saved are OR'd together so nothing
      // already read or saved is lost, the earliest-inserted row's content
      // (title/link/image/snippet) wins, and the survivor is renamed to the
      // fragment-free id so future refreshes match it via INSERT OR IGNORE instead of
      // recreating the duplicate.
      const rows = db.prepare("SELECT * FROM articles").all();
      const groups = new Map();
      for (const row of rows) {
        const hashIndex = row.id.indexOf("#");
        if (hashIndex === -1) continue;
        const baseId = row.id.slice(0, hashIndex);
        if (!groups.has(baseId)) groups.set(baseId, []);
        groups.get(baseId).push(row);
      }
      if (groups.size === 0) return;

      const deleteStmt = db.prepare("DELETE FROM articles WHERE id = ?");
      const renameStmt = db.prepare(
        "UPDATE articles SET id = ?, read = ?, readAt = ?, saved = ?, unsavedAt = ? WHERE id = ?"
      );

      let mergedGroups = 0;
      let deletedRows = 0;
      for (const [baseId, fragmentRows] of groups) {
        const existingBase = db.prepare("SELECT * FROM articles WHERE id = ?").get(baseId);
        const all = existingBase ? [existingBase, ...fragmentRows] : fragmentRows;

        all.sort((a, b) => new Date(a.insertedAt) - new Date(b.insertedAt));
        const survivor = all[0];
        const readAts = all.map((r) => r.readAt).filter(Boolean).sort();
        const unsavedAts = all.map((r) => r.unsavedAt).filter(Boolean).sort();

        for (const r of all) {
          if (r.id !== survivor.id) {
            deleteStmt.run(r.id);
            deletedRows++;
          }
        }
        renameStmt.run(
          baseId,
          all.some((r) => r.read) ? 1 : 0,
          readAts[0] ?? null,
          all.some((r) => r.saved) ? 1 : 0,
          unsavedAts[0] ?? null,
          survivor.id
        );
        mergedGroups++;
      }
      console.log(`Merged ${mergedGroups} duplicate article group(s), removed ${deletedRows} row(s).`);
    },
  },
];

export function runMigrations(db) {
  const currentVersion = db.pragma("user_version", { simple: true });
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion).sort(
    (a, b) => a.version - b.version
  );
  for (const migration of pending) {
    const applyMigration = db.transaction(() => {
      migration.run(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    applyMigration();
    console.log(`Applied migration ${migration.version}: ${migration.name}`);
  }
}
