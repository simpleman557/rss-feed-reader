// Response hardening applied to everything this server sends. Separate from
// requestGuards.js (which decides who may call) — this decides what the browser is told
// to do with the response.
//
// The Content-Security-Policy is the main event. No hole was found that it fixes today,
// but on this app an XSS would be unusually costly: script running on the app's own
// origin passes the Host check and can send the refresh header, so it would undo the
// rebinding and CSRF guards. Rendering full article HTML — a natural feature for a reader
// — is exactly where XSS tends to creep in later. The policy is strict because the app
// earns it: it loads its script and styles only from its own origin (the one-off theme
// script was moved out of the HTML into /theme-init.js precisely so 'self' suffices), and
// talks only to its own /api. Images are the one broad allowance — feed icons and article
// images legitimately come from anywhere, and an <img> can't execute anything — so any
// host plus data: (the placeholder icon) is permitted there.
//
// frame-ancestors 'none' (with X-Frame-Options: DENY for older browsers) is the
// clickjacking fix: nothing may frame this app, and nothing legitimately does.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: https: http:",
].join("; ");

export function securityHeaders(req, res, next) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Don't leak the referring URL to the arbitrary third-party hosts that serve feed
  // images; they don't need to know a request came from this app.
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}
