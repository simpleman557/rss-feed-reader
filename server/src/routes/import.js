import { Router } from "express";
import { importOpml } from "../db.js";

const router = Router();

// Body: { outlines } — the tree the browser parsed from an OPML file. Response:
// { feedsAdded, categoriesCreated, duplicates, invalid }. A file with nothing importable
// in it, or that's too big or deeply nested, is a ValidationError (400) from the planner.
router.post("/", (req, res) => {
  res.json(importOpml(req.body?.outlines));
});

export default router;
