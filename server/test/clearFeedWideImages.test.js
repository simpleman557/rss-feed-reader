import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MIGRATIONS } from "../src/migrations.js";
import { createTestDb, seedCategory, seedFeed, seedArticle, getArticle } from "./helpers.js";

const clearMigration = MIGRATIONS.find((m) => m.name === "clear feed-wide duplicate article images");

// createTestDb() already runs every migration once (against an empty articles table, so
// this one is a harmless no-op there) — fixture rows are seeded afterwards, then the
// migration is invoked again directly to exercise it against real data, exactly as it
// has to behave the first time it runs against an existing database in production.
function setupFeed() {
  const db = createTestDb();
  const categoryId = seedCategory(db);
  const feedId = seedFeed(db, categoryId);
  return { db, feedId };
}

describe("clear feed-wide duplicate article images", () => {
  it("nulls a logo repeated across every article, preserving read/saved state", () => {
    const { db, feedId } = setupFeed();
    const logo = "https://cdn.example.com/social-card.png";
    const ids = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        seedArticle(db, feedId, {
          imageUrl: logo,
          read: i === 0 ? 1 : 0,
          saved: i === 1 ? 1 : 0,
        })
      );
    }

    clearMigration.run(db);

    for (const id of ids) {
      assert.equal(getArticle(db, id).imageUrl, null, "the feed-wide logo should be cleared");
    }
    assert.equal(getArticle(db, ids[0]).read, 1, "read state must survive");
    assert.equal(getArticle(db, ids[1]).saved, 1, "saved state must survive");
  });

  it("leaves genuine per-article images untouched", () => {
    const { db, feedId } = setupFeed();
    const ids = [];
    for (let i = 0; i < 10; i++) {
      ids.push(seedArticle(db, feedId, { imageUrl: `https://cdn.example.com/img-${i}.jpg` }));
    }

    clearMigration.run(db);

    ids.forEach((id, i) => {
      assert.equal(getArticle(db, id).imageUrl, `https://cdn.example.com/img-${i}.jpg`);
    });
  });

  it("clears only the dominant image, keeping other images in the same feed", () => {
    const { db, feedId } = setupFeed();
    const logo = "https://cdn.example.com/logo.png";
    for (let i = 0; i < 9; i++) seedArticle(db, feedId, { imageUrl: logo });
    const realId = seedArticle(db, feedId, { imageUrl: "https://cdn.example.com/real.jpg" });

    clearMigration.run(db);

    assert.equal(getArticle(db, realId).imageUrl, "https://cdn.example.com/real.jpg");
    const remainingLogo = db
      .prepare("SELECT COUNT(*) AS n FROM articles WHERE imageUrl = ?")
      .get(logo).n;
    assert.equal(remainingLogo, 0);
  });

  it("is idempotent — a second run changes nothing", () => {
    const { db, feedId } = setupFeed();
    const logo = "https://cdn.example.com/social-card.png";
    for (let i = 0; i < 8; i++) seedArticle(db, feedId, { imageUrl: logo });

    clearMigration.run(db);
    assert.doesNotThrow(() => clearMigration.run(db));
    const withImages = db.prepare("SELECT COUNT(*) AS n FROM articles WHERE imageUrl IS NOT NULL").get().n;
    assert.equal(withImages, 0);
  });
});
