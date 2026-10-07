# Plan: make the hosted database robust

Written 2026-10-07 for the session implementing the fix. It records the decision, the
reasoning, and the work. Once the work ships, the lasting "why" belongs in `docs/SPEC.md`
and `docs/DEPLOY.md` (section 6). Delete this file in the final commit; git history keeps it.

## 1. What happened

On 2026-10-07, from about 11:00 UTC, the Cloud Run service (`feed-reader`, project
`project-fec8cd8c-9d55-4df8-822`, region `us-west1`) failed every request that touched the
database: `SqliteError: database disk image is malformed`. `/api/articles` returned 500,
`/api/refresh` returned 503, and the client showed its catch-all "Couldn't reach the server.
Make sure it's running", which was misleading. There was an earlier warning: one "malformed"
error on 2026-10-05 13:19 UTC (revision `feed-reader-00003`), plus intermittent 503/504s on
`/api/refresh` on Oct 4, 5 and 6.

**The data has not been recovered yet.** The live service is still down. Recovery is the
first piece of work (section 4.0) and comes before any code change.

## 2. Root cause

SQLite was running directly on a Cloud Storage FUSE mount (`/data`), in `DELETE` journal
mode. Cloud Storage can't change part of an object, only replace the whole thing, so every
SQLite commit re-uploads the entire file. That produced 839 object versions in a few days,
in bursts of dozens per second. There's no real file locking, and WAL mode is impossible on
FUSE, since it needs shared memory. The corruption is consistent with two ways of breaking:

- **Two writers.** During a deploy, Cloud Run runs the old and new revisions side by side
  while traffic switches. The old one keeps finishing in-flight requests, which can be a
  refresh of up to 300 s. `--max-instances=1` applies to each revision separately, so it
  doesn't prevent this. Two processes writing one SQLite file with no locking is a classic
  way to corrupt it.
- **Interrupted writes.** A commit that's cut off (a request timeout, an instance shutting
  down) can leave the uploaded object half-written.

High write volume made both more likely: each page load on each device (phone and laptop)
refreshes every feed, and refreshes run every 15 minutes while a tab is visible.

Not the cause: the browser, IAP or the network. Having two devices open does **not** create
two servers. They're just clients of the one process, which handles requests one at a time.
They only add write volume.

## 3. Decision

**Keep SQLite, but run it on the container's local disk, and use the bucket only for whole,
consistent snapshots uploaded through the Cloud Storage API (not FUSE).**

Why this design, given what the service is (one user, about 2 MB of data, scale-to-zero,
IAP in front):

- SQLite on a local disk works as designed, including WAL mode.
- Uploading a Cloud Storage object either fully succeeds or doesn't happen. The bucket can
  never hold a half-written file.
- With two instances during a deploy overlap, each has its own private copy. The worst case
  is losing one instance's last few seconds of changes, never a corrupted file.
- It keeps scale-to-zero and costs nothing extra.
- Most of the change is one new module; the business logic doesn't change.

Alternatives considered:

| Option | Why not now |
|---|---|
| Keep the FUSE mount and tune it | The failure modes come from SQLite-over-FUSE itself; no setting makes concurrent or interrupted whole-file rewrites safe. |
| More instances | Makes it worse: more processes writing the same file with no coordination. SQLite wants one writer. |
| Litestream | Ships only the changes (good for large databases) and gives point-in-time history. But it's a second process in the container, and between requests Cloud Run throttles the CPU almost to zero, so it would mostly rely on a final flush at shutdown anyway. No real advantage at 2 MB. This is the **next step** if the database grows (section 7). |
| Firestore or Cloud SQL | Removes this whole class of problems, but means rewriting the data layer, plus a monthly cost for Cloud SQL. Right only for multiple users or instances (section 7). |
| A VM with a persistent disk | SQLite just works, but IAP on a VM needs a load balancer, which costs far more than the app. |

## 4. Implementation

### 4.0 Recover the data (first, before any code change)

The bucket is `feed-reader-data-project-fec8cd8c`, and it has versioning on (839 versions
of `feed-reader.db` as of 2026-10-07). The last write was at 11:01:43 UTC on Oct 7. The
service is currently mounting the bucket over FUSE, the very setup that broke it.

