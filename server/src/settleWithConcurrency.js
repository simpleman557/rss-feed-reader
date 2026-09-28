// Like Promise.allSettled(items.map(fn)), but never more than `limit` calls in flight at
// once. Results come back in input order, each shaped exactly like allSettled's
// ({ status: "fulfilled", value } / { status: "rejected", reason }), so it drops in
// where allSettled was.
//
// Refreshing every feed at once was harmless with a dozen subscriptions, but an OPML
// import can bring in hundreds — and firing all of those fetches (plus their DNS
// lookups and icon/image follow-ups) in the same instant risks timeouts and rate limits
// from hosts that serve many feeds.
export async function settleWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
