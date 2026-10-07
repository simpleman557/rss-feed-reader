import { Router } from "express";
import { getFeeds, purgeExpiredArticles } from "../db.js";
import { refreshFeed } from "../refreshFeed.js";
import { requireAppRequestHeader } from "../requestGuards.js";
import { settleWithConcurrency } from "../settleWithConcurrency.js";
import { createRefreshCoordinator } from "../refreshCoordinator.js";

// Feeds fetched in parallel during a refresh-all; see settleWithConcurrency.js.
const REFRESH_CONCURRENCY = 10;

const router = Router();

// Refresh-all goes through a coordinator (refreshCoordinator.js): overlapping calls share
// one refresh, and one that finished in the last few minutes is reused. `?force=1` (the
// Refresh button) always fetches.
const refreshAll = createRefreshCoordinator({
  run: async () => {
    const feeds = getFeeds();
    const results = await settleWithConcurrency(feeds, REFRESH_CONCURRENCY, (feed) => refreshFeed(feed));
    const errors = results
      .map((r, i) => (r.status === "rejected" ? { feed: feeds[i], error: String(r.reason) } : null))
      .filter(Boolean);
    purgeExpiredArticles();
    return { count: feeds.length, errors };
  },
});

// Express 4 doesn't catch a rejected promise from an async handler, so without this a
// database error here was an unhandled rejection that took the whole process down (seen
// as 503s from Cloud Run) instead of a 500 for this one request.
router.post("/", requireAppRequestHeader, async (req, res, next) => {
  try {
    res.json(await refreshAll({ force: req.query.force === "1" }));
  } catch (err) {
    next(err);
  }
});

export default router;
