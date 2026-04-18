import { useLayoutEffect, useRef, useState } from "react";

// --------------------------------------------------------------
// /src/components/maintenance/PreflightCard.jsx
// Operator-facing preflight / turnover checklist export card
// --------------------------------------------------------------

function buildChecklistSections() {
  return [
    {
      title: "Clean & reset",
      items: [
        "Vacuum interior, seats, mats, and trunk",
        "Wipe dash, console, doors, and touch points",
        "Clean inside/outside glass",
        "Remove trash and guest items",
        "Wash exterior and dry door jambs",
      ],
    },
    {
      title: "Mechanical quick check",
      items: [
        "Check oil level",
        "Check washer fluid level",
        "Check coolant level",
        "Check brake fluid visually",
        "Check for fresh leaks under vehicle",
        "Check startup warning lights",
        "Confirm lights and wipers working",
      ],
    },
    {
      title: "Tires & safety",
      items: [
        "Set tire pressures",
        "Inspect tread and uneven wear",
        "Check for punctures / sidewall damage",
        "Quick visual brake / wheel condition check",
      ],
    },
    {
      title: "Photos & documentation",
      items: [
        "Take exterior walkaround photos",
        "Take interior photos",
        "Take odometer photo",
        "Take fuel level photo",
        "Capture any new damage close-ups",
      ],
    },
    {
      title: "Guest setup",
      items: [
        "Reset hospitality items / chargers",
        "Align mats and tidy cargo area",
        "Confirm registration is present",
        "Confirm insurance card is present",
        "Set and test lockbox",
        "Verify key starts and unlocks vehicle",
      ],
    },
  ];
}

export default function PreflightCard({
  vehicle,
  windowLabel,
  dueItems,
  cardRef,
}) {
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  const [scale, setScale] = useState(1);

  const checklistSections = buildChecklistSections();
  const dueList = Array.isArray(dueItems) ? dueItems.slice(0, 8) : [];

  useLayoutEffect(() => {
    function measureAndScale() {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content) return;

      // reset before measuring natural size
      setScale(1);

      requestAnimationFrame(() => {
        const viewportWidth = viewport.clientWidth;
        const viewportHeight = viewport.clientHeight;

        const contentWidth = content.scrollWidth;
        const contentHeight = content.scrollHeight;

        if (!viewportWidth || !viewportHeight || !contentWidth || !contentHeight) {
          return;
        }

        const widthScale = viewportWidth / contentWidth;
        const heightScale = viewportHeight / contentHeight;
        const nextScale = Math.min(1, widthScale, heightScale);

        setScale(nextScale);
      });
    }

    measureAndScale();
    window.addEventListener("resize", measureAndScale);
    return () => window.removeEventListener("resize", measureAndScale);
  }, [
    vehicle?.nickname,
    vehicle?.year,
    vehicle?.make,
    vehicle?.model,
    vehicle?.registration_expires,
    vehicle?.body_condition,
    vehicle?.currentOdometerMiles,
    vehicle?.vin,
    vehicle?.vin_last6,
    windowLabel,
    dueList.length,
    vehicle?.body_notes?.length,
  ]);

  if (!vehicle) return null;

  return (
    <div className="preflight-page" ref={cardRef}>
      <div className="preflight-viewport" ref={viewportRef}>
        <div
          className="preflight-scale-wrap"
          style={{ transform: `scale(${scale})` }}
        >
          <div className="preflight-card" ref={contentRef}>
            <div className="preflight-header">
              <div className="preflight-brand">
                <img
                  src="/logo.png"
                  alt="Fresh Coast Garage"
                  className="preflight-logo"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
                <div className="preflight-brand-text">
                  <div className="preflight-brand-name">Vehicle Preparation Card</div>
                  <div className="preflight-brand-sub">Turnover / preflight checklist</div>
                </div>
              </div>

              <div className="preflight-status">
                {windowLabel || "Open prep window"}
              </div>
            </div>

            <div className="preflight-hero">
              <div className="preflight-title">
                {vehicle.nickname} • {vehicle.year} {vehicle.make} {vehicle.model}
              </div>
              <div className="preflight-subtitle">
                Plate {vehicle.plate || vehicle.license_plate || "—"} • VIN ending{" "}
                {vehicle.vin_last6 || String(vehicle.vin || "").slice(-6) || "Unknown"}
              </div>
            </div>

            <div className="preflight-summary">
              Prep this vehicle before the next guest-facing handoff. Complete due
              maintenance first, then work the turnover checklist.
            </div>

            <div className="preflight-grid">
              <div className="preflight-block">
                <div className="preflight-block-title">Vehicle basics</div>

                <div className="preflight-row">
                  <span>Registration</span>
                  <strong>{vehicle.registration_expires || "—"}</strong>
                </div>

                <div className="preflight-row">
                  <span>Recall status</span>
                  <strong>No open recalls</strong>
                </div>

                <div className="preflight-row">
                  <span>Body condition</span>
                  <strong>{vehicle.body_condition || "unknown"}</strong>
                </div>

                <div className="preflight-row">
                  <span>Current odometer</span>
                  <strong>
                    {vehicle.currentOdometerMiles != null
                      ? `${Number(vehicle.currentOdometerMiles).toLocaleString()} mi`
                      : "—"}
                  </strong>
                </div>
              </div>

              <div className="preflight-block">
                <div className="preflight-block-title">Due before next trip</div>

                {dueList.length ? (
                  <div className="preflight-due-list">
                    {dueList.map((item) => (
                      <div key={item.id || item.title} className="preflight-due-item">
                        <span className="preflight-due-icon">!</span>
                        <span>{item.title}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="preflight-footnote">
                    No maintenance items are currently due inside this prep window.
                  </div>
                )}
              </div>
            </div>

            <div className="preflight-checklist-grid">
              {checklistSections.map((section) => (
                <div key={section.title} className="preflight-block">
                  <div className="preflight-block-title">{section.title}</div>

                  <div className="preflight-checklist">
                    {section.items.map((item) => (
                      <div key={item} className="preflight-check">
                        <span className="preflight-checkbox" />
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="preflight-block">
              <div className="preflight-block-title">Known cosmetic condition</div>

              {vehicle.body_notes?.length ? (
                <>
                  <ul className="preflight-notes">
                    {vehicle.body_notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>

                  <div className="preflight-footnote">
                    These cosmetic items are already documented and should be
                    re-photographed only if condition has changed.
                  </div>
                </>
              ) : (
                <div className="preflight-footnote">
                  No documented cosmetic notes at this time.
                </div>
              )}
            </div>

            <div className="preflight-footer">
              <div>Generated for vehicle prep</div>
              <div>Fresh Coast Garage • operator turnover card</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
