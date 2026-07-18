import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MIGRATIONS } from "../src/migrations.js";
import { createTestDb, seedCategory, seedFeed, seedArticle, getArticle, articleCount } from "./helpers.js";

const dedupeMigration = MIGRATIONS.find((m) => m.name === "dedupe fragment-suffixed article ids");

// createTestDb() already runs every migration once (against an empty articles table, so
// migration 3 is a harmless no-op there) — fixture rows with fragment ids are seeded
// afterwards, then the migration is invoked again directly to exercise its merge logic
// against them. It's designed to be safe to run more than once (see migrations.js), so
// this is exactly the scenario it has to handle in production too.
function setupFeed() {
  const db = createTestDb();
  const categoryId = seedCategory(db);
  const feedId = seedFeed(db, categoryId);
  return { db, feedId };
}

describe("dedupe fragment-suffixed article ids", () => {
  it("merges two fragment rows (no pre-existing base row) into one", () => {
    const { db, feedId } = setupFeed();
    const baseId = `${feedId}::abc`;
    seedArticle(db, feedId, {
      id: `${baseId}#0`,
      title: "First version",
      insertedAt: "2026-01-01T00:00:00.000Z",
      read: 0,
      saved: 0,
    });
    seedArticle(db, feedId, {
      id: `${baseId}#8`,
      title: "Second version",
      insertedAt: "2026-01-02T00:00:00.000Z",
      read: 1,
      saved: 0,
    });

    dedupeMigration.run(db);

    assert.equal(articleCount(db), 1);
    const survivor = getArticle(db, baseId);
    assert.ok(survivor);
    assert.equal(survivor.title, "First version", "earliest-inserted row's content should win");
  });

  it("merges a fragment duplicate into its already-existing base row", () => {
    const { db, feedId } = setupFeed();
    const baseId = `${feedId}::xyz`;
    seedArticle(db, feedId, {
      id: baseId,
      title: "Original",
      insertedAt: "2026-01-01T00:00:00.000Z",
    });
    seedArticle(db, feedId, {
      id: `${baseId}#3`,
      title: "Edited version",
      insertedAt: "2026-01-05T00:00:00.000Z",
    });

    dedupeMigration.run(db);

    assert.equal(articleCount(db), 1);
    const survivor = getArticle(db, baseId);
    assert.ok(survivor);
    assert.equal(survivor.title, "Original");
  });

  it("ORs read/saved together across the group instead of picking one side", () => {
    const { db, feedId } = setupFeed();
    const baseId = `${feedId}::foo`;
    seedArticle(db, feedId, { id: `${baseId}#0`, read: 1, saved: 0 });
    seedArticle(db, feedId, { id: `${baseId}#1`, read: 0, saved: 1 });

    dedupeMigration.run(db);

    const survivor = getArticle(db, baseId);
    assert.equal(survivor.read, 1);
    assert.equal(survivor.saved, 1);
  });

  it("keeps the earliest non-null readAt across the merged group", () => {
    const { db, feedId } = setupFeed();
    const baseId = `${feedId}::bar`;
    seedArticle(db, feedId, { id: `${baseId}#0`, readAt: "2026-01-05T00:00:00.000Z" });
    seedArticle(db, feedId, { id: `${baseId}#1`, readAt: "2026-01-01T00:00:00.000Z" });

    dedupeMigration.run(db);

    const survivor = getArticle(db, baseId);
    assert.equal(survivor.readAt, "2026-01-01T00:00:00.000Z");
  });

  it("is a no-op when no article id contains a fragment", () => {
    const { db, feedId } = setupFeed();
    const idA = seedArticle(db, feedId, { title: "A" });
    const idB = seedArticle(db, feedId, { title: "B" });

    dedupeMigration.run(db);

    assert.equal(articleCount(db), 2);
    assert.ok(getArticle(db, idA));
    assert.ok(getArticle(db, idB));
  });
});