1. **Get the user's permission before downloading anything.** The versions hold their
   private feed data: subscriptions, read and saved state. Download to the session's
   scratchpad, never into the repo. (An earlier session's permission checks denied reading
   the production database without explicit approval.)
2. **Ask the user to close the app on every device** (phone and laptop), so nothing writes
   to the bucket during recovery.
3. List the versions with their generation numbers and timestamps:
   `gcloud storage ls -a -l gs://feed-reader-data-project-fec8cd8c/feed-reader.db --project=project-fec8cd8c-9d55-4df8-822`.
   Download the newest 10–20, plus the current broken one.
4. Run `sqlite3 <file> 'PRAGMA integrity_check'` on each. The newest one that returns `ok`
   is the restore candidate.
5. Try salvaging the broken current version:
   `sqlite3 broken.db '.recover' | sqlite3 salvaged.db`, then integrity-check the result.
   Compare it with the candidate: row counts for categories, feeds and articles,
   `MAX(readAt)`, and saved articles. Say what the salvage gains and whether it looks
   complete.
6. **Ask the user before restoring**, showing the options (candidate version vs. salvage),
   the timestamp of each, and roughly what each would lose. Restore by copying the chosen
   generation over the live object, for example
   `gcloud storage cp 'gs://…/feed-reader.db#<generation>' gs://…/feed-reader.db`. To
   restore the salvage, upload that file instead. The broken version stays in the bucket's
   history, so this can be undone.
7. Start a fresh instance so nothing serves a stale copy of the file (for example
   `gcloud run services update feed-reader --region=us-west1 --project=project-fec8cd8c-9d55-4df8-822 --update-env-vars=RESTORED_AT=<date>`;
   changing an env var always creates a new revision). Then confirm with the user that the app loads and their
   feeds and saved articles are there.
8. **Last resort,** if no version or salvage works: the local database on the user's Mac
   (`~/Library/Application Support/Feed Reader/feed-reader.db`). It's a separate copy, not
   kept in sync; its subscriptions date from about Oct 5. Check what it holds first.
   Ask before uploading it.
9. Write down which version was restored and what was lost, for DEPLOY.md's incident note
   (section 6).

**Until 4.1 ships, the restored database is still on the fragile FUSE setup.** Tell the user
to use the app lightly, on one device at a time, and **not to deploy** until the new storage
code is ready. A deploy overlap is the most likely way to corrupt it again.

Then make a new branch off `master` for the code changes. Local behavior must not change:
everything below switches on only when the snapshot bucket env var is set.

### 4.1 Snapshot module (`server/src/snapshot.js`, new)

