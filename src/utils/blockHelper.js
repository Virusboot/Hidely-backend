const db = require('../config/db');

let _userBlocksTableReady = false;
let _tableInitPromise = null;

/**
 * Ensures the `user_blocks` table exists (idempotent, runs once per server lifecycle).
 */
async function ensureUserBlocksTable() {
  if (_userBlocksTableReady) return;
  if (_tableInitPromise) {
    await _tableInitPromise;
    return;
  }

  _tableInitPromise = (async () => {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS user_blocks (
          blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (blocker_id, blocked_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks (blocker_id);
        CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks (blocked_id);
      `);
      _userBlocksTableReady = true;
    } catch (err) {
      console.error('[BlockHelper] Failed to ensure user_blocks table:', err.message);
    } finally {
      _tableInitPromise = null;
    }
  })();

  await _tableInitPromise;
}

/**
 * Checks whether a mutual block exists between userAId and userBId.
 */
async function getBlockStatus(userAId, userBId) {
  const a = parseInt(userAId, 10);
  const b = parseInt(userBId, 10);
  if (!a || !b || isNaN(a) || isNaN(b) || a === b) {
    return { blocked: false, blockedByA: false, blockedByB: false };
  }

  try {
    await ensureUserBlocksTable();
    const res = await db.query(
      `SELECT blocker_id, blocked_id
       FROM user_blocks
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)`,
      [a, b]
    );
    let blockedByA = false;
    let blockedByB = false;
    for (const row of res.rows) {
      if (parseInt(row.blocker_id, 10) === a && parseInt(row.blocked_id, 10) === b) {
        blockedByA = true;
      }
      if (parseInt(row.blocker_id, 10) === b && parseInt(row.blocked_id, 10) === a) {
        blockedByB = true;
      }
    }
    return {
      blocked: blockedByA || blockedByB,
      blockedByA,
      blockedByB,
    };
  } catch (err) {
    console.error('[BlockHelper] getBlockStatus error:', err.message);
    return { blocked: false, blockedByA: false, blockedByB: false };
  }
}

/**
 * SQL predicate verifying that no mutual block exists between `currentUserParam` (e.g. '$1')
 * and `targetColumnExpr` (e.g. 'u.id'). Evaluates to TRUE when currentUserParam is NULL.
 */
function isNotMutuallyBlockedSql(targetColumnExpr, currentUserParam) {
  return `(${currentUserParam}::int IS NULL OR NOT EXISTS (
    SELECT 1 FROM user_blocks ub
    WHERE (ub.blocker_id = ${currentUserParam}::int AND ub.blocked_id = ${targetColumnExpr})
       OR (ub.blocker_id = ${targetColumnExpr} AND ub.blocked_id = ${currentUserParam}::int)
  ))`;
}

module.exports = {
  ensureUserBlocksTable,
  getBlockStatus,
  isNotMutuallyBlockedSql,
};
