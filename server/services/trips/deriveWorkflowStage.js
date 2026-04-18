// ------------------------------
// server/services/trips/deriveWorkflowStage.js
// Derives the initial workflow stage for a trip during ingestion.
// This should stay conservative: ingestion may default a trip into
// a safe starting stage, but should not act as the operational
// workflow engine.
// ------------------------------

function deriveWorkflowStage({
  status,
  workflowStage = null,
}) {
  if (status === "canceled") return "canceled";

  if (workflowStage) return workflowStage;

  return "booked";
}

module.exports = {
  deriveWorkflowStage,
};