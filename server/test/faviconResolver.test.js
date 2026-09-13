import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import dns from "dns/promises";
import { extractIconCandidates, discoverFeedIcon, shouldDiscoverIcon } from "../src/faviconResolver.js";

describe("extractIconCandidates", () => {
  it("extracts a plain <link rel=\"icon\"> and resolves it against the base URL", () => {
    const html = `<link rel="icon" href="/favicon.png">`;
    const candidates = extractIconCandidates(html, "https://example.com/");
    assert.deepEqual(
      candidates.map((c) => c.href),
      ["https://example.com/favicon.png"]
    );
  });

  it("ranks apple-touch-icon above a plain icon", () => {
    const html = `
      <link rel="icon" href="/favicon.png">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    `;
    const candidates = extractIconCandidates(html, "https://example.com/");
    assert.equal(candidates[0].href, "https://example.com/apple-touch-icon.png");
  });

  it("ranks a mask-icon below a plain icon", () => {
    const html = `
      <link rel="mask-icon" href="/mask.svg">
      <link rel="icon" href="/favicon.png">
    `;
    const candidates = extractIconCandidates(html, "https://example.com/");
    assert.equal(candidates[0].href, "https://example.com/favicon.png");
  });

  it("prefers the largest declared size within the same rel tier", () => {
    const html = `
      <link rel="apple-touch-icon" sizes="57x57" href="/small.png">
      <link rel="apple-touch-icon" sizes="180x180" href="/large.png">
    `;
    const candidates = extractIconCandidates(html, "https://example.com/");
    assert.equal(candidates[0].href, "https://example.com/large.png");
  });

  it("matches rel values that merely contain 'icon', case-insensitively", () => {
    const html = `<link rel="Shortcut Icon" href="/favicon.ico">`;
    const candidates = extractIconCandidates(html, "https://example.com/");
    assert.equal(candidates.length, 1);
  });

  it("skips a <link> tag with no href", () => {
    const html = `<link rel="icon">`;
    assert.deepEqual(extractIconCandidates(html, "https://example.com/"), []);
  });

  it("skips a candidate whose href can't be resolved to a valid URL", () => {
    const html = `<link rel="icon" href="http://[bad">`;
    assert.deepEqual(extractIconCandidates(html, "https://example.com/"), []);
  });
});

