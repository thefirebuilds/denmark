import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

function getMaxFutureDate(days = 7) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatBatteryHistorySummary(entry) {
  const data = entry?.data || {};

  const measuredVoltage =
    data.measured_voltage ??
    data.battery_voltage ??
    data.voltage ??
    null;

  const ccaMeasured =
    data.measured_cca ??
    data.cca_measured ??
    data.cca ??
    null;

  const ccaRated =
    data.rated_cca ??
    data.cca_rating ??
    null;

  const soh =
    data.state_of_health_percent ??
    data.soh_percent ??
    data.health_percent ??
    null;

  const soc =
    data.state_of_charge_percent ??
    data.soc_percent ??
    data.charge_percent ??
    null;

  const testerResult =
    data.tester_result ||
    data.battery_result ||
    data.decision ||
    null;

  const bits = [];

  if (measuredVoltage != null) bits.push(`${measuredVoltage} V`);
  if (ccaMeasured != null && ccaRated != null) {
    bits.push(`${ccaMeasured}/${ccaRated} CCA`);
  } else if (ccaMeasured != null) {
    bits.push(`${ccaMeasured} CCA`);
  }
  if (soh != null) bits.push(`${soh}% SOH`);
  if (soc != null) bits.push(`${soc}% SOC`);
  if (testerResult) bits.push(String(testerResult));

  return bits.length ? bits.join(" • ") : "No battery metrics recorded";
}

