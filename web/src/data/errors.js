// Turns a failed API call into a message that says what actually went wrong.
//
// The data layer (db.js, feeds.js) attaches the HTTP status to the Error it throws. A
// `fetch` that rejects outright — the network is down, or the connection was cut — has no
// status, and is the only case where "couldn't reach the server" is true. Before this,
// every failure said that, so a database error on a perfectly healthy server read as
// "make sure it's running" and sent the reader looking in the wrong place.
//
// `action` is "load" (fetching categories, feeds and articles) or "refresh" (fetching new
// articles from the feeds themselves).
export function describeFailure(err, action) {
  const status = err?.status;

  if (typeof status === "number" && status >= 500) {
    return action === "refresh"
      ? `The server hit an error while refreshing (${status}). Try again; if it keeps happening, check the server logs.`
      : `The server hit an error loading your feeds (${status}). Try Refresh; if it keeps happening, check the server logs.`;
  }

  if (typeof status === "number") {
    return action === "refresh"
      ? `The server turned down the refresh request (${status}).`
      : `The server turned down the request for your feeds (${status}).`;
  }

  return action === "refresh"
    ? "Couldn't refresh — check your connection and try again."
    : "Couldn't reach the server. Make sure it's running, then hit Refresh.";
}
