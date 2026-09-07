/**
 * Production Security Headers Middleware
 * Protects Express API, Web/Admin, static resources & Socket.IO
 */
function securityHeaders(req, res, next) {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Prevent MIME-sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // XSS protection for older browsers
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Strict Transport Security (HSTS) for HTTPS
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Content Security Policy compatible with web app, static admin, and Socket.IO
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https: wss: ws:; img-src 'self' https: data: blob:; media-src 'self' https: data: blob:;"
  );
  next();
}

module.exports = securityHeaders;
