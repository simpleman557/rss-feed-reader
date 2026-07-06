export default function TopBar({ view, onSetView, sort, onSetSort, onRefresh, refreshing }) {
  return (
    <header className="topbar">
      <div className="view-tabs">
        {["today", "all", "readLater"].map((v) => (
          <button
            key={v}
            className={`view-tab ${view === v ? "active" : ""}`}
            onClick={() => onSetView(v)}
          >
            {v === "today" ? "Today" : v === "all" ? "All" : "Read Later"}
          </button>
        ))}
      </div>

      <div className="topbar-actions">
        <select value={sort} onChange={(e) => onSetSort(e.target.value)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
        <button onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </header>
  );
}
