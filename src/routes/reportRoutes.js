const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { reportLimiter } = require('../middleware/rateLimiter');
const reportController = require('../controllers/reportController');

// Submit UGC / profile / CSAE report (authenticated & rate-limited)
router.post('/', authMiddleware, reportLimiter, reportController.createReport);

module.exports = router;
