import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import dns from "dns/promises";
import {
  isBlockedAddress,
  safeFetch,
  readTextCapped,
  BlockedAddressError,
  ResponseTooLargeError,
} from "../src/safeFetch.js";

// The address classifier is pure range arithmetic over values that never appear in
// normal use, so a wrong prefix length or a missed encoding would sit there silently —
// the fetch would just keep working, which is exactly the failure mode that matters.
describe("isBlockedAddress", () => {
  const blocked = [
    ["loopback", "127.0.0.1"],
    ["loopback, high in the /8", "127.255.255.254"],
    ["private 10/8", "10.1.2.3"],
    ["private 192.168/16", "192.168.0.216"],
    ["private 172.16/12, low edge", "172.16.0.0"],
    ["private 172.16/12, high edge", "172.31.255.255"],
    ["link-local", "169.254.1.1"],
    ["cloud metadata", "169.254.169.254"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["this-network", "0.0.0.0"],
    ["multicast", "224.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 unique-local", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped private", "::ffff:192.168.1.1"],
    // new URL() rewrites ::ffff:127.0.0.1 to this hex form, which the old check missed —
    // the address that got past the guard in the review that added these cases.
    ["IPv4-mapped loopback, hex form", "::ffff:7f00:1"],
    ["IPv4-mapped private, hex form", "::ffff:c0a8:101"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["IPv4-compatible loopback", "::127.0.0.1"],
    ["IPv4-compatible loopback, hex form", "::7f00:1"],
    ["NAT64-wrapped loopback", "64:ff9b::7f00:1"],
    ["NAT64-wrapped loopback, dotted", "64:ff9b::127.0.0.1"],
    ["unique-local fd00::/8", "fd12:3456:789a::1"],
    ["multicast ff02::", "ff02::1"],
  ];
  for (const [label, ip] of blocked) {
    it(`blocks ${label} (${ip})`, () => assert.equal(isBlockedAddress(ip), true));
  }

  const allowed = [
    ["a public host", "93.184.216.34"],
    ["just outside 172.16/12", "172.32.0.1"],
    ["just below 172.16/12", "172.15.255.255"],
    ["just outside 100.64/10", "100.128.0.1"],
    ["a public IPv6 address", "2606:2800:220:1:248:1893:25c8:1946"],
    ["another public IPv6 address", "2001:4860:4860::8888"],
    ["IPv4-mapped PUBLIC address stays allowed", "::ffff:8.8.8.8"],
    ["IPv4-mapped PUBLIC address, hex form", "::ffff:808:808"],
    ["NAT64-wrapped PUBLIC address", "64:ff9b::808:808"],
  ];
  for (const [label, ip] of allowed) {
    it(`allows ${label} (${ip})`, () => assert.equal(isBlockedAddress(ip), false));
  }

  it("refuses an unparseable address rather than guessing", () => {
    assert.equal(isBlockedAddress("not-an-ip"), true);
    assert.equal(isBlockedAddress(""), true);
    assert.equal(isBlockedAddress("999.1.1.1"), true);
    assert.equal(isBlockedAddress("::gggg"), true);
    assert.equal(isBlockedAddress("1:2:3::4:5::6:7"), true); // two "::" is illegal
  });
});

describe("safeFetch", () => {
  beforeEach(() => {
    mock.method(globalThis, "fetch");
  });
  afterEach(() => mock.restoreAll());

  function stubDns(map) {
    mock.method(dns, "lookup", async (hostname) => {
      const address = map[hostname];
      if (!address) throw new Error("ENOTFOUND");
      return [{ address, family: address.includes(":") ? 6 : 4 }];
    });
  }

  function response({ status = 200, location = null, url = "" } = {}) {
    return { ok: status < 400, status, url, headers: { get: (n) => (n.toLowerCase() === "location" ? location : null) } };
  }

  it("fetches a public host normally", async () => {
    stubDns({ "example.com": "93.184.216.34" });
    globalThis.fetch.mock.mockImplementation(async (url) => response({ url }));

    const res = await safeFetch("https://example.com/feed.xml");

    assert.equal(res.status, 200);
    assert.equal(globalThis.fetch.mock.callCount(), 1);
  });

  it("refuses a hostname that resolves to a private address, without fetching", async () => {
    stubDns({ "internal.corp": "192.168.0.10" });
    await assert.rejects(() => safeFetch("http://internal.corp/"), BlockedAddressError);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });

  it("refuses a literal loopback URL", async () => {
    stubDns({ "127.0.0.1": "127.0.0.1" });
    await assert.rejects(() => safeFetch("http://127.0.0.1:8080/"), BlockedAddressError);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });

  // The whole point of per-hop validation: the URL handed in is public and passes, and
  // the redirect is where the attack actually lives.
  it("refuses a redirect that points inward, after allowing the first hop", async () => {
    stubDns({ "public.example": "93.184.216.34", "169.254.169.254": "169.254.169.254" });
    globalThis.fetch.mock.mockImplementation(async (url) =>
      url === "https://public.example/feed.xml"
        ? response({ status: 302, location: "http://169.254.169.254/latest/meta-data/", url })
        : response({ url })
    );

    await assert.rejects(() => safeFetch("https://public.example/feed.xml"), BlockedAddressError);
    // The first hop happened; the inward one never did.
    assert.equal(globalThis.fetch.mock.callCount(), 1);
  });

  it("follows a redirect that stays public", async () => {
    stubDns({ "feeds.example": "93.184.216.34", "publisher.example": "93.184.216.35" });
    globalThis.fetch.mock.mockImplementation(async (url) =>
      url === "https://feeds.example/rss"
        ? response({ status: 301, location: "https://publisher.example/rss.xml", url })
        : response({ url, status: 200 })
    );

    const res = await safeFetch("https://feeds.example/rss");

    assert.equal(res.status, 200);
    assert.equal(res.url, "https://publisher.example/rss.xml");
  });

  it("resolves a relative Location header against the current URL", async () => {
    stubDns({ "example.com": "93.184.216.34" });
    const seen = [];
    globalThis.fetch.mock.mockImplementation(async (url) => {
      seen.push(url);
      return url.endsWith("/moved")
        ? response({ status: 302, location: "/final.xml", url })
        : response({ url });
    });

    await safeFetch("https://example.com/moved");

    assert.deepEqual(seen, ["https://example.com/moved", "https://example.com/final.xml"]);
  });

  it("gives up on a redirect loop instead of following forever", async () => {
    stubDns({ "example.com": "93.184.216.34" });
    globalThis.fetch.mock.mockImplementation(async (url) =>
      response({ status: 302, location: "https://example.com/next", url })
    );

    await assert.rejects(() => safeFetch("https://example.com/start"), BlockedAddressError);
  });

  it("refuses a non-http(s) scheme", async () => {
    await assert.rejects(() => safeFetch("file:///etc/passwd"), BlockedAddressError);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });

  it("refuses a host with any private address among several", async () => {
    mock.method(dns, "lookup", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await assert.rejects(() => safeFetch("https://split-horizon.example/"), BlockedAddressError);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });
});

// Nothing obliges a remote server to stop sending, and Content-Length is a hint rather
// than a promise, so the ceiling has to hold while the body is still arriving.
describe("readTextCapped", () => {
  function streamed(chunks, headers = {}) {
    let i = 0;
    return {
      headers: { get: (n) => headers[n.toLowerCase()] ?? null },
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
          cancel: async () => {},
        }),
      },
    };
  }
  const chunk = (n) => new Uint8Array(n).fill(97); // "a" * n

  it("returns the body when it fits", async () => {
    const text = await readTextCapped(streamed([chunk(10), chunk(10)]), 1000);
    assert.equal(text.length, 20);
  });

  it("refuses a body that exceeds the cap mid-stream", async () => {
    await assert.rejects(
      () => readTextCapped(streamed([chunk(600), chunk(600)]), 1000),
      ResponseTooLargeError
    );
  });

  it("refuses early when Content-Length already exceeds the cap", async () => {
    await assert.rejects(
      () => readTextCapped(streamed([chunk(10)], { "content-length": "999999" }), 1000),
      ResponseTooLargeError
    );
  });

  it("does not trip on a body exactly at the cap", async () => {
    const text = await readTextCapped(streamed([chunk(1000)]), 1000);
    assert.equal(text.length, 1000);
  });
});
