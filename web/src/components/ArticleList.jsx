import { useEffect, useRef, useState } from "react";
import ArticleItem from "./ArticleItem";

// Rows rendered up front, and added each time the end of the list scrolls into view.
// All Feeds can hold thousands of articles; mounting every row (and its <img>) at once
// is what makes a phone crawl. Purely a render window — the full list is still in memory.
const PAGE_SIZE = 100;

// Sentinel at the end of a windowed list: grows the window as it nears the viewport, and
// is also a plain button so it still works if IntersectionObserver is unavailable.
function ShowMore({ remaining, onMore }) {
  const ref = useRef(null);
  // `remaining` changes each time the window grows, which re-creates the observer — so
  // if the list is still short enough that the sentinel is on screen, it fires again.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onMore();
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [remaining, onMore]);

  return (
    <button ref={ref} type="button" className="show-more" onClick={onMore}>
      Show more ({remaining} remaining)
    </button>
  );
}

function renderRow(article, feedsById, onOpen, onToggleSaved, displayDate) {
  return (
    <ArticleItem
      key={article.id}
      article={article}
      feedTitle={feedsById.get(article.feedId)?.title || "Unknown feed"}
      feedImageUrl={feedsById.get(article.feedId)?.feedImageUrl ?? null}
      onOpen={onOpen}
      onToggleSaved={onToggleSaved}
      displayDate={displayDate}
    />
  );
}

function dateGroupLabel(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "Undated";
  const now = new Date();
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return "Today";
  }
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

// Splits an already-sorted article list into contiguous same-calendar-day runs — order
// is untouched, this only inserts headings ("Today", then e.g. "July 10, 2026").
function groupByDate(articles, getDate) {
  const groups = [];
  for (const article of articles) {
    const label = dateGroupLabel(getDate(article));
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.articles.push(article);
    } else {
      groups.push({ label, articles: [article] });
    }
  }
  return groups;
}

// `getDate` is optional: when provided, articles render under date headings; when
// omitted (e.g. Today's per-category lists, which are already all "today"), the plain
// flat list renders as before.
//
// Callers remount this (via `key`) when the destination/sort/search changes, which resets
// the render window back to the first page.
export default function ArticleList({ articles: allArticles, feedsById, onOpen, onToggleSaved, getDate, emptyMessage }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadMore] = useState(() => () => setLimit((n) => n + PAGE_SIZE));
  // Slice the already-sorted list *before* grouping, so date headings only appear for rows
  // that are actually rendered.
  const articles = allArticles.slice(0, limit);
  const remaining = allArticles.length - articles.length;
  const more = remaining > 0 ? <ShowMore remaining={remaining} onMore={loadMore} /> : null;

  if (articles.length === 0) {
    return <p className="empty-state">{emptyMessage || "No articles here yet."}</p>;
  }

  if (!getDate) {
    return (
      <ul className="article-list">
        {articles.map((a) => renderRow(a, feedsById, onOpen, onToggleSaved, a.isoDate))}
        {more && <li className="show-more-item">{more}</li>}
      </ul>
    );
  }

  return (
    <div className="date-groups">
      {groupByDate(articles, getDate).map((group, i) => (
        <section key={i} className="date-group">
          <h2 className="date-group-header">{group.label}</h2>
          <ul className="article-list">
            {group.articles.map((a) => renderRow(a, feedsById, onOpen, onToggleSaved, getDate(a)))}
          </ul>
        </section>
      ))}
      {more}
    </div>
  );
}
