import { equalSecret, hash, secret } from './config.js';
import { getGrant, putGrant } from './storage.js';

export const SCOPES = ['life.read', 'life.write', 'offline_access'];
export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) { super(message); this.status = status; }
}
/** @param {object} data @param {number} status */
export const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control':'no-store'}});

/** @param {Request} request */
export async function readBody(request) {
  if (Number(request.headers.get('content-length') || 0) > 16384) throw new HttpError(413, 'request_too_large');
  const reader = request.body?.getReader();
  if (!reader) return '';
  let total = 0;
  const chunks = [];
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 16384) { await reader.cancel(); throw new HttpError(413, 'request_too_large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {import('./config.js').Config} config */
export function challenge(config) {
  return `Bearer resource_metadata="${config.base}/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="Connect LifeRPG using OAuth"`;
}

/** @param {import('./database.js').Queryable} db @param {import('./config.js').Config} config @param {Request} request */
export async function authenticate(db, config, request) {
  const value = request.headers.get('authorization') || '';
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(value)?.[1];
  if (!token) return null;
  const grant = await getGrant(db, 'access', hash(token));
  if (!grant || grant.resource !== config.resource || grant.client_id !== config.clientId || grant.subject !== 'experiment-owner' || !Array.isArray(grant.scopes)) return null;
  return grant;
}

/** @param {URLSearchParams} params @param {import('./config.js').Config} config */
function validateAuthorization(params, config) {
  for (const key of ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']) {
    if (params.getAll(key).length > 1) throw new HttpError(400, 'duplicate_parameter');
  }
  const redirect = params.get('redirect_uri') || '';
  if (params.get('client_id') !== config.clientId || !config.redirects.includes(redirect)) throw new HttpError(400, 'invalid_client_or_redirect');
  if (params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') || '')) throw new HttpError(400, 'PKCE_S256_required');
  const scopes = (params.get('scope') || config.scopes.filter(s=>s!=='offline_access').join(' ')).split(' ').filter(Boolean);
  if (!scopes.length || scopes.some(s => !config.scopes.includes(s))) throw new HttpError(400, 'invalid_scope');
  if (params.get('resource') !== config.resource) throw new HttpError(400, 'invalid_target');
  if ((params.get('state') || '').length > 1024) throw new HttpError(400, 'invalid_state');
  return {client_id:config.clientId, redirect_uri:redirect, challenge:params.get('code_challenge'), state:params.get('state'), scopes, resource:config.resource, subject:'experiment-owner'};
}

/** @param {import('./database.js').Queryable} db @param {any} payload */
async function issueTokens(db, payload) {
  const access = secret();
  await putGrant(db, 'access', hash(access), payload, 3600);
  const refresh = payload.scopes.includes('offline_access') ? secret() : undefined;
  if (refresh) await putGrant(db, 'refresh', hash(refresh), payload, 30 * 86400);
  return {access_token:access, token_type:'Bearer', expires_in:3600, scope:payload.scopes.join(' '), ...(refresh ? {refresh_token:refresh} : {})};
}

/** @param {import('./database.js').Database} db @param {import('./config.js').Config} config @param {Request} request @returns {Promise<Response | null>} */
export async function oauthRoute(db, config, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path)) {
    return json({resource:config.resource, authorization_servers:[config.base], scopes_supported:config.scopes, bearer_methods_supported:['header'], resource_name:config.serverName});
  }
  if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
    return json({issuer:config.base, authorization_endpoint:`${config.base}/oauth/authorize`, token_endpoint:`${config.base}/oauth/token`, revocation_endpoint:`${config.base}/oauth/revoke`, response_types_supported:['code'], grant_types_supported:['authorization_code','refresh_token'], token_endpoint_auth_methods_supported:['client_secret_post','client_secret_basic'], code_challenge_methods_supported:['S256'], scopes_supported:config.scopes, authorization_response_iss_parameter_supported:true});
  }
  if (request.method === 'GET' && path === '/oauth/authorize') {
    const payload = validateAuthorization(url.searchParams, config);
    const ticket = secret();
    // Opportunistic cleanup only; no scheduler or daily job.
    await db.query('DELETE FROM oauth_grants WHERE expires_at < now()');
    await db.query("DELETE FROM auth_attempts WHERE bucket < now() - interval '1 day'");
    await putGrant(db, 'login', hash(ticket), payload, 300);
    // no-referrer makes a browser navigation POST send Origin:null. Preserve the
    // origin for CSRF validation while withholding the authorization URL/query.
    // Chromium also checks form-action against the 303 redirect destination.
    // This origin comes only from the exact, already-validated redirect allowlist.
    const callbackOrigin = new URL(payload.redirect_uri).origin;
    const permissionNames = /** @type {Record<string,string>} */ ({'life.read':'현실 기록 조회','life.write':'현실 기록 작성·정정','life.delete':'현실 기록·파생 기억 삭제','game.read':'게임·처리 결과 조회','game.play':'GM 실행·게임 상태 변경','usage.read':'사용량 조회','offline_access':'연결 유지'});
    const permissions=payload.scopes.map(scope=>permissionNames[scope] || '허용된 서비스 권한').join(' · ');
    return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>LifeRPG 연결</title><h1>LifeRPG 연결</h1><p>ChatGPT에 다음 권한을 부여합니다: ${permissions}. 본인이 시작한 연결인지 확인하세요.</p><p>서버를 준비할 때 생성된 소유자 연결 키를 입력하세요. 이 키를 대화에 붙여넣지 마세요.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="ticket" value="${ticket}"><label>소유자 연결 키 <input type="password" name="owner_key" autocomplete="off" required></label><button type="submit">연결 승인</button></form></html>`, {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':`default-src 'none'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`,'Referrer-Policy':'strict-origin','X-Content-Type-Options':'nosniff'}});
  }
  if (request.method === 'POST' && path === '/oauth/authorize') {
    if (request.headers.get('origin') !== config.base) throw new HttpError(403, 'invalid_origin');
    const params = new URLSearchParams(await readBody(request));
    const attempts = await db.query("INSERT INTO auth_attempts(bucket,attempts) VALUES (date_trunc('hour',now()),1) ON CONFLICT(bucket) DO UPDATE SET attempts=auth_attempts.attempts+1 RETURNING attempts");
    if (attempts.rows[0].attempts > 30) throw new HttpError(429, 'login_rate_limited');
    if (!equalSecret(params.get('owner_key') || '', config.ownerKey)) throw new HttpError(401, 'invalid_owner_key');
    const location = await db.transaction(async tx => {
      const payload = await getGrant(tx, 'login', hash(params.get('ticket') || ''), true);
      if (!payload) throw new HttpError(400, 'expired_login');
      const code = secret();
      await putGrant(tx, 'code', hash(code), payload, 120);
      const destination = new URL(payload.redirect_uri);
      destination.searchParams.set('code',code);
      destination.searchParams.set('iss',config.base);
      if (payload.state != null) destination.searchParams.set('state',payload.state);
      return destination.href;
    });
    return new Response(null,{status:303,headers:{Location:location,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  }
  if (request.method === 'POST' && ['/oauth/token','/oauth/revoke'].includes(path)) {
    const params = new URLSearchParams(await readBody(request));
    let clientId = params.get('client_id') || '';
    let clientSecret = params.get('client_secret') || '';
    const basic = /^Basic (.+)$/i.exec(request.headers.get('authorization') || '')?.[1];
    if (basic) {
      const decoded = Buffer.from(basic,'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      clientId = decodeURIComponent(decoded.slice(0,colon));
      clientSecret = decodeURIComponent(decoded.slice(colon+1));
    }
    if (clientId !== config.clientId || !equalSecret(clientSecret,config.clientSecret)) throw new HttpError(401,'invalid_client');
    if (path === '/oauth/revoke') {
      await db.query("DELETE FROM oauth_grants WHERE hash=$1 AND kind IN ('access','refresh')",[hash(params.get('token') || '')]);
      return json({});
    }
    if (params.get('resource') !== config.resource) throw new HttpError(400,'invalid_target');
    const grantType = params.get('grant_type');
    if (!['authorization_code','refresh_token'].includes(grantType || '')) throw new HttpError(400,'unsupported_grant_type');
    const tokens = await db.transaction(async tx => {
      const kind = grantType === 'authorization_code' ? 'code' : 'refresh';
      const token = params.get(kind === 'code' ? 'code' : 'refresh_token') || '';
      const payload = await getGrant(tx,kind,hash(token),true);
      if (!payload || payload.client_id !== clientId || payload.resource !== config.resource) throw new HttpError(400,'invalid_grant');
      if (kind === 'code') {
        const verifier = params.get('code_verifier') || '';
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !equalSecret(Buffer.from(hash(verifier),'hex').toString('base64url'),payload.challenge) || params.get('redirect_uri') !== payload.redirect_uri) throw new HttpError(400,'invalid_grant');
      } else if (params.has('scope') && params.get('scope') !== payload.scopes.join(' ')) throw new HttpError(400,'invalid_scope');
      return issueTokens(tx,payload);
    });
    return json(tokens);
  }
  return null;
}
