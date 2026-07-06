import { Router } from "express";
import { getArticles, markRead, toggleSaved } from "../db.js";

const router = Router();

router.get("/", (req, res) => {
  res.json(getArticles());
});

router.patch("/:id/read", (req, res) => {
  const { read = true } = req.body;
  markRead(req.params.id, read);
  res.status(204).end();
});

router.patch("/:id/saved", (req, res) => {
  const saved = toggleSaved(req.params.id);
  res.json({ saved });
});

export default router;
