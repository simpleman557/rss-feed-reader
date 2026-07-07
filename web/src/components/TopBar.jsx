export default function TopBar({ sort, onSetSort, onRefresh, refreshing }) {
  return (
    <header className="topbar">
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
