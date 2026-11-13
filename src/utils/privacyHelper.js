const db = require('../config/db');
const { ensureUserBlocksTable } = require('./blockHelper');

const VALID_AUDIENCE_POLICIES = new Set(['everyone', 'following', 'no_one']);

let _tagMentionSchemaReady = false;
let _schemaInitPromise = null;

/**
 * Ensures the tag/mention privacy columns on `users` and the `post_tags` table exist.
 * Idempotent and cached per server lifecycle.
 */
async function ensureTagMentionSchema() {
  if (_tagMentionSchemaReady) return;
  if (_schemaInitPromise) {
    await _schemaInitPromise;
    return;
  }

  _schemaInitPromise = (async () => {
    try {
      await ensureUserBlocksTable();
      await db.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS allow_tags_from VARCHAR(20) DEFAULT 'everyone',
        ADD COLUMN IF NOT EXISTS allow_mentions_from VARCHAR(20) DEFAULT 'everyone',
        ADD COLUMN IF NOT EXISTS manually_approve_tags BOOLEAN DEFAULT FALSE;

        CREATE TABLE IF NOT EXISTS post_tags (
          id SERIAL PRIMARY KEY,
          post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          tagged_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tagged_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'approved',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (post_id, tagged_user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_post_tags_tagged_user ON post_tags (tagged_user_id, status);
        CREATE INDEX IF NOT EXISTS idx_post_tags_post_id ON post_tags (post_id, status);
      `);
      _tagMentionSchemaReady = true;
    } catch (err) {
      console.error('[PrivacyHelper] Failed to ensure tag/mention schema:', err.message);
    } finally {
      _schemaInitPromise = null;
    }
  })();

  await _schemaInitPromise;
}

/**
 * Normalizes an arbitrary policy input to 'everyone' | 'following' | 'no_one'.
 */
function normalizeAudiencePolicy(value) {
  if (typeof value !== 'string') return 'everyone';
  const clean = value.trim().toLowerCase();
  if (clean === 'everyone' || clean === 'all') return 'everyone';
  if (clean === 'following' || clean === 'people_you_follow' || clean === 'followers') return 'following';
  if (clean === 'no_one' || clean === 'noone' || clean === 'none' || clean === 'nobody') return 'no_one';
  return 'everyone';
}

/**
 * Parses a strict audience policy value for write endpoints, returning null if invalid.
 */
function parseStrictAudiencePolicy(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim().toLowerCase();
  if (clean === 'everyone') return 'everyone';
  if (clean === 'following' || clean === 'people_you_follow') return 'following';
  if (clean === 'no_one' || clean === 'noone' || clean === 'none') return 'no_one';
  return null;
}

/**
 * Normalizes a list of raw username strings (stripping leading '@', trimming, lowercasing, deduplicating).
 */
function normalizeUsernameList(input) {
  let items = [];
  if (Array.isArray(input)) {
    items = input;
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          items = parsed;
        }
      } catch (_) {
        items = trimmed.split(',');
      }
    } else {
      items = trimmed.split(',');
    }
  }

  const seen = new Set();
  const out = [];
  for (const raw of items) {
    if (raw === null || raw === undefined) continue;
    const clean = String(raw).trim().replace(/^@+/, '').toLowerCase();
    if (!clean) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

/**
 * Extracts unique lowercase @username handles from text (ignoring email-like tokens such as a@b.com).
 */
function extractMentionUsernames(text) {
  if (!text || typeof text !== 'string') return [];
  const regex = /(?:^|[^a-zA-Z0-9_.])@([a-zA-Z0-9_.]{1,50})/g;
  const seen = new Set();
  const handles = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const clean = (match[1] || '').replace(/\.+$/, '').toLowerCase();
    if (!clean) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      handles.push(clean);
    }
  }
  return handles;
}

/**
 * Evaluates whether `actorId` is allowed to tag or @mention each username in `usernames`.
 * mode: 'tag' | 'mention'
 */
async function evaluateTagMentionTargets({ actorId, usernames, mode = 'mention' }) {
  const cleanUsernames = normalizeUsernameList(usernames);
  if (cleanUsernames.length === 0) {
    return { allowedUsers: [], rejectedUsers: [], notFoundUsernames: [] };
  }

  await ensureTagMentionSchema();

  const numericActorId = actorId ? parseInt(actorId, 10) : null;
  const res = await db.query(
    `SELECT
      u.id,
      u.name,
      u.username,
      u.profile_picture,
      COALESCE(u.allow_tags_from, 'everyone') AS allow_tags_from,
      COALESCE(u.allow_mentions_from, 'everyone') AS allow_mentions_from,
      COALESCE(u.manually_approve_tags, FALSE) AS manually_approve_tags,
      CASE
        WHEN $2::int IS NULL THEN FALSE
        ELSE EXISTS(
          SELECT 1 FROM user_follows uf
          WHERE uf.follower_id = u.id AND uf.following_id = $2::int
        )
      END AS target_follows_actor,
      CASE
        WHEN $2::int IS NULL THEN FALSE
        ELSE EXISTS(
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = $2::int AND ub.blocked_id = u.id)
             OR (ub.blocker_id = u.id AND ub.blocked_id = $2::int)
        )
      END AS is_blocked
     FROM users u
     WHERE LOWER(u.username) = ANY($1::text[])`,
    [cleanUsernames, numericActorId]
  );

  const byLowerUsername = new Map();
  for (const row of res.rows) {
    if (row.username) {
      byLowerUsername.set(row.username.toLowerCase(), row);
    }
  }

  const allowedUsers = [];
  const rejectedUsers = [];
  const notFoundUsernames = [];

  for (const uname of cleanUsernames) {
    const target = byLowerUsername.get(uname);
    if (!target) {
      notFoundUsernames.push(uname);
      continue;
    }

    const isSelf = numericActorId && parseInt(target.id, 10) === numericActorId;
    if (isSelf) {
      allowedUsers.push({
        id: target.id,
        name: target.name,
        username: target.username,
        profile_picture: target.profile_picture,
        manually_approve_tags: target.manually_approve_tags === true,
        policy: mode === 'tag'
          ? normalizeAudiencePolicy(target.allow_tags_from)
          : normalizeAudiencePolicy(target.allow_mentions_from),
      });
      continue;
    }

    if (target.is_blocked === true) {
      rejectedUsers.push({
        id: target.id,
        name: target.name,
        username: target.username,
        reason: 'blocked',
        policy: 'blocked',
      });
      continue;
    }

    const policy = mode === 'tag'
      ? normalizeAudiencePolicy(target.allow_tags_from)
      : normalizeAudiencePolicy(target.allow_mentions_from);

    let allowed = false;
    let reason = 'allowed';
    if (policy === 'everyone') {
      allowed = true;
    } else if (policy === 'following') {
      allowed = target.target_follows_actor === true;
      reason = allowed ? 'allowed' : 'following';
    } else if (policy === 'no_one') {
      allowed = false;
      reason = 'no_one';
    }

    if (allowed) {
      allowedUsers.push({
        id: target.id,
        name: target.name,
        username: target.username,
        profile_picture: target.profile_picture,
        manually_approve_tags: target.manually_approve_tags === true,
        policy,
      });
    } else {
      rejectedUsers.push({
        id: target.id,
        name: target.name,
        username: target.username,
        reason,
        policy,
      });
    }
  }

  return { allowedUsers, rejectedUsers, notFoundUsernames };
}

/**
 * Formats a concise human-readable rejection error message for tag or mention restriction.
 */
function buildRestrictionErrorMessage(rejectedUsers, mode = 'mention') {
  if (!rejectedUsers || rejectedUsers.length === 0) return '';
  const verb = mode === 'tag' ? 'tags' : '@mentions';
  if (rejectedUsers.length === 1) {
    const u = rejectedUsers[0];
    const handle = u.username ? `@${u.username}` : (u.name || 'This user');
    if (u.reason === 'following') {
      return `${handle} only allows ${verb} from people they follow.`;
    }
    if (u.reason === 'blocked') {
      return `Cannot ${mode === 'tag' ? 'tag' : 'mention'} ${handle}.`;
    }
    return `${handle} doesn't allow ${verb} from anyone.`;
  }
  const handles = rejectedUsers
    .slice(0, 3)
    .map((u) => (u.username ? `@${u.username}` : u.name || 'user'))
    .join(', ');
  const extra = rejectedUsers.length > 3 ? ` +${rejectedUsers.length - 3} more` : '';
  return `These users don't allow ${verb}: ${handles}${extra}.`;
}

/**
 * SQL select fragment computing allow_tags_from, allow_mentions_from,
 * can_be_tagged, and can_be_mentioned for table alias `u` relative to `currentUserParam` (e.g. '$1').
 */
function tagMentionCapabilityColumnsSql(currentUserParam, userAlias = 'u') {
  return `
    COALESCE(${userAlias}.allow_tags_from, 'everyone') AS allow_tags_from,
    COALESCE(${userAlias}.allow_mentions_from, 'everyone') AS allow_mentions_from,
    CASE
      WHEN ${currentUserParam}::int IS NULL THEN TRUE
      WHEN ${userAlias}.id = ${currentUserParam}::int THEN TRUE
      WHEN COALESCE(${userAlias}.allow_tags_from, 'everyone') = 'no_one' THEN FALSE
      WHEN COALESCE(${userAlias}.allow_tags_from, 'everyone') = 'following'
        THEN EXISTS(
          SELECT 1 FROM user_follows uf_tag
          WHERE uf_tag.follower_id = ${userAlias}.id AND uf_tag.following_id = ${currentUserParam}::int
        )
      ELSE TRUE
    END AS can_be_tagged,
    CASE
      WHEN ${currentUserParam}::int IS NULL THEN TRUE
      WHEN ${userAlias}.id = ${currentUserParam}::int THEN TRUE
      WHEN COALESCE(${userAlias}.allow_mentions_from, 'everyone') = 'no_one' THEN FALSE
      WHEN COALESCE(${userAlias}.allow_mentions_from, 'everyone') = 'following'
        THEN EXISTS(
          SELECT 1 FROM user_follows uf_mention
          WHERE uf_mention.follower_id = ${userAlias}.id AND uf_mention.following_id = ${currentUserParam}::int
        )
      ELSE TRUE
    END AS can_be_mentioned
  `;
}

/**
 * Removes @username from the trailing "with @u1 @u2" section (or inline mention) when a user removes their own tag.
 */
function stripTagFromCaptionSuffix(caption, username) {
  if (!caption || typeof caption !== 'string' || !username) return caption || '';
  const escaped = username.replace(/^@+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const handleRegex = new RegExp(`(^|\\s)@${escaped}(?=$|[\\s.,!?;:])`, 'gi');
  let updated = caption.replace(handleRegex, '$1');
  // Collapse multiple spaces created by removal
  updated = updated.replace(/[ \t]{2,}/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
  // Remove orphaned trailing "with" left after removing all tagged handles
  updated = updated.replace(/(?:\s+|\n)with\s*$/i, '').trim();
  return updated;
}

module.exports = {
  VALID_AUDIENCE_POLICIES,
  ensureTagMentionSchema,
  normalizeAudiencePolicy,
  parseStrictAudiencePolicy,
  normalizeUsernameList,
  extractMentionUsernames,
  evaluateTagMentionTargets,
  buildRestrictionErrorMessage,
  tagMentionCapabilityColumnsSql,
  stripTagFromCaptionSuffix,
};

