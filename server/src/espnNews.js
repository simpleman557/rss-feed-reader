import { safeFetch, readTextCapped, BlockedAddressError, ResponseTooLargeError } from "./safeFetch.js";

// ESPN's RSS feeds (www.espn.com/espn/rss/<league>/news) sit behind AWS WAF, which answers
// requests from cloud/data-center addresses (e.g. Cloud Run) with a JS challenge instead of
// the feed, whatever the User-Agent. ESPN's public JSON news API serves the same stories to
// those addresses, so a challenged ESPN feed is read from the API instead (feedParser.js).
// Only leagues whose RSS feed and API path are known to match are mapped.
const LEAGUE_API_PATHS = {
  nba: "basketball/nba",
  wnba: "basketball/wnba",
  ncb: "basketball/mens-college-basketball",
  nfl: "football/nfl",
  ncf: "football/college-football",
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
};

// The RSS feeds carry only these; the API also returns videos, game recaps and previews.
const RSS_ARTICLE_TYPES = new Set(["Story", "HeadlineNews"]);

const ESPN_RSS_PATH_REGEX = /^\/espn\/rss\/([a-z]+)\/news\/?$/;

// Same icon the RSS feeds declare in <image><url>.
const ESPN_FEED_IMAGE_URL = "https://a.espncdn.com/i/espn/teamlogos/lrg/trans/espn_dotcom_black.gif";

const MAX_API_BYTES = 5 * 1024 * 1024;

// The API URL for an ESPN league RSS feed, or null when the URL isn't one we can map.
export function espnNewsApiUrl(feedUrl) {
  let url;
  try {
    url = new URL(feedUrl);
  } catch {
    return null;
  }
  if (url.hostname !== "www.espn.com" && url.hostname !== "espn.com") return null;
  const league = ESPN_RSS_PATH_REGEX.exec(url.pathname)?.[1];
  const apiPath = league && LEAGUE_API_PATHS[league];
  if (!apiPath) return null;
  return `https://site.api.espn.com/apis/site/v2/sports/${apiPath}/news?limit=50`;
}

// Converts an API response into feedParser.js's feed shape. The guid matches the RSS feed's
// own (<guid>US-EN-<id></guid>), so an article seen through both sources is stored once.
export function parseEspnNews(json) {
  const articles = Array.isArray(json?.articles) ? json.articles : [];
  const items = articles
    .filter((a) => RSS_ARTICLE_TYPES.has(a?.type) && a.id != null && a.links?.web?.href)
    .map((a) => ({
      title: a.headline || "(untitled)",
      link: a.links.web.href,
      guid: `US-EN-${a.id}`,
      isoDate: a.published || null,
      contentSnippet: (a.description || "").trim().slice(0, 280),
      imageUrl: a.images?.find((img) => img?.url)?.url || null,
    }));
  return {
    title: json?.header ? `ESPN ${json.header}` : "ESPN",
    feedImageUrl: ESPN_FEED_IMAGE_URL,
    link: "https://www.espn.com",
    feedWideImageUrl: null,
    items,
  };
}

export async function fetchEspnNews(apiUrl, { headers, timeoutMs }) {
  let res;
  try {
    res = await safeFetch(apiUrl, { headers, timeoutMs });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`Timed out — ESPN's news API didn't respond after ${timeoutMs / 1000}s`);
    }
    if (err instanceof BlockedAddressError) throw new Error(err.message);
    throw new Error("Network error — couldn't reach ESPN's news API");
  }
  if (!res.ok) {
    throw new Error(`ESPN blocked the RSS feed, and its news API returned HTTP ${res.status}`);
  }
  let json;
  try {
    json = JSON.parse(await readTextCapped(res, MAX_API_BYTES, "ESPN news API response"));
  } catch (err) {
    if (err instanceof ResponseTooLargeError) throw new Error(err.message);
    throw new Error("Couldn't read ESPN's news API response");
  }
  return parseEspnNews(json);
}
