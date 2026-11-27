const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const express = require("express");
const { createGarageApp } = require("../freshcoastgarage");

test("garage availability bypasses Denmark auth and the garage serves no private API", async () => {
  const next = (_req, _res, done) => done();
  const router = express.Router();
  router.get("/public/availability", (_req, res) => res.json({ ok: true, vehicles: [] }));
  const modules = {
    express,
    "../dbHealth": { databaseUnavailableMiddleware: next },
    "../auth/middleware": { loadRequestAuth: next },
    "../routes/notificationRoutes": { router: next },
    "./healthRoutes": { createPublicHealthRouter: () => next, createProtectedHealthRouter: () => next },
    "./session": { createSessionMiddleware: () => next },
    "./cors": { defaultCors: next, marketplaceCors: next },
    "./routes": { registerApiRoutes: app => app.use("/api", (_req, res) => res.sendStatus(401)) },
    "./staticClient": { installStaticClient() {} },
    "./errorHandlers": { appErrorHandler: next, jsonParseErrorHandler: next },
    "../routes/plaidWebhook": next,
    "../routes/publicAvailability": router,
    "./metricsRequestDiagnostics": { createMetricsRequestDiagnostics: () => next },
  };
  const appModule = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, "../app/createApp.js"), "utf8");
  vm.compileFunction(source, ["module", "require"])(appModule, name => modules[name]);

  const denmark = appModule.exports.createApp({ port: 0 }).listen(0, "127.0.0.1");
  await once(denmark, "listening");
  try {
    const origin = `http://127.0.0.1:${denmark.address().port}`;
    const garage = createGarageApp(origin).listen(0, "127.0.0.1");
    await once(garage, "listening");
    try {
      const garageOrigin = `http://127.0.0.1:${garage.address().port}`;
      const availability = await fetch(`${garageOrigin}/api/public/availability`);
      assert.equal(availability.status, 200);
      assert.deepEqual(await availability.json(), { ok: true, vehicles: [] });
      assert.equal((await fetch(`${garageOrigin}/api/vehicles`)).status, 404);
      assert.equal((await fetch(`${origin}/api/vehicles`)).status, 401);
    } finally {
      garage.close();
    }
  } finally {
    denmark.close();
  }
});
