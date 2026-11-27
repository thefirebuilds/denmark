const express = require("express");
const path = require("node:path");

const availabilityPath = "/api/public/availability";
const siteRoot = path.join(__dirname, "..", "freshcoastgarage");

function createGarageApp(denmarkOrigin = "http://app:5000") {
  const app = express();
  app.disable("x-powered-by");

  app.get(availabilityPath, async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const upstream = await fetch(new URL(availabilityPath, denmarkOrigin), {
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (!upstream.ok) throw new Error(`Availability returned ${upstream.status}`);
      const payload = await upstream.json();
      if (payload?.ok !== true || !Array.isArray(payload.vehicles)) {
        throw new Error("Invalid availability response");
      }
      res.json(payload);
    } catch (error) {
      console.error("Fresh Coast Garage availability:", error.message);
      res.status(503).json({ ok: false, error: "Availability is temporarily offline" });
    }
  });

  app.use(express.static(siteRoot, { redirect: false }));
  app.use((_req, res) => res.sendStatus(404));
  return app;
}

if (require.main === module) {
  createGarageApp().listen(5080, "0.0.0.0", () => {
    console.log("Fresh Coast Garage listening on port 5080");
  });
}

module.exports = { createGarageApp };
