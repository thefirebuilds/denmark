const express = require('express');
const pool = require('../db');
const { getVehicleMaintenanceSummary } = require('../services/maintenance/getVehicleMaintenanceSummary');
const { createDataTools } = require('../services/businessQuestions/dataTools');
const { createQuestionAnswerer } = require('../services/businessQuestions/answerQuestion');
const { createTaskTools } = require('../services/businessQuestions/taskTools');
const { isAuthEnforced } = require('../auth/config');
const { hasPermission } = require('../auth/permissions');
const router = express.Router();
const execute = createDataTools({ pool, getMaintenanceSummary: getVehicleMaintenanceSummary });
const activeRequests = new Set();

router.post('/', async (req, res) => {
  const actor = req.auth?.userId || req.sessionID || req.ip;
  if (activeRequests.has(actor)) return res.status(429).json({ error: 'Please wait for your current question to finish.' });
  activeRequests.add(actor);
  try {
    res.set('Cache-Control', 'no-store');
    const canWrite = !isAuthEnforced() || (req.auth?.isActive === true && hasPermission(req.auth.role, 'maintenance.write'));
    const answerQuestion = createQuestionAnswerer({ execute,
      executeTask: canWrite ? createTaskTools({ pool, canWrite,
        reportedBy: req.auth?.email || req.auth?.displayName || null }) : undefined });
    res.json(await answerQuestion(req.body));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not answer your question. Please try again.' });
  } finally { activeRequests.delete(actor); }
});

module.exports = router;
