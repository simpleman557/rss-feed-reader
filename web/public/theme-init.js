// Applies a saved Light/Dark override before first paint, to avoid a flash of the wrong
// theme. Absence of the key means "system", which the CSS handles on its own.
//
// Kept as a separate file rather than an inline <script> so the server's Content-Security-
// Policy can be script-src 'self' with no inline exception (see server/src/securityHeaders.js).
// It must stay a plain, render-blocking <script> in <head> — before the module bundle and
// the stylesheet — so the data-theme attribute is set before anything paints.
try {
  var t = localStorage.getItem("theme");
  if (t === "light" || t === "dark") {
    document.documentElement.setAttribute("data-theme", t);
    // Match the browser-bar color (see theme.js's syncThemeColor); <head> metas are already parsed.
    var c = t === "light" ? "#f7f8fa" : "#0a0c11";
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) { m.content = c; });
  }
} catch {
  // localStorage can throw in private mode; there's nothing to do but fall back to system.
}
