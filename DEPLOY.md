# Deploying to Google Cloud Run

Cloud Run **service** (container), single instance, SQLite on a mounted GCS bucket,
access gated by Identity-Aware Proxy (IAP). The app has no login of its own, so never
deploy it without IAP (or `--no-allow-unauthenticated` at minimum).

## Environment variables

| Var | Cloud Run value | Why |
|---|---|---|
| `HOST` | `0.0.0.0` (set in Dockerfile) | Cloud Run's proxy must reach the container. Default is `127.0.0.1`. |
| `PORT` | set by Cloud Run | |
| `FEED_READER_DATA_DIR` | `/data` (set in Dockerfile) | Where `feed-reader.db` lives; the GCS volume mounts here. |
| `SQLITE_JOURNAL_MODE` | `DELETE` | WAL doesn't work on FUSE mounts. Default `WAL` locally. |
| `ALLOWED_HOSTS` | `*` | The loopback Host guard otherwise 403s every `*.run.app` request. Safe only because IAP authenticates every request. |

## Steps

Set `PROJECT`, `REGION`, and `BUCKET` first. Verify flags against the current Cloud Run
docs, especially `--iap`.

```bash
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com iap.googleapis.com storage.googleapis.com

# Persistence bucket (versioning gives you cheap backups)
gcloud storage buckets create gs://$BUCKET --location=$REGION
gcloud storage buckets update gs://$BUCKET --versioning

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
  --add-volume=name=data,type=cloud-storage,bucket=$BUCKET \
  --add-volume-mount=volume=data,mount-path=/data \
  --set-env-vars=SQLITE_JOURNAL_MODE=DELETE,ALLOWED_HOSTS=*

# Let yourself through IAP
gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=feed-reader \
  --region=$REGION --member=user:YOU@example.com --role=roles/iap.httpsResourceAccessor
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

## Limits

- `max-instances=1` is required: SQLite on GCS FUSE has no real cross-process locking.
- Feeds refresh only while a browser tab is open (client-side 15-minute timer).
- Some sites' bot protection blocks requests from cloud IP addresses whatever the User-Agent, so a
  feed that works locally can fail here. ESPN's league RSS feeds (`/espn/rss/<league>/news`) hit
  this and are read from ESPN's JSON news API instead (`server/src/espnNews.js`). Other sites show
  "Blocked by bot protection".
- If the FUSE-backed database proves flaky, move to Litestream-to-GCS or a hosted database.
