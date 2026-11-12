import { useEffect, useRef, useState } from "react";
import "../../styles/telemetry-snapshot.css";

const unavailable = "Not reported";
const reading = (value, unit = "") => value == null || value === "" || !Number.isFinite(Number(value))
  ? unavailable : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 5 })}${unit}`;
const time = value => value && Number.isFinite(new Date(value).getTime())
  ? new Date(value).toLocaleString() : unavailable;
const state = (value, yes, no) => value === true ? yes : value === false ? no : unavailable;

export default function TelemetrySnapshot({ vehicle, onClose }) {
  const dialog = useRef(null);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current.showModal();
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/vehicles/cached-status", { signal: controller.signal });
        if (!response.ok) throw new Error(`Unable to load telemetry (${response.status})`);
        const data = await response.json();
        const match = Array.isArray(data) && data.find(item =>
          vehicle.id != null && String(item.id) === String(vehicle.id));
        if (!match?.telemetry) throw new Error("No collected telemetry is available for this vehicle.");
        setSnapshot(match);
      } catch (err) {
        if (err.name !== "AbortError") setError(err.message);
      }
    }
    load();
    return () => controller.abort();
  }, [vehicle.id]);

  const t = snapshot?.telemetry;
  const groups = t ? [
    ["Collection", [
      ["Provider", t.source || snapshot.telemetry_source?.join(", ") || unavailable],
      ["Collected at", time(t.timestamps?.captured_at)],
      ["Provider updated at", time(t.timestamps?.vehicle_last_updated)],
    ]],
    ["Driving", [
      ["Engine", state(t.engine_running, "Running", "Off")],
      ["Speed", reading(t.speed, " mph")],
      ["Reported odometer", reading(t.reported_odometer, " mi")],
      ["Fuel level", reading(t.fuel_level, "%")],
      ["Engine speed", reading(t.engine?.rpm, " rpm")],
      ["Coolant temperature", reading(t.engine?.coolant_temp, " °F")],
    ]],
    ["Location", [
      ["Latitude", reading(t.location?.lat)],
      ["Longitude", reading(t.location?.lon)],
      ["Heading", reading(t.location?.heading, "°")],
      ["Address", t.location?.address || unavailable],
      ["GPS updated at", time(snapshot.location_last_updated || t.timestamps?.location_last_updated)],
    ]],
    ["Battery & diagnostics", [
      ["Battery voltage", reading(t.battery?.voltage, " V")],
      ["Battery status", t.battery?.status || unavailable],
      ["Battery updated at", time(t.battery?.last_updated)],
      ["Check engine light", state(t.mil?.mil_on, "On", "Off")],
      ["Diagnostics updated at", time(t.mil?.last_updated)],
      ["Trouble codes", t.mil?.qualified_dtc_list?.length
        ? t.mil.qualified_dtc_list.map(code => typeof code === "string" ? code : code.code || code.description || "Unidentified code").join(", ")
        : t.mil?.last_updated ? "None reported" : unavailable],
    ]],
  ] : [];

  return <dialog ref={dialog} className="telemetry-snapshot" onClose={onClose}
    onClick={event => { if (event.target === dialog.current) dialog.current.close(); }}
    aria-labelledby="telemetry-snapshot-title">
    <header>
      <div><h2 id="telemetry-snapshot-title">Telemetry snapshot</h2><p>{vehicle.nickname || vehicle.model || "Vehicle"}</p></div>
      <button type="button" onClick={() => dialog.current.close()} aria-label="Close telemetry snapshot">Close</button>
    </header>
    <p>Latest stored readings from the provider. Times are shown in your local time zone. Readings may have different update times.</p>
    {!t && !error ? <p role="status">Loading collected readings…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {groups.map(([title, rows]) => <section key={title}><h3>{title}</h3><dl>
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl></section>)}
  </dialog>;
}
