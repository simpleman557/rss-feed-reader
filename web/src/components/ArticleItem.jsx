import { useState } from "react";

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect width="24" height="24" rx="3" fill="#e2e2e6"/>
  <circle cx="8.5" cy="8.5" r="1.6" fill="#9ca3af"/>
  <path d="M3 17l5.5-5.5a1 1 0 0 1 1.4 0L14 15.5l2.5-2.5a1 1 0 0 1 1.4 0L21 16" stroke="#9ca3af" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const PLACEHOLDER_ICON = `data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`;

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
        title={article.saved ? "Remove from Read Later" : "Save for later"}
      >
        {article.saved ? "★" : "☆"}
      </button>
    </li>
  );
}
