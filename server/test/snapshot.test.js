import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import Database from "better-sqlite3";
import {
  getSnapshotConfig,
  databaseProblem,
  restoreFromSnapshot,
  createSnapshotter,
  snapshotAfterWrites,
  createGcsStore,
} from "../src/snapshot.js";

// ---- helpers ---------------------------------------------------------------------------

const roots = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-test-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// A real SQLite file with `rows` rows (enough for several pages) and an index.
function makeDbFile(file, rows = 400) {
  const db = new Database(file);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX idx_v ON t(v);");
  const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
  db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(`row ${i} ${"x".repeat(40)}`);
  })();
  db.close();
  return fs.readFileSync(file);
}

// Overwrite part of a table page so SQLite's integrity check fails.
function corrupt(buffer) {
  const copy = Buffer.from(buffer);
  for (let i = 4096 * 2 + 20; i < 4096 * 2 + 400; i++) copy[i] = 0xff;
  return copy;
}

function countRows(file) {
  const db = new Database(file, { fileMustExist: true });
  const n = db.prepare("SELECT COUNT(*) AS n FROM t").get().n;
  db.close();
  return n;
}

function capture() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    log: (m) => lines.log.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
  };
}

// An in-memory stand-in for the bucket: an ordered list of object versions, newest last.
function fakeStore(initial = []) {
  const objects = initial.map((o, i) => ({ generation: String(100 + i), updated: `2026-10-0${i + 1}T00:00:00Z`, ...o }));
  let next = 100 + objects.length;
  const store = {
    objects,
    uploads: [], // every upload attempt: { opts, data }
    statError: null,
    downloadError: null,
    uploadError: null, // thrown once on the next upload
    gate: null, // a promise uploads wait on
    current: () => objects.at(-1),
    // Another instance (or the old revision during a deploy) uploads something.
    externalUpload(data) {
      objects.push({ generation: String(next++), updated: new Date().toISOString(), data });
    },
    async stat() {
      if (store.statError) throw store.statError;
      const cur = objects.at(-1);
      return cur ? { generation: cur.generation, updated: cur.updated } : null;
    },
    async download(generation, destination) {
      if (store.downloadError) throw store.downloadError;
      fs.writeFileSync(destination, objects.find((o) => o.generation === generation).data);
    },
    async listVersions() {
      return [...objects].reverse().map((o) => ({ generation: o.generation, updated: o.updated }));
    },
    async upload(source, opts = {}) {
      store.uploads.push({ opts, data: fs.readFileSync(source) });
      if (store.gate) await store.gate;
      if (store.uploadError) {
        const err = store.uploadError;
        store.uploadError = null;
        throw err;
      }
      const cur = objects.at(-1);
      const currentGeneration = cur ? cur.generation : "0";
      if (opts.ifGenerationMatch !== undefined && String(opts.ifGenerationMatch) !== currentGeneration) {
        const err = new Error("conditionNotMet");
        err.code = 412;
        throw err;
      }
      const generation = String(next++);
      objects.push({ generation, updated: new Date().toISOString(), data: fs.readFileSync(source) });
      return { generation };
    },
  };
  return store;
}

// ---- config and integrity check --------------------------------------------------------

describe("getSnapshotConfig", () => {
  it("is off unless a bucket is named", () => {
    assert.equal(getSnapshotConfig({}), null);
  });
  it("defaults the object name", () => {
    assert.deepEqual(getSnapshotConfig({ FEED_READER_SNAPSHOT_BUCKET: "b" }), { bucket: "b", object: "feed-reader.db" });
  });
  it("accepts a custom object name", () => {
    assert.deepEqual(
      getSnapshotConfig({ FEED_READER_SNAPSHOT_BUCKET: "b", FEED_READER_SNAPSHOT_OBJECT: "x.db" }),
      { bucket: "b", object: "x.db" }
    );
  });
});

