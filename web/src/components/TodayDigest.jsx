import ArticleList from "./ArticleList";

export default function TodayDigest({ groups, feedsById, onOpen, onToggleSaved, onSelectCategory }) {
  if (groups.length === 0) {
    return <p className="empty-state">No articles today yet.</p>;
  }

  return (
    <div className="today-groups">
      {groups.map((group) => (
        <section key={group.id ?? "uncategorized"} className="today-group">
          {group.id !== null ? (
            <button className="today-group-header" onClick={() => onSelectCategory(group.id)}>
              {group.name}
            </button>
          ) : (
            <div className="today-group-header today-group-header-static">{group.name}</div>
          )}
          <ArticleList
            articles={group.articles}
            feedsById={feedsById}
            onOpen={onOpen}
            onToggleSaved={onToggleSaved}
          />
        </section>
      ))}
    </div>
  );
}
