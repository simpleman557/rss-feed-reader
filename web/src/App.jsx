import { useEffect, useMemo, useState, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import ArticleList from "./components/ArticleList";
import TodayDigest from "./components/TodayDigest";
import {
  getCategories,
  getFeeds,
  getArticles,
  addCategory as dbAddCategory,
  addFeed as dbAddFeed,
  updateFeedCategory,
  renameFeed as dbRenameFeed,
  updateCategoryName,
  deleteFeed as dbDeleteFeed,
  deleteCategory as dbDeleteCategory,
  markRead,
  toggleSaved,
} from "./data/db";
import { refreshAllFeeds, refreshFeed } from "./data/feeds";
import { getStoredTheme, applyTheme } from "./theme";
import "./App.css";

function isToday(isoDate) {
  if (!isoDate) return false;
  const d = new Date(isoDate);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function sortByField(list, sort, getTimestamp) {
  return [...list].sort((a, b) => {
    const da = new Date(getTimestamp(a)).getTime();
    const db_ = new Date(getTimestamp(b)).getTime();
    return sort === "newest" ? db_ - da : da - db_;
  });
}

const byIsoDate = (a) => a.isoDate;
const byReadAt = (a) => a.readAt || a.isoDate;

const AUTO_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export default function App() {
  const [categories, setCategories] = useState([]);
  const [feeds, setFeeds] = useState([]);
  const [articles, setArticles] = useState([]);
  const [view, setView] = useState("all");
  const [sort, setSort] = useState("newest");
  const [selectedCategoryId, setSelectedCategoryId] = useState(null);
  const [selectedFeedId, setSelectedFeedId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(getStoredTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const reloadAll = useCallback(async () => {
    try {
      const [cats, fds, arts] = await Promise.all([getCategories(), getFeeds(), getArticles()]);
      setCategories(cats);
      setFeeds(fds);
      setArticles(arts);
    } catch {
      // The whole app depends on the server; if it's unreachable, say so plainly
      // instead of silently rendering an empty shell.
      setError("Couldn't reach the server. Make sure it's running, then hit Refresh.");
    }
  }, []);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);

  const feedsById = useMemo(() => new Map(feeds.map((f) => [f.id, f])), [feeds]);

  const visibleArticles = useMemo(() => {
    if (view === "readArticles") {
      return sortByField(
        articles.filter((a) => a.read),
        sort,
        byReadAt
      );
    }

    if (view === "readLater") {
      return sortByField(
        articles.filter((a) => a.saved),
        sort,
        byIsoDate
      );
    }

    // Browse mode: unread articles, optionally scoped to a selected feed/category.
    let list = articles.filter((a) => !a.read);

    if (selectedFeedId !== null) {
      list = list.filter((a) => a.feedId === selectedFeedId);
    } else if (selectedCategoryId !== null) {
      const feedIds = new Set(feeds.filter((f) => f.categoryId === selectedCategoryId).map((f) => f.id));
      list = list.filter((a) => feedIds.has(a.feedId));
    }

    return sortByField(list, sort, byIsoDate);
  }, [articles, view, sort, selectedCategoryId, selectedFeedId, feeds]);

  // Today digest: unread articles published today, grouped by category (named
  // categories sorted alphabetically, Uncategorized last), each capped to the top 10
  // by the current sort direction. Only computed while Today is the active view.
  const todayGroups = useMemo(() => {
    if (view !== "today") return [];

    const byCategoryId = new Map();
    for (const a of articles) {
      if (a.read || !isToday(a.isoDate)) continue;
      const categoryId = feedsById.get(a.feedId)?.categoryId ?? null;
      if (!byCategoryId.has(categoryId)) byCategoryId.set(categoryId, []);
      byCategoryId.get(categoryId).push(a);
    }

    const namedGroups = categories
      .filter((c) => byCategoryId.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((c) => ({ id: c.id, name: c.name, articles: byCategoryId.get(c.id) }));

    const uncategorizedArticles = byCategoryId.get(null);
    const groups = uncategorizedArticles
      ? [...namedGroups, { id: null, name: "Uncategorized", articles: uncategorizedArticles }]
      : namedGroups;

    return groups.map((g) => ({ ...g, articles: sortByField(g.articles, sort, byIsoDate).slice(0, 10) }));
  }, [view, articles, feedsById, categories, sort]);

  function handleSelectCategory(categoryId) {
    setSelectedCategoryId(categoryId);
    setSelectedFeedId(null);
    setView("all");
  }

  function handleSelectFeed(feedId) {
    setSelectedFeedId(feedId);
    setSelectedCategoryId(null);
    setView("all");
  }

  function handleSelectToday() {
    setView("today");
    setSelectedCategoryId(null);
    setSelectedFeedId(null);
  }

  function handleSelectReadLater() {
    setView("readLater");
    setSelectedCategoryId(null);
    setSelectedFeedId(null);
  }

  function handleSelectReadArticles() {
    setView("readArticles");
    setSelectedCategoryId(null);
    setSelectedFeedId(null);
  }

  async function handleAddFeed(url, categoryId) {
    setError(null);
    const id = await dbAddFeed(url, categoryId);
    const feed = { id, url, categoryId, title: url };
    try {
      await refreshFeed(feed);
      await reloadAll();
    } catch (err) {
      setError(`Couldn't fetch that feed: ${err.message}`);
      await reloadAll();
    }
  }

  async function handleAddCategory(name) {
    await dbAddCategory(name);
    await reloadAll();
  }

  async function handleChangeFeedCategory(feedId, categoryId) {
    await updateFeedCategory(feedId, categoryId);
    await reloadAll();
  }

  async function handleRenameCategory(categoryId, name) {
    await updateCategoryName(categoryId, name);
    await reloadAll();
  }

  async function handleRenameFeed(feedId, title) {
    await dbRenameFeed(feedId, title);
    await reloadAll();
  }

  async function handleDeleteFeed(feedId) {
    await dbDeleteFeed(feedId);
    if (selectedFeedId === feedId) setSelectedFeedId(null);
    await reloadAll();
  }

  async function handleDeleteCategory(categoryId) {
    await dbDeleteCategory(categoryId);
    if (selectedCategoryId === categoryId) setSelectedCategoryId(null);
    await reloadAll();
  }

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const { errors } = await refreshAllFeeds();
      if (errors.length > 0) {
        setError(`${errors.length} feed(s) failed to refresh.`);
      }
    } finally {
      await reloadAll();
      setRefreshing(false);
    }
  }

  useEffect(() => {
    let intervalId = null;

    function startInterval() {
      if (intervalId) return;
      intervalId = setInterval(handleRefresh, AUTO_REFRESH_INTERVAL_MS);
    }

    function stopInterval() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        startInterval();
      } else {
        stopInterval();
      }
    }

    handleRefresh(); // covers a cold open after the tab was closed past the 30-day retention window
    if (document.visibilityState === "visible") {
      startInterval();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopInterval();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleOpen(articleId) {
    await markRead(articleId, true);
    setArticles((prev) => prev.map((a) => (a.id === articleId ? { ...a, read: true } : a)));
  }

  async function handleToggleSaved(articleId) {
    const saved = await toggleSaved(articleId);
    setArticles((prev) => prev.map((a) => (a.id === articleId ? { ...a, saved } : a)));
  }

  return (
    <div className="app">
      <Sidebar
        categories={categories}
        feeds={feeds}
        selectedCategoryId={selectedCategoryId}
        selectedFeedId={selectedFeedId}
        view={view}
        onSelectCategory={handleSelectCategory}
        onSelectFeed={handleSelectFeed}
        onSelectToday={handleSelectToday}
        onSelectReadLater={handleSelectReadLater}
        onSelectReadArticles={handleSelectReadArticles}
        onAddFeed={handleAddFeed}
        onAddCategory={handleAddCategory}
        onChangeFeedCategory={handleChangeFeedCategory}
        onRenameCategory={handleRenameCategory}
        onRenameFeed={handleRenameFeed}
        onDeleteFeed={handleDeleteFeed}
        onDeleteCategory={handleDeleteCategory}
        theme={theme}
        onSetTheme={setTheme}
      />
      <main className="main">
        <TopBar sort={sort} onSetSort={setSort} onRefresh={handleRefresh} refreshing={refreshing} />
        {error && <div className="error-banner">{error}</div>}
        {view === "today" ? (
          <TodayDigest
            groups={todayGroups}
            feedsById={feedsById}
            onOpen={handleOpen}
            onToggleSaved={handleToggleSaved}
            onSelectCategory={handleSelectCategory}
          />
        ) : (
          <ArticleList
            articles={visibleArticles}
            feedsById={feedsById}
            onOpen={handleOpen}
            onToggleSaved={handleToggleSaved}
            getDate={view === "readArticles" ? byReadAt : byIsoDate}
          />
        )}
      </main>
    </div>
  );
}
