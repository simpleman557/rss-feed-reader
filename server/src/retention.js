// Bounds article storage by actually deleting expired rows (not a view-level filter).
// Kept in its own module, with no module-level database connection of its own (unlike
// db.js, which opens the real one as a side effect of being imported) — that's what
// lets test/retention.test.js exercise this against a throwaway in-memory database
// without ever touching the real one.
//
// Saved articles (saved === true) are always exempt, regardless of age — the caller
// only hands this whatever it already filtered to saved = 0. For every other article,
// compute an anchor timestamp:
//   base   = isoDate if present and valid, else insertedAt
//   anchor = max(base, readAt if set, unsavedAt if set)
// and delete once `now > anchor + 30 days`. So: never-read articles expire 30 days
// after publish; read articles get 30 days from the moment they were read (not
// published); an article that was saved and later unsaved gets a fresh 30-day grace
// period from the moment it was unsaved, regardless of how old it already was — this
// guarantees an accidental unsave can never delete something with zero grace period.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function purgeExpiredArticles(db) {
  const articles = db.prepare("SELECT * FROM articles WHERE saved = 0").all();
  const now = Date.now();
  const del = db.prepare("DELETE FROM articles WHERE id = ?");
  const tx = db.transaction(() => {
    for (const a of articles) {
      const isoTime = a.isoDate ? new Date(a.isoDate).getTime() : NaN;
      const base = Number.isNaN(isoTime) ? new Date(a.insertedAt).getTime() : isoTime;
      let anchor = base;
      if (a.readAt) anchor = Math.max(anchor, new Date(a.readAt).getTime());
      if (a.unsavedAt) anchor = Math.max(anchor, new Date(a.unsavedAt).getTime());

      if (now > anchor + RETENTION_MS) {
        del.run(a.id);
      }
    }
  });
  tx();
}
