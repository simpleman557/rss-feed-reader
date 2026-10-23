import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../src/dbLogic.js";
import { createTestDb, seedCategory, seedFeed, seedArticle, getArticle } from "./helpers.js";

function setup() {
  const testDb = createTestDb();
  return { testDb, api: createDb(testDb) };
}

describe("addCategory", () => {
  it("adds a category and returns its id", () => {
    const { api } = setup();
    const id = api.addCategory("Tech");
    assert.equal(typeof id, "number");
    assert.deepEqual(api.getCategories().map((c) => c.name), ["Tech"]);
  });

  it("rejects the reserved name, case-insensitively", () => {
    const { api } = setup();
    assert.throws(() => api.addCategory("UNCATEGORIZED"), /reserved/i);
  });

  it("rejects a duplicate name, case-insensitively", () => {
    const { api } = setup();
    api.addCategory("Tech");
    assert.throws(() => api.addCategory("tech"), /already exists/i);
  });

  it("inserts new categories in alphabetical order", () => {
    const { api } = setup();
    api.addCategory("Zebra");
    api.addCategory("Apple");
    assert.deepEqual(api.getCategories().map((c) => c.name), ["Apple", "Zebra"]);
  });
});

describe("updateCategoryName", () => {
  it("renames a category", () => {
    const { api } = setup();
    const id = api.addCategory("Tech");
    api.updateCategoryName(id, "Technology");
    assert.deepEqual(api.getCategories().map((c) => c.name), ["Technology"]);
  });

  it("rejects renaming to the reserved name", () => {
    const { api } = setup();
    const id = api.addCategory("Tech");
    assert.throws(() => api.updateCategoryName(id, "Uncategorized"), /reserved/i);
  });

  it("rejects renaming to collide with a different existing category", () => {
    const { api } = setup();
    api.addCategory("Tech");
    const newsId = api.addCategory("News");
    assert.throws(() => api.updateCategoryName(newsId, "tech"), /already exists/i);
  });

  it("allows renaming to a case variant of its own current name", () => {
    const { api } = setup();
    const id = api.addCategory("Tech");
    api.updateCategoryName(id, "TECH");
    assert.deepEqual(api.getCategories().map((c) => c.name), ["TECH"]);
  });
});

describe("deleteCategory", () => {
  it("deletes an empty category", () => {
    const { api } = setup();
    const id = api.addCategory("Tech");
    api.deleteCategory(id);
    assert.deepEqual(api.getCategories(), []);
  });

  it("refuses to delete a category that still has feeds in it", () => {
    const { testDb, api } = setup();
    const id = api.addCategory("Tech");
    seedFeed(testDb, id);
    assert.throws(() => api.deleteCategory(id), /still has feeds in it/i);
    assert.equal(api.getCategories().length, 1, "category should survive the refused delete");
  });

  it("is a no-op for a category id that doesn't exist", () => {
    const { api } = setup();
    assert.doesNotThrow(() => api.deleteCategory(999));
  });
});

describe("addFeed", () => {
  it("rejects a URL that isn't a URL at all", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    assert.throws(() => api.addFeed("not a url", categoryId, "Test"), /valid URL/i);
  });

  it("rejects a non-http(s) scheme", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    assert.throws(() => api.addFeed("file:///etc/passwd", categoryId, "Test"), /http:\/\/ or https:\/\//i);
  });

  it("rejects a missing categoryId", () => {
    const { api } = setup();
    assert.throws(() => api.addFeed("https://example.com/feed.xml", null, "Test"), /choose a category/i);
  });

  it("rejects a categoryId that doesn't exist", () => {
    const { api } = setup();
    assert.throws(
      () => api.addFeed("https://example.com/feed.xml", 999, "Test"),
      /doesn't exist/i
    );
  });

  it("rejects a duplicate feed URL once normalized", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    api.addFeed("https://Example.com/feed.xml", categoryId, "Test");
    assert.throws(
      () => api.addFeed("http://example.com/feed.xml", categoryId, "Test 2"),
      /already been added/i
    );
  });

  it("allows the same host with a different query string", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    api.addFeed("https://example.com/feed.xml?format=rss", categoryId, "Test");
    assert.doesNotThrow(() =>
      api.addFeed("https://example.com/feed.xml?format=atom", categoryId, "Test 2")
    );
  });
});