Settings (env vars, documented in DEPLOY.md's table):
- `FEED_READER_SNAPSHOT_BUCKET`: the bucket name. If unset, snapshots are off (local use).
- `FEED_READER_SNAPSHOT_OBJECT`: defaults to `feed-reader.db`, the object name already in
  the bucket, so the restored healthy version becomes the first snapshot.

**Cloud Storage client.** Recommended: `@google-cloud/storage`. It handles credentials from
Cloud Run's metadata server, retries, and generation preconditions. The alternative is plain
`fetch` against the JSON API, using a token from the metadata server: no dependency, but
retries and auth to maintain by hand. The project keeps dependencies minimal, so record the
choice and its reason in SPEC.md. The "no third-party services" principle isn't affected,
because this is the same Google Cloud project that already hosts the app.

**Restore at startup.** It has to run *before* `db.js` opens the database. `db.js` opens it
when the module is imported, so restore with a top-level `await` before that import (in
`db.js` itself, or by importing `db.js` dynamically from `index.js` after the restore). The
server must not call `listen` until the restore finishes, so Cloud Run's startup probe keeps
traffic away until then.
1. Download the current generation of the object to a temp file in `DATA_DIR`, and remember
   its generation number (`knownGeneration`).
2. Open the temp file and run `PRAGMA quick_check`. If it passes, move it into place as
   `feed-reader.db`, delete any stale `-wal`/`-shm` files, then continue to open it normally.
3. If it fails, list the object's older versions (versioning is on), newest first, and try
   each one, up to about 20. Use the first that passes. Log it at **ERROR** level, with the
   generation number and timestamp of what was restored, and say that newer data was skipped.
   It must never be silent, because falling back hides data loss. (An email alert on these
   lines is a future enhancement; see section 6.)
4. **If the object doesn't exist** (a brand-new deployment), start with an empty database
   and log it loudly.
5. **On any other error** (network, permissions, every version failing the check), **exit
   with a non-zero code. Never start with an empty database.** An empty database would be
   uploaded over the real one at the first write. Versioning would make that recoverable,
   but it's the worst way this design can fail, and refusing to start rules it out.

**Uploading snapshots.**
- Make a consistent copy with `better-sqlite3`'s `db.backup(tempPath)`, an online backup
  that's safe while the database is in use. Upload that file, never the live database.
- Upload with the precondition `ifGenerationMatch: knownGeneration`, then store the new
  generation number.
- **Conflict policy: the live instance wins.**
  - A normal flush rejected by the precondition (status 412) means an older instance just
    uploaded during a deploy overlap. Upload again with no precondition, log a WARNING, and
    update `knownGeneration`.
  - The shutdown flush (SIGTERM, below) means *this* instance is the one going away. If its
    upload gets a 412, a newer instance has already written, so drop the upload and log a
    WARNING.

  The cost is that the old instance's changes from the overlap window are lost, which for
  one user is a few seconds of read and saved marks at most. The precondition makes that
  visible in the logs instead of silent. Preventing the loss entirely would need a lease or
  lock that makes the new instance wait for the old one, which isn't worth the complexity
  at this scale.
- **Combine overlapping flushes.** If an upload is already running, later requests wait for
  the next one; only one more is queued, which covers all of them. Never run two uploads at
  once.
- **Detect writes** with `SELECT total_changes()` on the shared connection. Comparing it
  with its value at the last snapshot catches background writes too (the `og:image`
  fetcher, the retention purge). Skip the upload when nothing changed.

**When to flush.** With request-based billing, Cloud Run throttles the CPU almost to zero
once a response is sent, so a timer or `res.on('finish')` hook may not run until much later.
So:
- **Every request that writes waits for a snapshot that includes it before replying.**
  These are the `POST`, `PATCH` and `DELETE` routes, including `POST /api/refresh` and
  OPML import. Put this in one place, such as a middleware or route wrapper, not in each
  route. As a result, once the client sees success, the change is safely in the bucket.
  Expect roughly 100–300 ms more per write; measure it. If marking an article read feels
  slow on the phone, the fallback is instance-based billing (`--no-cpu-throttling`) with a
  short delayed flush. That costs a little more and would need recording in DEPLOY.md.
- **On SIGTERM**, which Cloud Run sends about 10 s before shutting an instance down: stop
  accepting connections (`server.close()`), do one last flush with the precondition, then
  exit. Don't wait for a long refresh still in progress; anything it has committed is
  already in the backup, and refresh is idempotent. Background writes made after the last
  request reach the bucket here.

**Turn WAL back on in the hosted setup.** Remove `SQLITE_JOURNAL_MODE=DELETE` from the
deploy command. Keep the override in `db.js` because it's harmless, but update its comment.

### 4.2 Fewer writes (`server/src/routes/refresh.js`, `web/src/App.jsx`)

- **Only one refresh at a time:** if a refresh-all is already running, a second
  `POST /api/refresh` waits for it and returns its result instead of starting another.
- **Skip recent refreshes:** if a refresh-all finished less than about 5 minutes ago, return
  that result without fetching. Track this in memory; resetting on a cold start is what we
  want. A `force` flag skips the check. The client sets it **only** for the Refresh button
  click, not for the page-load call or the 15-minute timer. That way phone and laptop page
  loads don't each trigger a full refresh, but the button always fetches.
- The single-feed refresh (`POST /api/feeds/:id/refresh`) is unchanged.

### 4.3 Accurate error message (`web/src/data/db.js`, `web/src/App.jsx`)

`request()` loses the status code, and `reloadAll`'s catch-all shows "Couldn't reach the
server" for everything. Attach `status` to the thrown error. A `fetch` that rejects (a
network failure) is the only case that should keep the "couldn't reach the server" text. For
a 5xx, say something like "The server hit an error loading your feeds (500). Try Refresh; if
it keeps happening, check the server logs." Apply the same distinction to the OPML-import
message at `App.jsx` around line 362.