describe("discoverFeedIcon", () => {
  beforeEach(() => {
    mock.method(globalThis, "fetch");
    // Fetches now go through safeFetch.js, which resolves each host and refuses private
    // addresses. Stubbed so these stay pure unit tests with no live DNS dependency;
    // safeFetch's own address checks are covered directly in safeFetch.test.js.
    mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    mock.restoreAll();
  });

  function fakeResponse({ ok = true, url, contentType = "image/png", byteLength = 1000 } = {}) {
    return {
      ok,
      url,
      status: ok ? 200 : 500,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(byteLength),
    };
  }

  // Serves `html` for the homepage fetch, then routes any other URL (a candidate icon
  // being validated) through `iconResponse`.
  function mockHomepageAndIcon(html, iconResponse) {
    globalThis.fetch.mock.mockImplementation(async (url) => {
      if (url === "https://example.com/") {
        return { ok: true, url, status: 200, headers: { get: () => null }, text: async () => html };
      }
      return iconResponse(url);
    });
  }

  it("returns the first candidate that passes validation", async () => {
    mockHomepageAndIcon(`<link rel="icon" href="/favicon.png">`, (url) => fakeResponse({ url }));

    const result = await discoverFeedIcon("https://example.com/");

    assert.equal(result, "https://example.com/favicon.png");
  });

  it("rejects a candidate whose content-type isn't an image", async () => {
    mockHomepageAndIcon(`<link rel="icon" href="/favicon.png">`, (url) =>
      fakeResponse({ url, contentType: "text/html" })
    );

    const result = await discoverFeedIcon("https://example.com/");

    assert.equal(result, null);
  });

  it("rejects a candidate that's suspiciously small (a near-blank stub)", async () => {
    mockHomepageAndIcon(`<link rel="icon" href="/favicon.png">`, (url) =>
      fakeResponse({ url, byteLength: 10 })
    );

    const result = await discoverFeedIcon("https://example.com/");

    assert.equal(result, null);
  });

  it("rejects a candidate that redirects back down to plain HTTP", async () => {
    // Simulates the BBC Sport failure mode: the HTTPS-upgraded request actually lands
    // back on an http:// URL after following a redirect.
    mockHomepageAndIcon(`<link rel="icon" href="/favicon.png">`, () =>
      fakeResponse({ url: "http://example.com/favicon.png" })
    );

    const result = await discoverFeedIcon("https://example.com/");

    assert.equal(result, null);
  });

  it("upgrades a declared http:// href to https:// before fetching it", async () => {
    const requestedUrls = [];
    globalThis.fetch.mock.mockImplementation(async (url) => {
      requestedUrls.push(url);
      if (url === "https://example.com/") {
        return {
          ok: true,
          url,
          status: 200,
          headers: { get: () => null },
          text: async () => `<link rel="icon" href="http://example.com/favicon.png">`,
        };
      }
      return fakeResponse({ url: "https://example.com/favicon.png" });
    });

    await discoverFeedIcon("https://example.com/");

    assert.ok(
      requestedUrls.includes("https://example.com/favicon.png"),
      `expected an https:// fetch, got: ${requestedUrls.join(", ")}`
    );
  });

  it("falls through to the next candidate when the first one fails validation", async () => {
    mockHomepageAndIcon(
      `<link rel="apple-touch-icon" href="/bad.png"><link rel="icon" href="/good.png">`,
      (url) => (url.endsWith("/bad.png") ? fakeResponse({ url, byteLength: 1 }) : fakeResponse({ url }))
    );

    const result = await discoverFeedIcon("https://example.com/");

    assert.equal(result, "https://example.com/good.png");
  });

  it("returns null when the homepage itself can't be fetched", async () => {
    globalThis.fetch.mock.mockImplementation(async (url) => ({
      ok: false,
      url,
      status: 500,
      headers: { get: () => null },
    }));

    const result = await discoverFeedIcon("https://example.com/");

    assert.equal(result, null);
  });

  it("returns null when nothing declared on the homepage survives validation", async () => {
    mockHomepageAndIcon(`<link rel="icon" href="/favicon.png">`, (url) =>
      fakeResponse({ url, contentType: "text/html" })
    );

    const result = await discoverFeedIcon("https://example.com/");

    assert.equal(result, null);
  });

  it("returns null immediately for a falsy siteUrl, without fetching anything", async () => {
    const result = await discoverFeedIcon(null);

    assert.equal(result, null);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });
});

describe("shouldDiscoverIcon", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = Date.parse("2026-02-01T00:00:00.000Z");

  it("returns true when the feed has never been checked", () => {
    assert.equal(shouldDiscoverIcon({ iconCheckedAt: null }, NOW), true);
  });

  it("returns false when checked recently", () => {
    const feed = { iconCheckedAt: new Date(NOW - 1 * DAY_MS).toISOString() };
    assert.equal(shouldDiscoverIcon(feed, NOW), false);
  });

  it("returns false just under the 30-day recheck interval", () => {
    const feed = { iconCheckedAt: new Date(NOW - 29 * DAY_MS).toISOString() };
    assert.equal(shouldDiscoverIcon(feed, NOW), false);
  });

  it("returns true right at the 30-day boundary", () => {
    const feed = { iconCheckedAt: new Date(NOW - 30 * DAY_MS).toISOString() };
    assert.equal(shouldDiscoverIcon(feed, NOW), true);
  });

  it("returns true well past the recheck interval", () => {
    const feed = { iconCheckedAt: new Date(NOW - 90 * DAY_MS).toISOString() };
    assert.equal(shouldDiscoverIcon(feed, NOW), true);
  });
});
