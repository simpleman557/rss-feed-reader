import Database from "better-sqlite3";
import path from "path";
import { DATA_DIR } from "./dataDir.js";
import { runMigrations } from "./migrations.js";
import { createDb } from "./dbLogic.js";
import { getSnapshotConfig, createGcsStore, restoreFromSnapshot, createSnapshotter } from "./snapshot.js";

const DB_PATH = path.join(DATA_DIR, "feed-reader.db");
console.log(`Database: ${DB_PATH}`);

// Hosted setup only (FEED_READER_SNAPSHOT_BUCKET set): the database lives on local disk and
// the bucket holds snapshots of it (see snapshot.js). Restore the newest intact snapshot
// BEFORE opening the database. This is a top-level await, so nothing that imports this
// module — including the server's listen() call — runs until it finishes, and a restore
// that can't be done safely throws, which stops the server from starting at all rather
// than starting empty. Unset (local use): none of this runs.
const snapshotConfig = getSnapshotConfig();
let snapshotStore = null;
let restored = null;
if (snapshotConfig) {
  try {
    snapshotStore = await createGcsStore(snapshotConfig);
    restored = await restoreFromSnapshot({ store: snapshotStore, dbPath: DB_PATH, log: console });
  } catch (err) {
    console.error(`[snapshot] Refusing to start: ${err.message}`);
    throw err;
  }
}

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");
// WAL mode: better concurrent read/write behavior and fewer fsync stalls than the
// default rollback journal. Produces -wal/-shm sidecar files (already gitignored).
// The hosted deployment keeps the database on the container's local disk (snapshots go to the
// bucket separately), so WAL works there too. SQLITE_JOURNAL_MODE remains as an override for
// anyone who does put the file on a network or FUSE filesystem, which can't provide the shared
// memory WAL needs — though that setup is what corrupted the hosted database once; don't.
const JOURNAL_MODE = (process.env.SQLITE_JOURNAL_MODE || "WAL").toUpperCase();
if (!["WAL", "DELETE", "TRUNCATE", "PERSIST", "MEMORY", "OFF"].includes(JOURNAL_MODE)) {
  throw new Error(`Invalid SQLITE_JOURNAL_MODE: ${JOURNAL_MODE}`);
}
db.pragma(`journal_mode = ${JOURNAL_MODE}`);

const versionBeforeMigrations = db.pragma("user_version", { simple: true });
runMigrations(db);
const migrated = db.pragma("user_version", { simple: true }) !== versionBeforeMigrations;

// Present only in the hosted setup; the server wires it into requests and shutdown.
export const snapshotter = snapshotConfig
  ? createSnapshotter({
      store: snapshotStore,
      db,
      workDir: DATA_DIR,
      knownGeneration: restored.knownGeneration,
      // A database that was just migrated, newly created, or restored from an older version
      // differs from the bucket's object, so upload it right away instead of waiting for a write.
      dirtyAtStart: migrated || restored.needsHealing || restored.createdEmpty,
      log: console,
    })
  : null;
if (snapshotter && (migrated || restored.needsHealing || restored.createdEmpty)) {
  snapshotter.flush().catch((err) => console.error(`[snapshot] Initial upload failed; will retry: ${err.message}`));
}

// All business logic (ordering, uniqueness, retention) lives in dbLogic.js, built as a
// factory rather than defined here — this file's only job is opening the real
// connection and binding that logic to it. Tests call createDb() directly against a
// throwaway in-memory database instead, so they never touch the file below.
export const {
  getCategories,
  addCategory,
  updateCategoryName,
  deleteCategory,
  getFeeds,
  addFeed,
  renameFeed,
  updateFeedCategory,
  deleteFeed,
  importOpml,
  syncFeedMetadata,
  upsertArticles,
  getArticles,
  markRead,
  toggleSaved,
  getArticlesNeedingOgCheck,
  setArticleOgImage,
  clearArticleImagesForFeed,
  purgeExpiredArticles,
} = createDb(db);
