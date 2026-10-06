// Seeds a fresh throwaway database for the e2e run. Uses the server's own data layer (so
// it goes through the real migrations) and never touches the network or the real database:
// FEED_READER_DATA_DIR points at e2e/.data, which is wiped first.
import fs from "node:fs";

const dir = process.env.FEED_READER_DATA_DIR;
if (!dir) throw new Error("FEED_READER_DATA_DIR must be set");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

// Imported only after the directory exists: the server opens its database at import time.
const db = await import("../../server/src/db.js");

const news = db.addCategory("News");
const sports = db.addCategory("Sports");
db.addCategory("Tech");

const bbc = db.addFeed("https://bbc.example.invalid/feed.xml", news, "BBC");
const nyt = db.addFeed("https://nyt.example.invalid/feed.xml", news, "New York Times");
const nba = db.addFeed("https://nba.example.invalid/feed.xml", sports, "NBA");

const now = Date.now();
function articles(prefix, count, offsetMinutes = 0) {
  return Array.from({ length: count }, (_, i) => ({
    guid: `${prefix}-${i}`,
    title: `${prefix.toUpperCase()} headline number ${i + 1}`,
    link: `https://${prefix}.example.invalid/article/${i + 1}`,
    isoDate: new Date(now - (offsetMinutes + i) * 60_000).toISOString(),
    contentSnippet: `A short summary for ${prefix} article ${i + 1}.`,
  }));
}

// 130 in one feed so "All Feeds" is longer than the 100-row render window.
db.upsertArticles(bbc, articles("bbc", 130));
db.upsertArticles(nyt, articles("nyt", 5, 200));
db.upsertArticles(nba, articles("nba", 5, 400));

console.log("e2e database seeded");
