import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../src/dbLogic.js";
import { createTestDb, seedCategory, seedFeed } from "./helpers.js";

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
    seedFeed(testDb, categoryId, { url: "https://example.com/a.xml", title: "BBC" });
    const feedId = seedFeed(testDb, categoryId, { url: "https://example.com/b.xml", title: "CNN" });
    assert.throws(() => api.renameFeed(feedId, "BBC"), /already exists in this category/i);
  });

  it("allows the same title in a different category", () => {
    const { testDb, api } = setup();
    const categoryA = seedCategory(testDb, "A");
    const categoryB = seedCategory(testDb, "B");
    seedFeed(testDb, categoryA, { url: "https://example.com/a.xml", title: "BBC" });
    const feedId = seedFeed(testDb, categoryB, { url: "https://example.com/b.xml", title: "CNN" });
    assert.doesNotThrow(() => api.renameFeed(feedId, "BBC"));
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
    seedFeed(testDb, categoryId, { url: "https://example.com/a.xml", title: "BBC" });
    const feedId = seedFeed(testDb, categoryId, {
      url: "https://example.com/b.xml",
      title: "https://example.com/b.xml",
    });
    api.syncFeedMetadata(feedId, "BBC", null, null);
    const synced = api.getFeeds().find((f) => f.id === feedId);
    assert.equal(synced.title, "BBC (2)");
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
