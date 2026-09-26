import { useState } from "react";
import { PLACEHOLDER_ICON } from "../placeholderIcon";

export default function ArticleItem({ article, feedTitle, feedImageUrl, onOpen, onToggleSaved, displayDate }) {
  // The list already groups by day (date-group headings), so each row shows just the
  // time. `displayDate` is the timestamp the active view is grouped/sorted on (e.g.
  // readAt in Read Articles); it falls back to the publish date elsewhere.
  const ts = displayDate || article.isoDate;
  const parsed = ts ? new Date(ts) : null;
  const time =
    parsed && !Number.isNaN(parsed.getTime())
      ? parsed.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : "";

  // Ordered image fallback, best first:
  //   1. the article's own image — a real per-article photo, shown edge-to-edge (--photo)
  //   2. the feed's clean icon — the nice square favicon/apple-touch-icon
  //   3. a generic placeholder that can't itself fail (an inline data: URI)
  // A load error on any candidate (a 404, a hotlink block, a stray "undefined" src)
  // records that URL as failed and drops to the next one, so a broken article image lands
  // on the clean feed icon rather than skipping straight to the grey placeholder. Keyed on
  // the URL, not an index, so it stays correct if a later refresh swaps in a new image.
  const [failedSrc, setFailedSrc] = useState(() => new Set());
  const candidates = [];
  if (article.imageUrl) candidates.push({ url: article.imageUrl, photo: true });
  if (feedImageUrl) candidates.push({ url: feedImageUrl, photo: false });
  candidates.push({ url: PLACEHOLDER_ICON, photo: false });
  const current = candidates.find((c) => !failedSrc.has(c.url)) ?? candidates[candidates.length - 1];

  return (
    <li className={`article-item ${article.read ? "read" : "unread"} ${article.saved ? "saved" : ""}`}>
      <img
        className={`article-image${current.photo ? " article-image--photo" : ""}`}
        src={current.url}
        alt=""
        onError={() =>
          setFailedSrc((prev) => (prev.has(current.url) ? prev : new Set(prev).add(current.url)))
        }
      />
      <div className="article-main">
        <a
          className="article-title"
          href={article.link}
          target="_blank"
          rel="noreferrer"
          onClick={() => onOpen(article.id)}
        >
          {article.title}
        </a>
        {article.contentSnippet && <p className="article-snippet">{article.contentSnippet}</p>}
      </div>
      <div className="article-aside">
        <span className="article-feed">{feedTitle}</span>
        {time && <time className="article-date">{time}</time>}
      </div>
      <button
        className={`save-btn ${article.saved ? "saved" : ""}`}
        onClick={() => onToggleSaved(article.id)}
        aria-label={article.saved ? "Remove from Read Later" : "Save for later"}
        aria-pressed={article.saved}
        title={article.saved ? "Remove from Read Later" : "Save for later"}
      >
        {article.saved ? "★" : "☆"}
      </button>
    </li>
  );
}
