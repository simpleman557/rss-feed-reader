import { Router } from "express";
import { getCategories, addCategory, updateCategoryName, deleteCategory } from "../db.js";

const router = Router();

router.get("/", (req, res) => {
  res.json(getCategories());
});

router.post("/", (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    const id = addCategory(name);
    res.status(201).json({ id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/:id", (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    updateCategoryName(Number(req.params.id), name);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/:id", (req, res) => {
  deleteCategory(Number(req.params.id));
  res.status(204).end();
});

export default router;
