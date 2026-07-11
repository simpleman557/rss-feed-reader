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
  const sources = [article.imageUrl, feedImageUrl, PLACEHOLDER_ICON].filter(Boolean);
  const [stage, setStage] = useState(0);

  return (
    <li className={`article-item ${article.read ? "read" : "unread"} ${article.saved ? "saved" : ""}`}>
      <img
        className="article-image"
        src={sources[Math.min(stage, sources.length - 1)]}
        alt=""
        onError={() => setStage((s) => s + 1)}
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
