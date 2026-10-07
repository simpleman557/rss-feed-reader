async function requestJson(path) {
  // Both refresh endpoints take no body, which would otherwise make them the one thing
  // on this server any other site could trigger through your browser: a bodyless POST is
  // a "simple" request and crosses origins without a preflight. This header isn't simple,
  // so the browser must preflight it first — a check the server never approves for other
  // origins. See server/src/requestGuards.js.
  const res = await fetch(path, { method: "POST", headers: { "X-Feed-Reader": "1" } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status; // lets the UI tell a server error from a network failure
    throw err;
  }
  return res.json();
}

export function refreshFeed(feed) {
  return requestJson(`/api/feeds/${feed.id}/refresh`);
}

// `force` is for a deliberate click on Refresh. Without it the server may answer with a
// refresh that finished in the last few minutes instead of fetching everything again (see
// server/src/refreshCoordinator.js), which is what page loads and the timer want.
export function refreshAllFeeds({ force = false } = {}) {
  return requestJson(force ? "/api/refresh?force=1" : "/api/refresh");
}
