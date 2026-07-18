import { syncFeedMetadata, upsertArticles } from "./db.js";
import { fetchAndParseFeed } from "./feedParser.js";
import { discoverFeedIcon } from "./faviconResolver.js";

// Shared by the single-feed refresh route (fired right after adding a feed) and the
// refresh-all-feeds route, so both persist results identically.
export async function refreshFeed(feed) {
  const data = await fetchAndParseFeed(feed.url);

  // Icon discovery fetches and parses the site's homepage — worth it once, not worth
  // repeating on every refresh. Runs only the first time a feed is synced (still has
  // its URL-placeholder title) or if a previous attempt never landed an icon at all
  // (site was down, etc.) — self-healing without re-fetching a homepage that already
  // gave us a good result.
  const isFirstSync = feed.title === feed.url;
  const shouldDiscover = isFirstSync || !feed.feedImageUrl;
  const discovered = shouldDiscover ? await discoverFeedIcon(data.link) : null;
  const feedImageUrl = discovered || (shouldDiscover ? data.feedImageUrl ?? null : feed.feedImageUrl);

  syncFeedMetadata(feed.id, data.title || feed.title, feedImageUrl, data.link ?? null);
  upsertArticles(feed.id, data.items || []);
  return data;
}
