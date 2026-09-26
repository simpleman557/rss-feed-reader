import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTrackingPixel } from "../src/trackingPixel.js";

describe("isTrackingPixel", () => {
  it("flags NPR's rss tracking pixel", () => {
    assert.equal(
      isTrackingPixel("https://media.npr.org/include/images/tracking/npr-rss-pixel.png?story=nx-s1-5980066"),
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
      "https://ichef.bbci.co.uk/images/ic/240x135/p0l7jnbt.jpg",
      "https://a2.espncdn.com/combiner/i?img=%2Fphoto%2F2026%2F0907.jpg",
      "https://media.wired.com/photos/67b63b98fb14553f0ebd9ffd/master.jpg",
      "https://techcrunch.com/wp-content/uploads/2026/08/GettyImages-123.jpg",
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
