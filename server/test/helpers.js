// Shared fixtures for tests that need a real (but throwaway) database — an in-memory
// SQLite instance bootstrapped through the actual migration pipeline, so tests exercise
// the real schema rather than a hand-copied approximation of it that could drift out of
// sync with the real one.
import Database from "better-sqlite3";
import { runMigrations } from "../src/migrations.js";

export function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

export function seedCategory(db, name = "Test Category") {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO categories (name, "order") VALUES (?, 0)')
    .run(name);
  return lastInsertRowid;
}

export function seedFeed(db, categoryId, overrides = {}) {
  const feed = {
    url: "https://example.com/feed.xml",
    title: "Test Feed",
    feedImageUrl: null,
    siteUrl: null,
    order: 0,
    ...overrides,
  };
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO feeds (url, categoryId, title, feedImageUrl, siteUrl, "order") VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(feed.url, categoryId, feed.title, feed.feedImageUrl, feed.siteUrl, feed.order);
  return lastInsertRowid;
}

// `daysAgo` is a convenience for building fixture timestamps relative to now, since
// retention rules are entirely about elapsed time.
export function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

export function seedArticle(db, feedId, overrides = {}) {
  const article = {
    id: `${feedId}::${Math.random().toString(36).slice(2)}`,
    title: "Test Article",
    link: "https://example.com/article",
    isoDate: null,
    insertedAt: new Date().toISOString(),
    contentSnippet: "",
    imageUrl: null,
    read: 0,
    readAt: null,
    saved: 0,
    unsavedAt: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO articles (id, feedId, title, link, isoDate, insertedAt, contentSnippet, imageUrl, read, readAt, saved, unsavedAt)
     VALUES (@id, @feedId, @title, @link, @isoDate, @insertedAt, @contentSnippet, @imageUrl, @read, @readAt, @saved, @unsavedAt)`
  ).run({ ...article, feedId });
  return article.id;
}

export function getArticle(db, id) {
  return db.prepare("SELECT * FROM articles WHERE id = ?").get(id);
}

export function articleCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM articles").get().n;
}
