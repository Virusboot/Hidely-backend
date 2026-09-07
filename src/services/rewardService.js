const db = require('../config/db');
const { getIO } = require('../socket');
const { createNotification } = require('../controllers/notificationController');

// Dynamic Configurable Reward Amounts & Daily Maximum Caps
let REWARD_CONFIG = {
  // 1. Normal Contribution Points
  normalContributionPoints: parseInt(process.env.REWARD_NORMAL_POST_POINTS) || 10,
  maxDailyRewardedPosts: parseInt(process.env.REWARD_MAX_DAILY_POSTS) || 10,
  maxNormalContributionDaily: parseInt(process.env.REWARD_MAX_NORMAL_DAILY_POINTS) || 100,

  // 2. Camera Location Bonus
  cameraLocationBonus: parseInt(process.env.REWARD_CAMERA_LOCATION_POINTS) || 20,
  maxCameraBonusDaily: parseInt(process.env.REWARD_MAX_CAMERA_BONUS_DAILY) || 200,

  // 3. GPS Accuracy Bonus
  gpsAccuracyBonusBase: parseInt(process.env.REWARD_GPS_ACCURACY_BASE_POINTS) || 10,
  gpsAccuracyBonusHigh: parseInt(process.env.REWARD_GPS_ACCURACY_HIGH_POINTS) || 15,
  maxGpsAccuracyBonusDaily: parseInt(process.env.REWARD_MAX_GPS_ACCURACY_DAILY) || 150,

  // 4. Hidden Place Discovery
  hiddenPlaceDiscoveryPoints: parseInt(process.env.REWARD_HIDDEN_PLACE_POINTS) || 100,

  // 5. Engagement Points (Likes, Saves, Shares)
  engagementLikePoints: parseInt(process.env.REWARD_LIKE_POINTS) || 1,
  engagementSavePoints: parseInt(process.env.REWARD_SAVE_POINTS) || 2,
  engagementSharePoints: parseInt(process.env.REWARD_SHARE_POINTS) || 3,
  maxEngagementPointsPerPost: parseInt(process.env.REWARD_MAX_ENGAGEMENT_PER_POST) || 50,
  maxEngagementPointsDaily: parseInt(process.env.REWARD_MAX_ENGAGEMENT_DAILY) || 100,
};

function getRewardConfig() {
  return { ...REWARD_CONFIG };
}

function updateRewardConfig(newConfig) {
  if (!newConfig || typeof newConfig !== 'object') return false;
  REWARD_CONFIG = {
    ...REWARD_CONFIG,
    ...newConfig,
  };
  return true;
}

const LEVEL_THRESHOLDS = [
  { level: 1, name: 'New Explorer', minXp: 0, badgeSlug: 'new_explorer' },
  { level: 2, name: 'Wanderer', minXp: 200, badgeSlug: 'wanderer' },
  { level: 3, name: 'Pathfinder', minXp: 500, badgeSlug: 'pathfinder' },
  { level: 4, name: 'Explorer', minXp: 1000, badgeSlug: 'explorer' },
  { level: 5, name: 'Trail Seeker', minXp: 2000, badgeSlug: 'trail_seeker' },
  { level: 6, name: 'Adventure Scout', minXp: 4000, badgeSlug: 'adventure_scout' },
  { level: 7, name: 'Hidden Hunter', minXp: 7500, badgeSlug: 'hidden_hunter' },
  { level: 8, name: 'Elite Explorer', minXp: 15000, badgeSlug: 'elite_explorer' },
  { level: 9, name: 'Legendary Explorer', minXp: 30000, badgeSlug: 'legendary_explorer' },
  { level: 10, name: 'Hidely Legend', minXp: 60000, badgeSlug: 'hidely_legend' },
];

function calculateLevel(points) {
  let matched = LEVEL_THRESHOLDS[0];
  for (const info of LEVEL_THRESHOLDS) {
    if (points >= info.minXp) {
      matched = info;
    } else {
      break;
    }
  }
  return matched;
}

