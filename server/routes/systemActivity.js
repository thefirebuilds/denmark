const express = require("express");
const { listSystemActivity } = require("../services/systemActivityLog");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const entries = await listSystemActivity({
      limit: req.query.limit,
      category: req.query.category,
      eventType: req.query.eventType || req.query.event_type,
      actorUserId: req.query.actorUserId || req.query.actor_user_id,
      subjectType: req.query.subjectType || req.query.subject_type,
      subjectId: req.query.subjectId || req.query.subject_id,
      since: req.query.since,
    });

    res.json({
      generated_at: new Date().toISOString(),
      entries,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
