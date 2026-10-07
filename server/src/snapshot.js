// Durable storage for the hosted deployment: SQLite runs on the container's local disk and
// the bucket only ever receives WHOLE, consistent snapshots of it.
//
// Why: the first hosted version ran SQLite directly on a Cloud Storage FUSE mount. Cloud
// Storage can't change part of an object, only replace the whole thing, so every SQLite
// commit re-uploaded the entire file, with no real file locking underneath. An interrupted
// write, or an old and a new revision both writing during a deploy, corrupted the
// database (Oct 2026, see docs/DEPLOY.md "Data durability"). Here, an object upload either
// fully happens or doesn't, so the bucket can never hold a half-written file, and each
// instance has its own private copy of the database.
//
// What this file does (all of it off unless FEED_READER_SNAPSHOT_BUCKET is set, so local
// use is unchanged):
//  - restoreFromSnapshot(): before the database is opened, download it from the bucket and
//    check it. If the newest copy is damaged, fall back to older versions (loudly). If it
//    can't be done safely, throw — the server must never start empty over real data.
//  - createSnapshotter(): after writes, upload a consistent copy (better-sqlite3's online
//    backup), guarded by the object's generation number so a second instance can't be
//    overwritten silently. The live instance wins a conflict; see uploadWithPolicy.
//  - snapshotAfterWrites(): Express middleware that holds each write's response until a
//    snapshot containing it is uploaded. Cloud Run throttles the CPU after a response is
//    sent, so a background timer can't be relied on.
//
// The storage backend is passed in as a small "store" object (stat, download,
// listVersions, upload) so all of this can be tested without Google Cloud;
// createGcsStore() is the real implementation.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const MAX_FALLBACK_VERSIONS = 20;
const DEFAULT_OBJECT = "feed-reader.db";
const SHUTDOWN_FLUSH_TIMEOUT_MS = 8000; // Cloud Run allows ~10 s after SIGTERM

export function getSnapshotConfig(env = process.env) {
  const bucket = env.FEED_READER_SNAPSHOT_BUCKET;
  if (!bucket) return null;
  return { bucket, object: env.FEED_READER_SNAPSHOT_OBJECT || DEFAULT_OBJECT };
}

// Returns null if `file` is an intact SQLite database, otherwise a short reason. Uses the
// full integrity_check rather than quick_check: quick_check skips verifying that index
// contents match the tables, which is exactly how the Oct 2026 corruption showed up (the
// primary-key index stopped matching the table). The database is small, so the full check
// takes milliseconds.
export function databaseProblem(file) {
  let db;
  try {
    // SQLite treats an empty file as a valid, empty database, so the integrity check below
    // would pass it. A snapshot that is empty, or has no tables, is not data to restore.
    if (fs.statSync(file).size === 0) return "the file is empty";
    // Not opened read-only: a database saved in WAL mode needs to create its -shm file.
    db = new Database(file, { fileMustExist: true });
    const rows = db.pragma("integrity_check");
    if (rows.length === 1 && rows[0].integrity_check === "ok") {
      const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
      return tables > 0 ? null : "the database contains no tables";
    }
    return `integrity_check reported: ${rows
      .slice(0, 3)
      .map((r) => r.integrity_check)
      .join("; ")}`;
  } catch (err) {
    return `couldn't be opened or checked: ${err.message}`;
  } finally {
    try {
      db?.close();
    } catch {
      // nothing useful to do
    }
  }
}

function removeDbFiles(base) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(base + suffix, { force: true });
  }
}

// Replace the local database with `candidate`. Same directory, so the rename is atomic,
// and any stale WAL/SHM files from a previous database are removed first (they'd be
// replayed against the wrong file).
function moveIntoPlace(candidate, dbPath) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    fs.rmSync(candidate + suffix, { force: true });
  }
  fs.renameSync(candidate, dbPath);
}

