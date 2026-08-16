function createHealthService({ db, transport, getWorkerState = () => null }) {
  return {
    async computeHealth() {
      const checks = { postgres: false, mqtt: transport.isHealthy(), workers: getWorkerState() };
      try {
        await db.query("SELECT 1");
        checks.postgres = true;
      } catch (error) {
        checks.postgresError = error.message || String(error);
      }
      const health = !checks.postgres ? "critical" : !checks.mqtt ? "degraded" : "ready";
      return { health, checks, timestamp: new Date().toISOString() };
    },
  };
}

module.exports = { createHealthService };
