function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function feedOutline(feed) {
  return `<outline type="rss" text="${escapeXml(feed.title)}" xmlUrl="${escapeXml(feed.url)}"/>`;
}

export function buildOPML(categories, feeds) {
  const feedsByCategory = new Map();
  const uncategorized = [];

  for (const feed of feeds) {
    if (feed.categoryId == null) {
      uncategorized.push(feed);
      continue;
    }
    if (!feedsByCategory.has(feed.categoryId)) feedsByCategory.set(feed.categoryId, []);
    feedsByCategory.get(feed.categoryId).push(feed);
  }

  const categoryBlocks = categories
    .map((cat) => {
      const catFeeds = feedsByCategory.get(cat.id) || [];
      return [
        `<outline text="${escapeXml(cat.name)}">`,
        ...catFeeds.map((f) => `  ${feedOutline(f)}`),
        `</outline>`,
      ].join("\n");
    })
    .join("\n");

  const uncategorizedBlock = uncategorized.map(feedOutline).join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<opml version="2.0">`,
    `<head><title>Feed Reader Export</title></head>`,
    `<body>`,
    categoryBlocks,
    uncategorizedBlock,
    `</body>`,
    `</opml>`,
    ``,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// --- Import ---

// Reads an OPML document into a plain outline tree — [{ text, xmlUrl, children }] — and
// nothing more: turning that into categories and feeds (nesting, the reserved
// "Uncategorized" name, duplicates, URL validation) is the server's job, where those
// rules already live (server/src/opmlImport.js). DOMParser rather than a hand-rolled
// scan so malformed XML is caught properly; it never fetches external entities.
export function parseOPML(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  const body = doc.querySelector("opml > body");
  if (doc.querySelector("parsererror") || !body) {
    throw new Error("That doesn't look like an OPML file.");
  }
  return outlinesOf(body);
}

function outlinesOf(parent) {
  return Array.from(parent.children)
    .filter((el) => el.localName === "outline")
    .map((el) => ({
      text: el.getAttribute("text") || el.getAttribute("title") || "",
      xmlUrl: el.getAttribute("xmlUrl") || el.getAttribute("xmlurl") || "",
      children: outlinesOf(el),
    }));
}

const MAX_LISTED_PROBLEMS = 5;

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// The plain-text summary shown after an import, from the server's
// { feedsAdded, categoriesCreated, duplicates, invalid } response.
export function formatImportSummary({ feedsAdded, categoriesCreated, duplicates, invalid }) {
  const lines = [];
  if (feedsAdded === 0) {
    lines.push("No new feeds were imported.");
  } else {
    const created = categoriesCreated > 0 ? ` and created ${plural(categoriesCreated, "category", "categories")}` : "";
    lines.push(`Imported ${plural(feedsAdded, "feed")}${created}.`);
  }
  if (duplicates > 0) {
    lines.push(`Skipped ${duplicates} already subscribed (or repeated in the file).`);
  }
  if (invalid.length > 0) {
    lines.push(`${invalid.length} couldn't be imported:`);
    for (const e of invalid.slice(0, MAX_LISTED_PROBLEMS)) {
      lines.push(`\u2022 ${e.name || e.url} \u2014 ${e.reason}`);
    }
    if (invalid.length > MAX_LISTED_PROBLEMS) {
      lines.push(`\u2026and ${invalid.length - MAX_LISTED_PROBLEMS} more.`);
    }
  }
  if (feedsAdded > 0) {
    lines.push("Fetching their articles now \u2014 this can take a minute.");
  }
  return lines.join("\n");
}