describe("renameFeed", () => {
  it("renames a feed", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    const feedId = seedFeed(testDb, categoryId, { title: "Old Name" });
    api.renameFeed(feedId, "New Name");
    assert.equal(api.getFeeds()[0].title, "New Name");
  });

  it("rejects a name that collides with another feed in the same category", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    seedFeed(testDb, categoryId, { url: "https://example.com/a.xml", title: "Example Feed" });
    const feedId = seedFeed(testDb, categoryId, { url: "https://example.com/b.xml", title: "CNN" });
    assert.throws(() => api.renameFeed(feedId, "Example Feed"), /already exists in this category/i);
  });

  it("allows the same title in a different category", () => {
    const { testDb, api } = setup();
    const categoryA = seedCategory(testDb, "A");
    const categoryB = seedCategory(testDb, "B");
    seedFeed(testDb, categoryA, { url: "https://example.com/a.xml", title: "Example Feed" });
    const feedId = seedFeed(testDb, categoryB, { url: "https://example.com/b.xml", title: "CNN" });
    assert.doesNotThrow(() => api.renameFeed(feedId, "Example Feed"));
  });
});

describe("updateFeedCategory", () => {
  it("moves a feed to a different category", () => {
    const { testDb, api } = setup();
    const categoryA = seedCategory(testDb, "A");
    const categoryB = seedCategory(testDb, "B");
    const feedId = seedFeed(testDb, categoryA);
    api.updateFeedCategory(feedId, categoryB);
    assert.equal(api.getFeeds()[0].categoryId, categoryB);
  });

  it("rejects moving a feed to a nonexistent category", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    const feedId = seedFeed(testDb, categoryId);
    assert.throws(() => api.updateFeedCategory(feedId, 999), /doesn't exist/i);
  });

  // Feeds inside a category are in a fixed order. Dropping a feed on its own category (easy
  // to do by letting go over a sibling feed) is not a move, and must not reorder anything —
  // it used to send the feed to the end of the list.
  it("leaves the order alone when a feed is dropped on its own category", () => {
    const { testDb, api } = setup();
    const category = seedCategory(testDb, "News");
    const ids = ["A", "B", "C", "D"].map((title, i) =>
      seedFeed(testDb, category, { url: `https://example.com/${title}.xml`, title, order: i })
    );
    const titlesInOrder = () => api.getFeeds().map((f) => f.title);
    assert.deepEqual(titlesInOrder(), ["A", "B", "C", "D"]);

    api.updateFeedCategory(ids[0], category); // drop the first feed on its own category
    assert.deepEqual(titlesInOrder(), ["A", "B", "C", "D"]);

    api.updateFeedCategory(ids[2], category); // and a middle one
    assert.deepEqual(titlesInOrder(), ["A", "B", "C", "D"]);
  });

  it("still appends a feed to the end of a different category", () => {
    const { testDb, api } = setup();
    const from = seedCategory(testDb, "From");
    const to = seedCategory(testDb, "To");
    seedFeed(testDb, to, { url: "https://example.com/x.xml", title: "X", order: 0 });
    seedFeed(testDb, to, { url: "https://example.com/y.xml", title: "Y", order: 1 });
    const moving = seedFeed(testDb, from, { url: "https://example.com/a.xml", title: "A", order: 0 });

    api.updateFeedCategory(moving, to);
    assert.deepEqual(
      api.getFeeds().filter((f) => f.categoryId === to).map((f) => f.title),
      ["X", "Y", "A"]
    );
  });
});