function getNextLevelThreshold(points) {
  for (const info of LEVEL_THRESHOLDS) {
    if (points < info.minXp) {
      return info;
    }
  }
  return null;
}

/**
 * Idempotently award points to a user.
 */
async function awardPoints(userId, eventType, points, refType = null, refId = null, description = '', metadata = {}, options = {}) {
  if (!userId || points <= 0) return null;

  try {
    // 1. Insert transaction with unique constraint check for idempotency
    const txResult = await db.query(
      `INSERT INTO point_transactions 
        (user_id, event_type, points, reference_type, reference_id, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, event_type, reference_type, reference_id) DO NOTHING
       RETURNING *`,
      [userId, eventType, points, refType, refId ? String(refId) : null, description, JSON.stringify(metadata)]
    );

    // If transaction already exists, skip adding points again
    if (txResult.rows.length === 0) {
      console.log(`[RewardService] Duplicate point event ignored (Idempotent): ${eventType} for user ${userId}`);
      return null;
    }

    // 2. Update user's cached total_points & explorer_score
    const updateResult = await db.query(
      `UPDATE users 
       SET total_points = COALESCE(total_points, 0) + $1,
           explorer_score = COALESCE(explorer_score, 0) + ($1 * 1.0),
           last_points_updated_at = NOW()
       WHERE id = $2
       RETURNING id, total_points, current_level, current_rank, featured_badge_id`,
      [points, userId]
    );

    if (updateResult.rows.length === 0) return null;

    const user = updateResult.rows[0];
    const newTotalPoints = user.total_points;
    const oldLevelNum = user.current_level || 1;

    // 3. Level recalculation
    const levelInfo = calculateLevel(newTotalPoints);
    let levelChanged = false;

    if (levelInfo.level > oldLevelNum) {
      levelChanged = true;
      await db.query(`UPDATE users SET current_level = $1 WHERE id = $2`, [levelInfo.level, userId]);

      // Award Level Badge
      await grantBadgeBySlug(userId, levelInfo.badgeSlug, true);

      // Send Level Up Notification
      try {
        await createNotification({
          userId: userId,
          type: 'level_up',
          title: '🏆 Level Up!',
          message: `Congratulations! You are now a ${levelInfo.name} (Level ${levelInfo.level}).`,
        });
      } catch (err) {
        console.error('[RewardService] Error sending level up notification:', err.message);
      }
    }

    // 4. Check for special badge unlocks (if not deferred to batch caller)
    if (!options.skipBadgeCheck) {
      await checkSpecialBadgeEligibility(userId);
    }

    // 5. Emit real-time Socket.IO update to user's room
    try {
      const io = getIO();
      if (io) {
        const nextThreshold = getNextLevelThreshold(newTotalPoints);
        io.to(`user_${userId}`).emit('points_updated', {
          totalPoints: newTotalPoints,
          level: levelInfo.level,
          levelName: levelInfo.name,
          nextLevelMinXp: nextThreshold ? nextThreshold.minXp : newTotalPoints,
          earnedPoints: points,
          eventType,
          description,
        });
      }
    } catch (e) {
      console.error('[RewardService] Realtime socket emission error:', e.message);
    }

    return {
      pointsAwarded: points,
      totalPoints: newTotalPoints,
      level: levelInfo.level,
      levelChanged,
    };
  } catch (error) {
    console.error('[RewardService] Error awarding points:', error);
    return null;
  }
}

/**
 * Grant a badge to a user by slug.
 */
