import { Router } from "express";
import { getFeeds, purgeExpiredArticles } from "../db.js";
import { refreshFeed } from "../refreshFeed.js";

const router = Router();

router.post("/", async (req, res) => {
  const feeds = getFeeds();
  const results = await Promise.allSettled(feeds.map((feed) => refreshFeed(feed)));
  const errors = results
    .map((r, i) => (r.status === "rejected" ? { feed: feeds[i], error: String(r.reason) } : null))
    .filter(Boolean);
  purgeExpiredArticles();
  res.json({ count: feeds.length, errors });
});

export default router;