describe("syncFeedMetadata", () => {
  it("adopts the feed's real title on first sync (title still equals url placeholder)", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    const feedId = seedFeed(testDb, categoryId, {
      url: "https://example.com/feed.xml",
      title: "https://example.com/feed.xml",
    });
    api.syncFeedMetadata(feedId, "Real Title", null, null);
    assert.equal(api.getFeeds()[0].title, "Real Title");
  });

  it("disambiguates the first-sync title if it collides with a sibling in the same category", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    seedFeed(testDb, categoryId, { url: "https://example.com/a.xml", title: "Example Feed" });
    const feedId = seedFeed(testDb, categoryId, {
      url: "https://example.com/b.xml",
      title: "https://example.com/b.xml",
    });
    api.syncFeedMetadata(feedId, "Example Feed", null, null);
    const synced = api.getFeeds().find((f) => f.id === feedId);
    assert.equal(synced.title, "Example Feed (2)");
  });

  it("never overwrites a title that's already real, on later syncs", () => {
    // Regression test: syncFeedMetadata used to unconditionally overwrite a feed's
    // title from the RSS feed's own <title> on every refresh, silently reverting a
    // manual rename. Once the stored title differs from the url placeholder, later
    // syncs must leave it alone even if the feed's own title has since changed.
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    const feedId = seedFeed(testDb, categoryId, {
      url: "https://example.com/feed.xml",
      title: "My Custom Name",
    });
    api.syncFeedMetadata(feedId, "Some Different Feed-Provided Title", null, null);
    assert.equal(api.getFeeds()[0].title, "My Custom Name");
  });

  it("persists iconCheckedAt on first sync", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    const feedId = seedFeed(testDb, categoryId, {
      url: "https://example.com/feed.xml",
      title: "https://example.com/feed.xml",
    });
    const checkedAt = "2026-01-01T00:00:00.000Z";
    api.syncFeedMetadata(feedId, "Real Title", null, null, checkedAt);
    assert.equal(api.getFeeds()[0].iconCheckedAt, checkedAt);
  });

  it("updates iconCheckedAt on a later sync too, unlike title", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    const feedId = seedFeed(testDb, categoryId, {
      url: "https://example.com/feed.xml",
      title: "My Custom Name",
      iconCheckedAt: "2026-01-01T00:00:00.000Z",
    });
    const checkedAt = "2026-02-01T00:00:00.000Z";
    api.syncFeedMetadata(feedId, "Feed-Provided Title", null, null, checkedAt);
    assert.equal(api.getFeeds()[0].iconCheckedAt, checkedAt);
  });
});


describe("clearArticleImagesForFeed", () => {
  it("clears every stored image for the feed and reports the count", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    const feedId = seedFeed(testDb, categoryId);
    const withImg = seedArticle(testDb, feedId, { imageUrl: "https://cdn.example.com/topics/ai_64.png" });
    const alsoImg = seedArticle(testDb, feedId, { imageUrl: "https://cdn.example.com/topics/space_64.png" });
    const noImg = seedArticle(testDb, feedId, { imageUrl: null });

    const changed = api.clearArticleImagesForFeed(feedId);

    assert.equal(changed, 2, "only the two rows that had an image are counted");
    assert.equal(getArticle(testDb, withImg).imageUrl, null);
    assert.equal(getArticle(testDb, alsoImg).imageUrl, null);
    assert.equal(getArticle(testDb, noImg).imageUrl, null);
  });

  it("preserves read/saved state while clearing images", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    const feedId = seedFeed(testDb, categoryId);
    const id = seedArticle(testDb, feedId, {
      imageUrl: "https://example.com/logo.png",
      read: 1,
      readAt: "2026-01-01T00:00:00.000Z",
      saved: 1,
    });

    api.clearArticleImagesForFeed(feedId);

    const row = getArticle(testDb, id);
    assert.equal(row.imageUrl, null);
    assert.equal(row.read, 1);
    assert.equal(row.readAt, "2026-01-01T00:00:00.000Z");
    assert.equal(row.saved, 1);
  });

  it("leaves other feeds' images untouched", () => {
    const { testDb, api } = setup();
    const categoryId = seedCategory(testDb);
    const iconFeed = seedFeed(testDb, categoryId, { url: "https://icon.example/feed.xml" });
    const photoFeed = seedFeed(testDb, categoryId, { url: "https://photo.example/feed.xml" });
    seedArticle(testDb, iconFeed, { imageUrl: "https://icon.example/logo.png" });
    const keep = seedArticle(testDb, photoFeed, { imageUrl: "https://photo.example/real.jpg" });

    api.clearArticleImagesForFeed(iconFeed);

    assert.equal(getArticle(testDb, keep).imageUrl, "https://photo.example/real.jpg");
  });
});
