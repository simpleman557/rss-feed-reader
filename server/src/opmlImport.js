// Turns the outline tree the browser parsed out of an OPML file into a flat import plan:
// which feeds go into which category, and which entries can't be imported at all. No
// database involved, so it's tested directly (test/opmlImport.test.js); dbLogic.js's
// importOpml is what applies the plan.
//
// The tree arrives as JSON — [{ text, xmlUrl, children }] — so every field is untrusted:
// types are checked rather than assumed, and entry count, nesting depth and string
// lengths are capped. The app's categories are one level deep, so nesting is flattened:
// a feed lands in its nearest enclosing folder.
import { ValidationError } from "./errors.js";
import { RESERVED_CATEGORY_NAME, normalizeName, feedUrlProblem } from "./dbHelpers.js";

// Where feeds go when the file gives them no usable folder — sitting at the top level,
// or filed under a folder named "Uncategorized", which this app reserves for itself
// (other readers, Feedly among them, export exactly that name).
export const IMPORT_CATEGORY_NAME = "Imported";

export const MAX_OUTLINES = 5000;
const MAX_DEPTH = 10;
const MAX_NAME_LENGTH = 200;
const MAX_URL_LENGTH = 2048;

function cleanName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
}

// A folder with no name (or the reserved one) doesn't start a new category — its feeds
// stay in whatever folder enclosed it.
function folderFor(name, parentFolder) {
  if (!name || normalizeName(name) === RESERVED_CATEGORY_NAME) return parentFolder;
  return name;
}

export function planOpmlImport(outlines) {
  if (!Array.isArray(outlines)) {
    throw new ValidationError("That doesn't look like an OPML file.");
  }

  // Keyed by normalized folder name so two folders that differ only in case merge.
  const groups = new Map();
  const invalid = [];
  let visited = 0;
  let feedEntries = 0;

  function addToGroup(folder, feed) {
    const name = folder ?? IMPORT_CATEGORY_NAME;
    const key = normalizeName(name);
    if (!groups.has(key)) groups.set(key, { name, feeds: [] });
    groups.get(key).feeds.push(feed);
  }

  function walk(nodes, folder, depth) {
    if (depth > MAX_DEPTH) {
      throw new ValidationError("This OPML file is nested too deeply to import.");
    }
    for (const node of nodes) {
      if (++visited > MAX_OUTLINES) {
        throw new ValidationError(
          `This OPML file has more than ${MAX_OUTLINES} entries — split it up and import the pieces separately.`
        );
      }
      if (!node || typeof node !== "object") continue;

      const name = cleanName(node.text);
      const url = typeof node.xmlUrl === "string" ? node.xmlUrl.trim() : "";
      if (url) {
        feedEntries++;
        const problem = url.length > MAX_URL_LENGTH ? "That URL is too long." : feedUrlProblem(url);
        if (problem) invalid.push({ name, url: url.slice(0, 200), reason: problem });
        else addToGroup(folder, { url, title: name });
      } else if (Array.isArray(node.children)) {
        walk(node.children, folderFor(name, folder), depth + 1);
      }
      // Anything else — an outline with neither a feed URL nor children, or one that
      // only has an htmlUrl — isn't a subscription, so it's ignored rather than reported.
    }
  }

  walk(outlines, null, 0);

  if (feedEntries === 0) throw new ValidationError("No feeds found in that file.");
  return { groups: [...groups.values()], invalid };
}