// Run once at startup, BEFORE the database is opened. Resolves to:
//   { knownGeneration, needsHealing, createdEmpty, restoredFrom }
// `knownGeneration` is the bucket object's current generation (what the next upload must
// match; "0" when there's no object yet). `needsHealing` is true when we restored an older
// version, so the damaged current object should be replaced right away.
// Throws on anything it can't handle safely: never start with an empty database unless the
// object is genuinely absent.
export async function restoreFromSnapshot({ store, dbPath, log = console, maxFallback = MAX_FALLBACK_VERSIONS }) {
  const candidate = `${dbPath}.restoring`;
  removeDbFiles(candidate);

  // A failure here (network, permissions) propagates: starting empty would let the first
  // write upload an empty database over the real one.
  const current = await store.stat();

  if (!current) {
    log.error(
      "[snapshot] No snapshot object found in the bucket: starting with an EMPTY database. " +
        "Expected only for a brand-new deployment; if this service had data, stop and check the bucket."
    );
    return { knownGeneration: "0", needsHealing: false, createdEmpty: true, restoredFrom: null };
  }

  await store.download(current.generation, candidate);
  const problem = databaseProblem(candidate);
  if (!problem) {
    moveIntoPlace(candidate, dbPath);
    log.log(`[snapshot] Restored database from snapshot generation ${current.generation} (${current.updated}).`);
    return { knownGeneration: current.generation, needsHealing: false, createdEmpty: false, restoredFrom: current };
  }

  log.error(
    `[snapshot] The newest snapshot (generation ${current.generation}, ${current.updated}) is damaged: ${problem}. ` +
      "Looking for an older intact version."
  );
  removeDbFiles(candidate);

  const older = (await store.listVersions()).filter((v) => v.generation !== current.generation).slice(0, maxFallback);
  for (const version of older) {
    await store.download(version.generation, candidate);
    const oldProblem = databaseProblem(candidate);
    if (!oldProblem) {
      moveIntoPlace(candidate, dbPath);
      log.error(
        `[snapshot] restored from older snapshot: generation ${version.generation} (${version.updated}). ` +
          `Everything written after that was NOT restored (the damaged newer snapshot was generation ${current.generation}).`
      );
      // The damaged current object keeps its generation, so the next upload replaces it.
      return { knownGeneration: current.generation, needsHealing: true, createdEmpty: false, restoredFrom: version };
    }
    log.error(`[snapshot] Older snapshot generation ${version.generation} is also damaged: ${oldProblem}`);
    removeDbFiles(candidate);
  }

  throw new Error(
    `No intact snapshot found (newest was damaged, and none of the ${older.length} older versions checked passed). ` +
      "Refusing to start rather than run on an empty or damaged database."
  );
}

function isPreconditionFailed(err) {
  return err?.code === 412 || err?.status === 412 || err?.response?.status === 412;
}

