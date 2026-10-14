import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function login(base, config, fetcher = fetch, scopes = 'life.read life.write offline_access') {
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirects[0],response_type:'code',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:scopes,state:'liferpg-test-state',resource:`${base}/mcp`});
  const authorization = await fetcher(`${base}/oauth/authorize?${params}`);
  assert.equal(authorization.status,200);
  const html = await authorization.text();
  const ticket = /name="ticket" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(ticket);
  const granted = await fetcher(`${base}/oauth/authorize`,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:new URLSearchParams({ticket,owner_key:config.ownerKey})});
  assert.equal(granted.status,303);
  const destination = new URL(granted.headers.get('location'));
  assert.equal(destination.searchParams.get('iss'),base);
  assert.equal(destination.searchParams.get('state'),'liferpg-test-state');
  const tokenParams = {grant_type:'authorization_code',code:destination.searchParams.get('code'),code_verifier:verifier,client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:config.redirects[0],resource:`${base}/mcp`};
  const response = await fetcher(`${base}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(tokenParams)});
  assert.equal(response.status,200);
  return {tokens:await response.json(),tokenParams};
}

export async function mcpClient(base, token, fetcher = fetch) {
  const client = new Client({name:'liferpg-verification',version:'0.1.0'});
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{fetch:fetcher,requestInit:{headers:{Authorization:`Bearer ${token}`}}});
  await client.connect(transport);
  return client;
}

export const testEvent = {occurred_on:'2026-10-14',event_key:'synthetic-walk-30m',kind:'test',summary:'[합성 테스트] 30분 산책 완료',evidence:'서버 동작 확인용 합성 사건입니다.'};
