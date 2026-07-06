async function requestJson(path) {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export function refreshFeed(feed) {
  return requestJson(`/api/feeds/${feed.id}/refresh`);
}

export function refreshAllFeeds() {
  return requestJson("/api/refresh");
}
