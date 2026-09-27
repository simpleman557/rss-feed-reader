import { Router } from "express";
import { getFeeds, purgeExpiredArticles } from "../db.js";
import { refreshFeed } from "../refreshFeed.js";
import { requireAppRequestHeader } from "../requestGuards.js";
import { settleWithConcurrency } from "../settleWithConcurrency.js";

// Feeds fetched in parallel during a refresh-all; see settleWithConcurrency.js.
const REFRESH_CONCURRENCY = 10;

const router = Router();

router.post("/", requireAppRequestHeader, async (req, res) => {
  const feeds = getFeeds();
  const results = await settleWithConcurrency(feeds, REFRESH_CONCURRENCY, (feed) => refreshFeed(feed));
  const errors = results
    .map((r, i) => (r.status === "rejected" ? { feed: feeds[i], error: String(r.reason) } : null))
    .filter(Boolean);
  purgeExpiredArticles();
  res.json({ count: feeds.length, errors });
});

export default router;
