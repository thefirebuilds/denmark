import { useState } from "react";

// --------------------------------------------------------------
// /src/components/Rail.jsx
// Vertical rail component used for navigation and quick actions.
//--------------------------------------------------------------

const NAV_ITEMS = [
  { view: "dispatch", label: "Trips", icon: "✈️" },
  { view: "maintenance", label: "Maintenance", icon: "🚗" },
  { view: "metrics", label: "Metrics", icon: "📈" },
  { view: "expenses", label: "Expenses", icon: "💰" },
  { view: "inbox", label: "Expense Processing", icon: "💳" },
  { view: "marketplace", label: "Marketplace", icon: "🛍️" },
  { view: "fleet-map", label: "Fleet Map", icon: "🌎" },
  { view: "ledger", label: "Trip Ledger", icon: "📒" },
];

export default function Rail({ activeView = "dispatch", onChangeView }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <nav className={`rail ${expanded ? "rail--expanded" : ""}`}>
      <button
        type="button"
        className="rail-brand"
        onClick={() => setExpanded((current) => !current)}
        aria-label={expanded ? "Collapse menu" : "Expand menu"}
        aria-expanded={expanded}
        title={expanded ? "Collapse menu" : "Expand menu"}
      >
        <span className="rail-icon" aria-hidden="true">
          ≡
        </span>
        <span className="rail-label">Menu</span>
      </button>

      {NAV_ITEMS.map((item) => (
        <button
          key={item.view}
          type="button"
          className={`rail-btn ${activeView === item.view ? "active" : ""}`}
          onClick={() => onChangeView?.(item.view)}
          title={item.label}
          aria-label={item.label}
        >
          <span className="rail-icon" aria-hidden="true">
            {item.icon}
          </span>
          <span className="rail-label">{item.label}</span>
        </button>
      ))}

      <div className="rail-spacer"></div>

      <button
        type="button"
        className={`rail-btn ${activeView === "settings" ? "active" : ""}`}
        onClick={() => onChangeView?.("settings")}
        title="Settings"
        aria-label="Settings"
      >
        <span className="rail-icon" aria-hidden="true">
          ⚙️
        </span>
        <span className="rail-label">Settings</span>
      </button>
    </nav>
  );
}