function toNumberOrNull(value) {
  if (value === "" || value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function calculateAcTemperatureDelta(ambientTempF, ventTempF) {
  const ambient = toNumberOrNull(ambientTempF);
  const vent = toNumberOrNull(ventTempF);
  if (ambient == null || vent == null) return null;
  return Number((ambient - vent).toFixed(1));
}

function renderHistorySummary(ruleCode, entry) {
  const code = String(ruleCode || "").toLowerCase();
  const data = entry?.data || {};

  if (code.includes("battery")) {
    return formatBatteryHistorySummary(entry);
  }

  if (code.includes("brake")) {
    const bits = [];
    if (data.front_pad_mm != null) bits.push(`Front ${data.front_pad_mm} mm`);
    if (data.rear_pad_mm != null) bits.push(`Rear ${data.rear_pad_mm} mm`);
    if (data.rotor_condition) bits.push(`Rotors: ${data.rotor_condition}`);

    return bits.length
      ? bits.join(" • ")
      : [entry?.result || "No result", entry?.notes || null]
          .filter(Boolean)
          .join(" • ");
  }

  if (code === "bearing_tie_rod_check" || code.includes("tie_rod")) {
    const bits = [];
    if (data.wheel_bearings_ok === true) bits.push("Wheel bearings OK");
    if (data.tie_rods_ok === true) bits.push("Tie rods OK");
    if (data.ball_joints_ok === true) bits.push("Ball joints OK");
    if (data.steering_play_ok === true) bits.push("No steering play");

    return bits.length
      ? bits.join(" â€¢ ")
      : [entry?.result || "No result", entry?.notes || null]
          .filter(Boolean)
          .join(" â€¢ ");
  }

  if (code === "ac_performance_check" || code.includes("ac_performance")) {
    const bits = [];
    if (data.ambient_temp_f != null) bits.push(`Ambient ${data.ambient_temp_f} F`);
    if (data.vent_temp_f != null) bits.push(`Vent ${data.vent_temp_f} F`);
    if (data.temperature_delta_f != null) bits.push(`Delta ${data.temperature_delta_f} F`);
    if (data.low_side_pressure_psi != null) {
      bits.push(`Low ${data.low_side_pressure_psi} psi`);
    }
    if (data.high_side_pressure_psi != null) {
      bits.push(`High ${data.high_side_pressure_psi} psi`);
    }
    if (data.compressor_engages === true) bits.push("Compressor engages");
    if (data.compressor_engages === false) bits.push("Compressor concern");

    return bits.length
      ? bits.join(" â€¢ ")
      : [entry?.result || "No result", entry?.notes || null]
          .filter(Boolean)
          .join(" â€¢ ");
  }

  if (code.includes("tread")) {
    if (data.lowest_tread_32nds != null) {
      return `${data.lowest_tread_32nds}/32" lowest`;
    }
  }

  if (code.includes("tire_age")) {
    if (data.dot_code) {
      return `DOT ${data.dot_code}`;
    }
  }

  if (code.includes("clean")) {
    const bits = [];
    if (data.interior_cleaned) bits.push("Interior cleaned");
    if (data.exterior_cleaned) bits.push("Exterior cleaned");

    return bits.length
      ? bits.join(" • ")
      : [entry?.result || "No result", entry?.notes || null]
          .filter(Boolean)
          .join(" • ");
  }

  if (code.includes("fluid") || code.includes("oil") || code.includes("leak")) {
    const bits = [];
    if (data.engine_oil_ok === true) bits.push("Engine oil OK");
    if (data.windshield_washer_fluid_ok === true) bits.push("Washer fluid OK");
    if (data.brake_fluid_ok === true) bits.push("Brake fluid OK");
    if (data.coolant_ok === true) bits.push("Coolant OK");
    if (data.transmission_fluid_ok === true) bits.push("Transmission fluid OK");
    if (data.power_steering_fluid_ok === true) bits.push("Power steering OK");

    return bits.length
      ? bits.join(" • ")
      : [entry?.result || "No result", entry?.notes || null]
          .filter(Boolean)
          .join(" • ");
  }

  if (code.includes("tire_pressure")) {
    return [entry?.result || "Measured", entry?.notes || null]
      .filter(Boolean)
      .join(" • ");
  }

  return [entry?.result || "No result", entry?.notes || null]
    .filter(Boolean)
    .join(" • ");
}

function normalizeDotCode(value) {
  return String(value || "")
    .replace(/\D/g, "")
    .slice(0, 4);
}

function isValidDotCode(value) {
  if (!/^\d{4}$/.test(String(value || ""))) return false;
  const week = Number(String(value).slice(0, 2));
  return week >= 1 && week <= 53;
}

function deriveDisplayStatus(result) {
  if (result === "pass") return "pass";
  if (result === "fail") return "fail";
  if (result === "attention") return "attention";
  if (result === "performed") return "pass";
  if (result === "measured") return "pass";
  if (result === "not_applicable") return "unknown";
  return "unknown";
}

function getStatusLabel(status) {
  if (status === "pass") return "Pass";
  if (status === "fail") return "Fail";
  if (status === "attention") return "Needs attention";
  return "Unknown";
}

function getStatusIcon(status) {
  if (status === "pass") return "✅";
  if (status === "fail") return "❌";
  if (status === "attention") return "🟡";
  return "•";
}

function formatHistoryDate(value) {
  if (!value) return "Unknown date";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function InspectionItemDrawer({
  open,
  item,
  vehicle,
  onClose,
  onSave,
  onDeleteHistoryEntry,
  saving = false,
}) {
  const [form, setForm] = useState({
    performedAt: "",
    odometerMiles: "",
    result: "",
    notes: "",
    dotCode: "",
    lowestTread32nds: "",
    interiorCleaned: false,
    exteriorCleaned: false,
    engineOilOk: false,
    windshieldWasherFluidOk: false,
    brakeFluidOk: false,
    coolantOk: false,
    transmissionFluidOk: false,
    powerSteeringFluidOk: false,
    frontPadMm: "",
    rearPadMm: "",
    rotorCondition: "",
    acAmbientTempF: "",
    acVentTempF: "",
    acLowSidePressurePsi: "",
    acHighSidePressurePsi: "",
    acCompressorEngages: false,
    wheelBearingsOk: false,
    tieRodsOk: false,
    ballJointsOk: false,
    steeringPlayOk: false,
  });

  const recentHistory = useMemo(() => {
    const entries =
      Array.isArray(item?.history) && item.history.length
        ? item.history
        : item?.lastEvent
        ? [item.lastEvent]
        : [];

    return [...entries]
      .sort(
        (a, b) =>
          new Date(
            b?.performedAt || b?.performed_at || b?.recorded_at || 0
          ).getTime() -
          new Date(
            a?.performedAt || a?.performed_at || a?.recorded_at || 0
          ).getTime()
      )
      .slice(0, 5);
  }, [item]);

  useEffect(() => {
    if (!open || !item) return;

    const lastData = item.lastEvent?.data || {};
    const code = String(item.ruleCode || "").toLowerCase();

    const isTireAgeReview = code === "tire_age_review";
    const isTreadDepth = code === "tread_depth";
    const isCleaning = code === "cleaning";
    const isBrakeInspection = code === "brake_inspection";
    const isBearingTieRodCheck = code === "bearing_tie_rod_check";
    const isAcPerformanceCheck = code === "ac_performance_check";
    const isFluidCheck =
      code === "fluid_leak_check" ||
      code === "oil_change" ||
      code === "leak_check";
    const isTirePressure =
      code === "tire_pressure_inspection" || code === "tire_pressure_check";

    setForm({
      performedAt: new Date().toISOString().slice(0, 10),
      odometerMiles:
        vehicle?.currentOdometerMiles != null
          ? String(vehicle.currentOdometerMiles)
          : item.lastEvent?.odometerMiles != null
          ? String(item.lastEvent.odometerMiles)
          : "",
      result:
        isTireAgeReview ||
        isTreadDepth ||
        isCleaning ||
        isBearingTieRodCheck ||
        isAcPerformanceCheck ||
        isFluidCheck ||
        isTirePressure
          ? "measured"
          : item.status === "pass"
          ? "pass"
          : item.status === "fail"
          ? "fail"
          : item.status === "attention"
          ? "attention"
          : "",
      notes: "",
      dotCode: lastData.dot_code != null ? String(lastData.dot_code) : "",
      lowestTread32nds:
        lastData.lowest_tread_32nds != null
          ? String(lastData.lowest_tread_32nds)
          : "",
      interiorCleaned: Boolean(lastData.interior_cleaned),
      exteriorCleaned: Boolean(lastData.exterior_cleaned),
      engineOilOk: Boolean(lastData.engine_oil_ok),
      windshieldWasherFluidOk: Boolean(lastData.windshield_washer_fluid_ok),
      brakeFluidOk: Boolean(lastData.brake_fluid_ok),
      coolantOk: Boolean(lastData.coolant_ok),
      transmissionFluidOk: Boolean(lastData.transmission_fluid_ok),
      powerSteeringFluidOk: Boolean(lastData.power_steering_fluid_ok),
      frontPadMm:
        lastData.front_pad_mm != null ? String(lastData.front_pad_mm) : "",
      rearPadMm:
        lastData.rear_pad_mm != null ? String(lastData.rear_pad_mm) : "",
      rotorCondition: lastData.rotor_condition || "",
      wheelBearingsOk: Boolean(lastData.wheel_bearings_ok),
      tieRodsOk: Boolean(lastData.tie_rods_ok),
      ballJointsOk: Boolean(lastData.ball_joints_ok),
      steeringPlayOk: Boolean(lastData.steering_play_ok),
      acAmbientTempF:
        lastData.ambient_temp_f != null
          ? String(lastData.ambient_temp_f)
          : vehicle?.exteriorAirTempF != null
          ? String(vehicle.exteriorAirTempF)
          : "",
      acVentTempF:
        lastData.vent_temp_f != null ? String(lastData.vent_temp_f) : "",
      acLowSidePressurePsi:
        lastData.low_side_pressure_psi != null
          ? String(lastData.low_side_pressure_psi)
          : "",
      acHighSidePressurePsi:
        lastData.high_side_pressure_psi != null
          ? String(lastData.high_side_pressure_psi)
          : "",
      acCompressorEngages: Boolean(lastData.compressor_engages),
    });
  }, [
    open,
    item?.ruleId,
    item?.ruleCode,
    item?.lastEvent?.id,
    item?.lastEvent?.performedAt,
    item?.lastEvent?.odometerMiles,
    vehicle?.vin,
    vehicle?.currentOdometerMiles,
    vehicle?.exteriorAirTempF,
  ]);

  if (!open || !item) return null;

  function updateField(field, value) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function updateCheckbox(field) {
    setForm((current) => ({
      ...current,
      [field]: !current[field],
    }));
  }

  function handleSubmit(e) {
    e.preventDefault();

    const code = String(item.ruleCode || "").toLowerCase();
    const isTireAgeReview = code === "tire_age_review";
    const isTreadDepth = code === "tread_depth";
    const isCleaning = code === "cleaning";
    const isBrakeInspection = code === "brake_inspection";
    const isBearingTieRodCheck = code === "bearing_tie_rod_check";
    const isAcPerformanceCheck = code === "ac_performance_check";
    const isFluidCheck =
      code === "fluid_leak_check" ||
      code === "oil_change" ||
      code === "leak_check";

    const cleanedDotCode = normalizeDotCode(form.dotCode);

    if (isTireAgeReview && !isValidDotCode(cleanedDotCode)) {
      window.alert("Enter the oldest tire DOT date code as 4 digits, like 3422.");
      return;
    }

    if (
      isTreadDepth &&
      (form.lowestTread32nds === "" || Number(form.lowestTread32nds) <= 0)
    ) {
      window.alert("Enter the lowest recorded tire tread depth in 32nds.");
      return;
    }

    if (
      isBrakeInspection &&
      form.frontPadMm === "" &&
      form.rearPadMm === "" &&
      !form.rotorCondition
    ) {
      window.alert("Enter at least one brake measurement or rotor condition.");
      return;
    }

    if (
      isBearingTieRodCheck &&
      !form.wheelBearingsOk &&
      !form.tieRodsOk &&
      !form.ballJointsOk &&
      !form.steeringPlayOk
    ) {
      window.alert("Mark at least one bearing, tie rod, ball joint, or steering check.");
      return;
    }

    if (isAcPerformanceCheck && (form.acAmbientTempF === "" || form.acVentTempF === "")) {
      window.alert("Enter the outside air temperature and center vent temperature.");
      return;
    }

    const acTemperatureDeltaF = calculateAcTemperatureDelta(
      form.acAmbientTempF,
      form.acVentTempF
    );

    onSave?.({
      ruleId: item.ruleId,
      ruleCode: item.ruleCode,
      vehicleVin: vehicle?.vin || null,
      performedAt: form.performedAt || null,
      odometerMiles: form.odometerMiles === "" ? null : Number(form.odometerMiles),
      result: form.result || null,
      notes: form.notes || "",
      data: {
        ...(isTireAgeReview
          ? {
              dot_code: cleanedDotCode,
            }
          : {}),
        ...(isTreadDepth
          ? {
              lowest_tread_32nds: Number(form.lowestTread32nds),
            }
          : {}),
        ...(isCleaning
          ? {
              interior_cleaned: form.interiorCleaned,
              exterior_cleaned: form.exteriorCleaned,
            }
          : {}),
        ...(isBrakeInspection
          ? {
              front_pad_mm:
                form.frontPadMm === "" ? null : Number(form.frontPadMm),
              rear_pad_mm:
                form.rearPadMm === "" ? null : Number(form.rearPadMm),
              rotor_condition: form.rotorCondition || null,
            }
          : {}),
        ...(isBearingTieRodCheck
          ? {
              wheel_bearings_ok: form.wheelBearingsOk,
              tie_rods_ok: form.tieRodsOk,
              ball_joints_ok: form.ballJointsOk,
              steering_play_ok: form.steeringPlayOk,
            }
          : {}),
        ...(isAcPerformanceCheck
          ? {
              ambient_temp_f: toNumberOrNull(form.acAmbientTempF),
              vent_temp_f: toNumberOrNull(form.acVentTempF),
              temperature_delta_f: acTemperatureDeltaF,
              low_side_pressure_psi: toNumberOrNull(
                form.acLowSidePressurePsi
              ),
              high_side_pressure_psi: toNumberOrNull(
                form.acHighSidePressurePsi
              ),
              compressor_engages: form.acCompressorEngages,
            }
          : {}),
        ...(isFluidCheck
          ? {
              engine_oil_ok: form.engineOilOk,
              windshield_washer_fluid_ok: form.windshieldWasherFluidOk,
              brake_fluid_ok: form.brakeFluidOk,
              coolant_ok: form.coolantOk,
              transmission_fluid_ok: form.transmissionFluidOk,
              power_steering_fluid_ok: form.powerSteeringFluidOk,
            }
          : {}),
      },
    });
  }

  const resultOptions =
    item.ruleCode === "tire_age_review"
      ? [
          ["measured", "Measured"],
          ["not_applicable", "N/A"],
        ]
      : [
          ["pass", "Pass"],
          ["fail", "Fail"],
          ["attention", "Attention"],
          ["performed", "Performed"],
          ["measured", "Measured"],
          ["not_applicable", "N/A"],
        ];

  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={saving ? undefined : onClose} />

      <aside className="app-drawer app-drawer--right">
        <div className="app-drawer-header">
          <div>
            <div className="app-drawer-title">{item.label}</div>
            <div className="app-drawer-subtitle">
              {vehicle?.nickname} • {vehicle?.year} {vehicle?.make} {vehicle?.model}
            </div>
          </div>

          <button
            type="button"
            className="app-drawer-close"
            onClick={onClose}
            aria-label="Close"
            disabled={saving}
          >
            ×
          </button>
        </div>

        <form className="app-drawer-body" onSubmit={handleSubmit}>
          <div className="drawer-field">
            <label className="drawer-label">Display status</label>
            <div
              className={`drawer-status-preview drawer-status-preview--${deriveDisplayStatus(
                form.result
              )}`}
            >
              <span className="drawer-status-icon">
                {getStatusIcon(deriveDisplayStatus(form.result))}
              </span>
              <span className="drawer-status-text">
                {getStatusLabel(deriveDisplayStatus(form.result))}
              </span>
            </div>
          </div>

          <div className="drawer-field">
            <label className="drawer-label">Performed date</label>
            <input
              className="drawer-input"
              type="date"
              value={form.performedAt || ""}
              max={getMaxFutureDate(7)}
              onChange={(e) => updateField("performedAt", e.target.value)}
              disabled={saving}
            />
          </div>

          <div className="drawer-field">
            <label className="drawer-label">Odometer</label>
            <input
              className="drawer-input"
              type="number"
              min="0"
              step="1"
              value={form.odometerMiles}
              onChange={(e) => updateField("odometerMiles", e.target.value)}
              placeholder={
                vehicle?.currentOdometerMiles != null
                  ? String(vehicle.currentOdometerMiles)
                  : "Enter odometer"
              }
              disabled={saving}
            />
          </div>

          <div className="drawer-field">
            <label className="drawer-label">Recorded result</label>
            <div className="drawer-radio-group">
              {resultOptions.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`drawer-radio-pill ${form.result === value ? "selected" : ""}`}
                  onClick={() => updateField("result", value)}
                  disabled={saving}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {item.ruleCode === "tire_age_review" ? (
            <div className="drawer-field">
              <label className="drawer-label">Oldest tire DOT date code</label>
              <input
                className="drawer-input drawer-input--dot-code"
                type="text"
                inputMode="numeric"
                maxLength={4}
                value={form.dotCode}
                onChange={(e) => updateField("dotCode", normalizeDotCode(e.target.value))}
                placeholder="3422"
                disabled={saving}
              />
            </div>
          ) : null}

          {item.ruleCode === "tread_depth" ? (
            <div className="drawer-field">
              <label className="drawer-label">Lowest recorded tire tread (32nds)</label>
              <input
                className="drawer-input"
                type="number"
                min="1"
                step="1"
                value={form.lowestTread32nds}
                onChange={(e) => updateField("lowestTread32nds", e.target.value)}
                placeholder="4"
                disabled={saving}
              />
            </div>
          ) : null}

          {item.ruleCode === "cleaning" ? (
            <div className="drawer-field">
              <label className="drawer-label">Cleaning completed</label>
              <div className="drawer-check-grid">
                <button
                  type="button"
                  className={`drawer-radio-pill ${form.interiorCleaned ? "selected" : ""}`}
                  onClick={() => updateCheckbox("interiorCleaned")}
                  disabled={saving}
                >
                  Interior
                </button>
                <button
                  type="button"
                  className={`drawer-radio-pill ${form.exteriorCleaned ? "selected" : ""}`}
                  onClick={() => updateCheckbox("exteriorCleaned")}
                  disabled={saving}
                >
                  Exterior
                </button>
              </div>
            </div>
          ) : null}

          {item.ruleCode === "brake_inspection" ? (
            <div className="drawer-field">
              <label className="drawer-label">Brake measurements</label>
              <div className="drawer-check-grid">
                <input
                  className="drawer-input"
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.frontPadMm}
                  onChange={(e) => updateField("frontPadMm", e.target.value)}
                  placeholder="Front pad mm"
                  disabled={saving}
                />

                <input
                  className="drawer-input"
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.rearPadMm}
                  onChange={(e) => updateField("rearPadMm", e.target.value)}
                  placeholder="Rear pad mm"
                  disabled={saving}
                />

                <select
                  className="drawer-input"
                  value={form.rotorCondition}
                  onChange={(e) => updateField("rotorCondition", e.target.value)}
                  disabled={saving}
                >
                  <option value="">Rotor condition</option>
                  <option value="good">Good</option>
                  <option value="lightly grooved">Lightly grooved</option>
                  <option value="grooved">Grooved</option>
                  <option value="lip present">Lip present</option>
                  <option value="scored">Scored</option>
                  <option value="replace soon">Replace soon</option>
                </select>
              </div>
            </div>
          ) : null}

          {item.ruleCode === "bearing_tie_rod_check" ? (
            <div className="drawer-field">
              <label className="drawer-label">Bearing / tie rod check</label>
              <div className="drawer-check-grid">
                <button
                  type="button"
                  className={`drawer-radio-pill ${form.wheelBearingsOk ? "selected" : ""}`}
                  onClick={() => updateCheckbox("wheelBearingsOk")}
                  disabled={saving}
                >
                  Wheel bearings
                </button>
                <button
                  type="button"
                  className={`drawer-radio-pill ${form.tieRodsOk ? "selected" : ""}`}
                  onClick={() => updateCheckbox("tieRodsOk")}
                  disabled={saving}
                >
                  Tie rods
                </button>
                <button
                  type="button"
                  className={`drawer-radio-pill ${form.ballJointsOk ? "selected" : ""}`}
                  onClick={() => updateCheckbox("ballJointsOk")}
                  disabled={saving}
                >
                  Ball joints
                </button>
                <button
                  type="button"
                  className={`drawer-radio-pill ${form.steeringPlayOk ? "selected" : ""}`}
                  onClick={() => updateCheckbox("steeringPlayOk")}
                  disabled={saving}
                >
                  No steering play
                </button>
              </div>
            </div>
          ) : null}

          {(item.ruleCode === "fluid_leak_check" ||
            item.ruleCode === "oil_change" ||
            item.ruleCode === "leak_check") ? (
            <div className="drawer-field">
              <label className="drawer-label">Fluid level checks</label>
              <div className="drawer-check-grid">
                <button
                  type="button"
                  className={`drawer-radio-pill ${form.engineOilOk ? "selected" : ""}`}
                  onClick={() => updateCheckbox("engineOilOk")}
                  disabled={saving}
                >
                  Engine oil
                </button>
                <button
                  type="button"
                  className={`drawer-radio-pill ${form.windshieldWasherFluidOk ? "selected" : ""}`}
                  onClick={() => updateCheckbox("windshieldWasherFluidOk")}
                  disabled={saving}
                >
                  Washer fluid
                </button>
                <button
                  type="button"
                  className={`drawer-radio-pill ${form.brakeFluidOk ? "selected" : ""}`}
                  onClick={() => updateCheckbox("brakeFluidOk")}
                  disabled={saving}
                >
                  Brake fluid
                </button>
                <button
                  type="button"
                  className={`drawer-radio-pill ${form.coolantOk ? "selected" : ""}`}
                  onClick={() => updateCheckbox("coolantOk")}
                  disabled={saving}
                >
                  Coolant
                </button>
                <button
                  type="button"
                  className={`drawer-radio-pill ${form.transmissionFluidOk ? "selected" : ""}`}
                  onClick={() => updateCheckbox("transmissionFluidOk")}
                  disabled={saving}
                >
                  Transmission fluid
                </button>
                <button
                  type="button"
                  className={`drawer-radio-pill ${form.powerSteeringFluidOk ? "selected" : ""}`}
                  onClick={() => updateCheckbox("powerSteeringFluidOk")}
                  disabled={saving}
                >
                  Power steering
                </button>
              </div>
            </div>
          ) : null}

          {item.ruleCode === "ac_performance_check" ? (
            <div className="drawer-field">
              <label className="drawer-label">A/C performance</label>
              <div className="drawer-check-grid">
                <input
                  className="drawer-input"
                  type="number"
                  step="0.1"
                  value={form.acAmbientTempF}
                  onChange={(e) => updateField("acAmbientTempF", e.target.value)}
                  placeholder="Outside air F"
                  disabled={saving}
                />

                <input
                  className="drawer-input"
                  type="number"
                  step="0.1"
                  value={form.acVentTempF}
                  onChange={(e) => updateField("acVentTempF", e.target.value)}
                  placeholder="Center vent F"
                  disabled={saving}
                />

                <input
                  className="drawer-input"
                  type="number"
                  min="0"
                  step="1"
                  value={form.acLowSidePressurePsi}
                  onChange={(e) =>
                    updateField("acLowSidePressurePsi", e.target.value)
                  }
                  placeholder="Low side psi"
                  disabled={saving}
                />

                <input
                  className="drawer-input"
                  type="number"
                  min="0"
                  step="1"
                  value={form.acHighSidePressurePsi}
                  onChange={(e) =>
                    updateField("acHighSidePressurePsi", e.target.value)
                  }
                  placeholder="High side psi"
                  disabled={saving}
                />

                <button
                  type="button"
                  className={`drawer-radio-pill ${form.acCompressorEngages ? "selected" : ""}`}
                  onClick={() => updateCheckbox("acCompressorEngages")}
                  disabled={saving}
                >
                  Compressor engages
                </button>

                <div className="drawer-context">
                  Temperature delta:{" "}
                  {calculateAcTemperatureDelta(
                    form.acAmbientTempF,
                    form.acVentTempF
                  ) ?? "Enter temps"}{" "}
                  F
                </div>
              </div>
            </div>
          ) : null}

          <div className="drawer-field">
            <label className="drawer-label">Notes</label>
            <textarea
              className="drawer-input drawer-input--textarea"
              rows={6}
              value={form.notes}
              onChange={(e) => updateField("notes", e.target.value)}
              placeholder="Add inspection notes..."
              disabled={saving}
            />
          </div>

          {recentHistory.length ? (
            <div className="drawer-history">
              <div className="drawer-label">
                Last {Math.min(5, recentHistory.length)} entries
              </div>

              <div className="drawer-history-list">
                {recentHistory.map((entry) => (
                  <div
                    key={
                      entry.id ||
                      `${entry.performedAt || entry.performed_at}-${
                        entry.odometerMiles || entry.odometer_miles || "na"
                      }`
                    }
                    className="drawer-history-item"
                  >
                    <div className="drawer-history-top">
                      <strong>
                        {formatHistoryDate(
                          entry.performedAt || entry.performed_at || entry.recorded_at
                        )}
                      </strong>
                      <span>
                        {entry.odometerMiles != null || entry.odometer_miles != null
                          ? `${Number(
                              entry.odometerMiles ?? entry.odometer_miles
                            ).toLocaleString()} mi`
                          : "—"}
                      </span>
                    </div>

                    <div className="drawer-history-bottom">
                      {renderHistorySummary(item.ruleCode, entry)}
                    </div>

                    {entry.result || entry.notes ? (
                      <div className="drawer-history-bottom">
                        {[entry.result || null, entry.notes || null]
                          .filter(Boolean)
                          .join(" • ")}
                      </div>
                    ) : null}

                    {entry.id ? (
                      <div className="drawer-history-actions">
                        <button
                          type="button"
                          className="drawer-history-delete"
                          disabled={saving}
                          onClick={() => {
                            const confirmed = window.confirm(
                              `Delete maintenance entry from ${formatHistoryDate(
                                entry.performedAt || entry.performed_at || entry.recorded_at
                              )}${
                                entry.odometerMiles != null || entry.odometer_miles != null
                                  ? ` at ${Number(
                                      entry.odometerMiles ?? entry.odometer_miles
                                    ).toLocaleString()} mi`
                                  : ""
                              }? This cannot be undone.`
                            );

                            if (!confirmed) return;
                            onDeleteHistoryEntry?.(entry);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="drawer-context">
            <div>
              <strong>Rule code:</strong> {item.ruleCode || "—"}
            </div>
            <div>
              <strong>Blocks rental when overdue:</strong>{" "}
              {item.blocksRentalWhenOverdue ? "Yes" : "No"}
            </div>
            <div>
              <strong>Blocks guest export when overdue:</strong>{" "}
              {item.blocksGuestExportWhenOverdue ? "Yes" : "No"}
            </div>
            <div>
              <strong>Requires pass result:</strong>{" "}
              {item.requiresPassResult ? "Yes" : "No"}
            </div>
          </div>

          <div className="app-drawer-actions">
            <button
              type="button"
              className="message-action"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button type="submit" className="message-action" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </aside>
    </>,
    document.body
  );
}