describe("databaseProblem", () => {
  it("passes an intact database", () => {
    const file = path.join(tmpDir(), "ok.db");
    makeDbFile(file);
    assert.equal(databaseProblem(file), null);
  });
  it("flags a damaged database", () => {
    const dir = tmpDir();
    const file = path.join(dir, "bad.db");
    fs.writeFileSync(file, corrupt(makeDbFile(path.join(dir, "src.db"))));
    assert.match(databaseProblem(file), /./);
  });
  it("flags an empty file, which SQLite would accept as a valid empty database", () => {
    const file = path.join(tmpDir(), "empty.db");
    fs.writeFileSync(file, "");
    assert.match(databaseProblem(file), /empty/);
  });
  it("flags a valid database that contains no tables", () => {
    const file = path.join(tmpDir(), "notables.db");
    const db = new Database(file);
    db.pragma("user_version = 3"); // writes the header page, but creates no tables
    db.close();
    assert.match(databaseProblem(file), /no tables|empty/);
  });
  it("flags a file that isn't a database, and a missing file", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "junk.db"), "not a database at all, just text".repeat(200));
    assert.match(databaseProblem(path.join(dir, "junk.db")), /./);
    assert.match(databaseProblem(path.join(dir, "missing.db")), /./);
  });
});

// ---- restore at startup ----------------------------------------------------------------

describe("restoreFromSnapshot", () => {
  function setup(versions) {
    const dir = tmpDir();
    const dbPath = path.join(dir, "feed-reader.db");
    return { dir, dbPath, store: fakeStore(versions), log: capture() };
  }

  it("restores the current snapshot when it passes the check", async () => {
    const dir = tmpDir();
    const good = makeDbFile(path.join(dir, "src.db"), 50);
    const s = setup([{ data: good }]);
    const result = await restoreFromSnapshot(s);
    assert.equal(result.knownGeneration, s.store.current().generation);
    assert.equal(result.needsHealing, false);
    assert.equal(countRows(s.dbPath), 50);
    assert.equal(s.log.lines.error.length, 0);
  });

  it("falls back past a damaged newest snapshot, loudly, and plans to heal the bucket", async () => {
    const dir = tmpDir();
    const old = makeDbFile(path.join(dir, "old.db"), 30);
    const newer = corrupt(makeDbFile(path.join(dir, "new.db"), 60));
    const s = setup([{ data: old }, { data: newer }]);
    const result = await restoreFromSnapshot(s);

    assert.equal(countRows(s.dbPath), 30); // the older, intact one
    assert.equal(result.needsHealing, true);
    // The next upload must replace the damaged current object, so that's the generation to match.
    assert.equal(result.knownGeneration, s.store.current().generation);
    assert.equal(result.restoredFrom.generation, "100");
    const errors = s.log.lines.error.join("\n");
    assert.match(errors, /restored from older snapshot: generation 100/);
    assert.match(errors, /NOT restored/);
  });

  it("tries several versions to find an intact one", async () => {
    const dir = tmpDir();
    const good = makeDbFile(path.join(dir, "good.db"), 20);
    const bad = corrupt(makeDbFile(path.join(dir, "bad.db"), 40));
    const s = setup([{ data: good }, { data: bad }, { data: bad }]);
    await restoreFromSnapshot(s);
    assert.equal(countRows(s.dbPath), 20);
  });

  it("refuses to start when no snapshot is intact", async () => {
    const dir = tmpDir();
    const bad = corrupt(makeDbFile(path.join(dir, "bad.db"), 40));
    const s = setup([{ data: bad }, { data: bad }]);
    await assert.rejects(restoreFromSnapshot(s), /No intact snapshot/);
    assert.equal(fs.existsSync(s.dbPath), false); // never leaves a database behind
    assert.equal(fs.existsSync(`${s.dbPath}.restoring`), false);
  });

  it("refuses to start (rejects) when the download fails, instead of starting empty", async () => {
    const dir = tmpDir();
    const s = setup([{ data: makeDbFile(path.join(dir, "g.db"), 10) }]);
    s.store.downloadError = new Error("network unreachable");
    await assert.rejects(restoreFromSnapshot(s), /network unreachable/);
    assert.equal(fs.existsSync(s.dbPath), false);
  });

  it("refuses to start when it can't even look at the bucket (permissions)", async () => {
    const s = setup([]);
    s.store.statError = Object.assign(new Error("403 forbidden"), { code: 403 });
    await assert.rejects(restoreFromSnapshot(s), /403 forbidden/);
    assert.equal(fs.existsSync(s.dbPath), false);
  });

  it("starts empty, and says so loudly, only when the object genuinely doesn't exist", async () => {
    const s = setup([]);
    const result = await restoreFromSnapshot(s);
    assert.equal(result.createdEmpty, true);
    assert.equal(result.knownGeneration, "0"); // the first upload is "only if it doesn't exist"
    assert.match(s.log.lines.error.join("\n"), /EMPTY database/);
    assert.equal(fs.existsSync(s.dbPath), false); // the caller creates it
  });

  it("replaces stale local files, including a leftover WAL", async () => {
    const dir = tmpDir();
    const s = setup([{ data: makeDbFile(path.join(dir, "g.db"), 25) }]);
    fs.writeFileSync(s.dbPath, "stale");
    fs.writeFileSync(`${s.dbPath}-wal`, "stale wal");
    fs.writeFileSync(`${s.dbPath}-shm`, "stale shm");
    await restoreFromSnapshot(s);
    assert.equal(countRows(s.dbPath), 25);
    assert.equal(fs.existsSync(`${s.dbPath}-wal`) && fs.readFileSync(`${s.dbPath}-wal`, "utf8") === "stale wal", false);
  });

  it("restores a snapshot that was saved from a WAL-mode database", async () => {
    const dir = tmpDir();
    const live = new Database(path.join(dir, "live.db"));
    live.pragma("journal_mode = WAL");
    live.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    live.prepare("INSERT INTO t (v) VALUES ('a'), ('b')").run();
    await live.backup(path.join(dir, "snap.db"));
    live.close();
    const s = setup([{ data: fs.readFileSync(path.join(dir, "snap.db")) }]);
    await restoreFromSnapshot(s);
    assert.equal(countRows(s.dbPath), 2);
  });
});

