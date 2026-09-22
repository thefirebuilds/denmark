const express = require('express');
const pool = require('../db');
const { getVehicleMaintenanceSummary } = require('../services/maintenance/getVehicleMaintenanceSummary');
const { createDataTools } = require('../services/businessQuestions/dataTools');
const { createQuestionAnswerer } = require('../services/businessQuestions/answerQuestion');
const router = express.Router();
const answerQuestion = createQuestionAnswerer({ execute: createDataTools({ pool, getMaintenanceSummary: getVehicleMaintenanceSummary }) });
const activeRequests = new Set();

router.post('/', async (req, res) => {
  const actor = req.auth?.userId || req.sessionID || req.ip;
  if (activeRequests.has(actor)) return res.status(429).json({ error: 'Please wait for your current question to finish.' });
  activeRequests.add(actor);
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await answerQuestion(req.body));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not answer your question. Please try again.' });
  } finally { activeRequests.delete(actor); }
});

module.exports = router;
