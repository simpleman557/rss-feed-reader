// Many feeds open every item's HTML with a 1x1 tracking/telemetry pixel (NPR's is
// .../tracking/npr-rss-pixel.png?story=...). It's a real, loadable image, so it can't be
// caught as a broken <img src> in the browser — it just renders as a blank box where a
// thumbnail should be — and it carries a per-article id in its query, so the feed-wide
// image detection (feedWideImage.js) can't spot it either. Matching it by URL is the only
// reliable signal.
//
// The pattern is kept deliberately narrow — well-known tracking/spacer signatures only (a
// "/tracking/" path segment, a "pixel"/"beacon" filename token, a 1x1 marker, or a named
// spacer gif) — so it won't swallow a real photo whose URL merely contains one of these
// words somewhere. Lives in its own module so both feedParser.js (which drops these while
// scanning item HTML) and migrations.js (which clears ones already stored) can share it
// without either pulling in the other's dependencies.
// "pixel", "beacon" and "1x1" are matched only as whole tokens (not letters/digits on
// either side) so "pixelated-art.jpg" or "240x135" aren't mistaken for pixels.
const TRACKING_PIXEL_REGEX =
  /\/tracking\/|(?<![a-z])pixel(?![a-z])|(?<![a-z])beacon(?![a-z])|(?<![a-z0-9])1x1(?![a-z0-9])|(?:spacer|blank|clear|transparent|dot)\.gif/i;

export function isTrackingPixel(url) {
  return !!url && TRACKING_PIXEL_REGEX.test(url);
}
