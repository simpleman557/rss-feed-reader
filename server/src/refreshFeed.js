import { syncFeedMetadata, upsertArticles } from "./db.js";
import { fetchAndParseFeed } from "./feedParser.js";

// Shared by the single-feed refresh route (fired right after adding a feed) and the
// refresh-all-feeds route, so both persist results identically.
export async function refreshFeed(feed) {
  const data = await fetchAndParseFeed(feed.url);
  syncFeedMetadata(feed.id, data.title || feed.title, data.feedImageUrl ?? null);
  upsertArticles(feed.id, data.items || []);
  return data;
}
