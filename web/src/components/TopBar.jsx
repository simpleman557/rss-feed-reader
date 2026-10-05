export default function TopBar({
  sort,
  onSetSort,
  onRefresh,
  refreshing,
  searchQuery,
  onSearchQueryChange,
  menuOpen,
  onOpenMenu,
  menuButtonRef,
}) {
  return (
    <header className="topbar">
      <button
        ref={menuButtonRef}
        type="button"
        className="menu-btn"
        aria-label="Open menu"
        aria-controls="sidebar"
        aria-expanded={menuOpen}
        onClick={onOpenMenu}
      >
        {"☰"}
      </button>
      <input
        className="search-input"
        type="search"
        placeholder="Search"
        value={searchQuery}
        onChange={(e) => onSearchQueryChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onSearchQueryChange(""); }}
      />
      <div className="topbar-actions">
        {/* On phones this collapses to a 44px icon: the glyph shows the direction and the
            native <select> sits invisibly on top, so tapping still opens the OS picker. */}
        <label className="sort-control">
          <span className="sort-glyph" aria-hidden="true">
            {sort === "oldest" ? "↑" : "↓"}
          </span>
          <select aria-label="Sort order" value={sort} onChange={(e) => onSetSort(e.target.value)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
        <button
          className="refresh-btn"
          onClick={() => onRefresh()}
          disabled={refreshing}
          aria-label={refreshing ? "Refreshing" : "Refresh"}
        >
          <span className={`refresh-glyph${refreshing ? " spinning" : ""}`} aria-hidden="true">
            {"↻"}
          </span>
          <span className="refresh-label">{refreshing ? "Refreshing…" : "Refresh"}</span>
        </button>
      </div>
    </header>
  );
}
