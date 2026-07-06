import ArticleItem from "./ArticleItem";

export default function ArticleList({ articles, feedsById, onOpen, onToggleSaved }) {
  if (articles.length === 0) {
    return <p className="empty-state">No articles here yet.</p>;
  }

  return (
    <ul className="article-list">
      {articles.map((article) => (
        <ArticleItem
          key={article.id}
          article={article}
          feedTitle={feedsById.get(article.feedId)?.title || "Unknown feed"}
          feedImageUrl={feedsById.get(article.feedId)?.feedImageUrl ?? null}
          onOpen={onOpen}
          onToggleSaved={onToggleSaved}
        />
      ))}
    </ul>
  );
}
