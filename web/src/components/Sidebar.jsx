import { useRef, useState } from "react";
import { buildOPML, formatImportSummary } from "../data/opml";
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
  onImportOPML,
  onChangeFeedCategory,
  onRenameCategory,
  onRenameFeed,
  onDeleteFeed,
  onDeleteCategory,
  theme,
  onSetTheme,
  open,
  onClose,
  closeButtonRef,
}) {
  const [newCategoryName, setNewCategoryName] = useState("");
  // Which form is open in the Customization card: null, "category", or "feed".
  const [customForm, setCustomForm] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  const [editingCategoryId, setEditingCategoryId] = useState(null);
  const [editCategoryName, setEditCategoryName] = useState("");
  const [editingFeedId, setEditingFeedId] = useState(null);
  const [editFeedName, setEditFeedName] = useState("");
  // Tracks which sections have been explicitly expanded — anything not in here starts
  // (and stays, until toggled) collapsed by default, including categories that haven't
  // loaded yet at mount time or get added later.
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [addFeedUrl, setAddFeedUrl] = useState("");
  const [addFeedCategoryId, setAddFeedCategoryId] = useState("");
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef(null);

  function feedsForCategory(categoryId) {
    return feeds.filter((f) => (f.categoryId ?? null) === categoryId);
  }

  function toggleCollapsed(key) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAddCategory() {
    setNewCategoryName("");
    setCustomForm((f) => (f === "category" ? null : "category"));
  }

  // A feed has to belong to a category, so the form asks. Defaults to where you are: the
  // selected category, else the category of the selected feed, else the first one.
  function toggleAddFeed() {
    if (customForm === "feed") {
      setCustomForm(null);
      return;
    }
    const selectedFeed = feeds.find((f) => f.id === selectedFeedId);
    setAddFeedUrl("");
    setAddFeedCategoryId(String(selectedCategoryId ?? selectedFeed?.categoryId ?? categories[0]?.id ?? ""));
    setCustomForm("feed");
  }

  async function handleAddFeedSubmit(e) {
    e.preventDefault();
    if (!addFeedUrl.trim() || !addFeedCategoryId) return;
    try {
      await onAddFeed(addFeedUrl.trim(), Number(addFeedCategoryId));
      setCustomForm(null);
      setAddFeedUrl("");
    } catch (err) {
      window.alert(err.message);
    }
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    // Clear the input so choosing the same file again still fires a change event.
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      window.alert(formatImportSummary(await onImportOPML(file)));
    } catch (err) {
      window.alert(err.message);
    } finally {
      setImporting(false);
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
        <div
          className={`feed-row ${selectedFeedId === f.id ? "active" : ""}`}
          onClick={() => onSelectFeed(f.id)}
        >
          <button
            className={`feed-item ${selectedFeedId === f.id ? "active" : ""}`}
            aria-current={selectedFeedId === f.id ? "true" : undefined}
            title={f.url}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("application/x-feed-id", String(f.id))}
          >
            <img
              className="feed-icon"
              src={f.feedImageUrl || PLACEHOLDER_ICON}
              alt=""
              width="16"
              height="16"
              loading="lazy"
              decoding="async"
              onError={(e) => {
                e.currentTarget.onerror = null;
                e.currentTarget.src = PLACEHOLDER_ICON;
              }}
            />
            <span className="feed-title-text">{f.title}</span>
          </button>
          <button
            className="edit-feed-btn"
            title="Edit feed"
            aria-label={`Edit ${f.title}`}
            onClick={(e) => {
              e.stopPropagation();
              startEditingFeed(f);
            }}
          >
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

  async function handleDeleteCategory(cat) {
    if (window.confirm(`Delete category "${cat.name}"?`)) {
      try {
        await onDeleteCategory(cat.id);
        setEditingCategoryId(null);
      } catch (err) {
        window.alert(err.message);
      }
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
      setCustomForm(null);
    } catch (err) {
      window.alert(err.message);
    }
  }

  return (
    <nav id="sidebar" className={`sidebar${open ? " open" : ""}`} aria-label="Feeds">
      <div className="sidebar-header">
        <span className="sidebar-title">Feed Reader</span>
        <button
          ref={closeButtonRef}
          type="button"
          className="sidebar-close"
          aria-label="Close menu"
          onClick={onClose}
        >
          {"\u2715"}
        </button>
      </div>

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

      <div className="sidebar-divider" />

      {categories.length > 0 && <div className="sidebar-section-label">Categories</div>}

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
                // The whole row selects the category (the name button's click bubbles up to
                // it). With a mouse, selecting also expands/collapses — there's no chevron
                // on desktop. On touch, a tap only selects; the selected row then shows a
                // pencil and a chevron right after the name, and the chevron is what
                // expands. The two small buttons stop propagation so they don't also select.
                <div
                  className={`category-header ${selectedCategoryId === cat.id ? "active" : ""}`}
                  onClick={() => {
                    onSelectCategory(cat.id);
                    if (window.matchMedia("(hover: hover)").matches) toggleCollapsed(key);
                  }}
                >
                  <button
                    className={`sidebar-item ${selectedCategoryId === cat.id ? "active" : ""}`}
                    aria-current={selectedCategoryId === cat.id ? "true" : undefined}
                  >
                    {cat.name}
                  </button>
                  <button
                    className="edit-category-btn"
                    title="Edit category"
                    aria-label={`Edit ${cat.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      startEditingCategory(cat);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="expand-btn"
                    aria-label={collapsed ? `Expand ${cat.name}` : `Collapse ${cat.name}`}
                    aria-expanded={!collapsed}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapsed(key);
                    }}
                  >
                    {collapsed ? "▸" : "▾"}
                  </button>
                </div>
              )}
              {!collapsed && (
                <ul className="feed-list">{feedsForCategory(cat.id).map(renderFeedRow)}</ul>
              )}
            </li>
          );
        })}
      </ul>

      <div className="sidebar-section">
        <div className="sidebar-section-label">Customization</div>
        <div className="sidebar-section-card">
          <div className="sidebar-card-row sidebar-card-row-split">
            <button
              className="sidebar-card-half"
              aria-expanded={customForm === "category"}
              onClick={toggleAddCategory}
            >
              Add category
            </button>
            <button
              className="sidebar-card-half"
              aria-expanded={customForm === "feed"}
              onClick={toggleAddFeed}
            >
              Add feed
            </button>
          </div>
          {customForm === "category" && (
            <form className="customize-form" onSubmit={handleAddCategory}>
              <label htmlFor="new-category-name">Category name</label>
              <input
                id="new-category-name"
                type="text"
                required
                autoFocus
                placeholder="Tech"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
              />
              <div className="customize-form-actions">
                <button type="submit">Add</button>
                <button type="button" onClick={() => setCustomForm(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {customForm === "feed" && (
            <form className="customize-form" onSubmit={handleAddFeedSubmit}>
              {categories.length === 0 ? (
                <p className="customize-form-note">Add a category first, then you can add feeds to it.</p>
              ) : (
                <>
                  <label htmlFor="new-feed-url">Feed URL</label>
                  <input
                    id="new-feed-url"
                    type="url"
                    required
                    autoFocus
                    placeholder="https://example.com/feed.xml"
                    value={addFeedUrl}
                    onChange={(e) => setAddFeedUrl(e.target.value)}
                  />
                  <label htmlFor="new-feed-category">Category</label>
                  <select
                    id="new-feed-category"
                    value={addFeedCategoryId}
                    onChange={(e) => setAddFeedCategoryId(e.target.value)}
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <div className="customize-form-actions">
                {categories.length > 0 && <button type="submit">Add</button>}
                <button type="button" onClick={() => setCustomForm(null)}>
                  {categories.length > 0 ? "Cancel" : "Close"}
                </button>
              </div>
            </form>
          )}
          <div className="sidebar-card-row sidebar-card-row-split">
            <button
              className="sidebar-card-half"
              onClick={() => importInputRef.current?.click()}
              disabled={importing}
            >
              {importing ? "Importing\u2026" : "Import OPML"}
            </button>
            <button className="sidebar-card-half" onClick={handleExportOPML}>
              Export OPML
            </button>
          </div>
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
        <input
          ref={importInputRef}
          type="file"
          accept=".opml,.xml,text/xml,application/xml,text/x-opml"
          hidden
          onChange={handleImportFile}
        />
      </div>
    </nav>
  );
}
