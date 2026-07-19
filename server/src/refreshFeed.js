import { syncFeedMetadata, upsertArticles } from "./db.js";
import { fetchAndParseFeed } from "./feedParser.js";
import { discoverFeedIcon, shouldDiscoverIcon } from "./faviconResolver.js";

// Shared by the single-feed refresh route (fired right after adding a feed) and the
// refresh-all-feeds route, so both persist results identically.
export async function refreshFeed(feed) {
  const data = await fetchAndParseFeed(feed.url);

  let feedImageUrl = feed.feedImageUrl;
  let iconCheckedAt = feed.iconCheckedAt;
  if (shouldDiscoverIcon(feed)) {
    const discovered = await discoverFeedIcon(data.link);
    // Prefer a freshly discovered icon. If this check didn't find one — a first sync
    // with nothing declared, or a periodic recheck that failed (site briefly down,
    // etc.) — fall back to whatever icon the feed already had rather than the cheap
    // RSS-derived guess, so a transient recheck failure can never downgrade an
    // already-good discovered icon; the cheap guess is only used when there's truly
    // nothing better yet.
    feedImageUrl = discovered || feed.feedImageUrl || data.feedImageUrl || null;
    iconCheckedAt = new Date().toISOString();
  }

  syncFeedMetadata(feed.id, data.title || feed.title, feedImageUrl, data.link ?? null, iconCheckedAt);
  upsertArticles(feed.id, data.items || []);
  return data;
}
