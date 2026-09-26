import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dominantFeedImageUrl } from "../src/feedWideImage.js";

describe("dominantFeedImageUrl", () => {
  it("flags a single image repeated across the whole feed (the Slashdot case)", () => {
    const logo = "https://a.fsdn.com/sd/twitter_icon_large.png";
    const urls = Array.from({ length: 95 }, () => logo);
    assert.equal(dominantFeedImageUrl(urls), logo);
  });

  it("returns null when images are genuinely per-article", () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://cdn.example.com/img-${i}.jpg`);
    assert.equal(dominantFeedImageUrl(urls), null);
  });

  it("leaves a feed alone when its most-repeated image is only a small minority", () => {
    // Mirrors a real feed (BBC repeated one image across ~2% of items): a handful of
    // shared images among many distinct ones is not a feed-wide logo.
    const urls = Array.from({ length: 100 }, (_, i) => `https://cdn.example.com/img-${i}.jpg`);
    for (let i = 0; i < 5; i++) urls[i] = "https://cdn.example.com/shared.jpg";
    assert.equal(dominantFeedImageUrl(urls), null);
  });

  it("ignores missing images when measuring the share", () => {
    // 6 present images, 5 of them identical -> the logo dominates the images that exist,
    // even though half the raw list is empty.
    const logo = "https://cdn.example.com/logo.png";
    const urls = [logo, logo, logo, logo, logo, "https://cdn.example.com/real.jpg", null, null, "", undefined];
    assert.equal(dominantFeedImageUrl(urls), logo);
  });

  it("does not act on a tiny feed, where a coincidental repeat isn't enough signal", () => {
    const logo = "https://cdn.example.com/logo.png";
    assert.equal(dominantFeedImageUrl([logo, logo, logo]), null);
  });

  it("returns null for an empty list", () => {
    assert.equal(dominantFeedImageUrl([]), null);
  });

  it("honours a caller-supplied threshold", () => {
    const logo = "https://cdn.example.com/logo.png";
    const urls = [logo, logo, logo, "a", "b", "c"]; // 3/6 = 0.5 share
    assert.equal(dominantFeedImageUrl(urls), null); // below default 0.7
    assert.equal(dominantFeedImageUrl(urls, { minShare: 0.5 }), logo);
  });
});