### 4.4 Tests

- `server/test/snapshot.test.js` (new), with the Cloud Storage client mocked behind a small
  interface:
  - restoring the newest version that passes the check, and falling back past a corrupt one
    (build one by truncating or overwriting bytes of a real database file);
  - refusing to start on a download error;
  - starting empty, with a log message, when the object doesn't exist;
  - a 412 on a normal flush leading to an unconditional retry;
  - a 412 on the shutdown flush leading to a dropped upload;
  - overlapping flushes combined into one queued upload;
  - no upload when nothing changed.
- Refresh throttling: a second call while one is running shares it, a recent result is
  reused, and `force` skips the check.
- Playwright: a 500 from `/api/articles` shows the server-error message, not "couldn't reach
  the server". Use route interception.
- Update the case counts in SPEC.md's Testing section.

### 4.5 Infrastructure (record the exact commands in DEPLOY.md)

- **Deploy:** remove the Cloud Storage volume and its mount. Add
  `FEED_READER_SNAPSHOT_BUCKET`, and drop `SQLITE_JOURNAL_MODE=DELETE`. Keep
  `FEED_READER_DATA_DIR=/data` (now a plain local folder) and `--max-instances=1`. The local
  disk is memory-backed, so the database counts against the instance's memory limit (default
  512 MiB). Note that in DEPLOY.md. The service account keeps
  `roles/storage.objectUser`, which also covers listing versions; verify that.
- **Switch-over deploy:** close the app on every device (phone and laptop) first, so the old
  revision isn't writing through FUSE while the new one downloads its first snapshot.
- **Bucket lifecycle:** delete old versions once they're more than 30 days old **and** at
  least 50 newer versions exist (both conditions in one rule). **Apply this only after
  recovery is completely finished**, including any salvage from the corrupted file, because
  it deletes the history that recovery relies on.

## 5. New risks this design introduces (record these in DEPLOY.md's Limits)

- The local disk uses memory: fine at 2 MB; watch for this if the database grows (section 7).
- Writes take an upload's worth of extra time (4.1).
- A deploy overlap can lose the outgoing instance's last few seconds of writes (4.1). It's
  logged and never silent.
- A crash without SIGTERM (an out-of-memory kill) loses only background writes since the
  last request; every acknowledged write is already uploaded.
- Falling back to an older snapshot loses data newer than it. That's why it must be logged at ERROR level.
- The restore and fallback code rarely runs in production, so its tests matter more than
  usual.

## 6. Documentation to update

Future sessions should be able to tell from the docs alone *what* the setup is and *why*.
The established place for "why" is SPEC.md's **Design decisions worth knowing**: concise
bullets with the reason and the alternatives rejected. DEPLOY.md holds the operational
detail. Update:

**`docs/DEPLOY.md`**
- The intro line ("SQLite on a mounted GCS bucket") becomes "SQLite on local disk, with
  snapshots in a Cloud Storage bucket".
- Env var table: add `FEED_READER_SNAPSHOT_BUCKET` and `FEED_READER_SNAPSHOT_OBJECT`; remove
  the `SQLITE_JOURNAL_MODE=DELETE` row, or mark it legacy; update `FEED_READER_DATA_DIR`'s
  description (a local folder, not a mount).
- The deploy command in Steps: no volume flags, with the new env vars.
- A new **Data durability** section: how restore, flush, the conflict policy and shutdown
  work, and the risks from section 5.
- A new **Recovery runbook**: list versions (`gcloud storage ls -a gs://$BUCKET/feed-reader.db`),
  download one, run `sqlite3 file 'PRAGMA integrity_check'`, restore it by copying that
  version over the live object, and redeploy (or wait for a cold start) so it's picked up.
  Mention `.recover` for salvaging data from a corrupt file.
