import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import ArticleList from "./components/ArticleList";
import TodayDigest from "./components/TodayDigest";
import ErrorBanner from "./components/ErrorBanner";
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
  importOpml,
  markRead,
  toggleSaved,
} from "./data/db";
import { parseOPML } from "./data/opml";
import { refreshAllFeeds, refreshFeed } from "./data/feeds";
import { getStoredTheme, applyTheme } from "./theme";
import { describeFailure } from "./data/errors";
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

// Real OPML exports are tens of KB (about a MB for thousands of feeds). Kept in step with
// the 2 MB body limit on the server's /api/import route, so an oversized file gets this
// message instead of a bare "request entity too large" from the server.
const MAX_OPML_FILE_BYTES = 2 * 1024 * 1024;

// Which sidebar destination/category/feed was showing survives a reload of this same
// tab (sessionStorage), but not closing the tab and opening a new one — sessionStorage
// is cleared then, so a fresh session starts at the default below. That's exactly the
// "reload keeps my place, close-and-reopen doesn't" split, with no manual detection of
// which case we're in needed.
const SESSION_KEY_VIEW = "feedReader.view";
const SESSION_KEY_CATEGORY = "feedReader.selectedCategoryId";
const SESSION_KEY_FEED = "feedReader.selectedFeedId";
const DEFAULT_VIEW = "today";

