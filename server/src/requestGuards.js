// Checks that run before any route: who is allowed to talk to this server at all. No
// database or network involved, so these are tested directly (test/requestGuards.test.js).

// DNS rebinding. A page served from attacker.example can, after it has loaded, change
// that name's DNS to point at 127.0.0.1. Its later requests then land on this server
// while the browser still considers them same-origin — so neither the loopback bind nor
// the absence of CORS headers helps, and the page can read and change everything here.
// The one thing such a page cannot fake is the Host header: scripts aren't allowed to
// set it, so it still says attacker.example. Accepting only loopback names closes it.
//
// The port deliberately isn't checked. In development the Vite dev server proxies /api
// to this port and the Host it forwards may name either port, and the port is not what
// distinguishes a rebound attacker from a real local client — the hostname is.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHostname(hostname) {
  return typeof hostname === "string" && LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

export function requireLoopbackHost(req, res, next) {
  // req.hostname is the Host header with its port removed. It would prefer
  // X-Forwarded-Host only if Express's "trust proxy" setting were enabled, which it
  // isn't, so a client can't talk its way past this by sending that header.
  if (isLoopbackHostname(req.hostname)) return next();
  res.status(403).json({ error: "Forbidden: unrecognized Host header" });
}

// Cross-site request forgery on bodyless POSTs. Any site can have a browser send a plain
// cross-origin POST with no body and no preflight; it just never gets to see the reply.
// That's harmless for the other state-changing routes here — they're PATCH or DELETE, or
// they need a JSON body, and either of those forces a CORS preflight this server doesn't
// answer — but the two refresh routes take no body at all, so a malicious page could
// otherwise fire them at will and keep this server fetching feeds. Requiring a header
// that no simple request may carry forces that same preflight, so the POST is never sent.
export const APP_REQUEST_HEADER = "X-Feed-Reader";

export function requireAppRequestHeader(req, res, next) {
  if (req.get(APP_REQUEST_HEADER) === "1") return next();
  res.status(403).json({ error: `Forbidden: missing ${APP_REQUEST_HEADER} header` });
}
