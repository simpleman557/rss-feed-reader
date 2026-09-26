import { safeFetch, isPublicUrl } from "./safeFetch.js";
import { getArticlesNeedingOgCheck, setArticleOgImage } from "./db.js";

const OG_FETCH_TIMEOUT_MS = 5000;
// OG tags live in <head>; reading up to 32 KB is enough for any real page, and we
// stop as soon as we hit the limit rather than throwing — unlike readTextCapped,
// which is designed for feeds (must reject oversized ones) and throws on excess.
const OG_MAX_BYTES = 32 * 1024;
const OG_USER_AGENT = "FeedReader/1.0";

// Reads at most maxBytes from res.body, then cancels the stream. Never throws on
// size — just stops early. Returns empty string if there is no body.
async function readPartialText(res, maxBytes) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const space = maxBytes - total;
      chunks.push(space < value.byteLength ? value.slice(0, space) : value);
      total += Math.min(value.byteLength, space);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

// Two bounded patterns rather than one combined, for the same reason as firstImgSrc
// in feedParser.js: a single regex with alternation can exhibit catastrophic
// backtracking on hostile HTML containing many "<meta" openings and no ">".
const META_TAG_REGEX = /<meta\s[^>]{0,500}>/gi;
const OG_PROPERTY_REGEX = /\bproperty\s*=\s*["']og:image["']/i;
const OG_CONTENT_REGEX = /\bcontent\s*=\s*["']([^"']{1,2000})["']/i;

async function fetchOgImage(url) {
  let res;
  try {
    res = await safeFetch(url, {
      headers: { "User-Agent": OG_USER_AGENT },
      timeoutMs: OG_FETCH_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const html = await readPartialText(res, OG_MAX_BYTES);
  META_TAG_REGEX.lastIndex = 0;
  let tag;
  while ((tag = META_TAG_REGEX.exec(html))) {
    if (!OG_PROPERTY_REGEX.test(tag[0])) continue;
    const m = OG_CONTENT_REGEX.exec(tag[0]);
    if (m?.[1]) return m[1];
  }
  return null;
}

// Finds articles in the given feed that haven't been OG-checked yet (imageUrl IS
// NULL, ogImageChecked IS NULL, inserted within the last 7 days) and fills in their
// imageUrl from the article page's og:image tag. Runs serially to avoid hammering
// the article host. Called as fire-and-forget from refreshFeed.js — never awaited,
// so it never delays the refresh response.
export async function fillOgImagesForFeed(feedId) {
  const articles = getArticlesNeedingOgCheck(feedId);
  for (const article of articles) {
    const now = new Date().toISOString();
    const raw = await fetchOgImage(article.link).catch(() => null);
    const imageUrl = raw && (await isPublicUrl(raw).catch(() => false)) ? raw : null;
    setArticleOgImage(article.id, imageUrl, now);
  }
}
