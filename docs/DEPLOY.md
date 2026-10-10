# Deploying to Google Cloud Run

Cloud Run **service** (container), single instance, SQLite on the container's local disk
with snapshots in a Cloud Storage bucket, access gated by Identity-Aware Proxy (IAP). The app has no login of its own, so never
deploy it without IAP (or `--no-allow-unauthenticated` at minimum).

## Environment variables

| Var | Cloud Run value | Why |
|---|---|---|
| `HOST` | `0.0.0.0` (set in Dockerfile) | Cloud Run's proxy must reach the container. Default is `127.0.0.1`. |
| `PORT` | set by Cloud Run | |
| `FEED_READER_DATA_DIR` | `/data` (set in Dockerfile) | Where the working copy of `feed-reader.db` lives. A plain local folder in the container, **not** a mount. |
| `FEED_READER_SNAPSHOT_BUCKET` | the bucket name | Turns on snapshots: the database is restored from this bucket at startup and uploaded to it after every write. Unset means local use, with none of this active. |
| `FEED_READER_SNAPSHOT_OBJECT` | `feed-reader.db` (default) | The object name inside the bucket. |
| `SQLITE_JOURNAL_MODE` | unset (WAL) | Don't set it on Cloud Run. It used to be `DELETE`, a workaround for the old mounted bucket that no longer exists. |
| `ALLOWED_HOSTS` | the service's `run.app` hostnames, comma-separated | The loopback Host guard otherwise 403s every `*.run.app` request. `*` also works, and is needed for the first deploy before the URLs exist, but is safe only because IAP authenticates every request. The live service lists its two hostnames. |

## Steps

Set `PROJECT`, `REGION`, and `BUCKET` first. Verify flags against the current Cloud Run
docs, especially `--iap`.

```bash
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com iap.googleapis.com storage.googleapis.com

# Snapshot bucket. Versioning is required: it is what recovery relies on (see below).
gcloud storage buckets create gs://$BUCKET --location=$REGION
gcloud storage buckets update gs://$BUCKET --versioning

# Clean up old versions, but never leave fewer than 50 newer ones: delete a version only
# when it stopped being current more than 30 days ago AND at least 50 newer versions exist.
# (Both conditions in one rule. Don't apply this until any recovery work is finished: it
# deletes the history recovery relies on.)
cat > lifecycle.json <<'JSON'
{ "rule": [ { "action": { "type": "Delete" },
              "condition": { "isLive": false, "daysSinceNoncurrentTime": 30, "numNewerVersions": 50 } } ] }
JSON
gcloud storage buckets update gs://$BUCKET --lifecycle-file=lifecycle.json

# Runtime identity with access to the bucket only
gcloud iam service-accounts create feed-reader-run
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member=serviceAccount:feed-reader-run@$PROJECT.iam.gserviceaccount.com \
  --role=roles/storage.objectUser

# Build from source and deploy
gcloud run deploy feed-reader --source . --region=$REGION \
  --service-account=feed-reader-run@$PROJECT.iam.gserviceaccount.com \
  --no-allow-unauthenticated --iap \
  --max-instances=1 --min-instances=0 --timeout=300 \
  --set-env-vars=FEED_READER_SNAPSHOT_BUCKET=$BUCKET,ALLOWED_HOSTS=*

# Then tighten ALLOWED_HOSTS to the service's actual hostnames (the ^@^ sets a
# different list separator, since the value itself contains commas)
URLS=$(gcloud run services describe feed-reader --region=$REGION \
  --format='value(metadata.annotations."run.googleapis.com/urls")' | tr -d '[]" ' | sed 's#https://##g')
gcloud run services update feed-reader --region=$REGION \
  --update-env-vars=^@^ALLOWED_HOSTS=$URLS

# Let yourself through IAP
gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=feed-reader \
  --region=$REGION --member=user:YOU@example.com --role=roles/iap.httpsResourceAccessor
```

## Data durability