async function grantBadgeBySlug(userId, badgeSlug, setAsFeaturedIfNone = false) {
  try {
    const badgeRes = await db.query(`SELECT * FROM badges WHERE slug = $1 AND is_active = TRUE`, [badgeSlug]);
    if (badgeRes.rows.length === 0) return null;

    const badge = badgeRes.rows[0];
    const insertRes = await db.query(
      `INSERT INTO user_badges (user_id, badge_id, progress_snapshot)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, badge_id) DO NOTHING
       RETURNING *`,
      [userId, badge.id, JSON.stringify({ slug: badgeSlug })]
    );

    if (insertRes.rows.length > 0) {
      console.log(`[RewardService] Badge unlocked: ${badge.name} for user ${userId}`);

      if (setAsFeaturedIfNone) {
        await db.query(`UPDATE users SET featured_badge_id = $1 WHERE id = $2 AND featured_badge_id IS NULL`, [badge.id, userId]);
      }

      try {
        await createNotification({
          userId: userId,
          type: 'badge_earned',
          title: '💎 New Badge Earned!',
          message: `You earned the "${badge.name}" badge: ${badge.description}`,
        });
      } catch (err) {
        console.error('[RewardService] Notification error:', err.message);
      }
    }
  } catch (err) {
    console.error('[RewardService] Error granting badge:', err.message);
  }
}

/**
 * Check badge criteria for a user (consolidated 1-query execution).
 */
async function checkSpecialBadgeEligibility(userId) {
  if (!userId) return;

  try {
    const countsRes = await db.query(
      `SELECT 
         (SELECT COUNT(*)::int FROM point_transactions WHERE user_id = $1 AND event_type = 'hidden_place_discovered') AS hidden_place_count,
         (SELECT COUNT(*)::int FROM point_transactions WHERE user_id = $1 AND event_type = 'high_accuracy_location') AS accuracy_count,
         (SELECT COUNT(*)::int FROM posts WHERE user_id = $1) AS post_count`,
      [userId]
    );

    const counts = countsRes.rows[0] || {};
    const hiddenPlaceCount = parseInt(counts.hidden_place_count || 0);
    const accuracyCount = parseInt(counts.accuracy_count || 0);
    const postCount = parseInt(counts.post_count || 0);

    if (hiddenPlaceCount >= 1) {
      await grantBadgeBySlug(userId, 'first_discovery');
    }
    if (hiddenPlaceCount >= 5) {
      await grantBadgeBySlug(userId, 'hidely_pioneer');
    }
    if (accuracyCount >= 5) {
      await grantBadgeBySlug(userId, 'precision_explorer');
    }
    if (postCount >= 10) {
      await grantBadgeBySlug(userId, 'top_visual_contributor');
    }
  } catch (err) {
    console.error('[RewardService] Special badge check error:', err.message);
  }
}

/**
 * Process server-side post creation & place rewards with configurable caps.
 */