function readSession(key, fallback) {
  const raw = sessionStorage.getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export default function App() {
  const [categories, setCategories] = useState([]);
  const [feeds, setFeeds] = useState([]);
  const [articles, setArticles] = useState([]);
  const [view, setView] = useState(() => readSession(SESSION_KEY_VIEW, DEFAULT_VIEW));
  const [sort, setSort] = useState("newest");
  const [selectedCategoryId, setSelectedCategoryId] = useState(() => readSession(SESSION_KEY_CATEGORY, null));
  const [selectedFeedId, setSelectedFeedId] = useState(() => readSession(SESSION_KEY_FEED, null));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [refreshErrors, setRefreshErrors] = useState([]);
  const [theme, setTheme] = useState(getStoredTheme);
  const [searchQuery, setSearchQuery] = useState("");
  const mainRef = useRef(null);
  // Phone-width navigation: the sidebar is an off-canvas drawer below 768px (see App.css);
  // on wider screens these are inert — the sidebar is always visible there.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef(null);
  const closeButtonRef = useRef(null);
  const drawerWasOpen = useRef(false);
  const lastRefreshAt = useRef(Date.now());
  // Snapshot of every article's read/saved flags as of the last "you've moved on"
  // moment — id -> { read, saved }. Marking an article read or saving/un-saving it
  // updates `articles` immediately (so counts, the grey-out style, Read Articles, and
  // Read Later's live membership all reflect it right away), but this snapshot
  // deliberately does NOT move on a background auto-refresh — only on an explicit
  // refresh/reload, or on navigating to a different destination/category/feed (see the
  // two effects below for each trigger). Combined with the OR-fallback below, that's
  // what lets a just-read (or just-un-saved) article keep sitting in place, greyed out,
  // for as long as you're still looking at this same screen — without lingering
  // forever once you've actually moved on and come back to it later.
  const [snapshot, setSnapshot] = useState(() => new Map());

  function wasUnreadInSnapshot(id) {
    const snap = snapshot.get(id);
    return snap ? !snap.read : false;
  }

  function wasSavedInSnapshot(id) {
    const snap = snapshot.get(id);
    return snap ? snap.saved : false;
  }

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Persist the current destination/selection so a browser reload restores it (see the
  // sessionStorage note above); sort is deliberately excluded — it just resets to
  // "Newest first" on every load, reload or not.
  useEffect(() => {
    sessionStorage.setItem(SESSION_KEY_VIEW, JSON.stringify(view));
    sessionStorage.setItem(SESSION_KEY_CATEGORY, JSON.stringify(selectedCategoryId));
    sessionStorage.setItem(SESSION_KEY_FEED, JSON.stringify(selectedFeedId));
  }, [view, selectedCategoryId, selectedFeedId]);

  // While the drawer is open: lock background scroll (CSS keys off the class, and only
  // below 768px), close on Escape, and move focus into the drawer — then back to the menu
  // button once it closes, so keyboard/screen-reader users aren't left stranded.
  useEffect(() => {
    const root = document.documentElement;
    if (drawerOpen) {
      root.classList.add("drawer-open");
      closeButtonRef.current?.focus();
      drawerWasOpen.current = true;
      const onKeyDown = (e) => {
        if (e.key === "Escape") setDrawerOpen(false);
      };
      document.addEventListener("keydown", onKeyDown);
      return () => {
        root.classList.remove("drawer-open");
        document.removeEventListener("keydown", onKeyDown);
      };
    }
    if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      menuButtonRef.current?.focus();
    }
  }, [drawerOpen]);

  // Jump back to the top whenever the selected destination/category/feed changes —
  // each shows a different list with its own height, so the old scroll position is
  // meaningless there. Deliberately keyed only on the selection itself (not on sort,
  // theme, or anything in the Customization card), so those don't yank the scroll
  // position around. `.main` scrolls internally on desktop; the window scrolls on
  // mobile (see App.css's 768px breakpoint) — reset both.
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, [view, selectedCategoryId, selectedFeedId]);

  // Navigating to a different destination/category/feed also counts as "moving on" for
  // the snapshot above — otherwise a read/un-saved article you'd already left behind
  // would keep lingering every single time you came back to that same screen, not just
  // within the one sitting you changed it in. Re-syncs the snapshot from whatever
  // `articles` already holds client-side — no network round-trip needed, unlike an
  // explicit Refresh, which also re-fetches. Deliberately not keyed on `articles`
  // itself, so a background auto-refresh alone still doesn't trigger this.
  useEffect(() => {
    setSnapshot(new Map(articles.map((a) => [a.id, { read: a.read, saved: a.saved }])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedCategoryId, selectedFeedId]);

  const reloadAll = useCallback(async ({ resetSnapshot = false } = {}) => {
    try {
      const [cats, fds, arts] = await Promise.all([getCategories(), getFeeds(), getArticles()]);
      setCategories(cats);
      setFeeds(fds);
      setArticles(arts);
      // Only an explicit reload re-baselines the snapshot to match the fresh data —
      // see the snapshot comment above for why a background refresh must not do this.
      if (resetSnapshot) {
        setSnapshot(new Map(arts.map((a) => [a.id, { read: a.read, saved: a.saved }])));
      }
    } catch (err) {
      // The whole app depends on the server; say plainly what went wrong (unreachable vs.
      // a server error) instead of silently rendering an empty shell.
      setError(describeFailure(err, "load"));
    }
  }, []);

  useEffect(() => {
    reloadAll({ resetSnapshot: true });
  }, [reloadAll]);

  const feedsById = useMemo(() => new Map(feeds.map((f) => [f.id, f])), [feeds]);

  // Unread/saved counts shown next to the sidebar destinations.
  const counts = useMemo(() => {
    let all = 0;
    let today = 0;
    let saved = 0;
    for (const a of articles) {
      if (a.saved) saved++;
      if (a.read) continue;
      all++;
      if (isToday(a.isoDate)) today++;
    }
    return { all, today, saved };
  }, [articles]);

  const visibleArticles = useMemo(() => {
    if (view === "readArticles") {
      return sortByField(
        articles.filter((a) => a.read),
        sort,
        byReadAt
      );
    }

    if (view === "readLater") {
      // An article un-saved since the last explicit reload lingers here too (greyed
      // out via its live `saved: false`, no accent bar) rather than vanishing — see
      // the snapshot comment above.
      return sortByField(
        articles.filter((a) => a.saved || wasSavedInSnapshot(a.id)),
        sort,
        byIsoDate
      );
    }

    // Browse mode: unread articles, optionally scoped to a selected feed/category. A
    // just-read article lingers here too (greyed out via its live `read: true`) rather
    // than vanishing — see the snapshot comment above.
    let list = articles.filter((a) => !a.read || wasUnreadInSnapshot(a.id));

    if (selectedFeedId !== null) {
      list = list.filter((a) => a.feedId === selectedFeedId);
    } else if (selectedCategoryId !== null) {
      const feedIds = new Set(feeds.filter((f) => f.categoryId === selectedCategoryId).map((f) => f.id));
      list = list.filter((a) => feedIds.has(a.feedId));
    }

    return sortByField(list, sort, byIsoDate);
  }, [articles, view, sort, selectedCategoryId, selectedFeedId, feeds, snapshot]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;
    return sortByField(
      articles.filter(
        (a) =>
          (a.title || "").toLowerCase().includes(q) ||
          (a.contentSnippet || "").toLowerCase().includes(q)
      ),
      sort,
      byIsoDate
    );
  }, [searchQuery, articles, sort]);

  // Today digest: unread articles published today, grouped by category (named
  // categories sorted alphabetically, Uncategorized last), each capped to the top 10
  // by the current sort direction. Only computed while Today is the active view.
  const todayGroups = useMemo(() => {
    if (view !== "today") return [];

    const byCategoryId = new Map();
    for (const a of articles) {
      // A just-read article lingers here too until an explicit reload — see the
      // snapshot comment above.
      const stillCountsAsUnread = !a.read || wasUnreadInSnapshot(a.id);
      if (!stillCountsAsUnread || !isToday(a.isoDate)) continue;
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
  }, [view, articles, feedsById, categories, sort, snapshot]);

  // Picking a destination also dismisses the drawer. Done here rather than in an effect on
  // the selection, because re-tapping the already-active item changes no state.
  function closingDrawer(handler) {
    return (...args) => {
      setDrawerOpen(false);
      return handler(...args);
    };
  }

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

  // Parses in the browser, imports on the server, then reloads so the new categories and
  // feeds appear. Fetching the new feeds' articles is kicked off but not awaited — for a
  // big list it takes a while — so the caller can show the import summary right away.
  // Resolves to that summary; the Sidebar owns showing it (and any error) to the user.
  async function handleImportOPML(file) {
    if (file.size > MAX_OPML_FILE_BYTES) {
      throw new Error("That file is too large to be an OPML export.");
    }
    setError(null);
    const outlines = parseOPML(await file.text());
    const summary = await importOpml(outlines);
    await reloadAll();
    if (summary.feedsAdded > 0) {
      // Forced: the new feeds need fetching even if a refresh just finished. handleRefresh
      // reports its own failures, so there's nothing to catch here.
      handleRefresh({ force: true });
    }
    return summary;
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

  // `explicit` distinguishes a user-driven refresh (the button, or this mount's own
  // initial load) from the silent 15-minute background timer below — only an explicit
  // one re-baselines the snapshot, letting already-read/un-saved articles finally drop
  // out of view. The background timer still fetches new content either way; it just
  // doesn't prune anything out from under you while you're reading.
  async function handleRefresh({ explicit = true, force = false } = {}) {
    setRefreshing(true);
    setError(null);
    setRefreshErrors([]);
    try {
      const { errors } = await refreshAllFeeds({ force });
      if (errors.length > 0) {
        setRefreshErrors(errors);
        setError(
          errors.length === 1
            ? `1 feed failed to refresh.`
            : `${errors.length} feeds failed to refresh.`
        );
      } else {
        setRefreshErrors([]);
      }
    } catch (err) {
      // A dropped connection (common on a phone) or a server error lands here; without
      // this it was an unhandled rejection and the user saw nothing.
      setError(describeFailure(err, "refresh"));
    } finally {
      await reloadAll({ resetSnapshot: explicit });
      lastRefreshAt.current = Date.now();
      setRefreshing(false);
    }
  }

  useEffect(() => {
    let intervalId = null;

    function startInterval() {
      if (intervalId) return;
      intervalId = setInterval(() => handleRefresh({ explicit: false }), AUTO_REFRESH_INTERVAL_MS);
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
        // Phones suspend background tabs' timers, so a tab left for a while comes back
        // stale — catch up right away instead of waiting out a fresh 15 minutes.
        if (Date.now() - lastRefreshAt.current >= AUTO_REFRESH_INTERVAL_MS) {
          handleRefresh({ explicit: false });
        }
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
    const { readAt } = await markRead(articleId, true);
    setArticles((prev) => prev.map((a) => (a.id === articleId ? { ...a, read: true, readAt } : a)));
  }

  async function handleToggleSaved(articleId) {
    const saved = await toggleSaved(articleId);
    setArticles((prev) => prev.map((a) => (a.id === articleId ? { ...a, saved } : a)));
  }

  // Remounting ArticleList on these resets its render window (see ArticleList.jsx).
  const listKey = `${view}|${selectedCategoryId}|${selectedFeedId}|${sort}|${searchQuery.trim()}`;

  return (
    <div className="app">
      <Sidebar
        categories={categories}
        feeds={feeds}
        counts={counts}
        selectedCategoryId={selectedCategoryId}
        selectedFeedId={selectedFeedId}
        view={view}
        // A category stays open in the drawer (tapping one also expands it and reveals its
        // add/edit buttons); All Feeds is the same handler with null, and does close it.
        onSelectCategory={(id) => {
          if (id === null) setDrawerOpen(false);
          handleSelectCategory(id);
        }}
        onSelectFeed={closingDrawer(handleSelectFeed)}
        onSelectToday={closingDrawer(handleSelectToday)}
        onSelectReadLater={closingDrawer(handleSelectReadLater)}
        onSelectReadArticles={closingDrawer(handleSelectReadArticles)}
        onAddFeed={handleAddFeed}
        onAddCategory={handleAddCategory}
        onImportOPML={handleImportOPML}
        onChangeFeedCategory={handleChangeFeedCategory}
        onRenameCategory={handleRenameCategory}
        onRenameFeed={handleRenameFeed}
        onDeleteFeed={handleDeleteFeed}
        onDeleteCategory={handleDeleteCategory}
        theme={theme}
        onSetTheme={setTheme}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        closeButtonRef={closeButtonRef}
      />
      {drawerOpen && <div className="drawer-backdrop" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}
      <main className="main" ref={mainRef}>
        <TopBar
          sort={sort}
          onSetSort={setSort}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          menuOpen={drawerOpen}
          onOpenMenu={() => setDrawerOpen(true)}
          menuButtonRef={menuButtonRef}
        />
        {error && <ErrorBanner message={error} details={refreshErrors} />}
        {searchResults !== null ? (
          <ArticleList
            key={listKey}
            articles={searchResults}
            feedsById={feedsById}
            onOpen={handleOpen}
            onToggleSaved={handleToggleSaved}
            getDate={byIsoDate}
            emptyMessage={`No results for "${searchQuery.trim()}".`}
          />
        ) : view === "today" ? (
          <TodayDigest
            groups={todayGroups}
            feedsById={feedsById}
            onOpen={handleOpen}
            onToggleSaved={handleToggleSaved}
            onSelectCategory={handleSelectCategory}
          />
        ) : (
          <ArticleList
            key={listKey}
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
