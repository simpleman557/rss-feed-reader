// The "keep it in place" memory behind App.jsx's lingering read/un-saved articles: id ->
// { read, saved } as of the last moment the reader moved on. See the snapshot comment in
// App.jsx for the full story.

// Folds a silent (background) refresh's articles into the memory without moving it on:
// existing entries are kept exactly as they were, and an article we hadn't seen yet is
// recorded as it arrived. Without that, a newly arrived article has no entry, counts as
// "already read", and vanishes the instant it is read.
export function mergeSnapshot(prev, articles) {
  const next = new Map();
  for (const a of articles) {
    next.set(a.id, prev.get(a.id) ?? { read: a.read, saved: a.saved });
  }
  return next;
}
