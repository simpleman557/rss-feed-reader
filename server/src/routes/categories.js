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
  const id = addCategory(name);
  res.status(201).json({ id });
});

router.patch("/:id", (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }
  updateCategoryName(Number(req.params.id), name);
  res.status(204).end();
});

router.delete("/:id", (req, res) => {
  deleteCategory(Number(req.params.id));
  res.status(204).end();
});

export default router;