- **Incident note:** two or three lines on the Oct 2026 corruption and its cause, as the
  reason this section exists.
- Limits: replace the FUSE line ("If the FUSE-backed database proves flaky…") with the
  section 5 risks. Explain that `max-instances=1` still matters (one writer), and say it
  doesn't cover deploy overlaps.
- The lifecycle rule, with its command.

**`docs/SPEC.md`**
- Architecture: the persistence bullet mentions the snapshot module only in the hosted
  setup.
- Data Directory → **Journal mode** paragraph: WAL everywhere now. The reason
  `DELETE` existed (FUSE) is gone, along with the FUSE mount.
- Auto-refresh: the 5-minute skip and the single running refresh, the `force` flag, and why
  (to cut writes; multiple devices each refresh on page load).
- Design decisions → **Deployment**: replace the "SQLite on a mounted bucket" bullet with
  the new design. Include the *why* (whole-object uploads can't be half-written; each
  instance has its own copy; it keeps scale-to-zero), the *incident* that forced it, and the
  *rejected alternatives* with one reason each (section 3's table). Add the "live instance
  wins" conflict policy and the refuse-to-start-empty rule as their own decisions, because
  they are the parts most likely to be "simplified" away by mistake. Note the Cloud Storage
  client dependency choice.
- Future enhancements: add **Email alerts for hosted errors**. A Cloud Monitoring alert
  policy emails the user when the service logs `severity>=ERROR` lines containing
  "malformed" or "restored from older snapshot", or returns 5xx on `/api/*`. Why: the Oct 5
  "malformed" error gave two days' warning, but nobody was watching the logs, so the first
  sign was the app failing. Setup is an email notification channel, a log-match condition
  and an alert policy, free at this volume. The user liked the idea but deferred it.
- Design decisions → **Behavior and UI**: why server errors and network failures now show
  different messages.
- Known gaps → **Larger** → the Hosted deployment line: update the storage description.
- Testing: the new test files and updated counts.

**`README.md`** (around line 102): "SQLite database on a mounted Cloud Storage bucket"
becomes "local SQLite with snapshots to a Cloud Storage bucket".

**Code comments:** `db.js`'s journal-mode comment; a header comment in `snapshot.js` that
explains the design in brief and points to DEPLOY.md's Data durability section.

## 7. Growth path (for reference; nothing to build now)

1. **Now:** local SQLite plus whole-file snapshots. Good up to a few tens of MB and one user.
2. **When the database reaches roughly 50–100 MB** (slow cold starts, upload delay
   noticeable on writes, memory pressure): switch the snapshot module to **Litestream**,
   which ships only WAL changes and gives point-in-time restore. Same single instance.
3. **Multiple users or instances:** this needs accounts and per-user data, which is a
   redesign anyway. Move to a managed database: **Cloud SQL Postgres** fits the relational
   schema, and **Firestore** is cheaper at low use. Lift the one-instance limit, and move
   feed refreshing to a scheduled server-side job (for example Cloud Scheduler calling a
   refresh endpoint) instead of refreshing on page load.

Scaling SQLite further than step 2 isn't worth it, because going past one user requires a
database change regardless.

## 8. Order of work

1. Recover the data (4.0). Don't touch code until the user confirms the app works again.
2. Make a new branch off `master`. Do 4.3 (error message) and 4.2 (fewer writes): they're
   small and independently useful.
3. 4.1 snapshot module, with 4.4 tests. Run it locally against a scratch bucket with the
   env var set: restore, write, check the new generation, simulate a 412, send SIGTERM.
4. Deploy (4.5) with every device's app closed, then confirm the app loads, a mark-read
   creates a new object generation, and the logs are clean.
5. Add the lifecycle rule, but only after recovery is completely finished.
6. Update the docs (section 6) and delete this file.

**Ask the user:** permission before downloading the database versions and before
restoring (4.0); and whether
the extra time on writes is acceptable once measured (otherwise, instance-based billing).
