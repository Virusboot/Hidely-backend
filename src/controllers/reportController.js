const db = require('../config/db');

let reportsTableEnsured = false;

async function ensureReportsTable() {
  if (reportsTableEnsured) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS content_reports (
        id SERIAL PRIMARY KEY,
        reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        target_type VARCHAR(30) NOT NULL,
        target_id INTEGER,
        reported_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        target_name VARCHAR(255) DEFAULT '',
        reason VARCHAR(80) NOT NULL,
        details TEXT DEFAULT '',
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        admin_note TEXT DEFAULT '',
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports (status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_content_reports_reporter ON content_reports (reporter_id, created_at DESC);
    `);
    reportsTableEnsured = true;
  } catch (err) {
    console.warn('[Reports] ensureReportsTable notice:', err.message);
  }
}

const ALLOWED_TARGET_TYPES = new Set(['post', 'reel', 'profile', 'comment']);

/**
 * Submit a UGC safety / policy report
 * POST /api/reports
 */
async function createReport(req, res) {
  const reporterId = req.user.id;
  const {
    targetType,
    targetId,
    targetUsername,
    targetName,
    reason,
    details,
  } = req.body || {};

  const cleanTypeRaw = (targetType || '').toString().trim();
  const cleanTypeLower = cleanTypeRaw.toLowerCase();
  const cleanReason = (reason || '').toString().trim();
  const cleanDetails = (details || '').toString().trim().slice(0, 1000);
  const cleanTargetName = (targetName || targetUsername || '').toString().trim().slice(0, 255);

  if (!ALLOWED_TARGET_TYPES.has(cleanTypeLower)) {
    return res.status(400).json({ error: 'Invalid report targetType. Expected Post, Reel, Profile, or Comment.' });
  }

  if (!cleanReason || cleanReason.length > 80) {
    return res.status(400).json({ error: 'Please select a valid report reason.' });
  }

  let parsedTargetId = null;
  if (targetId !== undefined && targetId !== null && String(targetId).trim() !== '') {
    const num = parseInt(targetId, 10);
    if (!Number.isInteger(num) || num <= 0) {
      return res.status(400).json({ error: 'Invalid targetId parameter.' });
    }
    parsedTargetId = num;
  }

  try {
    await ensureReportsTable();

    let reportedUserId = null;
    if (targetUsername && typeof targetUsername === 'string') {
      const cleanUname = targetUsername.replace(/^@+/, '').trim().toLowerCase();
      if (cleanUname) {
        const uRes = await db.query(
          'SELECT id FROM users WHERE LOWER(username) = $1 LIMIT 1',
          [cleanUname]
        );
        if (uRes.rows.length > 0) {
          reportedUserId = uRes.rows[0].id;
        }
      }
    }

    if (!reportedUserId && parsedTargetId && (cleanTypeLower === 'post' || cleanTypeLower === 'reel')) {
      const pRes = await db.query('SELECT user_id FROM posts WHERE id = $1 LIMIT 1', [parsedTargetId]);
      if (pRes.rows.length > 0) {
        reportedUserId = pRes.rows[0].user_id;
      }
    }

    if (!reportedUserId && cleanTypeLower === 'profile' && parsedTargetId) {
      reportedUserId = parsedTargetId;
    }

    // Prevent exact duplicate flood from same user inside 15 minutes
    const dupRes = await db.query(
      `SELECT id FROM content_reports
       WHERE reporter_id = $1
         AND LOWER(target_type) = $2
         AND COALESCE(target_id, 0) = COALESCE($3::int, 0)
         AND reason = $4
         AND created_at > NOW() - INTERVAL '15 minutes'
       LIMIT 1`,
      [reporterId, cleanTypeLower, parsedTargetId, cleanReason]
    );

    if (dupRes.rows.length > 0) {
      return res.status(200).json({
        success: true,
        reportId: dupRes.rows[0].id,
        duplicate: true,
        message: 'Report already received and queued for review within 24 hours.',
      });
    }

    const insertRes = await db.query(
      `INSERT INTO content_reports (
        reporter_id, target_type, target_id, reported_user_id, target_name, reason, details, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      RETURNING id, status, created_at`,
      [
        reporterId,
        cleanTypeRaw,
        parsedTargetId,
        reportedUserId,
        cleanTargetName,
        cleanReason,
        cleanDetails,
      ]
    );

    return res.status(201).json({
      success: true,
      reportId: insertRes.rows[0].id,
      status: insertRes.rows[0].status,
      message: 'Report submitted successfully. Our safety team will review it within 24 hours.',
    });
  } catch (error) {
    console.error('[Reports] Error creating report:', error);
    return res.status(500).json({ error: 'Failed to submit report. Please try again later.' });
  }
}

module.exports = {
  createReport,
  ensureReportsTable,
};
