// Validates required environment variables at startup.
// Import this as the first statement in index.js.

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`[startup] Missing required environment variable: ${name}`);
  return val;
}

export const JWT_SECRET = requireEnv('JWT_SECRET');
export const ENCRYPTION_KEY = requireEnv('ENCRYPTION_KEY');
export const FRONTEND_URL = requireEnv('FRONTEND_URL');
export const PORT = Number(process.env.PORT) || 4000;
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const DEBUG_KEY = process.env.DEBUG_KEY;
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
export const META_WA_WEBHOOK_SECRET = process.env.META_WA_WEBHOOK_SECRET;
export const APP_URL = process.env.APP_URL;

// FRONTEND_URL is a comma-separated CORS allowlist; user-facing links
// (onboarding, invites, password resets) need ONE url from it.
// Prefer the custom https domain over the *.railway.app fallback.
export function publicAppUrl() {
  const urls = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean);
  return urls.find(u => u.startsWith('https://') && !u.includes('railway.app')) || urls[0] || '';
}
