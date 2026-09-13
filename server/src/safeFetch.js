// Outbound-fetch guard for everything this server retrieves on a feed's behalf.
//
// Every URL we fetch is ultimately chosen by someone else: the feed URL comes from the
// user, but the homepage comes from the feed's own <link> element and the icon href
// comes from that homepage's HTML. A plain fetch() would happily follow any of those
// into the private network — loopback, the LAN, link-local — which is a server-side
// request forgery (SSRF) primitive handed to whoever publishes the feed.
//
// Two things matter, and the second is the one that's easy to miss:
//   1. Reject an address that isn't publicly routable.
//   2. Re-check after EVERY redirect. Validating only the URL passed in is a front-door
//      check on a house with an unlocked back door — a public-looking URL that 302s to
//      127.0.0.1 defeats it completely. So redirects are followed manually here, one hop
//      at a time, with the same check applied to each hop's destination.
//
// Feeds legitimately redirect (FeedBurner to the publisher, http to https, moved
// domains), so refusing redirects outright isn't an option — each hop is validated
// instead. Real feeds are public, so nothing legitimate is blocked by any of this.
//
// Known residual gap: the DNS lookup that validates a hostname and the connection that
// actually follows it are separate steps, so a DNS entry that changes between the two
// (a "DNS rebinding" attack, which needs the attacker to run their own DNS server and
// win a timing race) isn't covered. Closing that requires pinning the socket to the
// validated IP via a custom fetch dispatcher — a large amount of machinery for a
// single-user local app whose realistic threat is a hostile feed, not a targeted
// attacker. Documented rather than silently ignored.
import dns from "dns/promises";

const MAX_REDIRECTS = 5;

// Thrown when a target resolves somewhere non-public. Distinct from a network failure so
// callers can tell "refused on purpose" from "couldn't connect" and say so in the UI.
export class BlockedAddressError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

// Everything that isn't a normal public destination: this machine, the local network,
// the link-local range (which is also where cloud metadata services live), carrier-grade
// NAT, benchmarking, multicast and reserved space.
const BLOCKED_V4_RANGES = [
  ["0.0.0.0", 8],          // "this network"
  ["10.0.0.0", 8],         // private
  ["100.64.0.0", 10],      // carrier-grade NAT
  ["127.0.0.0", 8],        // loopback
  ["169.254.0.0", 16],     // link-local, incl. cloud metadata at 169.254.169.254
  ["172.16.0.0", 12],      // private
  ["192.0.0.0", 24],       // IETF protocol assignments
  ["192.168.0.0", 16],     // private
  ["198.18.0.0", 15],      // benchmarking
  ["224.0.0.0", 4],        // multicast
  ["240.0.0.0", 4],        // reserved, incl. 255.255.255.255
];

function isBlockedV4(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable — refuse rather than guess
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
  });
}

