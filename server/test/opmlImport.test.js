import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planOpmlImport, IMPORT_CATEGORY_NAME, MAX_OUTLINES } from "../src/opmlImport.js";

const feed = (title, xmlUrl) => ({ text: title, xmlUrl, children: [] });
const folder = (text, children) => ({ text, xmlUrl: "", children });

function summarize(plan) {
  return plan.groups.map((g) => [g.name, g.feeds.map((f) => f.url)]);
}

describe("planOpmlImport — grouping", () => {
  it("files each feed under its folder", () => {
    const plan = planOpmlImport([
      folder("Tech", [feed("A", "https://a.example/feed")]),
      folder("News", [feed("B", "https://b.example/feed"), feed("C", "https://c.example/feed")]),
    ]);
    assert.deepEqual(summarize(plan), [
      ["Tech", ["https://a.example/feed"]],
      ["News", ["https://b.example/feed", "https://c.example/feed"]],
    ]);
  });

  it("puts top-level feeds in the fallback category", () => {
    const plan = planOpmlImport([feed("A", "https://a.example/feed")]);
    assert.deepEqual(summarize(plan), [[IMPORT_CATEGORY_NAME, ["https://a.example/feed"]]]);
  });

  it("flattens nesting: a feed lands in its nearest enclosing folder", () => {
    const plan = planOpmlImport([
      folder("Tech", [
        feed("A", "https://a.example/feed"),
        folder("Security", [feed("B", "https://b.example/feed")]),
      ]),
    ]);
    assert.deepEqual(summarize(plan), [
      ["Tech", ["https://a.example/feed"]],
      ["Security", ["https://b.example/feed"]],
    ]);
  });

  it("treats a folder named Uncategorized as no folder, since that name is reserved", () => {
    const plan = planOpmlImport([folder("uncategorized", [feed("A", "https://a.example/feed")])]);
    assert.deepEqual(summarize(plan), [[IMPORT_CATEGORY_NAME, ["https://a.example/feed"]]]);
  });

  it("lets a nameless or reserved-name subfolder inherit its parent folder", () => {
    const plan = planOpmlImport([
      folder("Tech", [
        folder("", [feed("A", "https://a.example/feed")]),
        folder("Uncategorized", [feed("B", "https://b.example/feed")]),
      ]),
    ]);
    assert.deepEqual(summarize(plan), [["Tech", ["https://a.example/feed", "https://b.example/feed"]]]);
  });

  it("merges folders whose names differ only by case, keeping the first spelling", () => {
    const plan = planOpmlImport([
      folder("Tech", [feed("A", "https://a.example/feed")]),
      folder("TECH", [feed("B", "https://b.example/feed")]),
    ]);
    assert.deepEqual(summarize(plan), [["Tech", ["https://a.example/feed", "https://b.example/feed"]]]);
  });
});

describe("planOpmlImport — entries", () => {
  it("keeps the title, collapsing whitespace and trimming", () => {
    const plan = planOpmlImport([feed("  Hello \n  World  ", "https://a.example/feed")]);
    assert.equal(plan.groups[0].feeds[0].title, "Hello World");
  });

  it("truncates an absurdly long title rather than rejecting the feed", () => {
    const plan = planOpmlImport([feed("x".repeat(1000), "https://a.example/feed")]);
    assert.equal(plan.groups[0].feeds[0].title.length, 200);
  });

  it("reports non-http(s) and unparseable URLs as invalid instead of planning them", () => {
    const plan = planOpmlImport([
      feed("Good", "https://a.example/feed"),
      feed("FTP", "ftp://a.example/feed"),
      feed("Junk", "not a url"),
    ]);
    assert.deepEqual(summarize(plan), [[IMPORT_CATEGORY_NAME, ["https://a.example/feed"]]]);
    assert.deepEqual(plan.invalid.map((e) => e.name), ["FTP", "Junk"]);
    assert.match(plan.invalid[0].reason, /http/i);
  });

  it("reports an over-long URL as invalid, and truncates it in the report", () => {
    const plan = planOpmlImport([feed("Long", `https://a.example/${"x".repeat(3000)}`), feed("OK", "https://b.example/f")]);
    assert.equal(plan.invalid.length, 1);
    assert.match(plan.invalid[0].reason, /too long/i);
    assert.ok(plan.invalid[0].url.length <= 200);
  });

  it("silently ignores outlines that are neither a feed nor a folder", () => {
    const plan = planOpmlImport([
      { text: "A website", htmlUrl: "https://a.example" },
      { text: "Empty folder", children: [] },
      feed("Real", "https://a.example/feed"),
    ]);
    assert.deepEqual(summarize(plan), [[IMPORT_CATEGORY_NAME, ["https://a.example/feed"]]]);
    assert.deepEqual(plan.invalid, []);
  });

  it("tolerates junk field types from an untrusted client", () => {
    const plan = planOpmlImport([
      null,
      "string",
      42,
      { text: 7, xmlUrl: 9 },
      { text: { a: 1 }, xmlUrl: "https://a.example/feed", children: "nope" },
    ]);
    assert.deepEqual(summarize(plan), [[IMPORT_CATEGORY_NAME, ["https://a.example/feed"]]]);
    assert.equal(plan.groups[0].feeds[0].title, "");
  });
});

describe("planOpmlImport — limits", () => {
  it("rejects input that isn't an array", () => {
    assert.throws(() => planOpmlImport(undefined), /OPML/);
    assert.throws(() => planOpmlImport({ outlines: [] }), /OPML/);
  });

  it("rejects a file with no feeds in it", () => {
    assert.throws(() => planOpmlImport([]), /No feeds found/);
    assert.throws(() => planOpmlImport([folder("Empty", [])]), /No feeds found/);
  });

  it("counts a file whose only feeds are invalid as having feeds, and reports them", () => {
    const plan = planOpmlImport([feed("Bad", "ftp://a.example/feed")]);
    assert.deepEqual(plan.groups, []);
    assert.equal(plan.invalid.length, 1);
  });

  it("rejects more than MAX_OUTLINES entries", () => {
    const many = Array.from({ length: MAX_OUTLINES + 1 }, (_, i) => feed(`F${i}`, `https://a.example/${i}`));
    assert.throws(() => planOpmlImport(many), /more than 5000/);
  });

  it("accepts exactly MAX_OUTLINES entries", () => {
    const many = Array.from({ length: MAX_OUTLINES }, (_, i) => feed(`F${i}`, `https://a.example/${i}`));
    assert.equal(planOpmlImport(many).groups[0].feeds.length, MAX_OUTLINES);
  });

  it("rejects folders nested too deeply", () => {
    let tree = [feed("Deep", "https://a.example/feed")];
    for (let i = 0; i < 30; i++) tree = [folder(`F${i}`, tree)];
    assert.throws(() => planOpmlImport(tree), /nested too deeply/);
  });
});