export function createSnapshotter({ store, db, workDir, knownGeneration, dirtyAtStart = false, log = console }) {
  const tmpFile = path.join(workDir, "snapshot-upload.tmp");
  let known = String(knownGeneration);
  const totalChanges = () => db.prepare("SELECT total_changes() AS n").get().n;
  // The change count at the last upload. -1 forces the first upload (a database that was
  // just migrated, or restored from an older version, differs from the bucket's object).
  let uploadedChanges = dirtyAtStart ? -1 : totalChanges();
  let running = null;
  let queued = null;

  // One upload attempt. `shutdown` changes only what happens on a generation conflict.
  async function uploadWithPolicy(shutdown) {
    try {
      const { generation } = await store.upload(tmpFile, { ifGenerationMatch: known });
      known = generation;
      return { uploaded: true };
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
      if (shutdown) {
        // This instance is the one going away and a newer one has already written: drop
        // ours instead of overwriting the newer data.
        log.warn("[snapshot] Dropped the shutdown snapshot: a newer snapshot was uploaded by another instance.");
        return { uploaded: false, dropped: true };
      }
      // A normal flush: an older instance (deploy overlap) uploaded since we last did. The
      // live instance wins; its own changes from the overlap window are lost, logged here
      // so it's never silent.
      log.warn(
        "[snapshot] Another instance uploaded a newer snapshot (deploy overlap?). Overwriting it: " +
          "the live instance wins, so that instance's recent changes are lost."
      );
      const { generation } = await store.upload(tmpFile, {});
      known = generation;
      return { uploaded: true, overwrote: true };
    }
  }

  async function doUpload({ shutdown = false } = {}) {
    // Read the count BEFORE the backup: a write that lands during the backup is then seen as
    // new next time instead of being counted as already uploaded.
    const changes = totalChanges();
    if (changes === uploadedChanges) return { uploaded: false, unchanged: true };
    fs.rmSync(tmpFile, { force: true });
    await db.backup(tmpFile); // consistent online copy; safe while the database is in use
    try {
      const result = await uploadWithPolicy(shutdown);
      uploadedChanges = changes;
      return result;
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }

  function start() {
    const p = doUpload().finally(() => {
      if (running === p) running = null;
    });
    running = p;
    return p;
  }

  const noop = () => {};

  return {
    // Resolves once a snapshot including every write made before this call is uploaded.
    // Never runs two uploads at once: while one is in flight, later callers share a single
    // queued follow-up (which covers all of them).
    flush() {
      if (!running) return start();
      if (!queued) {
        queued = running.then(noop, noop).then(() => {
          queued = null;
          return start();
        });
      }
      return queued;
    },

    // The last flush on SIGTERM. Waits for an upload already running, then does one more with
    // the generation precondition, bounded so it fits Cloud Run's shutdown window.
    async shutdownFlush({ timeoutMs = SHUTDOWN_FLUSH_TIMEOUT_MS } = {}) {
      const work = (async () => {
        if (running) await running.then(noop, noop);
        return doUpload({ shutdown: true });
      })();
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ uploaded: false, timedOut: true }), timeoutMs);
      });
      try {
        const result = await Promise.race([work, timeout]);
        if (result.timedOut) log.error("[snapshot] The shutdown snapshot didn't finish in time.");
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// Holds every write request's response until a snapshot containing it is uploaded, so once
// the client sees success the change is in the bucket. If the upload fails the response still
// goes out (the change is already applied locally, and a client retrying a toggle such as
// "save" would undo it): the failure is logged at ERROR and the next flush retries.
export function snapshotAfterWrites(snapshotter, { log = console } = {}) {
  const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    const end = res.end;
    res.end = function (...args) {
      res.end = end; // only intercept the first call
      snapshotter
        .flush()
        .catch((err) => {
          log.error(`[snapshot] Upload failed after ${req.method} ${req.originalUrl}; it will be retried: ${err.message}`);
        })
        .then(() => end.apply(res, args));
      return res;
    };
    next();
  };
}

// The real store, backed by Google Cloud Storage. `storage` can be injected (tests do);
// otherwise the client picks up credentials on its own (Cloud Run's metadata server, or
// local Application Default Credentials).
export async function createGcsStore({ bucket, object = DEFAULT_OBJECT, storage }) {
  if (!storage) {
    const { Storage } = await import("@google-cloud/storage");
    storage = new Storage();
  }
  const b = storage.bucket(bucket);

  return {
    async stat() {
      try {
        const [meta] = await b.file(object).getMetadata();
        return { generation: String(meta.generation), updated: meta.updated };
      } catch (err) {
        if (err.code !== 404) throw err;
        // Cloud Storage answers 404 both for a missing object and for a missing bucket. Only
        // the first means "no snapshot yet"; a wrong bucket name must stop the server, not
        // look like a fresh deployment and start empty.
        const [bucketExists] = await b.exists();
        if (!bucketExists) throw new Error(`The bucket "${bucket}" doesn't exist (check FEED_READER_SNAPSHOT_BUCKET).`);
        return null;
      }
    },

    async download(generation, destination) {
      await b.file(object, { generation: Number(generation) }).download({ destination });
    },

    // Newest first. Includes the current version; callers skip it if they don't want it.
    async listVersions() {
      const [files] = await b.getFiles({ versions: true, prefix: object });
      return files
        .filter((f) => f.name === object)
        .map((f) => ({ generation: String(f.metadata.generation), updated: f.metadata.updated }))
        .sort((x, y) => (BigInt(y.generation) > BigInt(x.generation) ? 1 : -1));
    },

    // Without ifGenerationMatch the upload is unconditional. With it, a mismatch rejects
    // with code 412. ("0" means "only if the object doesn't exist yet".)
    async upload(source, { ifGenerationMatch } = {}) {
      const options = { destination: object, resumable: false };
      if (ifGenerationMatch !== undefined) {
        options.preconditionOpts = { ifGenerationMatch: Number(ifGenerationMatch) };
      }
      const [file] = await b.upload(source, options);
      return { generation: String(file.metadata.generation) };
    },
  };
}
