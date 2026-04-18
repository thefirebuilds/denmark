// --------------------------------------------------------------
// /src/components/maintenance/GuestSafetySnapshotCard.jsx
// File to hold the card component for the guest-facing safety snapshot PDF. 
// This is a simplified view of key safety and condition info about the vehicle, 
// designed for easy sharing with guests before their trip.
//--------------------------------------------------------------

import { getVinLast6, formatMiles } from "../../utils/maintUtils";


export default function GuestSafetySnapshotCard({ vehicle, cardRef }) {
  if (!vehicle) return null;

  const passItems = vehicle.inspection_items.filter((item) => item.status === "pass");
  const attentionItems = vehicle.inspection_items.filter(
    (item) => item.status === "attention" || item.status === "fail"
  );

  const headline =
    attentionItems.length === 0
      ? "No known safety issues at time of inspection."
      : "Inspection review recommended before next guest handoff.";

  return (
    <div className="guest-snapshot-shell">
      <div className="guest-snapshot-card" ref={cardRef}>
        <div className="guest-snapshot-header">
          <div className="guest-snapshot-brand">
            <img
              src="/logo.png"
              alt="Fresh Coast Garage"
              className="guest-snapshot-logo"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
            <div className="guest-snapshot-brand-text">
              <div className="guest-snapshot-brand-name">Vehicle Safety Snapshot</div>
              <div className="guest-snapshot-brand-sub">
                Prepared for your trip
              </div>
            </div>
          </div>

          <div
            className={`guest-snapshot-status ${
              attentionItems.length === 0 ? "ok" : "review"
            }`}
          >
            {attentionItems.length === 0 ? "Guest-ready" : "Needs review"}
          </div>
        </div>

        <div className="guest-snapshot-hero">
          <div className="guest-snapshot-subtitle">
            Plate {vehicle.plate || "—"} • VIN ending {getVinLast6(vehicle.vin)}
          </div>

          <div className="guest-snapshot-subtitle">
            Odometer {formatMiles(vehicle.currentOdometerMiles)} • {vehicle.next_service_due?.label || "Next service due"} {vehicle.next_service_due?.text || "Unknown"}
          </div>
        </div>

        <div className="guest-snapshot-summary">
          {headline}
        </div>

        <div className="guest-snapshot-grid">
          <div className="guest-snapshot-block">
            <div className="guest-snapshot-block-title">Vehicle basics</div>
            <div className="guest-snapshot-row">
              <span>Registration</span>
              <strong>{vehicle.registration_expires}</strong>
            </div>
            <div className="guest-snapshot-row-value">✅ No Open Recalls</div>
            <div className="guest-snapshot-row">
              <span>Body condition</span>
              <strong>{vehicle.body_condition}</strong>
            </div>
          </div>

          <div className="guest-snapshot-block">
            <div className="guest-snapshot-block-title">Checked and documented</div>
            {passItems.slice(0, 6).map((item) => {
              const rawDot = item.lastEvent?.data?.dot_code || item.lastEvent?.data?.dotCode || null;

              function parseDotCode(dotCode) {
                const raw = String(dotCode || "").trim();
                if (!/^\d{4}$/.test(raw)) return null;
                const week = Number(raw.slice(0, 2));
                const yearTwoDigit = Number(raw.slice(2, 4));
                const fullYear = 2000 + yearTwoDigit;
                if (week < 1 || week > 53) return null;
                const jan1 = new Date(fullYear, 0, 1);
                const manufacturedAt = new Date(jan1.getTime() + (week - 1) * 7 * 24 * 60 * 60 * 1000);
                return { week, year: fullYear, manufacturedAt };
              }

              function formatDotCodeForGuest(dotCode) {
                const parsed = parseDotCode(dotCode);
                if (!parsed) return `DOT ${dotCode}`;
                const now = new Date();
                const monthsOld =
                  (now.getFullYear() - parsed.manufacturedAt.getFullYear()) * 12 +
                  (now.getMonth() - parsed.manufacturedAt.getMonth());
                const years = Math.floor(Math.max(monthsOld, 0) / 12);
                const months = Math.max(monthsOld, 0) % 12;
                const madeLabel = parsed.manufacturedAt.toLocaleDateString("en-US", { month: "short", year: "numeric" });
                const ageLabel = years > 0 ? `${years} yr ${months} mo old` : `${months} mo old`;
                return `${madeLabel} • ${ageLabel}`;
              }

              return (
                <div key={item.label} className="guest-snapshot-check">
                  <span className="guest-snapshot-check-icon">✓</span>
                  <span>
                    <strong>{item.label}:</strong>{" "}
                    {item.ruleCode === "tire_age_review" && rawDot ? (
                      <>
                        DOT {rawDot} • {formatDotCodeForGuest(rawDot)}
                      </>
                    ) : (
                      item.value
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="guest-snapshot-block">
          <div className="guest-snapshot-block-title">Known cosmetic condition</div>

          {vehicle.body_notes?.length > 0 ? (
            <>
              <ul className="guest-snapshot-notes">
                {vehicle.body_notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>

              <div className="guest-snapshot-footnote">
                These cosmetic items are documented and are not the responsibility
                of the current guest.
              </div>
            </>
          ) : (
            <div className="guest-snapshot-footnote">
              No documented cosmetic notes at this time.
            </div>
          )}
        </div>

        <div className="guest-snapshot-footer">
          <div>Generated for guest review</div>
          <div>This vehicle is monitored and inspected by the host.</div>
        </div>
      </div>
    </div>
  );
}