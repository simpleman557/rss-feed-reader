import ArticleItem from "./ArticleItem";

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
export default function ArticleList({ articles, feedsById, onOpen, onToggleSaved, getDate, emptyMessage }) {
  if (articles.length === 0) {
    return <p className="empty-state">{emptyMessage || "No articles here yet."}</p>;
  }

  if (!getDate) {
    return (
      <ul className="article-list">
        {articles.map((a) => renderRow(a, feedsById, onOpen, onToggleSaved, a.isoDate))}
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
    </div>
  );
}
