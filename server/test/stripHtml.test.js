import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Parser from "rss-parser";
import rssParserUtils from "rss-parser/lib/utils.js";
import { stripHtml } from "../src/stripHtml.js";
import "../src/feedParser.js"; // installs the replacement into rss-parser

// Verbatim from rss-parser 3.13.0, lib/utils.js — the behaviour being preserved.
function originalStripHtml(str) {
  str = str.replace(/([^\n])<\/?(h|br|p|ul|ol|li|blockquote|section|table|tr|div)(?:.|\n)*?>([^\n])/gm, '$1\n$3')
  str = str.replace(/<(?:.|\n)*?>/gm, '');
  return str;
}

// Deterministic PRNG, so a failure reproduces exactly on every run.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("stripHtml matches rss-parser's original output exactly", () => {
  const cases = [
    ["plain text", "Just some words."],
    ["empty string", ""],
    ["simple paragraph", "<p>Hello world</p>"],
    ["two paragraphs", "<p>One</p><p>Two</p>"],
    ["paragraphs separated by a newline", "<p>One</p>\n<p>Two</p>"],
    ["br between words", "Line one<br>Line two"],
    ["self-closing br", "Line one<br/>Line two"],
    // The original's lazy group runs past a ">" followed by "\n" and swallows the text
    // up to the next tag. That's arguably a bug in rss-parser, but snippets shouldn't
    // silently change, so it's preserved.
    ["br + newline then a later tag (original swallows text)", "Line one<br>\nLine two <b>bold</b> end"],
    ["inline tags don't insert breaks", "Some <b>bold</b> and <a href=\"x\">a link</a>."],
    ["headings", "Intro<h2>Heading</h2>Body"],
    ["prefix-matched names (<pre>, <link>, <track>)", "a<pre>b</pre>c<link rel=x>d<track>e"],
    ["list", "Items:<ul><li>one</li><li>two</li></ul>after"],
    ["entities are left for getSnippet to decode", "Tom &amp; Jerry<br>next"],
    ["unclosed tag at the end", "text <img src=\"x\""],
    ["carriage return inside a tag stops the match", "a<p\r>b<div>c"],
    ["u2028 inside a tag", "a<p\u2028>b"],
    ["tag at the very start", "<div>start</div>"],
    ["> as the last character", "a<p>"],
    ["newline before a block tag", "a\n<p>b"],
    ["CDATA-style real content", "<p><img src=\"https://x/y.jpg\" /></p><p>Caption text here.</p>\n<p>More text.</p>"],
  ];
  for (const [label, input] of cases) {
    it(label, () => assert.equal(stripHtml(input), originalStripHtml(input)));
  }

  it("agrees on 30,000 randomly generated tag soups (seeded)", () => {
    const tokens = [
      "<", ">", "/", "\n", "\r", "\u2028", "\u2029", " ", "a", "x", "=", "\"",
      "p", "br", "h1", "li", "tr", "table", "div", "blockquote", "section", "ul", "ol",
      "b", "span", "img", "pre", "<p>", "</p>", "<br>", "<br/>", "\n<p>", "</div>\n",
      "<a href=\"x\">", "</a>", "<h2>", "<li>", "&amp;", ">\n", "<tr", "<ol ",
    ];
    const random = mulberry32(0x5eed);
    for (let n = 0; n < 30000; n++) {
      const length = Math.floor(random() * 40);
      let input = "";
      for (let i = 0; i < length; i++) input += tokens[Math.floor(random() * tokens.length)];
      const expected = originalStripHtml(input);
      const actual = stripHtml(input);
      if (actual !== expected) {
        assert.fail(`mismatch on input ${JSON.stringify(input)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    }
  });
});

// The inputs that made the original stall. Thresholds are deliberately generous so a
// slow CI machine can't flake them; the original needs minutes to hours on these.
describe("stripHtml stays fast on hostile input", () => {
  const MB = 1024 * 1024;
  const hostile = [
    ["many '<' with no '>' (pass 2)", "<img ".repeat(MB / 5)],
    ["many block-tag openings with no '>' (pass 1)", "x<p ".repeat(MB / 4)],
    ["every '>' followed by a newline (pass 1's lazy extension)", "a<p>\n".repeat(MB / 5)],
    ["carriage returns cutting every tag short", "<a\r".repeat(MB / 3)],
  ];
  for (const [label, input] of hostile) {
    it(label, () => {
      const started = performance.now();
      stripHtml(input);
      const ms = performance.now() - started;
      assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms on ${(input.length / MB).toFixed(1)} MB`);
    });
  }
});

describe("the replacement is installed in rss-parser", () => {
  // If an rss-parser upgrade restructured its internals, the swap would stop taking
  // effect and the stall would return with nothing else failing — this catches that.
  it("is the function rss-parser actually calls", () => {
    assert.equal(rssParserUtils.stripHtml, stripHtml);
  });

  it("keeps a hostile feed's parse fast through the real parser", async () => {
    const xml = `<rss version="2.0"><channel><title>t</title><item><title>i</title><description><![CDATA[${"<img ".repeat(80000)}]]></description></item></channel></rss>`;
    const started = performance.now();
    await new Parser().parseString(xml);
    const ms = performance.now() - started;
    assert.ok(ms < 2000, `400 KB hostile feed took ${ms.toFixed(0)} ms to parse`);
  });
});
