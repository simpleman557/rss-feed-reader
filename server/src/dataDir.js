import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const APP_NAME = "Feed Reader";

// OS-appropriate location for user data, kept separate from the code/install
// directory (so an update or reinstall of the app never touches it) — matches how
// real desktop apps behave (e.g. macOS keeps app data in ~/Library/Application
// Support, not inside the app bundle). Overridable for anyone who wants the file
// somewhere specific (a synced folder, an external drive, etc).
function defaultDataDir() {
  if (process.env.FEED_READER_DATA_DIR) return process.env.FEED_READER_DATA_DIR;

  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_NAME);
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), APP_NAME);
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "feed-reader");
}

export const DATA_DIR = defaultDataDir();

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    // Cross-device (EXDEV) can happen if the two directories are on different
    // filesystems/volumes — rename can't do that atomically, so fall back to copy+delete.
    if (err.code !== "EXDEV") throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

// One-time migration: earlier versions stored the database inside the project
// directory itself (server/data/feed-reader.db). If that's where the data still
// lives and nothing exists yet at the new location, move it — including the SQLite
// WAL/SHM sidecar files, which can hold not-yet-checkpointed writes — so existing
// subscriptions and read/saved state survive the upgrade untouched.
function migrateLegacyDataDir() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const legacyDir = path.join(__dirname, "..", "data");
  const legacyDb = path.join(legacyDir, "feed-reader.db");
  const newDb = path.join(DATA_DIR, "feed-reader.db");

  if (fs.existsSync(newDb) || !fs.existsSync(legacyDb)) return;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = legacyDb + suffix;
    if (fs.existsSync(from)) moveFile(from, newDb + suffix);
  }
  console.log(`Moved existing database from ${legacyDir} to ${DATA_DIR}`);
}

migrateLegacyDataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });
