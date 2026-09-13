import { Router } from "express";
import { getFeeds, addFeed, renameFeed, updateFeedCategory, deleteFeed } from "../db.js";
import { refreshFeed } from "../refreshFeed.js";
import { requireAppRequestHeader } from "../requestGuards.js";

const router = Router();

router.get("/", (req, res) => {
  res.json(getFeeds());
});

router.post("/", (req, res) => {
  const { url, categoryId, title } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required" });
  }
  const id = addFeed(url, categoryId ?? null, title);
  res.status(201).json({ id });
});

router.patch("/:id", (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }
  renameFeed(Number(req.params.id), title);
  res.status(204).end();
});

router.patch("/:id/category", (req, res) => {
  const { categoryId } = req.body;
  updateFeedCategory(Number(req.params.id), categoryId ?? null);
  res.status(204).end();
});

router.delete("/:id", (req, res) => {
  deleteFeed(Number(req.params.id));
  res.status(204).end();
});

router.post("/:id/refresh", requireAppRequestHeader, async (req, res) => {
  const feedId = Number(req.params.id);
  const feed = getFeeds().find((f) => f.id === feedId);
  if (!feed) {
    return res.status(404).json({ error: "Feed not found" });
  }
  try {
    const data = await refreshFeed(feed);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to fetch/parse feed: ${err.message}` });
  }
});

export default router;
