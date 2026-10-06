// A per-article image field is only useful when it's actually per-article. Some feeds
// embed the same site logo or social-card image in every entry's HTML, and the img-scan
// in feedParser.js dutifully picks it up as each item's "image" — one real feed, for
// instance, opened every item's description with the identical
// social-card PNG. Treated as an article image that then
// renders cropped (object-fit: cover) on every single row, it both looks wrong and hides
// the feed's own clean icon, which is the far better thing to show when there's no real
// article picture.
//
// This spots that situation from the one signal that distinguishes it: a single URL that
// dominates the feed. It returns the offending URL (so callers can drop it and fall back
// to the feed icon) or null when the images look genuinely per-article — which is the
// overwhelming norm. Measured across the subscribed feeds, real feeds repeat almost
// nothing (the most-repeated image in one real feed covered 7 of 343 items, ~2%), while the
// offending feed's covered all 95, so the two are separated by a wide margin and the threshold below sits
// comfortably between them.
export function dominantFeedImageUrl(imageUrls, { minItems = 5, minShare = 0.7 } = {}) {
  const present = imageUrls.filter(Boolean);
  // Below a handful of images, a coincidental repeat (two of three items sharing a hero
  // shot) isn't enough signal to call something a feed-wide logo, so leave it alone.
  if (present.length < minItems) return null;

  const counts = new Map();
  let topUrl = null;
  let topCount = 0;
  for (const url of present) {
    const next = (counts.get(url) || 0) + 1;
    counts.set(url, next);
    if (next > topCount) {
      topCount = next;
      topUrl = url;
    }
  }
  return topCount / present.length >= minShare ? topUrl : null;
}
