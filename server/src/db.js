import Database from "better-sqlite3";
import path from "path";
import { DATA_DIR } from "./dataDir.js";
import { runMigrations } from "./migrations.js";
import { createDb } from "./dbLogic.js";

const DB_PATH = path.join(DATA_DIR, "feed-reader.db");
console.log(`Database: ${DB_PATH}`);

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");
// WAL mode: better concurrent read/write behavior and fewer fsync stalls than the
// default rollback journal. Produces -wal/-shm sidecar files (already gitignored).
db.pragma("journal_mode = WAL");

runMigrations(db);

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
