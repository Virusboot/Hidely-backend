// Centralized Express Rate Limiting Middleware (Zero External Dependencies)

const rateLimitStore = new Map();

// Periodic cleanup of expired rate limit entries every 5 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now > data.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);
if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

/**
 * Creates a rate-limiting middleware instance.
 */
function createRateLimiter({
  windowMs = 15 * 60 * 1000, // 15 minutes default
  max = 10, // 10 requests limit default
  message = 'Too many requests. Please try again later.',
}) {
  return (req, res, next) => {
    // Extract real client IP behind proxies
    const clientIp = req.headers['x-forwarded-for']
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : req.ip || (req.socket && req.socket.remoteAddress) || 'unknown-ip';

    const routeScope = `${req.baseUrl || ''}${req.path || ''}`;
    const key = `${routeScope}:${clientIp}`;
    const now = Date.now();

    let record = rateLimitStore.get(key);

    if (!record || now > record.resetTime) {
      record = {
        count: 1,
        resetTime: now + windowMs,
      };
      rateLimitStore.set(key, record);
    } else {
      record.count += 1;
    }

    const remaining = Math.max(0, max - record.count);
    const resetSeconds = Math.ceil((record.resetTime - now) / 1000);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetSeconds);

    if (record.count > max) {
      res.setHeader('Retry-After', resetSeconds);
      return res.status(429).json({ error: message });
    }

    next();
  };
}

module.exports = {
  createRateLimiter,
  loginLimiter: createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many login attempts. Please try again after 15 minutes.',
  }),
  registerLimiter: createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many registration attempts. Please try again after 15 minutes.',
  }),
  otpLimiter: createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many OTP verification attempts. Please try again after 15 minutes.',
  }),
  forgotPasswordLimiter: createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many password reset requests. Please try again after 15 minutes.',
  }),
  resetPasswordLimiter: createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many password reset submissions. Please try again after 15 minutes.',
  }),
  availabilityLimiter: createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'Too many availability checks. Please slow down and try again shortly.',
  }),
  mapLimiter: createRateLimiter({
    windowMs: 5 * 60 * 1000,
    max: 120,
    message: 'Too many map requests. Please try again shortly.',
  }),
  reportLimiter: createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many report submissions. Please try again later.',
  }),
  accountActionLimiter: createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many sensitive account requests. Please try again after 15 minutes.',
  }),
};
