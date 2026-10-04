import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { espnNewsApiUrl, parseEspnNews } from "../src/espnNews.js";

describe("espnNewsApiUrl", () => {
  it("maps ESPN league RSS feeds to the news API", () => {
    assert.equal(
      espnNewsApiUrl("https://www.espn.com/espn/rss/nba/news"),
      "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=50"
    );
    assert.equal(
      espnNewsApiUrl("https://espn.com/espn/rss/nfl/news/"),
      "https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50"
    );
  });

  it("returns null for unmapped leagues, other ESPN pages and other hosts", () => {
    assert.equal(espnNewsApiUrl("https://www.espn.com/espn/rss/news"), null);
    assert.equal(espnNewsApiUrl("https://www.espn.com/espn/rss/cricket/news"), null);
    assert.equal(espnNewsApiUrl("https://www.espn.com/nba/"), null);
    assert.equal(espnNewsApiUrl("https://evil.example/espn/rss/nba/news"), null);
    assert.equal(espnNewsApiUrl("https://www.espn.com.evil.example/espn/rss/nba/news"), null);
    assert.equal(espnNewsApiUrl("not a url"), null);
  });
});

describe("parseEspnNews", () => {
  const article = (over) => ({
    id: 50092448,
    type: "Story",
    headline: "LeBron calls scrimmage a great first step",
    description: "  The new-look 76ers held their first scrimmage.  ",
    published: "2026-10-04T00:40:19Z",
    images: [{ url: "https://a.espncdn.com/photo/2026/1004/r1.jpg" }],
    links: { web: { href: "https://www.espn.com/nba/story/_/id/50092448/lebron" } },
    ...over,
  });

  it("converts articles into feed items with the RSS feed's guid format", () => {
    const feed = parseEspnNews({ header: "NBA News", articles: [article()] });
    assert.equal(feed.title, "ESPN NBA News");
    assert.equal(feed.link, "https://www.espn.com");
    assert.equal(feed.feedWideImageUrl, null);
    assert.deepEqual(feed.items, [
      {
        title: "LeBron calls scrimmage a great first step",
        link: "https://www.espn.com/nba/story/_/id/50092448/lebron",
        guid: "US-EN-50092448",
        isoDate: "2026-10-04T00:40:19Z",
        contentSnippet: "The new-look 76ers held their first scrimmage.",
        imageUrl: "https://a.espncdn.com/photo/2026/1004/r1.jpg",
      },
    ]);
  });

  it("keeps only the item types the RSS feed carries", () => {
    const feed = parseEspnNews({
      articles: [
        article({ id: 1, type: "Story" }),
        article({ id: 2, type: "HeadlineNews" }),
        article({ id: 3, type: "Media" }),
        article({ id: 4, type: "Recap" }),
        article({ id: 5, type: "Preview" }),
      ],
    });
    assert.deepEqual(feed.items.map((i) => i.guid), ["US-EN-1", "US-EN-2"]);
  });

  it("skips articles without an id or web link, and tolerates missing fields", () => {
    const feed = parseEspnNews({
      articles: [
        article({ id: undefined }),
        article({ links: {} }),
        { id: 7, type: "Story", links: { web: { href: "https://www.espn.com/x" } } },
      ],
    });
    assert.deepEqual(feed.items, [
      { title: "(untitled)", link: "https://www.espn.com/x", guid: "US-EN-7", isoDate: null, contentSnippet: "", imageUrl: null },
    ]);
  });

  it("returns an empty feed for a malformed response", () => {
    assert.deepEqual(parseEspnNews(null).items, []);
    assert.deepEqual(parseEspnNews({ articles: "nope" }).items, []);
  });
});
