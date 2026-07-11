import { useState } from "react";
import { PLACEHOLDER_ICON } from "../placeholderIcon";

export default function ArticleItem({ article, feedTitle, feedImageUrl, onOpen, onToggleSaved }) {
  const date = article.isoDate ? new Date(article.isoDate) : null;
  const sources = [article.imageUrl, feedImageUrl, PLACEHOLDER_ICON].filter(Boolean);
  const [stage, setStage] = useState(0);

  return (
    <li className={`article-item ${article.read ? "read" : "unread"}`}>
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
        <div className="article-meta">
          <span className="article-feed">{feedTitle}</span>
          {date && <span className="article-date">{date.toLocaleString()}</span>}
        </div>
        {article.contentSnippet && (
          <p className="article-snippet">{article.contentSnippet}</p>
        )}
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
