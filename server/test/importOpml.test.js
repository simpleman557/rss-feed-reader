import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../src/dbLogic.js";
import { IMPORT_CATEGORY_NAME } from "../src/opmlImport.js";
import { createTestDb, seedCategory, seedFeed, seedArticle, getArticle } from "./helpers.js";

const feed = (title, xmlUrl) => ({ text: title, xmlUrl, children: [] });
const folder = (text, children) => ({ text, xmlUrl: "", children });

function setup() {
  const testDb = createTestDb();
  return { testDb, api: createDb(testDb) };
}

const catName = (api, id) => api.getCategories().find((c) => c.id === id)?.name;

describe("importOpml", () => {
  it("creates categories and feeds, and reports the counts", () => {
    const { api } = setup();
    const result = api.importOpml([
      folder("Tech", [feed("Ars", "https://ars.example/feed")]),
      folder("News", [feed("BBC", "https://bbc.example/feed"), feed("NPR", "https://npr.example/feed")]),
    ]);
    assert.deepEqual(result, { feedsAdded: 3, categoriesCreated: 2, duplicates: 0, invalid: [] });
    assert.deepEqual(api.getCategories().map((c) => c.name), ["News", "Tech"]);
    const feeds = api.getFeeds();
    assert.deepEqual(feeds.map((f) => [f.title, catName(api, f.categoryId)]).sort(), [
      ["Ars", "Tech"],
      ["BBC", "News"],
      ["NPR", "News"],
    ]);
  });

  it("keeps each feed's OPML title, alphabetical within its category", () => {
    const { api } = setup();
    api.importOpml([
      folder("News", [
        feed("Zulu", "https://z.example/feed"),
        feed("Alpha", "https://a.example/feed"),
        feed("Mike", "https://m.example/feed"),
      ]),
    ]);
    const ordered = api.getFeeds().sort((a, b) => a.order - b.order).map((f) => f.title);
    assert.deepEqual(ordered, ["Alpha", "Mike", "Zulu"]);
  });

  it("stores the URL as the placeholder title when the OPML gives none, so the first refresh names it", () => {
    const { api } = setup();
    api.importOpml([feed("", "https://a.example/feed")]);
    const [f] = api.getFeeds();
    assert.equal(f.title, "https://a.example/feed");
    api.syncFeedMetadata(f.id, "Real Title", null, null);
    assert.equal(api.getFeeds()[0].title, "Real Title");
  });

  it("gives an imported title the same permanence as a manual rename: a refresh doesn't overwrite it", () => {
    const { api } = setup();
    api.importOpml([feed("My Name For It", "https://a.example/feed")]);
    const [f] = api.getFeeds();
    api.syncFeedMetadata(f.id, "The Feed's Own Title", "https://a.example/icon.png", null);
    const [after] = api.getFeeds();
    assert.equal(after.title, "My Name For It");
    assert.equal(after.feedImageUrl, "https://a.example/icon.png"); // metadata still syncs
  });

  it("disambiguates two feeds that share a title within a category", () => {
    const { api } = setup();
    api.importOpml([folder("News", [feed("Same", "https://a.example/feed"), feed("Same", "https://b.example/feed")])]);
    assert.deepEqual(api.getFeeds().map((f) => f.title).sort(), ["Same", "Same (2)"]);
  });

  it("allows the same title in two different categories", () => {
    const { api } = setup();
    api.importOpml([
      folder("One", [feed("Same", "https://a.example/feed")]),
      folder("Two", [feed("Same", "https://b.example/feed")]),
    ]);
    assert.deepEqual(api.getFeeds().map((f) => f.title), ["Same", "Same"]);
  });

  it("reuses an existing category, case-insensitively, instead of creating a second one", () => {
    const { testDb, api } = setup();
    const existing = seedCategory(testDb, "Tech");
    const result = api.importOpml([folder("TECH", [feed("Ars", "https://ars.example/feed")])]);
    assert.equal(result.categoriesCreated, 0);
    assert.equal(api.getCategories().length, 1);
    assert.equal(api.getFeeds()[0].categoryId, existing);
  });

  it("appends to an existing category's feeds without disturbing them", () => {
    const { testDb, api } = setup();
    const cat = seedCategory(testDb, "Tech");
    const oldFeed = seedFeed(testDb, cat, { url: "https://old.example/feed", title: "Old" });
    const articleId = seedArticle(testDb, oldFeed, { read: 1, readAt: "2026-01-01T00:00:00.000Z", saved: 1 });
    api.importOpml([folder("Tech", [feed("New", "https://new.example/feed")])]);
    assert.equal(api.getFeeds().length, 2);
    const article = getArticle(testDb, articleId);
    assert.equal(article.read, 1);
    assert.equal(article.saved, 1);
  });

  it("skips a feed that's already subscribed, comparing URLs the way addFeed does", () => {
    const { testDb, api } = setup();
    const cat = seedCategory(testDb, "Tech");
    seedFeed(testDb, cat, { url: "https://Example.com/feed/", title: "Existing" });
    const result = api.importOpml([folder("Tech", [feed("Dup", "http://example.com/feed"), feed("Fresh", "https://fresh.example/feed")])]);
    assert.equal(result.duplicates, 1);
    assert.equal(result.feedsAdded, 1);
    assert.equal(api.getFeeds().length, 2);
  });

  it("skips a feed repeated within the file, keeping the first occurrence", () => {
    const { api } = setup();
    const result = api.importOpml([
      folder("One", [feed("First", "https://a.example/feed")]),
      folder("Two", [feed("Second", "https://a.example/feed")]),
    ]);
    assert.equal(result.feedsAdded, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(api.getFeeds()[0].title, "First");
  });

  it("doesn't leave an empty category behind for a folder whose feeds were all duplicates", () => {
    const { testDb, api } = setup();
    const cat = seedCategory(testDb, "Tech");
    seedFeed(testDb, cat, { url: "https://a.example/feed" });
    const result = api.importOpml([
      folder("Tech", [feed("Fresh", "https://fresh.example/feed")]),
      folder("Ghost", [feed("Dup", "https://a.example/feed")]),
    ]);
    assert.equal(result.categoriesCreated, 0);
    assert.deepEqual(api.getCategories().map((c) => c.name), ["Tech"]);
  });

  it("imports the valid feeds and reports the invalid ones", () => {
    const { api } = setup();
    const result = api.importOpml([feed("Good", "https://a.example/feed"), feed("Bad", "ftp://b.example/feed")]);
    assert.equal(result.feedsAdded, 1);
    assert.equal(result.invalid.length, 1);
    assert.equal(result.invalid[0].name, "Bad");
    assert.equal(api.getFeeds().length, 1);
  });

  it("files top-level and Uncategorized feeds under the fallback category", () => {
    const { api } = setup();
    api.importOpml([feed("Loose", "https://a.example/feed"), folder("Uncategorized", [feed("Also", "https://b.example/feed")])]);
    assert.deepEqual(api.getCategories().map((c) => c.name), [IMPORT_CATEGORY_NAME]);
    assert.equal(api.getFeeds().length, 2);
  });

  it("rejects a file with no feeds without changing anything", () => {
    const { api } = setup();
    assert.throws(() => api.importOpml([folder("Empty", [])]), /No feeds found/);
    assert.deepEqual(api.getCategories(), []);
  });

  it("is all-or-nothing on an unexpected fault: a mid-import failure rolls back what came before", () => {
    const { testDb, api } = setup();
    // A trigger that fails the second insert stands in for any unexpected database error
    // (not a ValidationError), which must abort and roll back the whole transaction.
    testDb.exec(`
      CREATE TRIGGER fail_second BEFORE INSERT ON feeds
      WHEN (SELECT COUNT(*) FROM feeds) >= 1
      BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `);
    assert.throws(
      () => api.importOpml([folder("Tech", [feed("A", "https://a.example/feed"), feed("B", "https://b.example/feed")])]),
      /boom/
    );
    assert.equal(api.getFeeds().length, 0);
    assert.equal(api.getCategories().length, 0);
  });

  it("imports a large list quickly enough to be usable", () => {
    const { api } = setup();
    const tree = Array.from({ length: 10 }, (_, c) =>
      folder(`Folder ${c}`, Array.from({ length: 50 }, (_, i) => feed(`Feed ${c}-${i}`, `https://f${c}-${i}.example/feed`)))
    );
    const start = Date.now();
    const result = api.importOpml(tree);
    const elapsed = Date.now() - start;
    assert.equal(result.feedsAdded, 500);
    assert.ok(elapsed < 10000, `500 feeds took ${elapsed}ms`);
  });
});
