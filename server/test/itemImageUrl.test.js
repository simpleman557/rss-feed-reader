import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { itemImageUrl } from "../src/feedParser.js";

const mediaContent = (...attrs) => ({ "media:content": attrs.map(($) => ({ $ })) });

describe("itemImageUrl media:content", () => {
  it("uses an entry declared as an image", () => {
    assert.equal(
      itemImageUrl(mediaContent({ url: "https://cdn.example/a", medium: "image" })),
      "https://cdn.example/a"
    );
    assert.equal(
      itemImageUrl(mediaContent({ url: "https://cdn.example/b", type: "image/jpeg" })),
      "https://cdn.example/b"
    );
  });

  it("uses an undeclared entry whose URL is an image file (The Athletic)", () => {
    const url = "https://static01.nyt.com/athletic/uploads/wp/2026/09/27/GettyImages-1-scaled.jpg";
    assert.equal(itemImageUrl(mediaContent({ url })), url);
    assert.equal(itemImageUrl(mediaContent({ url: `${url}?w=1440` })), `${url}?w=1440`);
  });

  it("ignores an undeclared entry whose URL isn't an image file", () => {
    assert.equal(itemImageUrl(mediaContent({ url: "https://cdn.example/clip.mp4" })), null);
    assert.equal(itemImageUrl(mediaContent({ url: "https://cdn.example/media/123" })), null);
  });

  it("trusts a declared non-image even if the URL looks like an image", () => {
    assert.equal(itemImageUrl(mediaContent({ url: "https://cdn.example/poster.jpg", medium: "video" })), null);
  });

  it("skips a leading video entry to reach an image entry", () => {
    assert.equal(
      itemImageUrl(
        mediaContent(
          { url: "https://cdn.example/clip.mp4", medium: "video" },
          { url: "https://cdn.example/still.png" }
        )
      ),
      "https://cdn.example/still.png"
    );
  });
});
