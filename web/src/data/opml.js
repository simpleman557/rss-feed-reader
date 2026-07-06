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