async function processPostRewards({ userId, postId, isCameraCapture, locationAccuracyMeters, isNewMasterPlace, isDuplicatePlace }) {
  if (!userId || !postId) return;

  // 1. Single Consolidated 24-Hour Daily Cap Query
  const dailyCapRes = await db.query(
    `SELECT 
       COUNT(*) FILTER (WHERE event_type = 'quality_post')::int AS daily_quality_post_count,
       COALESCE(SUM(points) FILTER (WHERE event_type = 'quality_post'), 0)::int AS daily_quality_post_points,
       COALESCE(SUM(points) FILTER (WHERE event_type = 'camera_location_post'), 0)::int AS daily_camera_points,
       COALESCE(SUM(points) FILTER (WHERE event_type = 'high_accuracy_location'), 0)::int AS daily_accuracy_points
     FROM point_transactions 
     WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
    [userId]
  );

  const row = dailyCapRes.rows[0] || {};
  const dailyPosts = parseInt(row.daily_quality_post_count || 0);
  const dailyNormalPoints = parseInt(row.daily_quality_post_points || 0);
  const cameraDailyPoints = parseInt(row.daily_camera_points || 0);
  const accuracyDailyPoints = parseInt(row.daily_accuracy_points || 0);

  // 2. Normal Contribution Points Check
  if (dailyPosts < REWARD_CONFIG.maxDailyRewardedPosts && dailyNormalPoints < REWARD_CONFIG.maxNormalContributionDaily) {
    await awardPoints(userId, 'quality_post', REWARD_CONFIG.normalContributionPoints, 'post', postId, 'Normal contribution points', {}, { skipBadgeCheck: true });
  }

  // 3. Camera Location Bonus Check
  if (isCameraCapture && cameraDailyPoints < REWARD_CONFIG.maxCameraBonusDaily) {
    await awardPoints(userId, 'camera_location_post', REWARD_CONFIG.cameraLocationBonus, 'post', postId, 'Camera location bonus points', {}, { skipBadgeCheck: true });
  }

  // 4. GPS Accuracy Bonus Check
  if (locationAccuracyMeters != null && locationAccuracyMeters <= 100 && accuracyDailyPoints < REWARD_CONFIG.maxGpsAccuracyBonusDaily) {
    const bonus = locationAccuracyMeters <= 20 ? REWARD_CONFIG.gpsAccuracyBonusHigh : REWARD_CONFIG.gpsAccuracyBonusBase;
    await awardPoints(userId, 'high_accuracy_location', bonus, 'post', postId, `GPS accuracy bonus (${Math.round(locationAccuracyMeters)}m)`, {}, { skipBadgeCheck: true });
  }

  // 5. Hidden Place Discovery Reward
  if (isNewMasterPlace && !isDuplicatePlace) {
    await awardPoints(userId, 'hidden_place_discovered', REWARD_CONFIG.hiddenPlaceDiscoveryPoints, 'post', postId, 'Discovered a new genuine Hidden Place!', {}, { skipBadgeCheck: true });
    try {
      await createNotification({
        userId: userId,
        type: 'place_discovered',
        title: '📍 Discovery Verified!',
        message: `You earned +${REWARD_CONFIG.hiddenPlaceDiscoveryPoints} points for discovering a new genuine Hidden Place.`,
      });
    } catch (e) {
      console.error('[RewardService] Discovery notification error:', e.message);
    }
  }

  // 6. Check special badge eligibility once after all post rewards have processed
  await checkSpecialBadgeEligibility(userId);
}

/**
 * Process engagement points (likes/saves/shares) with configurable caps & anti-self-like rules.
 */
async function processEngagementReward({ authorId, actorId, eventType, postId }) {
  if (!authorId || !actorId || !postId) return;
  // Ignore self-engagement
  if (parseInt(authorId) === parseInt(actorId)) return;

  let pointsToAward = 0;
  if (eventType === 'post_liked') pointsToAward = REWARD_CONFIG.engagementLikePoints;
  else if (eventType === 'post_saved') pointsToAward = REWARD_CONFIG.engagementSavePoints;
  else if (eventType === 'post_shared') pointsToAward = REWARD_CONFIG.engagementSharePoints;

  if (pointsToAward <= 0) return;

  // Check per-post engagement cap
  const postEngagementRes = await db.query(
    `SELECT COALESCE(SUM(points), 0)::int as total_points FROM point_transactions 
     WHERE user_id = $1 AND reference_type = 'post' AND reference_id = $2 AND event_type LIKE 'post_%'`,
    [authorId, String(postId)]
  );
  const postEngagementPoints = parseInt(postEngagementRes.rows[0].total_points || 0);
  if (postEngagementPoints >= REWARD_CONFIG.maxEngagementPointsPerPost) return;

  // Check daily engagement cap
  const dailyEngagementRes = await db.query(
    `SELECT COALESCE(SUM(points), 0)::int as total_points FROM point_transactions 
     WHERE user_id = $1 AND event_type LIKE 'post_%' AND created_at >= NOW() - INTERVAL '24 hours'`,
    [authorId]
  );
  const dailyEngagementPoints = parseInt(dailyEngagementRes.rows[0].total_points || 0);
  if (dailyEngagementPoints >= REWARD_CONFIG.maxEngagementPointsDaily) return;

  await awardPoints(authorId, eventType, pointsToAward, 'post', postId, `Engagement reward (${eventType}) from user ${actorId}`, { actorId });
}

module.exports = {
  awardPoints,
  processPostRewards,
  processEngagementReward,
  getRewardConfig,
  updateRewardConfig,
  calculateLevel,
  getNextLevelThreshold,
  LEVEL_THRESHOLDS,
};
