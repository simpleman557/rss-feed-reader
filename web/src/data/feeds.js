async function requestJson(path) {
  // Both refresh endpoints take no body, which would otherwise make them the one thing
  // on this server any other site could trigger through your browser: a bodyless POST is
  // a "simple" request and crosses origins without a preflight. This header isn't simple,
  // so the browser must preflight it first — a check the server never approves for other
  // origins. See server/src/requestGuards.js.
  const res = await fetch(path, { method: "POST", headers: { "X-Feed-Reader": "1" } });
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
