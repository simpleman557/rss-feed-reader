import { syncFeedMetadata, upsertArticles } from "./db.js";
import { fetchAndParseFeed } from "./feedParser.js";
import { discoverFeedIcon, shouldDiscoverIcon } from "./faviconResolver.js";
import { isPublicUrl } from "./safeFetch.js";

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
    // data.feedImageUrl is chosen by the feed itself (its <image><url>, or a favicon path
    // derived from the feed's <link>) and, unlike `discovered`, never went through
    // safeFetch. It gets stored and later rendered as an <img src> in the browser, so a
    // hostile feed could otherwise point it at a device on the user's network
    // (http://192.168.1.1/...). Adopt it only if it's a public http(s) URL. feed.feedImageUrl
    // needs no recheck: it only ever holds a value this same code already vetted.
    const feedProvidedIcon =
      data.feedImageUrl && (await isPublicUrl(data.feedImageUrl)) ? data.feedImageUrl : null;
    feedImageUrl = discovered || feed.feedImageUrl || feedProvidedIcon || null;
    iconCheckedAt = new Date().toISOString();
  }

  syncFeedMetadata(feed.id, data.title || feed.title, feedImageUrl, data.link ?? null, iconCheckedAt);
  upsertArticles(feed.id, data.items || []);
  return data;
}
