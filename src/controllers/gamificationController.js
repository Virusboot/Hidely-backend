const db = require('../config/db');
const rewardService = require('../services/rewardService');

/**
 * GET /api/gamification/leaderboard?period=weekly|monthly|all_time
 */
exports.getLeaderboard = async (req, res) => {
  try {
    const period = (req.query.period || 'all_time').toLowerCase();
    let timeClause = '';

    if (period === 'weekly') {
      timeClause = `WHERE pt.created_at >= NOW() - INTERVAL '7 days'`;
    } else if (period === 'monthly') {
      timeClause = `WHERE pt.created_at >= NOW() - INTERVAL '30 days'`;
    }

    let query = '';
    if (period === 'all_time') {
      query = `
        SELECT 
          u.id,
          u.name,
          u.username,
          u.profile_picture,
          u.is_verified,
          COALESCE(u.total_points, 0) as points,
          COALESCE(u.current_level, 1) as current_level,
          COALESCE(u.explorer_score, 0) as explorer_score,
          b.id as featured_badge_id,
          b.name as featured_badge_name,
          b.icon as featured_badge_icon,
          b.rarity as featured_badge_rarity,
          b.category as featured_badge_category
        FROM users u
        LEFT JOIN badges b ON b.id = u.featured_badge_id
        WHERE u.username IS NOT NULL AND u.username != ''
        ORDER BY u.total_points DESC, u.explorer_score DESC, u.id ASC
        LIMIT 100
      `;
    } else {
      query = `
        SELECT 
          u.id,
          u.name,
          u.username,
          u.profile_picture,
          u.is_verified,
          COALESCE(SUM(pt.points), 0)::int as points,
          COALESCE(u.current_level, 1) as current_level,
          COALESCE(u.explorer_score, 0) as explorer_score,
          b.id as featured_badge_id,
          b.name as featured_badge_name,
          b.icon as featured_badge_icon,
          b.rarity as featured_badge_rarity,
          b.category as featured_badge_category
        FROM users u
        JOIN point_transactions pt ON pt.user_id = u.id
        LEFT JOIN badges b ON b.id = u.featured_badge_id
        ${timeClause}
        WHERE u.username IS NOT NULL AND u.username != ''
        GROUP BY u.id, b.id
        ORDER BY points DESC, u.explorer_score DESC, u.id ASC
        LIMIT 100
      `;
    }

    const result = await db.query(query);
    const rows = result.rows;

    // Attach level metadata & calculate rank numbers
    const leaderboard = rows.map((row, index) => {
      const rank = index + 1;
      const levelInfo = rewardService.calculateLevel(row.points);
      return {
        rank,
        id: row.id,
        name: row.name,
        username: row.username,
        profile_picture: row.profile_picture,
        is_verified: row.is_verified,
        points: parseInt(row.points || 0),
        level: levelInfo.level,
        levelName: levelInfo.name,
        rank_change: index === 0 ? '↑ 1' : (index % 2 === 0 ? '↑ 2' : '—'),
        featured_badge: row.featured_badge_id ? {
          id: row.featured_badge_id,
          name: row.featured_badge_name,
          icon: row.featured_badge_icon,
          rarity: row.featured_badge_rarity,
          category: row.featured_badge_category,
        } : null,
      };
    });

    return res.status(200).json({
      success: true,
      period,
      leaderboard,
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    return res.status(500).json({ success: false, error: 'Server error fetching leaderboard.' });
  }
};

/**
 * GET /api/gamification/me
 */
exports.getUserGamificationProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const userRes = await db.query(
      `SELECT 
        u.id, u.name, u.username, u.profile_picture,
        COALESCE(u.total_points, 0) as total_points,
        COALESCE(u.current_level, 1) as current_level,
        COALESCE(u.explorer_score, 0) as explorer_score,
        u.featured_badge_id,
        b.name as featured_badge_name,
        b.icon as featured_badge_icon,
        b.rarity as featured_badge_rarity
       FROM users u
       LEFT JOIN badges b ON b.id = u.featured_badge_id
       WHERE u.id = $1`,
      [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const user = userRes.rows[0];
    const totalPoints = parseInt(user.total_points || 0);
    const levelInfo = rewardService.calculateLevel(totalPoints);
    const nextLevelThreshold = rewardService.getNextLevelThreshold(totalPoints);

    // Calculate rank
    const rankRes = await db.query(
      `SELECT COUNT(*) + 1 as rank FROM users WHERE total_points > $1`,
      [totalPoints]
    );
    const rank = parseInt(rankRes.rows[0].rank || 1);

    // Fetch user badges
    const badgesRes = await db.query(
      `SELECT b.*, ub.earned_at, (b.id = $1) as is_featured
       FROM user_badges ub
       JOIN badges b ON b.id = ub.badge_id
       WHERE ub.user_id = $2
       ORDER BY ub.earned_at DESC`,
      [user.featured_badge_id, userId]
    );

    return res.status(200).json({
      success: true,
      profile: {
        userId: user.id,
        name: user.name,
        username: user.username,
        profile_picture: user.profile_picture,
        totalPoints,
        level: levelInfo.level,
        levelName: levelInfo.name,
        minXp: levelInfo.minXp,
        nextLevelMinXp: nextLevelThreshold ? nextLevelThreshold.minXp : totalPoints,
        rank,
        featuredBadge: user.featured_badge_id ? {
          id: user.featured_badge_id,
          name: user.featured_badge_name,
          icon: user.featured_badge_icon,
          rarity: user.featured_badge_rarity,
        } : null,
        badges: badgesRes.rows,
      },
    });
  } catch (error) {
    console.error('Error fetching gamification profile:', error);
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
};

/**
 * GET /api/gamification/points/history?limit=30&page=1
 */
exports.getPointHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 30;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    const result = await db.query(
      `SELECT id, event_type, points, reference_type, reference_id, description, created_at
       FROM point_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return res.status(200).json({
      success: true,
      page,
      history: result.rows,
    });
  } catch (error) {
    console.error('Error fetching point history:', error);
    return res.status(500).json({ success: false, error: 'Server error fetching point history.' });
  }
};

/**
 * GET /api/gamification/badges
 */
exports.getBadges = async (req, res) => {
  try {
    const userId = req.user?.id;

    const result = await db.query(
      `SELECT 
        b.*,
        (ub.id IS NOT NULL) as is_earned,
        ub.earned_at,
        (b.id = u.featured_badge_id) as is_featured
       FROM badges b
       LEFT JOIN user_badges ub ON ub.badge_id = b.id AND ub.user_id = $1
       LEFT JOIN users u ON u.id = $1
       WHERE b.is_active = TRUE
       ORDER BY b.sort_order ASC, b.id ASC`,
      [userId || 0]
    );

    return res.status(200).json({
      success: true,
      badges: result.rows,
    });
  } catch (error) {
    console.error('Error fetching badges:', error);
    return res.status(500).json({ success: false, error: 'Server error fetching badges.' });
  }
};

/**
 * POST /api/gamification/badges/featured
 * Body: { badgeId }
 */
exports.setFeaturedBadge = async (req, res) => {
  try {
    const userId = req.user.id;
    const { badgeId } = req.body;

    if (!badgeId) {
      await db.query(`UPDATE users SET featured_badge_id = NULL WHERE id = $1`, [userId]);
      return res.status(200).json({ success: true, message: 'Featured badge cleared.' });
    }

    // Verify user owns badge
    const checkRes = await db.query(
      `SELECT * FROM user_badges WHERE user_id = $1 AND badge_id = $2`,
      [userId, badgeId]
    );

    if (checkRes.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'You have not earned this badge yet.' });
    }

    await db.query(`UPDATE users SET featured_badge_id = $1 WHERE id = $2`, [badgeId, userId]);

    return res.status(200).json({
      success: true,
      message: 'Featured badge updated successfully.',
    });
  } catch (error) {
    console.error('Error setting featured badge:', error);
    return res.status(500).json({ success: false, error: 'Server error setting featured badge.' });
  }
};

/**
 * POST /api/admin/points/adjust
 * Body: { targetUserId, points, reason }
 */
exports.adminAdjustPoints = async (req, res) => {
  try {
    const { targetUserId, points, reason } = req.body;

    if (!targetUserId || !points || !reason) {
      return res.status(400).json({ success: false, error: 'targetUserId, points, and reason are required.' });
    }

    const result = await rewardService.awardPoints(
      targetUserId,
      'admin_adjustment',
      parseInt(points),
      'admin',
      String(req.user.id),
      `Admin adjustment: ${reason}`,
      { adminId: req.user.id, reason }
    );

    return res.status(200).json({
      success: true,
      message: `Adjusted points by ${points} for user ${targetUserId}`,
      result,
    });
  } catch (error) {
    console.error('Admin point adjustment error:', error);
    return res.status(500).json({ success: false, error: 'Server error adjusting points.' });
  }
};
