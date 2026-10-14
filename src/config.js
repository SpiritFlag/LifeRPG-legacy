import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** @param {string} value */
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
/** @param {string} a @param {string} b */
export const equalSecret = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

/** @param {NodeJS.ProcessEnv} env */
export function readConfig(env = process.env) {
  const base = new URL(env.PUBLIC_BASE_URL || 'http://localhost:3000');
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('PUBLIC_BASE_URL must be an origin');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) throw new Error('HTTPS required');
  const clientSecret = env.OAUTH_CLIENT_SECRET || '';
  const ownerKey = env.OWNER_LOGIN_KEY || '';
  if (clientSecret.length < 32 || ownerKey.length < 32 || clientSecret === ownerKey) throw new Error('Independent secrets of at least 32 characters required');
  const redirects = (env.OAUTH_REDIRECT_URIS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!redirects.length) throw new Error('Exact OAuth redirect allowlist required');
  for (const redirect of redirects) {
    const url = new URL(redirect);
    if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(base.protocol === 'http:' && url.protocol === 'http:' && url.hostname === 'localhost'))) throw new Error('Invalid redirect URI');
  }
  return { base: base.origin, resource: `${base.origin}/mcp`, clientId: env.OAUTH_CLIENT_ID || 'liferpg-chatgpt', clientSecret, ownerKey, redirects,allowSyntheticGame:env.ALLOW_SYNTHETIC_GAME === 'true',maintenanceWrites:env.MAINTENANCE_WRITES === 'true' };
}
/** @typedef {ReturnType<typeof readConfig>} Config */
