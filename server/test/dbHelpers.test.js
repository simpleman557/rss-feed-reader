import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  findAlphabeticalOrder,
  bucketOf,
  normalizeFeedUrl,
  uniqueTitleInBucket,
  articleId,
  rowToArticle,
} from "../src/dbHelpers.js";

describe("normalizeName", () => {
  it("trims and lowercases", () => {
    assert.equal(normalizeName("  Tech  "), "tech");
  });
});

describe("findAlphabeticalOrder", () => {
  const items = [{ id: 1, name: "Banana" }, { id: 2, name: "Cherry" }, { id: 3, name: "Date" }];

  it("slots a new name in the middle alphabetically", () => {
    const order = findAlphabeticalOrder(items, (x) => x.name, "Carrot");
    // "Carrot" < "Cherry" (second letter a < h), so it lands between Banana (index 0)
    // and Cherry (index 1).
    assert.ok(order > 0 && order < 1, `expected order between 0 and 1, got ${order}`);
  });

  it("slots a new name before everything", () => {
    const order = findAlphabeticalOrder(items, (x) => x.name, "Apple");
    assert.ok(order < 0, `expected a negative (before-index-0) order, got ${order}`);
  });

  it("slots a new name after everything", () => {
    const order = findAlphabeticalOrder(items, (x) => x.name, "Fig");
    assert.equal(order, items.length);
  });

  it("compares case-insensitively", () => {
    const order = findAlphabeticalOrder(items, (x) => x.name, "apple");
    assert.ok(order < 0, "lowercase 'apple' should still sort before 'Banana'");
  });

  it("inserts after an existing case-insensitive match, not before it", () => {
    // localeCompare with sensitivity "base" treats "Banana" and "banana" as equal, and
    // the insertion search only advances past strictly-greater items — so a match
    // should land immediately after the existing equal entry, not before it.
    const order = findAlphabeticalOrder(items, (x) => x.name, "banana");
    assert.ok(order > 0 && order < 1, `expected to land just after Banana (index 0), got ${order}`);
  });

  it("excludes the given id from the comparison list (for repositioning on rename)", () => {
    // Renaming Cherry to "Apricot" should be positioned relative to [Banana, Date] only
    // (Cherry excluded), landing before Banana.
    const order = findAlphabeticalOrder(items, (x) => x.name, "Apricot", 2);
    assert.ok(order < 0, `expected before Banana once Cherry is excluded, got ${order}`);
  });
});

describe("bucketOf", () => {
  const feeds = [
    { id: 1, categoryId: 1, order: 2 },
    { id: 2, categoryId: 1, order: 0 },
    { id: 3, categoryId: 2, order: 0 },
    { id: 4, categoryId: null, order: 0 },
  ];

  it("filters to just the requested category, sorted by order", () => {
    const bucket = bucketOf(feeds, 1);
    assert.deepEqual(bucket.map((f) => f.id), [2, 1]);
  });

  it("treats undefined and null categoryId as the same bucket", () => {
    const bucket = bucketOf(feeds, undefined);
    assert.deepEqual(bucket.map((f) => f.id), [4]);
  });
});

describe("normalizeFeedUrl", () => {
  it("lowercases the host but leaves the path case untouched", () => {
    assert.equal(normalizeFeedUrl("https://Example.COM/Feed.xml"), "example.com/Feed.xml");
  });

  it("treats http and https as equivalent", () => {
    assert.equal(
      normalizeFeedUrl("http://example.com/feed"),
      normalizeFeedUrl("https://example.com/feed")
    );
  });

  it("strips exactly one trailing slash from the path", () => {
    assert.equal(normalizeFeedUrl("https://example.com/feed/"), "example.com/feed");
  });

  it("does not strip the root path down to nothing", () => {
    assert.equal(normalizeFeedUrl("https://example.com/"), "example.com/");
  });

  it("preserves the query string exactly, including case", () => {
    assert.equal(
      normalizeFeedUrl("https://example.com/feed?format=RSS"),
      "example.com/feed?format=RSS"
    );
  });

  it("treats a differing query string as a genuinely different feed", () => {
    assert.notEqual(
      normalizeFeedUrl("https://example.com/feed?format=rss"),
      normalizeFeedUrl("https://example.com/feed?format=atom")
    );
  });

  it("returns null for an unparseable URL", () => {
    assert.equal(normalizeFeedUrl("not a url"), null);
  });
});

describe("uniqueTitleInBucket", () => {
  const bucket = [{ title: "Example Feed" }, { title: "Example Feed (2)" }];

  it("returns the title unchanged when there's no collision", () => {
    assert.equal(uniqueTitleInBucket(bucket, "Another Feed"), "Another Feed");
  });

  it("appends ' (2)' on a first collision", () => {
    assert.equal(uniqueTitleInBucket([{ title: "Example Feed" }], "Example Feed"), "Example Feed (2)");
  });

  it("counts up past already-taken suffixes", () => {
    assert.equal(uniqueTitleInBucket(bucket, "Example Feed"), "Example Feed (3)");
  });

  it("detects a collision case-insensitively", () => {
    assert.equal(uniqueTitleInBucket([{ title: "example feed" }], "Example Feed"), "Example Feed (2)");
  });
});

describe("articleId / rowToArticle", () => {
  it("builds a feedId::guid composite id", () => {
    assert.equal(articleId(7, "abc123"), "7::abc123");
  });

  it("converts integer read/saved columns to real booleans", () => {
    const article = rowToArticle({ id: "1::a", read: 1, saved: 0, title: "x" });
    assert.equal(article.read, true);
    assert.equal(article.saved, false);
  });
});
