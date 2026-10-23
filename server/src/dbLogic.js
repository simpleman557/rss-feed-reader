// Every business-rule function (ordering, uniqueness, retention) bound to a single
// database connection, built by this factory — kept in its own module with no
// module-level database connection of its own (unlike db.js, which opens the real one
// as a side effect of being imported), so tests can call `createDb(testDb)` against a
// throwaway in-memory database without ever touching the real one. `db.js` calls this
// once, against the real connection, and re-exports the result for the rest of the app.
import { ValidationError } from "./errors.js";
import { purgeExpiredArticles as purgeExpiredArticlesImpl } from "./retention.js";
import { planOpmlImport } from "./opmlImport.js";
import {
  RESERVED_CATEGORY_NAME,
  normalizeName,
  findAlphabeticalOrder,
  bucketOf,
  normalizeFeedUrl,
  feedUrlProblem,
  uniqueTitleInBucket,
  articleId,
  rowToArticle,
} from "./dbHelpers.js";

export function createDb(db) {
  function normalizeCategoryOrder() {
    const all = db.prepare('SELECT * FROM categories ORDER BY "order" ASC').all();
    const update = db.prepare('UPDATE categories SET "order" = ? WHERE id = ?');
    const tx = db.transaction(() => {
      all.forEach((c, i) => update.run(i, c.id));
    });
    tx();
  }

  function getCategories() {
    return db.prepare('SELECT * FROM categories ORDER BY "order" ASC').all();
  }

  function addCategory(name) {
    const trimmed = name.trim();
    const normalized = normalizeName(trimmed);
    if (normalized === RESERVED_CATEGORY_NAME) {
      throw new ValidationError(`"Uncategorized" is reserved and can't be used as a category name.`);
    }

    const existing = getCategories();
    if (existing.some((c) => normalizeName(c.name) === normalized)) {
      throw new ValidationError(`A category named "${trimmed}" already exists.`);
    }

    // Insert alphabetically relative to the current (possibly manually reordered) sequence.
    const order = findAlphabeticalOrder(existing, (c) => c.name, trimmed);

    const { lastInsertRowid } = db
      .prepare('INSERT INTO categories (name, "order") VALUES (?, ?)')
      .run(trimmed, order);
    normalizeCategoryOrder();
    return lastInsertRowid;
  }

  function updateCategoryName(categoryId, name) {
    const trimmed = name.trim();
    const normalized = normalizeName(trimmed);
    if (normalized === RESERVED_CATEGORY_NAME) {
      throw new ValidationError(`"Uncategorized" is reserved and can't be used as a category name.`);
    }

    const categories = getCategories();
    if (categories.some((c) => c.id !== categoryId && normalizeName(c.name) === normalized)) {
      throw new ValidationError(`A category named "${trimmed}" already exists.`);
    }

    const category = db.prepare("SELECT * FROM categories WHERE id = ?").get(categoryId);
    if (!category) return;
    // Renaming re-sorts it alphabetically relative to everyone else's current position.
    const order = findAlphabeticalOrder(categories, (c) => c.name, trimmed, categoryId);
    db.prepare('UPDATE categories SET name = ?, "order" = ? WHERE id = ?').run(trimmed, order, categoryId);
    normalizeCategoryOrder();
  }

  // Every feed must always belong to a real category — there's no "Uncategorized"
  // bucket for orphaned feeds to fall back into (see Sidebar/Data Model in docs/adr/2026-10-06-feed-reader-spec.md) — so
  // a category can't be deleted while it still has feeds in it; the user has to move or
  // delete them first. (The feeds.categoryId foreign key is still ON DELETE SET NULL as
  // a defense-in-depth fallback, but this check means that path should never actually
  // fire through normal app use.)
  function deleteCategory(categoryId) {
    const category = db.prepare("SELECT * FROM categories WHERE id = ?").get(categoryId);
    if (!category) return;
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM feeds WHERE categoryId = ?").get(categoryId);
    if (n > 0) {
      throw new ValidationError(`"${category.name}" still has feeds in it — move or delete them first.`);
    }
    db.prepare("DELETE FROM categories WHERE id = ?").run(categoryId);
  }

  function normalizeFeedBucketOrder(categoryId) {
    const bucket = bucketOf(db.prepare("SELECT * FROM feeds").all(), categoryId);
    const update = db.prepare('UPDATE feeds SET "order" = ? WHERE id = ?');
    const tx = db.transaction(() => {
      bucket.forEach((f, i) => update.run(i, f.id));
    });
    tx();
  }

  function getFeeds() {
    return db.prepare('SELECT * FROM feeds ORDER BY "order" ASC').all();
  }

  // Every feed must belong to a real, existing category — there's no "Uncategorized"
  // fallback (see deleteCategory above) — so addFeed/updateFeedCategory both require an
  // id that actually resolves to a category rather than silently accepting `null`.
  function requireCategory(categoryId) {
    if (categoryId == null) {
      throw new ValidationError("Choose a category for this feed.");
    }
    if (!db.prepare("SELECT id FROM categories WHERE id = ?").get(categoryId)) {
      throw new ValidationError("That category doesn't exist.");
    }
  }

  // A feed URL is only ever fetched via safeFetch (which refuses non-public addresses
  // and non-http(s) schemes), so this isn't the security boundary — it's here so a
  // typo or a paste of something that isn't a feed URL fails immediately, with a clear
  // message, instead of being stored and then failing on every refresh forever.
  function requireFetchableUrl(url) {
    const problem = feedUrlProblem(url);
    if (problem) throw new ValidationError(problem);
  }

  function addFeed(url, categoryId, title) {
    requireFetchableUrl(url);
    requireCategory(categoryId);
    const allFeeds = db.prepare("SELECT * FROM feeds").all();

    const normalizedUrl = normalizeFeedUrl(url);
    if (normalizedUrl && allFeeds.some((f) => normalizeFeedUrl(f.url) === normalizedUrl)) {
      throw new ValidationError("This feed URL has already been added.");
    }

    const bucketCount = bucketOf(allFeeds, categoryId).length;
    // Title is just a URL placeholder until the feed is fetched, so it isn't checked for
    // uniqueness or alphabetically placed yet — syncFeedMetadata repositions it once the
    // real title comes in from the first refresh.
    const { lastInsertRowid } = db
      .prepare('INSERT INTO feeds (url, categoryId, title, feedImageUrl, "order") VALUES (?, ?, ?, NULL, ?)')
      .run(url, categoryId, title || url, bucketCount);
    return lastInsertRowid;
  }

  function updateFeedTitle(feedId, title) {
    const feed = db.prepare("SELECT * FROM feeds WHERE id = ?").get(feedId);
    if (!feed) return;
    const categoryId = feed.categoryId ?? null;
    const bucket = bucketOf(db.prepare("SELECT * FROM feeds WHERE id != ?").all(feedId), categoryId);
    const order = findAlphabeticalOrder(bucket, (f) => f.title, title);
    db.prepare('UPDATE feeds SET title = ?, "order" = ? WHERE id = ?').run(title, order, feedId);
    normalizeFeedBucketOrder(categoryId);
  }

  // Runs on every successful refresh. The feed's title is only adopted from the feed
  // itself the first time (while our stored title is still the URL placeholder set at
  // creation) — once it has a real title, whether from that first sync or a manual
  // rename, refreshes must never clobber it. feedImageUrl/siteUrl/iconCheckedAt have no
  // such placeholder state and always re-sync to whatever refreshFeed.js decided this
  // call (it — not this function — decides whether that includes a fresh
  // icon-discovery pass; see refreshFeed.js's shouldDiscoverIcon).
  function syncFeedMetadata(feedId, title, feedImageUrl, siteUrl, iconCheckedAt) {
    const feed = db.prepare("SELECT * FROM feeds WHERE id = ?").get(feedId);
    if (!feed) return;

    if (feed.title !== feed.url) {
      db.prepare("UPDATE feeds SET feedImageUrl = ?, siteUrl = ?, iconCheckedAt = ? WHERE id = ?").run(
        feedImageUrl ?? null,
        siteUrl ?? null,
        iconCheckedAt ?? null,
        feedId
      );
      return;
    }

    const categoryId = feed.categoryId ?? null;
    const bucket = bucketOf(db.prepare("SELECT * FROM feeds WHERE id != ?").all(feedId), categoryId);
    const uniqueTitle = uniqueTitleInBucket(bucket, title);
    const order = findAlphabeticalOrder(bucket, (f) => f.title, uniqueTitle);
    db.prepare(
      'UPDATE feeds SET title = ?, feedImageUrl = ?, siteUrl = ?, iconCheckedAt = ?, "order" = ? WHERE id = ?'
    ).run(uniqueTitle, feedImageUrl ?? null, siteUrl ?? null, iconCheckedAt ?? null, order, feedId);
    normalizeFeedBucketOrder(categoryId);
  }

  function renameFeed(feedId, title) {
    const trimmed = title.trim();
    const normalized = normalizeName(trimmed);
    const feed = db.prepare("SELECT * FROM feeds WHERE id = ?").get(feedId);
    if (!feed) return;
    const categoryId = feed.categoryId ?? null;
    const bucket = bucketOf(db.prepare("SELECT * FROM feeds").all(), categoryId);
    if (bucket.some((f) => f.id !== feedId && normalizeName(f.title) === normalized)) {
      throw new ValidationError(`A feed named "${trimmed}" already exists in this category.`);
    }
    updateFeedTitle(feedId, trimmed);
  }

  // Applies an OPML import: the outline tree the browser parsed is flattened by
  // planOpmlImport (pure — see opmlImport.js), then each feed goes through the same
  // addFeed as a hand-typed one, so URL validation and duplicate detection are the very
  // same rules. Runs in one transaction so an unexpected fault leaves nothing half
  // imported; expected per-feed problems (an invalid URL) don't abort it, they're
  // reported back in `invalid`.
  //
  // A folder that already exists (case-insensitively) is reused; a new one is created
  // only once a feed is actually about to land in it, so a folder whose feeds were all
  // duplicates doesn't leave an empty category behind. The OPML title is kept, made
  // unique within the category and slotted in alphabetically — the same treatment a
  // synced title gets — because a dead feed never refreshes and would otherwise be
  // stuck showing its raw URL. That also means a later refresh won't overwrite it (see
  // syncFeedMetadata), the same as a manual rename.
  function importOpml(outlines) {
    const { groups, invalid } = planOpmlImport(outlines);
    const result = { feedsAdded: 0, categoriesCreated: 0, duplicates: 0, invalid: [...invalid] };

    db.transaction(() => {
      const categoryIds = new Map(getCategories().map((c) => [normalizeName(c.name), c.id]));
      const seenUrls = new Set(db.prepare("SELECT url FROM feeds").all().map((f) => normalizeFeedUrl(f.url)));

      for (const group of groups) {
        const categoryKey = normalizeName(group.name);
        for (const feed of group.feeds) {
          const urlKey = normalizeFeedUrl(feed.url);
          if (seenUrls.has(urlKey)) {
            result.duplicates++;
            continue;
          }
          if (!categoryIds.has(categoryKey)) {
            categoryIds.set(categoryKey, addCategory(group.name));
            result.categoriesCreated++;
          }
          const categoryId = categoryIds.get(categoryKey);
          try {
            const feedId = addFeed(feed.url, categoryId);
            if (feed.title) {
              const siblings = bucketOf(
                db.prepare("SELECT * FROM feeds WHERE id != ?").all(feedId),
                categoryId
              );
              updateFeedTitle(feedId, uniqueTitleInBucket(siblings, feed.title));
            }
            seenUrls.add(urlKey);
            result.feedsAdded++;
          } catch (err) {
            if (!(err instanceof ValidationError)) throw err;
            result.invalid.push({ name: feed.title, url: feed.url, reason: err.message });
          }
        }
      }
    })();

    return result;
  }

  function updateFeedCategory(feedId, categoryId) {
    requireCategory(categoryId);
    const feed = db.prepare("SELECT * FROM feeds WHERE id = ?").get(feedId);
    if (!feed) return;
    // Already in that category: not a move. Without this, a drop that lands on the feed's
    // own category (e.g. released over a sibling feed) sent it to the end of the list.
    if ((feed.categoryId ?? null) === categoryId) return;
    const order = bucketOf(db.prepare("SELECT * FROM feeds WHERE id != ?").all(feedId), categoryId).length;
    db.prepare('UPDATE feeds SET categoryId = ?, "order" = ? WHERE id = ?').run(categoryId, order, feedId);
  }

  function deleteFeed(feedId) {
    // The articles.feedId foreign key is ON DELETE CASCADE, so this automatically
    // deletes all of the feed's articles too.
    db.prepare("DELETE FROM feeds WHERE id = ?").run(feedId);
  }

  // INSERT OR IGNORE: a row whose id (feedId::guid) already exists is left untouched, so
  // existing read/saved state and imageUrl are preserved permanently across refreshes —
  // only genuinely new guids get inserted. Does the "skip if present" in a single
  // statement, with no separate existence check.
  // An article already stored is left as it is, except that a missing image is filled in
  // when the feed now supplies one, so an improvement to image extraction (feedParser.js)
  // also reaches articles that were saved before it. An existing image, whether from the
  // feed or from og:image, is never replaced.
  const insertArticleStmt = db.prepare(`
    INSERT INTO articles (id, feedId, title, link, isoDate, insertedAt, contentSnippet, imageUrl, read, readAt, saved, unsavedAt)
    VALUES (@id, @feedId, @title, @link, @isoDate, @insertedAt, @contentSnippet, @imageUrl, 0, NULL, 0, NULL)
    ON CONFLICT(id) DO UPDATE SET imageUrl = excluded.imageUrl
      WHERE articles.imageUrl IS NULL AND excluded.imageUrl IS NOT NULL
  `);

  function upsertArticles(feedId, items) {
    const now = new Date().toISOString();
    const tx = db.transaction((items) => {
      for (const item of items) {
        insertArticleStmt.run({
          id: articleId(feedId, item.guid || item.link),
          feedId,
          title: item.title,
          link: item.link ?? null,
          isoDate: item.isoDate || now,
          insertedAt: now,
          contentSnippet: item.contentSnippet || "",
          imageUrl: item.imageUrl || null,
        });
      }
    });
    tx(items);
  }

  function getArticles() {
    // Only the columns the UI reads — this is the biggest response the server sends, so
    // the bookkeeping columns (insertedAt, unsavedAt, ogImageChecked) stay server-side.
    return db
      .prepare(
        "SELECT id, feedId, title, link, isoDate, contentSnippet, imageUrl, read, readAt, saved FROM articles"
      )
      .all()
      .map(rowToArticle);
  }

  function markRead(id, read = true) {
    const article = db.prepare("SELECT * FROM articles WHERE id = ?").get(id);
    if (!article) return;
    const readAt = read && !article.read ? new Date().toISOString() : article.readAt;
    db.prepare("UPDATE articles SET read = ?, readAt = ? WHERE id = ?").run(read ? 1 : 0, readAt, id);
    return readAt;
  }

  function toggleSaved(id) {
    const article = db.prepare("SELECT * FROM articles WHERE id = ?").get(id);
    if (!article) return;
    const saved = !article.saved;
    const unsavedAt = !saved ? new Date().toISOString() : article.unsavedAt;
    db.prepare("UPDATE articles SET saved = ?, unsavedAt = ? WHERE id = ?").run(saved ? 1 : 0, unsavedAt, id);
    return saved;
  }

  function getArticlesNeedingOgCheck(feedId) {
    return db
      .prepare(
        `SELECT id, link FROM articles
         WHERE feedId = ? AND imageUrl IS NULL AND ogImageChecked IS NULL
           AND link IS NOT NULL AND insertedAt > datetime('now', '-30 days')`
      )
      .all(feedId);
  }

  function setArticleOgImage(id, imageUrl, checkedAt) {
    db.prepare(
      "UPDATE articles SET imageUrl = ?, ogImageChecked = ? WHERE id = ?"
    ).run(imageUrl ?? null, checkedAt, id);
  }

  // Wipes every stored per-article image for a feed. Used for an "icon-only" feed — one
  // that stamps the same logo into every entry (see feedParser.js / feedWideImage.js), so
  // it has no genuine per-article pictures. This clears both those logos and any og:image
  // topic badges fetched for it before it was recognised as icon-only, so its articles
  // fall back to the one clean feed icon. Touches imageUrl only; read/saved state is left
  // alone. Returns the number of rows changed.
  function clearArticleImagesForFeed(feedId) {
    return db
      .prepare("UPDATE articles SET imageUrl = NULL WHERE feedId = ? AND imageUrl IS NOT NULL")
      .run(feedId).changes;
  }

  function purgeExpiredArticles() {
    purgeExpiredArticlesImpl(db);
  }

  return {
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
  };
}
