import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTrackingPixel } from "../src/trackingPixel.js";

describe("isTrackingPixel", () => {
  it("flags an rss tracking pixel", () => {
    assert.equal(
      isTrackingPixel("https://media.example.org/include/images/tracking/site-rss-pixel.png?story=abc123"),
      true
    );
  });

  it("flags common tracking/spacer signatures", () => {
    for (const url of [
      "https://x.example/track/beacon.gif",
      "https://x.example/img/tracking-pixel.png",
      "https://x.example/pixel.gif",
      "https://x.example/assets/1x1.gif",
      "https://x.example/spacer.gif",
      "https://x.example/blank.gif",
      "https://x.example/transparent.gif",
    ]) {
      assert.equal(isTrackingPixel(url), true, url);
    }
  });

  it("leaves real article images alone", () => {
    for (const url of [
      "https://img.example.co.uk/images/ic/240x135/p0l7jnbt.jpg",
      "https://cdn.example.com/combiner/i?img=%2Fphoto%2F2026%2F0907.jpg",
      "https://media.example.com/photos/67b63b98/master.jpg",
      "https://news.example.com/wp-content/uploads/2026/08/GettyImages-123.jpg",
      "https://example.com/photos/pixelated-art-review.jpg",
    ]) {
      assert.equal(isTrackingPixel(url), false, url);
    }
  });

  it("returns false for empty/nullish input", () => {
    assert.equal(isTrackingPixel(null), false);
    assert.equal(isTrackingPixel(undefined), false);
    assert.equal(isTrackingPixel(""), false);
  });
});
