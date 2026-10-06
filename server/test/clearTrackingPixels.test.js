import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MIGRATIONS } from "../src/migrations.js";
import { createTestDb, seedCategory, seedFeed, seedArticle, getArticle } from "./helpers.js";

const clearMigration = MIGRATIONS.find((m) => m.name === "clear tracking-pixel article images");

function setupFeed() {
  const db = createTestDb();
  const categoryId = seedCategory(db);
  const feedId = seedFeed(db, categoryId);
  return { db, feedId };
}

describe("clear tracking-pixel article images", () => {
  it("nulls a stored tracking pixel, preserving read/saved state", () => {
    const { db, feedId } = setupFeed();
    const id = seedArticle(db, feedId, {
      imageUrl: "https://media.example.org/include/images/tracking/site-rss-pixel.png?story=abc123",
      read: 1,
      saved: 1,
    });

    clearMigration.run(db);

    const row = getArticle(db, id);
    assert.equal(row.imageUrl, null);
    assert.equal(row.read, 1);
    assert.equal(row.saved, 1);
  });

  it("leaves genuine article images untouched", () => {
    const { db, feedId } = setupFeed();
    const keep = seedArticle(db, feedId, { imageUrl: "https://img.example.co.uk/images/ic/240x135/p0l7jnbt.jpg" });
    const nullId = seedArticle(db, feedId, { imageUrl: null });

    clearMigration.run(db);

    assert.equal(getArticle(db, keep).imageUrl, "https://img.example.co.uk/images/ic/240x135/p0l7jnbt.jpg");
    assert.equal(getArticle(db, nullId).imageUrl, null);
  });

  it("is idempotent", () => {
    const { db, feedId } = setupFeed();
    seedArticle(db, feedId, { imageUrl: "https://x.example/pixel.gif" });
    clearMigration.run(db);
    assert.doesNotThrow(() => clearMigration.run(db));
    const withImages = db.prepare("SELECT COUNT(*) AS n FROM articles WHERE imageUrl IS NOT NULL").get().n;
    assert.equal(withImages, 0);
  });
});
