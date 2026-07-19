// Every business-rule function (ordering, uniqueness, retention) bound to a single
// database connection, built by this factory — kept in its own module with no
// module-level database connection of its own (unlike db.js, which opens the real one
// as a side effect of being imported), so tests can call `createDb(testDb)` against a
// throwaway in-memory database without ever touching the real one. `db.js` calls this
// once, against the real connection, and re-exports the result for the rest of the app.
import { ValidationError } from "./errors.js";
import { purgeExpiredArticles as purgeExpiredArticlesImpl } from "./retention.js";
import {
  RESERVED_CATEGORY_NAME,
  normalizeName,
  findAlphabeticalOrder,
  bucketOf,
  normalizeFeedUrl,
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
  // bucket for orphaned feeds to fall back into (see Sidebar/Data Model in SPEC.md) — so
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

  function addFeed(url, categoryId, title) {
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
  // rename, refreshes must never clobber it. feedImageUrl/siteUrl have no such
  // placeholder state and always re-sync to whatever refreshFeed.js decided this call
  // (it — not this function — decides whether that includes a fresh icon-discovery
  // pass; see refreshFeed.js for why that's not simply "every refresh").
  function syncFeedMetadata(feedId, title, feedImageUrl, siteUrl) {
    const feed = db.prepare("SELECT * FROM feeds WHERE id = ?").get(feedId);
    if (!feed) return;

    if (feed.title !== feed.url) {
      db.prepare("UPDATE feeds SET feedImageUrl = ?, siteUrl = ? WHERE id = ?").run(
        feedImageUrl ?? null,
        siteUrl ?? null,
        feedId
      );
      return;
    }

    const categoryId = feed.categoryId ?? null;
    const bucket = bucketOf(db.prepare("SELECT * FROM feeds WHERE id != ?").all(feedId), categoryId);
    const uniqueTitle = uniqueTitleInBucket(bucket, title);
    const order = findAlphabeticalOrder(bucket, (f) => f.title, uniqueTitle);
    db.prepare('UPDATE feeds SET title = ?, feedImageUrl = ?, siteUrl = ?, "order" = ? WHERE id = ?').run(
      uniqueTitle,
      feedImageUrl ?? null,
      siteUrl ?? null,
      order,
      feedId
    );
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

  function updateFeedCategory(feedId, categoryId) {
    requireCategory(categoryId);
    const feed = db.prepare("SELECT * FROM feeds WHERE id = ?").get(feedId);
    if (!feed) return;
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
  const insertArticleStmt = db.prepare(`
    INSERT OR IGNORE INTO articles (id, feedId, title, link, isoDate, insertedAt, contentSnippet, imageUrl, read, readAt, saved, unsavedAt)
    VALUES (@id, @feedId, @title, @link, @isoDate, @insertedAt, @contentSnippet, @imageUrl, 0, NULL, 0, NULL)
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
    return db.prepare("SELECT * FROM articles").all().map(rowToArticle);
  }

  function markRead(id, read = true) {
    const article = db.prepare("SELECT * FROM articles WHERE id = ?").get(id);
    if (!article) return;
    const readAt = read && !article.read ? new Date().toISOString() : article.readAt;
    db.prepare("UPDATE articles SET read = ?, readAt = ? WHERE id = ?").run(read ? 1 : 0, readAt, id);
  }

  function toggleSaved(id) {
    const article = db.prepare("SELECT * FROM articles WHERE id = ?").get(id);
    if (!article) return;
    const saved = !article.saved;
    const unsavedAt = !saved ? new Date().toISOString() : article.unsavedAt;
    db.prepare("UPDATE articles SET saved = ?, unsavedAt = ? WHERE id = ?").run(saved ? 1 : 0, unsavedAt, id);
    return saved;
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
    syncFeedMetadata,
    upsertArticles,
    getArticles,
    markRead,
    toggleSaved,
    purgeExpiredArticles,
  };
}