The database is SQLite, kept on the container's local disk. The bucket holds **whole,
consistent snapshots** of it, uploaded through the Cloud Storage API (never a mounted
filesystem). An upload either fully happens or doesn't, so the bucket can't hold a
half-written file. The design and the reasoning behind it are in `adr/2026-10-06-feed-reader-spec.md` ("Hosted
durability"); this is how it behaves in operation.

- **Startup.** The server downloads the bucket's current object and runs SQLite's full
  `integrity_check` on it before it opens the database, and doesn't listen until that's done
  (so Cloud Run keeps traffic away). Log line: `[snapshot] Restored database from snapshot
  generation N`. If the newest object fails the check, it tries older versions, newest first
  (up to 20), uses the first intact one, and logs at **ERROR** `restored from older snapshot:
  generation N` with what was skipped. Then it replaces the damaged object right away. If
  nothing is intact, if it can't reach the bucket, or if the bucket name is wrong, it **exits
  instead of starting**. It starts with an empty database only when the bucket exists but has no
  `feed-reader.db` object (a brand-new deployment), and says so loudly.
- **Every write** (any `POST`, `PATCH`, `DELETE`) waits until a snapshot containing it is
  uploaded before the response goes out. Cloud Run throttles the CPU after a response is sent,
  so a background timer can't be relied on. Reads upload nothing. If an upload fails, the
  request still succeeds (the change is applied locally), the failure is logged at ERROR, and
  the next write retries.
- **Two instances.** During a deploy Cloud Run runs the old and new revisions side by side for a
  short time, and `--max-instances=1` doesn't prevent that (it limits each revision, not both).
  Each instance has its own private copy, so nothing corrupts. Each upload is guarded by the
  object's generation number: if another instance wrote since, the live instance's normal upload
  overwrites it (log: `Another instance uploaded a newer snapshot ... the live instance wins`),
  while the outgoing instance's final upload at shutdown is dropped. The cost is that the
  outgoing instance's last few seconds of changes can be lost, and that is always logged.
- **Shutdown.** On SIGTERM (about 10 s before Cloud Run stops an instance) it takes one last
  snapshot, bounded to 8 s, and exits. Log line: `SIGTERM received: taking a final snapshot`.

Measured: a write takes about 140 ms longer than it would without snapshots, a cold start restores
in about a second, and a refresh of 17 feeds took 1.7 s.

**Incident note (Oct 2026).** The first hosted version ran SQLite directly on a mounted Cloud
Storage bucket. On Oct 7 the database was corrupted and the app showed "couldn't reach the
server" while the server was actually up and returning errors. The articles table had 254
duplicated ids and its last page was damaged. Cause (likely, not proven): every SQLite commit
re-uploaded the whole file with no real locking, so an interrupted write (refreshes were hitting the
300 s timeout mid-write) or an old and a new revision writing during a deploy broke it. That is why
the design above exists, and why this section and the runbook below do.

## Recovery runbook

Use this if the app shows server errors (the error banner says "The server hit an error…") or the
logs show `malformed`, `restored from older snapshot`, or `Refusing to start`. Always **close the app
on every device first**, so nothing writes while you work.

```bash
# What's wrong? Recent errors and the startup lines:
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="feed-reader" AND (severity>=WARNING OR textPayload:"snapshot")' \
  --project=$PROJECT --freshness=3h --order=asc --limit=30 --format='value(timestamp,severity,textPayload)'

# List the saved versions (each has a generation number; the live one has no #):
gcloud storage ls -l -a gs://$BUCKET/feed-reader.db

# Download the current version and a few older ones into a private folder, then check each.
# A healthy file prints only "ok":
gcloud storage cp "gs://$BUCKET/feed-reader.db#GENERATION" ./g-GENERATION.db
sqlite3 g-GENERATION.db "PRAGMA integrity_check;"
```

Reading the result:
- **Only `ok`**: that version is healthy; restore it (below).
- **`wrong # of entries in index …` / `row N missing from index …`** (and nothing about `Tree N
  page M`): the table data is intact but an index is out of step. `REINDEX` alone may fail with
  `UNIQUE constraint failed: articles.id`, which means duplicate article rows. Check with
  `select count(*) from (select id from articles NOT INDEXED group by id having count(*)>1);` and, if
  there are duplicates, rebuild the table once with the duplicates merged (keep any read/saved flag
  and the earliest readAt), then recreate the indexes and re-check:
  ```sql
  PRAGMA foreign_keys=OFF; BEGIN;
  CREATE TABLE articles_new ( id TEXT PRIMARY KEY, feedId INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    title TEXT NOT NULL, link TEXT, isoDate TEXT, insertedAt TEXT NOT NULL, contentSnippet TEXT, imageUrl TEXT,
    read INTEGER NOT NULL DEFAULT 0, readAt TEXT, saved INTEGER NOT NULL DEFAULT 0, unsavedAt TEXT, ogImageChecked TEXT);
  INSERT INTO articles_new
  SELECT a.id, a.feedId, a.title, a.link, a.isoDate, a.insertedAt, a.contentSnippet,
         COALESCE(a.imageUrl,(SELECT b.imageUrl FROM articles b NOT INDEXED WHERE b.id=a.id AND b.imageUrl IS NOT NULL LIMIT 1)),
         g.read, g.readAt, g.saved, g.unsavedAt, a.ogImageChecked
  FROM articles a NOT INDEXED
  JOIN (SELECT id, min(rowid) rid, max(read) read, max(saved) saved, min(readAt) readAt, max(unsavedAt) unsavedAt
        FROM articles NOT INDEXED GROUP BY id) g ON a.rowid=g.rid;
  DROP TABLE articles; ALTER TABLE articles_new RENAME TO articles;
  CREATE INDEX idx_articles_feedId ON articles(feedId); CREATE INDEX idx_articles_isoDate ON articles(isoDate);
  COMMIT;
  ```
  (Compare counts of distinct ids, read and saved before and after. Check the column list against the
  current schema first: `select sql from sqlite_master where name='articles'`.)
- **`Tree N page M: …` / `database disk image is malformed`**: structural damage; use an older
  version, or try `sqlite3 broken.db ".recover"` to salvage rows into a new file.

Restore the file you've verified. Guarding on the generation you inspected means you only replace
that version, and every older version stays in the bucket's history:

```bash
gcloud storage cp ./repaired.db gs://$BUCKET/feed-reader.db --if-generation-match=CURRENT_GENERATION
# A running instance keeps its own copy and would overwrite your restore on its next write, so
# start a fresh one (any config change makes a new revision), with the app still closed everywhere:
gcloud run services update feed-reader --region=$REGION --update-env-vars=RESTARTED_AT=$(date -u +%FT%TZ)
```

Then check the startup log shows `Restored database from snapshot generation N` and open the app.
`RESTARTED_AT` does nothing; remove it later with `--remove-env-vars=RESTARTED_AT`.

## Verifying a deploy

After deploying, with the app opened once and a star or "read" mark made:
- The startup log has `[snapshot] Restored database from snapshot generation N` and
  `Feed proxy server listening`, and nothing at WARNING or above.
- `gcloud storage ls -l -a gs://$BUCKET/feed-reader.db | tail -3` shows a new version for each
  write (a refresh and a star are two versions, not dozens), and reads add none.
- A refresh finishes in seconds. A `POST /api/refresh` near the 300 s timeout means something is wrong.

**Alerting is not set up** (there's one user). Adding a log-based alert for `severity>=ERROR` lines
containing "malformed" or "restored from older snapshot", and for 5xx on `/api/*`, is listed in
`adr/2026-10-06-feed-reader-spec.md` under Future enhancements.

## Moving an existing deployment off the old mounted bucket

If a service still has the Cloud Storage volume (`gcloud run services describe feed-reader
--format='yaml(spec.template.spec.volumes)'` shows one): make sure the bucket's current object is
healthy (runbook above), **close the app on every device** so the old revision isn't writing, then
deploy the new code in one step, which removes the mount and the old setting and turns snapshots on:

```bash
gcloud run deploy feed-reader --source . --region=$REGION --project=$PROJECT \
  --remove-volume-mount=/data --remove-volume=data \
  --remove-env-vars=SQLITE_JOURNAL_MODE \
  --update-env-vars=FEED_READER_SNAPSHOT_BUCKET=$BUCKET
```

## IAP with a personal Gmail account

By default, IAP on Cloud Run uses a Google-managed OAuth client. That client only admits
users inside the project's organization. A personal `@gmail.com` account never counts as
inside one, even when it owns the project. Google can also create an organization for you
automatically, with no directory behind it. In that case `gcloud projects describe` shows a
parent org, but your Gmail account still isn't a member.

What you see: Google sign-in works, then IAP shows **"You don't have access"** with your
account listed. The IAM grants above all look correct, and no request reaches Cloud Run.
Waiting, clearing cookies, or using a private window won't help.

The fix is a custom OAuth client. It's a one-time Console setup, because there's no gcloud
or API path for creating it: Google shut down the IAP OAuth Admin API in March 2026.

1. **Google Auth Platform → Branding / Audience:** set up the consent screen with audience
   **External**. While it's in Testing status, add your Gmail address under **Test users**.
2. **Google Auth Platform → Clients → Create client:** choose **Web application**, with this
   authorized redirect URI:
   `https://iap.googleapis.com/v1/oauth/clientIds/CLIENT_ID:handleRedirect`
3. Point IAP at the client. In the Console: **Security → Identity-Aware Proxy**, find
   `feed-reader`, then **Edit OAuth Client → Custom OAuth**. Or use gcloud with a YAML file:

   ```yaml
   access_settings:
     oauth_settings:
       client_id: "CLIENT_ID"
       client_secret: "CLIENT_SECRET"
   ```

   ```bash
   gcloud iap settings set iap_settings.yaml --resource-type=cloud-run --service=feed-reader \
     --region=$REGION --project=$PROJECT
   rm iap_settings.yaml   # it holds the client secret; it's also gitignored
   ```

   The top-level key must be exactly `access_settings`. A stray character, such as vim's
   `i` ending up as `iaccess_settings`, fails with `Unknown name ... Cannot find field`, and
   nothing is applied.

To check that IAP is using the custom client:

```bash
gcloud iap settings get --resource-type=cloud-run --service=feed-reader \
  --region=$REGION --project=$PROJECT --format="value(accessSettings.oauthSettings.clientId)"
```

## Troubleshooting access

- **Wrong project.** The project number in the `*.run.app` URL
  (`feed-reader-<PROJECT_NUMBER>.<region>.run.app`) identifies the project that owns the
  service. Match it with `gcloud projects list` before debugging IAM, especially if you have
  more than one project.
- **Fresh grants.** IAP policy changes can take a few minutes to take effect. If access still
  fails well after that, the cause is something else, usually the OAuth client issue above.
- **The healthy state:** the IAP policy gives your account `roles/iap.httpsResourceAccessor`
  (`gcloud iap web get-iam-policy ...`), the service gives
  `service-<PROJECT_NUMBER>@gcp-sa-iap.iam.gserviceaccount.com` the role `roles/run.invoker`
  (`gcloud run services get-iam-policy ...`), and the service has the annotation
  `run.googleapis.com/iap-enabled: 'true'`.
- **Fallback without IAP setup.** A project Owner can reach the service through an
  authenticated localhost tunnel, `gcloud run services proxy feed-reader --region=$REGION`.
  This works only from a machine with gcloud installed.

## Installing on an iPhone home screen

The app ships a web manifest and icons (`web/public/`), so it can be added to the home screen.
Spec and test results: `adr/2026-10-10-iphone-pwa.md`.

1. In **Safari** (other iPhone browsers can't add it), open the service URL and sign in.
2. Tap Share, then **Add to Home Screen**, then Add.
3. Launch it from the new icon. It opens full screen with no Safari toolbar.

What was seen on a real iPhone: no second Google sign-in was asked for, and tapping an article
opens an in-app browser sheet with an X (top left) and a back button (bottom left). Either one
returns to the reader at the same scroll position, with the article marked read.

Notes:
- The manifest link sends credentials (`crossorigin="use-credentials"` in `web/index.html`).
  Without that the browser fetches it without the IAP cookie and gets Google's sign-in page.
  To check after a deploy, open `<service-url>/manifest.webmanifest` in Safari while signed in:
  it should show JSON.
- There is no service worker, so nothing is cached for offline use and a deploy reaches the
  installed app like any page load.
- **If the IAP session expires** while the app is open, background requests may fail and show
  the error banner instead of a sign-in page. This has not been observed yet. Closing the app
  and opening it again is the first thing to try; record what actually happens here.
- **Re-adding the icon loses paywall logins.** iOS caches the home-screen icon when it is added,
  so a new icon means deleting and re-adding the app. Each home-screen entry keeps its own logins
  for the in-app sheet, so you sign in again to paywalled sources in the new one (seen on a real
  iPhone; Google sign-in was not asked for again). Add the new entry first and keep the old one
  until the logins are back.
- To undo it, delete the icon from the home screen. Nothing on the server changes.

## Limits

- `max-instances=1` is still required: SQLite wants one writer. It does **not** cover a deploy,
  when the old and new revisions both run briefly; the generation guard under Data durability
  handles that (a few seconds of the outgoing instance's changes can be lost, and it's logged).
- The local disk in Cloud Run is backed by memory, so the database counts against the instance's
  memory limit (512 MiB by default). Fine at a few MB; watch it if the database grows past tens of MB,
  which is also when to move the snapshots to Litestream (see `adr/2026-10-06-feed-reader-spec.md`, Hosted durability).
- Every write takes about 140 ms longer than without snapshots (it waits for the upload). If that
  ever feels slow on a phone, the fallback is instance-based billing (`--no-cpu-throttling`) with a
  short delayed flush, which costs a little more.
- A crash without SIGTERM (an out-of-memory kill) loses only background writes since the last request;
  every acknowledged write is already uploaded.
- Falling back to an older snapshot loses everything written after it. It's logged at ERROR
  (`restored from older snapshot`), which is why that line matters.
- The restore and fallback code rarely runs in production, so its tests matter more than usual.
- The service account needs `roles/storage.objectUser` on the bucket, which covers reading, writing
  and listing versions. It probably can't tell "bucket missing" from "object missing" (the check uses
  `bucket.exists()`, which needs `storage.buckets.get`, and `objectUser` doesn't include it; this
  hasn't been tried against a real brand-new deployment), so a first start with no snapshot object
  yet would then refuse to start rather than start empty. If that happens, upload a database or
  grant `roles/storage.legacyBucketReader` for that first run.
- Feeds refresh only while a browser tab is open (client-side 15-minute timer). Refreshes are
  coalesced on the server: one at a time, and a result under 5 minutes old is reused unless the
  Refresh button forced it.
- Some sites' bot protection blocks requests from cloud IP addresses whatever the User-Agent, so a
  feed that works locally can fail here. One site has a built-in fallback that reads its public JSON
  news API instead (`server/src/espnNews.js`). Other sites show "Blocked by bot protection".
