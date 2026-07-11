import { useState } from "react";
import { buildOPML } from "../data/opml";
import { PLACEHOLDER_ICON } from "../placeholderIcon";

function Count({ n }) {
  return n > 0 ? <span className="sb-count">{n}</span> : null;
}

export default function Sidebar({
  categories,
  feeds,
  counts,
  selectedCategoryId,
  selectedFeedId,
  view,
  onSelectCategory,
  onSelectFeed,
  onSelectToday,
  onSelectReadLater,
  onSelectReadArticles,
  onAddFeed,
  onAddCategory,
  onChangeFeedCategory,
  onRenameCategory,
  onRenameFeed,
  onDeleteFeed,
  onDeleteCategory,
  theme,
  onSetTheme,
}) {
  const [newCategoryName, setNewCategoryName] = useState("");
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [dragOverKey, setDragOverKey] = useState(null);
  const [isDraggingFeed, setIsDraggingFeed] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState(null);
  const [editCategoryName, setEditCategoryName] = useState("");
  const [editingFeedId, setEditingFeedId] = useState(null);
  const [editFeedName, setEditFeedName] = useState("");
  // Tracks which sections have been explicitly expanded — anything not in here starts
  // (and stays, until toggled) collapsed by default, including categories that haven't
  // loaded yet at mount time or get added later.
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  // undefined = no add-feed form open; null = open for Uncategorized; number = open for that category
  const [addFeedTarget, setAddFeedTarget] = useState(undefined);
  const [addFeedUrl, setAddFeedUrl] = useState("");

  function feedsForCategory(categoryId) {
    return feeds.filter((f) => (f.categoryId ?? null) === categoryId);
  }

  const uncategorized = feedsForCategory(null);

  function toggleCollapsed(key) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function startAddingFeed(categoryId) {
    setAddFeedTarget(categoryId);
    setAddFeedUrl("");
  }

  function cancelAddingFeed() {
    setAddFeedTarget(undefined);
    setAddFeedUrl("");
  }

  async function handleAddFeedSubmit(e, categoryId) {
    e.preventDefault();
    if (!addFeedUrl.trim()) return;
    try {
      await onAddFeed(addFeedUrl.trim(), categoryId);
      setAddFeedTarget(undefined);
      setAddFeedUrl("");
    } catch (err) {
      window.alert(err.message);
    }
  }

  function handleExportOPML() {
    const xml = buildOPML(categories, feeds);
    const blob = new Blob([xml], { type: "text/x-opml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "feeds.opml";
    a.click();
    URL.revokeObjectURL(url);
  }

  function renderAddFeedForm(categoryId) {
    return (
      <form className="add-feed-inline-form" onSubmit={(e) => handleAddFeedSubmit(e, categoryId)}>
        <input
          type="url"
          required
          autoFocus
          placeholder="Feed URL (RSS/Atom)"
          value={addFeedUrl}
          onChange={(e) => setAddFeedUrl(e.target.value)}
        />
        <div className="edit-feed-actions">
          <button type="submit">Add</button>
          <button type="button" onClick={cancelAddingFeed}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  function renderFeedRow(f) {
    if (editingFeedId === f.id) {
      return (
        <li key={f.id}>
          <form className="edit-feed-form" onSubmit={(e) => handleFeedRenameSubmit(e, f.id)}>
            <input
              type="text"
              required
              autoFocus
              value={editFeedName}
              onChange={(e) => setEditFeedName(e.target.value)}
            />
            <div className="feed-url-display">{f.url}</div>
            <div className="edit-feed-actions">
              <button type="submit">Save</button>
              <button type="button" onClick={() => setEditingFeedId(null)}>
                Cancel
              </button>
              <button type="button" className="delete-btn" onClick={() => handleDeleteFeed(f)}>
                Delete feed
              </button>
            </div>
          </form>
        </li>
      );
    }

    return (
      <li key={f.id}>
        <div className="feed-row">
          <button
            className={`feed-item ${selectedFeedId === f.id ? "active" : ""}`}
            aria-current={selectedFeedId === f.id ? "true" : undefined}
            title={f.url}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-feed-id", String(f.id));
              setIsDraggingFeed(true);
            }}
            onDragEnd={() => setIsDraggingFeed(false)}
            onClick={() => onSelectFeed(f.id)}
          >
            <img
              className="feed-icon"
              src={f.feedImageUrl || PLACEHOLDER_ICON}
              alt=""
              onError={(e) => {
                e.currentTarget.onerror = null;
                e.currentTarget.src = PLACEHOLDER_ICON;
              }}
            />
            <span className="feed-title-text">{f.title}</span>
          </button>
          <button className="edit-feed-btn" title="Edit feed" onClick={() => startEditingFeed(f)}>
            ✎
          </button>
        </div>
      </li>
    );
  }

  function startEditingCategory(cat) {
    setEditingCategoryId(cat.id);
    setEditCategoryName(cat.name);
  }

  async function handleRenameSubmit(e, categoryId) {
    e.preventDefault();
    if (!editCategoryName.trim()) return;
    try {
      await onRenameCategory(categoryId, editCategoryName.trim());
      setEditingCategoryId(null);
    } catch (err) {
      window.alert(err.message);
    }
  }

  function handleDeleteCategory(cat) {
    if (window.confirm(`Delete category "${cat.name}"? Its feeds will become Uncategorized.`)) {
      onDeleteCategory(cat.id);
      setEditingCategoryId(null);
    }
  }

  function startEditingFeed(f) {
    setEditingFeedId(f.id);
    setEditFeedName(f.title);
  }

  async function handleFeedRenameSubmit(e, feedId) {
    e.preventDefault();
    if (!editFeedName.trim()) return;
    try {
      await onRenameFeed(feedId, editFeedName.trim());
      setEditingFeedId(null);
    } catch (err) {
      window.alert(err.message);
    }
  }

  function handleDeleteFeed(f) {
    if (window.confirm(`Delete "${f.title}" and all its saved articles? This can't be undone.`)) {
      onDeleteFeed(f.id);
      setEditingFeedId(null);
    }
  }

  function dropZoneProps(key, categoryId, extraClassName = "") {
    return {
      className: `${extraClassName} drop-zone ${dragOverKey === key ? "drag-over" : ""}`.trim(),
      onDragOver: (e) => {
        e.preventDefault();
        setDragOverKey(key);
      },
      onDragLeave: () => setDragOverKey((k) => (k === key ? null : k)),
      onDrop: (e) => {
        e.preventDefault();
        const feedId = Number(e.dataTransfer.getData("application/x-feed-id"));
        if (!Number.isNaN(feedId)) onChangeFeedCategory(feedId, categoryId);
        setDragOverKey(null);
      },
    };
  }

  async function handleAddCategory(e) {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    try {
      await onAddCategory(newCategoryName.trim());
      setNewCategoryName("");
      setShowNewCategory(false);
    } catch (err) {
      window.alert(err.message);
    }
  }

  const uncategorizedCollapsed = !expandedIds.has("uncategorized");

  return (
    <nav className="sidebar">
      {(() => {
        const allActive =
          view === "all" && selectedCategoryId === null && selectedFeedId === null;
        return (
          <button
            className={`sidebar-item all-item ${allActive ? "active" : ""}`}
            aria-current={allActive ? "true" : undefined}
            onClick={() => onSelectCategory(null)}
          >
            All Feeds
            <Count n={counts.all} />
          </button>
        );
      })()}

      <button
        className={`sidebar-item ${view === "today" ? "active" : ""}`}
        aria-current={view === "today" ? "true" : undefined}
        onClick={onSelectToday}
      >
        Today
        <Count n={counts.today} />
      </button>

      <button
        className={`sidebar-item ${view === "readLater" ? "active" : ""}`}
        aria-current={view === "readLater" ? "true" : undefined}
        onClick={onSelectReadLater}
      >
        Read Later
        <Count n={counts.saved} />
      </button>

      <button
        className={`sidebar-item ${view === "readArticles" ? "active" : ""}`}
        aria-current={view === "readArticles" ? "true" : undefined}
        onClick={onSelectReadArticles}
      >
        Read Articles
      </button>

      {(uncategorized.length > 0 || isDraggingFeed) && (
        <>
          <div {...dropZoneProps("uncategorized", null, "category-header uncategorized-header")}>
            <div className="sidebar-item uncategorized-label">Uncategorized</div>
            <button
              className="collapse-btn"
              title={uncategorizedCollapsed ? "Expand" : "Collapse"}
              aria-label={uncategorizedCollapsed ? "Expand Uncategorized" : "Collapse Uncategorized"}
              aria-expanded={!uncategorizedCollapsed}
              onClick={() => toggleCollapsed("uncategorized")}
            >
              {uncategorizedCollapsed ? "▸" : "▾"}
            </button>
            <button
              className="add-feed-btn"
              title="Add feed"
              onClick={() => startAddingFeed(null)}
            >
              +
            </button>
          </div>
          {addFeedTarget === null && renderAddFeedForm(null)}
          {!uncategorizedCollapsed && (
            <ul className="feed-list">{uncategorized.map(renderFeedRow)}</ul>
          )}
        </>
      )}

      <div className="sidebar-divider" />

      {categories.length > 0 && <div className="sb-section-label">Categories</div>}

      <ul className="category-list">
        {categories.map((cat) => {
          const key = `cat-${cat.id}`;
          const collapsed = !expandedIds.has(key);
          return (
            <li key={cat.id} {...dropZoneProps(key, cat.id)}>
              {editingCategoryId === cat.id ? (
                <form
                  className="edit-category-form"
                  onSubmit={(e) => handleRenameSubmit(e, cat.id)}
                >
                  <input
                    type="text"
                    required
                    autoFocus
                    value={editCategoryName}
                    onChange={(e) => setEditCategoryName(e.target.value)}
                  />
                  <div className="edit-category-actions">
                    <button type="submit">Save</button>
                    <button type="button" onClick={() => setEditingCategoryId(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="delete-btn"
                      onClick={() => handleDeleteCategory(cat)}
                    >
                      Delete category
                    </button>
                  </div>
                </form>
              ) : (
                <div className="category-header">
                  <button
                    className={`sidebar-item ${selectedCategoryId === cat.id ? "active" : ""}`}
                    aria-current={selectedCategoryId === cat.id ? "true" : undefined}
                    onClick={() => onSelectCategory(cat.id)}
                  >
                    {cat.name}
                  </button>
                  <button
                    className="collapse-btn"
                    title={collapsed ? "Expand" : "Collapse"}
                    aria-label={collapsed ? `Expand ${cat.name}` : `Collapse ${cat.name}`}
                    aria-expanded={!collapsed}
                    onClick={() => toggleCollapsed(key)}
                  >
                    {collapsed ? "▸" : "▾"}
                  </button>
                  <button
                    className="add-feed-btn"
                    title="Add feed"
                    onClick={() => startAddingFeed(cat.id)}
                  >
                    +
                  </button>
                  <button
                    className="edit-category-btn"
                    title="Edit category"
                    onClick={() => startEditingCategory(cat)}
                  >
                    ✎
                  </button>
                </div>
              )}
              {addFeedTarget === cat.id && renderAddFeedForm(cat.id)}
              {!collapsed && (
                <ul className="feed-list">{feedsForCategory(cat.id).map(renderFeedRow)}</ul>
              )}
            </li>
          );
        })}
      </ul>

      {showNewCategory ? (
        <form className="add-category-form" onSubmit={handleAddCategory}>
          <input
            type="text"
            required
            autoFocus
            placeholder="Category name"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
          />
          <button type="submit">Add</button>
          <button type="button" onClick={() => setShowNewCategory(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button className="new-category-btn" onClick={() => setShowNewCategory(true)}>
          + Add Category
        </button>
      )}

      <div className="sidebar-section">
        <div className="sidebar-section-label">Customization</div>
        <div className="sidebar-section-card">
          <button className="sidebar-card-row" onClick={handleExportOPML}>
            Export OPML
          </button>
          <div className="sidebar-card-row sidebar-card-row-theme">
            <div className="theme-control" role="group" aria-label="Appearance">
              {[
                ["system", "System"],
                ["light", "Light"],
                ["dark", "Dark"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`theme-option ${theme === value ? "active" : ""}`}
                  aria-pressed={theme === value}
                  onClick={() => onSetTheme(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}
