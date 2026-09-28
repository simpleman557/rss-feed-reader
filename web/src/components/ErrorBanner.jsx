import { useState } from "react";

export default function ErrorBanner({ message, details = [] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="error-banner">
      <div className="error-banner-summary">
        <span>{message}</span>
        {details.length > 0 && (
          <button
            className="error-banner-toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "Hide details \u25b2" : "Show details \u25bc"}
          </button>
        )}
      </div>
      {expanded && details.length > 0 && (
        <ul className="error-banner-details">
          {details.map((e) => (
            <li key={e.feed.id}>
              <strong>{e.feed.title}</strong>{" \u2014 "}{e.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
