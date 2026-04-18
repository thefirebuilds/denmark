// --------------------------------------------------------------
// /src/components/Rail.jsx
// file to hold the vertical rail component used for navigation and quick actions
//--------------------------------------------------------------

export default function Rail({ activeView = "dispatch", onChangeView }) {
  return (
    <nav className="rail">
      <div className="rail-brand">≡</div>

      <button
        type="button"
        className={`rail-btn ${activeView === "dispatch" ? "active" : ""}`}
        onClick={() => onChangeView?.("dispatch")}
        title="Trips"
      >
        ✈️
      </button>

      <button
        type="button"
        className={`rail-btn ${activeView === "maintenance" ? "active" : ""}`}
        onClick={() => onChangeView?.("maintenance")}
        title="Maintenance"
      >
        🚗
      </button>

      <button
        type="button"
        className={`rail-btn ${activeView === "expenses" ? "active" : ""}`}
        onClick={() => onChangeView?.("expenses")}
        title="Expenses"
      >
        💰
      </button>

      <button
        type="button"
        className={`rail-btn ${activeView === "ledger" ? "active" : ""}`}
        onClick={() => onChangeView?.("ledger")}
        title="Trip Ledger"
      >
        📒
      </button>

      <button
        type="button"
        className={`rail-btn ${activeView === "inbox" ? "active" : ""}`}
        onClick={() => onChangeView?.("inbox")}
        title="Expense Processing"
      >
        🧾
      </button>

      <button
        type="button"
        className={`rail-btn ${activeView === "metrics" ? "active" : ""}`}
        onClick={() => onChangeView?.("metrics")}
        title="Metrics"
      >
        📈
      </button>

      <button
        type="button"
        className={`rail-btn ${activeView === "marketplace" ? "active" : ""}`}
        onClick={() => onChangeView?.("marketplace")}
        title="Marketplace"
      >
        🛍️
      </button>

      <div className="rail-spacer"></div>

      <button
        type="button"
        className={`rail-btn ${activeView === "settings" ? "active" : ""}`}
        onClick={() => onChangeView?.("settings")}
        title="Settings"
      >
        ⚙️
      </button>
    </nav>
  );
}