// Expands an IPv6 string to its 16 bytes, or null if it doesn't parse. Handles "::"
// compression and a trailing dotted-quad (::ffff:127.0.0.1). Whatever new URL() hands us
// has already been normalized to the hex form (::ffff:7f00:1), but we accept both, plus
// anything dns.lookup might return, rather than trusting one spelling.
function parseIPv6ToBytes(input) {
  let addr = input.toLowerCase().split("%")[0]; // drop any zone index

  // A trailing IPv4 dotted-quad (the last group) becomes two hex hextets, so the rest of
  // the parser only ever deals in hextets.
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":");
    if (lastColon === -1) return null;
    const v4 = ipv4ToInt(addr.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null; // "::" may appear at most once
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

  let hextets;
  if (tail === null) {
    hextets = head; // no "::" — must be exactly 8 groups
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // "::" must stand for at least one zero group
    hextets = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (hextets.length !== 8) return null;

  const bytes = [];
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    const n = parseInt(h, 16);
    bytes.push((n >>> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

// The three ways an IPv4 address rides inside an IPv6 one. Each maps to a real IPv4
// destination, so the embedded address is pulled out and run through the IPv4 rules —
// otherwise http://[::ffff:127.0.0.1]/ reaches loopback while http://127.0.0.1/ is
// blocked, which was the actual bug this replaced.
function embeddedV4(bytes) {
  const zeros = (upTo) => bytes.slice(0, upTo).every((b) => b === 0);
  const asV4 = () => bytes.slice(12).join(".");
  // ::ffff:a.b.c.d — IPv4-mapped
  if (zeros(10) && bytes[10] === 0xff && bytes[11] === 0xff) return asV4();
  // 64:ff9b::a.b.c.d — the well-known NAT64 prefix
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((b) => b === 0)) {
    return asV4();
  }
  // ::a.b.c.d — deprecated IPv4-compatible (but not :: or ::1 themselves)
  if (zeros(12) && !(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] <= 1)) {
    return asV4();
  }
  return null;
}

function isBlockedV6(ip) {
  const bytes = parseIPv6ToBytes(ip);
  if (bytes === null) return true; // unparseable — refuse rather than guess

  const embedded = embeddedV4(bytes);
  if (embedded !== null) return isBlockedV4(embedded);

  if (bytes.every((b) => b === 0)) return true;                       // :: unspecified
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1 loopback
  if ((bytes[0] & 0xfe) === 0xfc) return true;                        // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;   // fe80::/10 link-local
  if (bytes[0] === 0xff) return true;                                 // ff00::/8 multicast
  return false;
}

// Exported for direct testing — this is exactly the kind of range arithmetic that can be
// subtly wrong (an off-by-one in a prefix, a missed v4-mapped form) without ever throwing.
export function isBlockedAddress(ip, family) {
  if (!ip) return true;
  return family === 6 || ip.includes(":") ? isBlockedV6(ip) : isBlockedV4(ip);
}

// Resolves the hostname and refuses if ANY address it maps to is non-public — a host
// with both a public and a private record shouldn't be usable as a way in. Note this
// checks the resolved addresses rather than the text of the hostname, so obfuscated
// literals (http://2130706433/, http://0177.0.0.1/) are caught for free: whatever they
// resolve to is what gets checked.
async function assertPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedAddressError(`Not a valid URL: ${url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new BlockedAddressError(`Refusing to fetch a non-http(s) URL (${parsed.protocol})`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // unwrap [::1] form
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new BlockedAddressError(`Couldn't resolve ${parsed.hostname}`);
  }
  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      throw new BlockedAddressError(
        `Refusing to fetch a private or internal address (${parsed.hostname} resolves to ${address})`
      );
    }
  }
  return parsed;
}

// Resolves a URL and reports whether it's a public http(s) destination — the same check
// safeFetch applies, but making NO request. For URLs we store and later render as an
// <img src> in the browser rather than fetch ourselves (a feed's own <image><url>), so a
// hostile feed can't point one at a device on the user's network. Caveat: the browser
// does its own DNS resolution when it loads the image, so a hostname that resolves to a
// public address here but a private one there isn't covered; IP literals and ordinary
// hostnames are.
export async function isPublicUrl(url) {
  try {
    await assertPublicUrl(url);
    return true;
  } catch {
    return false;
  }
}

// Drop-in replacement for fetch() on any URL we didn't choose ourselves. The single
// timeout signal covers the WHOLE redirect chain, not each hop, so a chain of slow
// redirects can't multiply the caller's timeout budget.
export async function safeFetch(url, { headers = {}, timeoutMs } = {}) {
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { headers, redirect: "manual", signal });

    const location = res.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(res.status) || !location) {
      return res;
    }
    current = new URL(location, current).href; // resolve relative Location headers
  }

  throw new BlockedAddressError(`Too many redirects (more than ${MAX_REDIRECTS})`);
}

// Thrown when a response exceeds the caller's byte budget. Nothing tells us in advance
// how big a remote body is (Content-Length is a hint, not a promise), so the limit is
// enforced while reading and the connection dropped the moment it's exceeded — without
// this, a hostile or broken feed could stream until the process runs out of memory.
export class ResponseTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResponseTooLargeError";
  }
}

async function readCapped(res, maxBytes, what) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ResponseTooLargeError(`${what} is larger than ${Math.round(maxBytes / 1024)} KB`);
  }
  // Test doubles stand in for Response without a stream; real fetch() always has one.
  if (!res.body) return null;

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(`${what} is larger than ${Math.round(maxBytes / 1024)} KB`);
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

// Size-capped stand-ins for res.text() / res.arrayBuffer().
export async function readTextCapped(res, maxBytes, what = "Response") {
  const bytes = await readCapped(res, maxBytes, what);
  return bytes === null ? await res.text() : new TextDecoder().decode(bytes);
}

export async function readArrayBufferCapped(res, maxBytes, what = "Response") {
  const bytes = await readCapped(res, maxBytes, what);
  return bytes === null ? await res.arrayBuffer() : bytes.buffer;
}
