import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { purgeExpiredArticles } from "../src/retention.js";
import { createTestDb, seedCategory, seedFeed, seedArticle, getArticle, daysAgo } from "./helpers.js";

function setupFeed() {
  const db = createTestDb();
  const categoryId = seedCategory(db);
  const feedId = seedFeed(db, categoryId);
  return { db, feedId };
}

describe("purgeExpiredArticles", () => {
  it("deletes a never-read article published more than 30 days ago", () => {
    const { db, feedId } = setupFeed();
    const id = seedArticle(db, feedId, { isoDate: daysAgo(31) });

    purgeExpiredArticles(db);

    assert.equal(getArticle(db, id), undefined);
  });

  it("keeps a never-read article published less than 30 days ago", () => {
    const { db, feedId } = setupFeed();
    const id = seedArticle(db, feedId, { isoDate: daysAgo(29) });

    purgeExpiredArticles(db);

    assert.ok(getArticle(db, id));
  });

  it("falls back to insertedAt when isoDate is missing", () => {
    const { db, feedId } = setupFeed();
    const expiredId = seedArticle(db, feedId, { isoDate: null, insertedAt: daysAgo(31) });
    const freshId = seedArticle(db, feedId, { isoDate: null, insertedAt: daysAgo(1) });

    purgeExpiredArticles(db);

    assert.equal(getArticle(db, expiredId), undefined);
    assert.ok(getArticle(db, freshId));
  });

  it("gives a read article 30 days from readAt, not from publish date", () => {
    const { db, feedId } = setupFeed();
    // Published long ago, but read recently — should survive on the readAt anchor.
    const id = seedArticle(db, feedId, {
      isoDate: daysAgo(90),
      read: 1,
      readAt: daysAgo(10),
    });

    purgeExpiredArticles(db);

    assert.ok(getArticle(db, id));
  });

  it("deletes a read article once 30 days have passed since it was read", () => {
    const { db, feedId } = setupFeed();
    const id = seedArticle(db, feedId, {
      isoDate: daysAgo(90),
      read: 1,
      readAt: daysAgo(31),
    });

    purgeExpiredArticles(db);

    assert.equal(getArticle(db, id), undefined);
  });

  it("never deletes a saved article regardless of age", () => {
    const { db, feedId } = setupFeed();
    const id = seedArticle(db, feedId, {
      isoDate: daysAgo(400),
      read: 1,
      readAt: daysAgo(400),
      saved: 1,
    });

    purgeExpiredArticles(db);

    assert.ok(getArticle(db, id));
  });

  it("gives an unsaved article a fresh 30-day grace period from unsavedAt", () => {
    const { db, feedId } = setupFeed();
    // Old publish date, but only unsaved recently — must not be deleted immediately.
    const id = seedArticle(db, feedId, {
      isoDate: daysAgo(400),
      saved: 0,
      unsavedAt: daysAgo(1),
    });

    purgeExpiredArticles(db);

    assert.ok(getArticle(db, id));
  });

  it("deletes an unsaved article once 30 days have passed since it was unsaved", () => {
    const { db, feedId } = setupFeed();
    const id = seedArticle(db, feedId, {
      isoDate: daysAgo(400),
      saved: 0,
      unsavedAt: daysAgo(31),
    });

    purgeExpiredArticles(db);

    assert.equal(getArticle(db, id), undefined);
  });

  it("anchors on whichever of readAt/unsavedAt is more recent, not whichever is set", () => {
    const { db, feedId } = setupFeed();
    // readAt is old enough to have expired on its own; unsavedAt is recent and should
    // win via max(), keeping the article alive.
    const id = seedArticle(db, feedId, {
      isoDate: daysAgo(400),
      read: 1,
      readAt: daysAgo(60),
      saved: 0,
      unsavedAt: daysAgo(2),
    });

    purgeExpiredArticles(db);

    assert.ok(getArticle(db, id));
  });
});