// ---- uploading snapshots ---------------------------------------------------------------

describe("createSnapshotter", () => {
  // A live database plus a store whose current object is that database.
  function setup({ dirtyAtStart = false } = {}) {
    const dir = tmpDir();
    const livePath = path.join(dir, "live.db");
    const initial = makeDbFile(livePath, 10);
    const store = fakeStore([{ data: initial }]);
    const db = new Database(livePath);
    db.pragma("journal_mode = WAL");
    const log = capture();
    const snap = createSnapshotter({
      store,
      db,
      workDir: dir,
      knownGeneration: store.current().generation,
      dirtyAtStart,
      log,
    });
    const write = (n = 1) => {
      for (let i = 0; i < n; i++) db.prepare("INSERT INTO t (v) VALUES (?)").run(`new ${Math.random()}`);
    };
    const rowsIn = (buffer) => {
      const f = path.join(dir, `check-${Math.random()}.db`);
      fs.writeFileSync(f, buffer);
      return countRows(f);
    };
    return { dir, store, db, snap, log, write, rowsIn };
  }

  it("uploads a consistent copy guarded by the current generation, then the new one", async () => {
    const s = setup();
    const firstGen = s.store.current().generation;
    s.write();
    await s.snap.flush();
    assert.equal(s.store.uploads.length, 1);
    assert.equal(s.store.uploads[0].opts.ifGenerationMatch, firstGen);
    assert.equal(s.rowsIn(s.store.uploads[0].data), 11); // a real, intact database with the write
    const secondGen = s.store.current().generation;
    assert.notEqual(secondGen, firstGen);

    s.write();
    await s.snap.flush();
    assert.equal(s.store.uploads[1].opts.ifGenerationMatch, secondGen); // tracked the new generation
  });

  it("uploads nothing when nothing changed", async () => {
    const s = setup();
    await s.snap.flush();
    await s.snap.flush();
    assert.equal(s.store.uploads.length, 0);
  });

  it("notices writes made outside any request (background work)", async () => {
    const s = setup();
    s.db.prepare("UPDATE t SET v = 'changed' WHERE id = 1").run();
    await s.snap.flush();
    assert.equal(s.store.uploads.length, 1);
  });

  it("uploads even with no changes when the database was just restored or migrated", async () => {
    const s = setup({ dirtyAtStart: true });
    await s.snap.flush();
    assert.equal(s.store.uploads.length, 1);
  });

  it("on a generation conflict during a normal flush, overwrites (the live instance wins) and warns", async () => {
    const s = setup();
    s.store.externalUpload(Buffer.from("something an older instance wrote"));
    s.write();
    await s.snap.flush();

    assert.equal(s.store.uploads.length, 2);
    assert.notEqual(s.store.uploads[0].opts.ifGenerationMatch, undefined); // tried with the guard first
    assert.deepEqual(s.store.uploads[1].opts, {}); // then unconditionally
    assert.equal(s.rowsIn(s.store.current().data), 11); // ours is now the current object
    assert.match(s.log.lines.warn.join("\n"), /live instance wins/);

    s.write();
    await s.snap.flush(); // and it tracked the new generation (no second conflict)
    assert.equal(s.store.uploads.at(-1).opts.ifGenerationMatch, s.store.objects.at(-2).generation);
  });

  it("on a generation conflict at shutdown, drops its snapshot instead of overwriting", async () => {
    const s = setup();
    const theirs = Buffer.from("newer data from another instance");
    s.store.externalUpload(theirs);
    s.write();
    const result = await s.snap.shutdownFlush();

    assert.equal(result.dropped, true);
    assert.equal(s.store.uploads.length, 1); // no retry
    assert.deepEqual(s.store.current().data, theirs); // the other instance's data is untouched
    assert.match(s.log.lines.warn.join("\n"), /Dropped the shutdown snapshot/);
  });

  it("combines overlapping flushes: one running, one queued for everyone else", async () => {
    const s = setup();
    let release;
    s.store.gate = new Promise((resolve) => {
      release = resolve;
    });

    s.write();
    const p1 = s.snap.flush(); // starts the first upload (held at the gate)
    await new Promise((r) => setTimeout(r, 20));
    s.write();
    const p2 = s.snap.flush();
    s.write();
    const p3 = s.snap.flush();
    assert.equal(p2, p3, "later callers share one queued follow-up");
    assert.equal(s.store.uploads.length, 1, "never two uploads at once");

    s.store.gate = null;
    release();
    await Promise.all([p1, p2, p3]);
    assert.equal(s.store.uploads.length, 2);
    assert.equal(s.rowsIn(s.store.current().data), 13); // the follow-up includes all three writes
  });

  it("a failed upload rejects, isn't counted as done, and the next flush retries", async () => {
    const s = setup();
    s.write();
    s.store.uploadError = new Error("storage unavailable");
    await assert.rejects(s.snap.flush(), /storage unavailable/);
    await s.snap.flush(); // still dirty, so it uploads now
    assert.equal(s.store.uploads.length, 2);
    assert.equal(s.rowsIn(s.store.current().data), 11);
  });

  it("shutdownFlush uploads pending changes, and gives up on a hung upload", async () => {
    const s = setup();
    s.write();
    assert.equal((await s.snap.shutdownFlush()).uploaded, true);

    const hung = setup();
    hung.write();
    hung.store.gate = new Promise(() => {}); // never resolves
    const result = await hung.snap.shutdownFlush({ timeoutMs: 50 });
    assert.equal(result.timedOut, true);
    assert.match(hung.log.lines.error.join("\n"), /didn't finish in time/);
  });
});

// ---- holding write responses until the snapshot is up ----------------------------------

describe("snapshotAfterWrites", () => {
  let server;
  let port;
  const state = { flushes: 0, release: null, fail: false, log: capture() };

  before(async () => {
    const snapshotter = {
      flush() {
        state.flushes++;
        if (state.fail) return Promise.reject(new Error("bucket down"));
        return new Promise((resolve) => {
          state.release = resolve;
        });
      },
    };
    const app = express();
    app.use(snapshotAfterWrites(snapshotter, { log: state.log }));
    app.get("/read", (req, res) => res.json({ ok: true }));
    app.post("/write", (req, res) => res.json({ saved: true }));
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    port = server.address().port;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  function request(method, pathname) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: pathname, method }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("doesn't snapshot on reads", async () => {
    state.flushes = 0;
    const res = await request("GET", "/read");
    assert.equal(res.status, 200);
    assert.equal(state.flushes, 0);
  });

  it("holds a write's response until the snapshot is uploaded", async () => {
    state.flushes = 0;
    state.fail = false;
    let finished = false;
    const pending = request("POST", "/write").then((r) => {
      finished = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(state.flushes, 1);
    assert.equal(finished, false, "the response must wait for the upload");
    state.release();
    const res = await pending;
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { saved: true });
  });

  it("still answers a write if the upload fails, and logs it as an error", async () => {
    state.fail = true;
    const res = await request("POST", "/write");
    assert.equal(res.status, 200);
    assert.match(state.log.lines.error.join("\n"), /Upload failed after POST \/write.*bucket down/);
  });
});

// ---- the Google Cloud Storage adapter --------------------------------------------------

describe("createGcsStore", () => {
  function fakeStorage({ files = [], metadata = {}, metadataError = null, bucketExists = true } = {}) {
    const calls = { file: [], upload: [], download: [], getFiles: [] };
    const bucket = {
      async exists() {
        return [bucketExists];
      },
      file(name, opts) {
        calls.file.push({ name, opts });
        return {
          async getMetadata() {
            if (metadataError) throw metadataError;
            return [metadata];
          },
          async download(o) {
            calls.download.push(o);
          },
        };
      },
      async getFiles(opts) {
        calls.getFiles.push(opts);
        return [files];
      },
      async upload(source, opts) {
        calls.upload.push({ source, opts });
        return [{ metadata: { generation: 777 } }];
      },
    };
    return { storage: { bucket: (name) => (calls.bucketName = name, bucket) }, calls };
  }

  it("stat returns the generation as a string, or null when the object doesn't exist", async () => {
    const found = fakeStorage({ metadata: { generation: 12345, updated: "t" } });
    const store = await createGcsStore({ bucket: "b", object: "o.db", storage: found.storage });
    assert.deepEqual(await store.stat(), { generation: "12345", updated: "t" });
    assert.equal(found.calls.bucketName, "b");

    const missing = fakeStorage({ metadataError: Object.assign(new Error("nope"), { code: 404 }) });
    assert.equal(await (await createGcsStore({ bucket: "b", storage: missing.storage })).stat(), null);
  });

  it("stat refuses (throws) when the 404 is really a missing bucket, so a typo can't start the server empty", async () => {
    const wrongBucket = fakeStorage({
      metadataError: Object.assign(new Error("not found"), { code: 404 }),
      bucketExists: false,
    });
    const store = await createGcsStore({ bucket: "typo-bucket", storage: wrongBucket.storage });
    await assert.rejects(store.stat(), /bucket "typo-bucket" doesn't exist/);
  });

  it("stat rethrows anything other than not-found", async () => {
    const denied = fakeStorage({ metadataError: Object.assign(new Error("forbidden"), { code: 403 }) });
    const store = await createGcsStore({ bucket: "b", storage: denied.storage });
    await assert.rejects(store.stat(), /forbidden/);
  });

  it("downloads a specific generation", async () => {
    const f = fakeStorage();
    const store = await createGcsStore({ bucket: "b", object: "o.db", storage: f.storage });
    await store.download("1791385009950334", "/tmp/x");
    assert.deepEqual(f.calls.file.at(-1), { name: "o.db", opts: { generation: 1791385009950334 } });
    assert.deepEqual(f.calls.download.at(-1), { destination: "/tmp/x" });
  });

  it("lists versions of just this object, newest first", async () => {
    const f = fakeStorage({
      files: [
        { name: "o.db", metadata: { generation: 1791139936949464, updated: "a" } },
        { name: "o.db-journal", metadata: { generation: 1791999999999999, updated: "journal" } },
        { name: "o.db", metadata: { generation: 1791385009950334, updated: "c" } },
        { name: "o.db", metadata: { generation: 1791370903356703, updated: "b" } },
      ],
    });
    const store = await createGcsStore({ bucket: "b", object: "o.db", storage: f.storage });
    assert.deepEqual(await store.listVersions(), [
      { generation: "1791385009950334", updated: "c" },
      { generation: "1791370903356703", updated: "b" },
      { generation: "1791139936949464", updated: "a" },
    ]);
    assert.deepEqual(f.calls.getFiles.at(-1), { versions: true, prefix: "o.db" });
  });

  it("uploads with a generation precondition when asked, unconditionally otherwise", async () => {
    const f = fakeStorage();
    const store = await createGcsStore({ bucket: "b", object: "o.db", storage: f.storage });
    assert.deepEqual(await store.upload("/tmp/s", { ifGenerationMatch: "42" }), { generation: "777" });
    assert.deepEqual(f.calls.upload.at(-1).opts, {
      destination: "o.db",
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 42 },
    });
    await store.upload("/tmp/s", {});
    assert.deepEqual(f.calls.upload.at(-1).opts, { destination: "o.db", resumable: false });
    await store.upload("/tmp/s", { ifGenerationMatch: "0" }); // "only if it doesn't exist"
    assert.equal(f.calls.upload.at(-1).opts.preconditionOpts.ifGenerationMatch, 0);
  });
});
