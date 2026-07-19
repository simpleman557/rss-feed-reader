// Pure helper functions used by db.js's business rules — no database connection
// involved, so they're plain functions operating on values already in memory. Kept in
// their own module (rather than db.js, which opens a real database connection as a
// side effect of being imported) so tests can import and exercise them directly,
// without any database setup at all. These are exactly the kind of logic that can
// silently regress without ever throwing: a locale-comparison edge case, an
// accidentally-symmetric URL normalization, an off-by-one in a disambiguation suffix.

export const RESERVED_CATEGORY_NAME = "uncategorized";

export function normalizeName(name) {
  return name.trim().toLowerCase();
}

// Position `key` alphabetically among `sortedList` (already ordered), skipping `excludeId`.
// Returns a fractional order value to slot it in without disturbing everyone else's order.
export function findAlphabeticalOrder(sortedList, getKey, key, excludeId) {
  const list = excludeId == null ? sortedList : sortedList.filter((x) => x.id !== excludeId);
  const insertIndex = list.findIndex(
    (x) => getKey(x).localeCompare(key, undefined, { sensitivity: "base" }) > 0
  );
  return insertIndex === -1 ? list.length : insertIndex - 0.5;
}

// Feeds are grouped into "buckets" by categoryId — every feed has one (see
// requireCategory in db.js), so in practice every bucket key is a real category id.
// `null` remains a valid bucket key for this function's own sake (it's a generic
// grouper, not feed-specific), it just should never occur for a feed row. Order values
// only need to be consistent within a bucket; they're allowed to overlap across buckets.
export function bucketOf(feeds, categoryId) {
  return feeds
    .filter((f) => (f.categoryId ?? null) === (categoryId ?? null))
    .sort((a, b) => a.order - b.order);
}

// Lowercases the host (scheme is collapsed — http/https treated as equivalent) and
// strips one trailing slash from the path; query string and path case are left alone
// since some feeds legitimately depend on them (e.g. `?format=rss`).
export function normalizeFeedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return `${u.host.toLowerCase()}${pathname}${u.search}`;
  } catch {
    return null;
  }
}

// Two different feeds can legitimately share the same real-world title (e.g. two
// editions of the same publication), so an auto-synced title that collides with a
// sibling's in the same bucket gets a " (2)", " (3)", etc. suffix instead of silently
// producing two identically-named feeds. Manual renames already reject collisions
// outright (see renameFeed in db.js); this just gives auto-sync a non-colliding default
// instead.
export function uniqueTitleInBucket(bucket, title) {
  const taken = new Set(bucket.map((f) => normalizeName(f.title)));
  if (!taken.has(normalizeName(title))) return title;
  let n = 2;
  while (taken.has(normalizeName(`${title} (${n})`))) n++;
  return `${title} (${n})`;
}

export function articleId(feedId, guid) {
  return `${feedId}::${guid}`;
}

export function rowToArticle(row) {
  return { ...row, read: !!row.read, saved: !!row.saved };
}
