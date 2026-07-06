import express from "express";
import cors from "cors";
import { fetchAndParseFeed } from "./feedParser.js";
import categoriesRouter from "./routes/categories.js";
import feedsRouter from "./routes/feeds.js";
import articlesRouter from "./routes/articles.js";
import refreshRouter from "./routes/refresh.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get("/api/feed", async (req, res) => {
  const { url } = req.query;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing url query param" });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid url" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "url must be http or https" });
  }

  try {
    const feed = await fetchAndParseFeed(url);
    res.json(feed);
  } catch (err) {
    res.status(502).json({ error: `Failed to fetch/parse feed: ${err.message}` });
  }
});

app.use("/api/categories", categoriesRouter);
app.use("/api/feeds", feedsRouter);
app.use("/api/articles", articlesRouter);
app.use("/api/refresh", refreshRouter);

app.listen(PORT, () => {
  console.log(`Feed proxy server listening on http://localhost:${PORT}`);
});
