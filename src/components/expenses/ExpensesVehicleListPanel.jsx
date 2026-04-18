import { useEffect, useMemo, useState } from "react";

const API_BASE = "http://localhost:5000";
const VEHICLES_API = `${API_BASE}/api/vehicles/status`;

function buildVehicleLabel(vehicle) {
  if (vehicle?.nickname) return vehicle.nickname;
  const bits = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean);
  return bits.length ? bits.join(" ") : `Vehicle ${vehicle?.id}`;
}

function buildVehicleSubLabel(vehicle) {
  const bits = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean);
  return bits.length ? bits.join(" ") : "Vehicle";
}

function sortVehicles(a, b) {
  return buildVehicleLabel(a).localeCompare(buildVehicleLabel(b));
}

export default function ExpensesVehicleListPanel({
  selectedVehicleId,
  onSelectVehicle,
}) {
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let ignore = false;

    async function loadVehicles() {
      setLoading(true);
      setLoadError("");

      try {
        const res = await fetch(VEHICLES_API);
        if (!res.ok) {
          throw new Error(`Failed to load vehicles (${res.status})`);
        }

        const data = await res.json();
        const rows = Array.isArray(data) ? data : data?.data || [];

        if (!ignore) {
          setVehicles(rows);
        }
      } catch (err) {
        if (!ignore) {
          setLoadError(err.message || "Failed to load vehicles");
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    loadVehicles();

    return () => {
      ignore = true;
    };
  }, []);

  const sortedVehicles = useMemo(() => {
    return [...vehicles].sort(sortVehicles);
  }, [vehicles]);

  return (
    <section className="panel expenses-vehicle-panel">
      <div className="panel-header">
        <div>
          <h2>Expenses</h2>
          <span>
            {selectedVehicleId ? "Filtered by vehicle" : "Fleet-wide expense view"}
          </span>
        </div>
      </div>

      <div className="list fleet-list">
        <div
          className={`fleet-row ${
            selectedVehicleId == null ? "fleet-row--highlighted" : ""
          }`}
        >
          <button
            type="button"
            className="fleet-row-summary"
            onClick={() => onSelectVehicle?.(null)}
          >
            <div className="fleet-row-summary-main">
              <div className="fleet-row-title">All expenses</div>
              <div className="fleet-row-odometer">Fleet-wide summary</div>
            </div>

            <div className="fleet-row-summary-side">
              <div className="fleet-status-pill parked">
                {selectedVehicleId == null ? "Selected" : "All"}
              </div>
            </div>
          </button>
        </div>

        {loading ? (
          <div className="message-empty">Loading vehicles…</div>
        ) : loadError ? (
          <div className="expenses-error-state">{loadError}</div>
        ) : !sortedVehicles.length ? (
          <div className="message-empty">No vehicles found.</div>
        ) : (
          sortedVehicles.map((vehicle) => {
            const vehicleId = Number(vehicle.id);
            const isSelected = Number(selectedVehicleId) === vehicleId;
            const label = buildVehicleLabel(vehicle);
            const subLabel = buildVehicleSubLabel(vehicle);

            return (
              <div
                key={vehicleId}
                className={`fleet-row ${isSelected ? "fleet-row--highlighted" : ""}`}
              >
                <button
                  type="button"
                  className="fleet-row-summary"
                  onClick={() => onSelectVehicle?.(vehicleId)}
                >
                  <div className="fleet-row-summary-main">
                    <div className="fleet-row-title">{label}</div>
                    <div className="fleet-row-odometer">{subLabel}</div>
                  </div>

                  <div className="fleet-row-summary-side">
                    <div className={`fleet-status-pill ${isSelected ? "running" : "parked"}`}>
                      {isSelected ? "Selected" : "View"}
                    </div>
                  </div>
                </button>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}