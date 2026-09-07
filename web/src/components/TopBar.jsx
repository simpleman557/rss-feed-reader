export default function TopBar({ sort, onSetSort, onRefresh, refreshing, searchQuery, onSearchQueryChange }) {
  return (
    <header className="topbar">
      <input
        className="search-input"
        type="search"
        placeholder="Search"
        value={searchQuery}
        onChange={(e) => onSearchQueryChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onSearchQueryChange(""); }}
      />
      <div className="topbar-actions">
        <select value={sort} onChange={(e) => onSetSort(e.target.value)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
        <button className="refresh-btn" onClick={() => onRefresh()} disabled={refreshing}>
          {refreshing ? "Refreshing\u2026" : "Refresh"}
        </button>
      </div>
    </header>
  );
}
