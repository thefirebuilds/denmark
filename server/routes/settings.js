// ------------------------------------------------------------
// /server/routes/settings.js
// Small JSON-backed application settings API.
// ------------------------------------------------------------

const express = require("express");
const pool = require("../db");

const router = express.Router();

const DEFAULT_SETTINGS = {
  "ui.dispatch": {
    openTripsSort: "priority",
    pinOverdue: true,
    showCanceled: false,
    bucketOrder: [
      "needs_closeout",
      "in_progress",
      "unconfirmed",
      "upcoming",
      "canceled",
      "closed",
    ],
  },
};

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function defaultForKey(key) {
  return DEFAULT_SETTINGS[key] || {};
}

function mergeSettings(key, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultForKey(key);
  }

  return {
    ...defaultForKey(key),
    ...value,
  };
}

router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT key, value, updated_at
      FROM app_settings
      ORDER BY key ASC
    `);

    const settings = { ...DEFAULT_SETTINGS };

    for (const row of rows) {
      settings[row.key] = mergeSettings(row.key, row.value);
    }

    res.json({ settings });
  } catch (err) {
    console.error("GET /api/settings failed:", err);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

router.get("/:key", async (req, res) => {
  try {
    const key = normalizeKey(req.params.key);

    if (!key) {
      return res.status(400).json({ error: "Setting key is required" });
    }

    const { rows } = await pool.query(
      `
      SELECT key, value, updated_at
      FROM app_settings
      WHERE key = $1
      LIMIT 1
      `,
      [key]
    );

    const row = rows[0] || null;

    res.json({
      key,
      value: mergeSettings(key, row?.value),
      updated_at: row?.updated_at || null,
    });
  } catch (err) {
    console.error("GET /api/settings/:key failed:", err);
    res.status(500).json({ error: "Failed to load setting" });
  }
});

router.put("/:key", async (req, res) => {
  try {
    const key = normalizeKey(req.params.key);
    const value = mergeSettings(key, req.body?.value ?? req.body);

    if (!key) {
      return res.status(400).json({ error: "Setting key is required" });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
      RETURNING key, value, updated_at
      `,
      [key, JSON.stringify(value)]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error("PUT /api/settings/:key failed:", err);
    res.status(500).json({ error: "Failed to save setting" });
  }
});

module.exports = router;
