import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { readConfig, hash } from '../src/config.js';
import { login, mcpClient, testEvent } from '../scripts/client.js';

const config = readConfig({PUBLIC_BASE_URL:'https://liferpg.example',OAUTH_CLIENT_SECRET:'client-secret-'.repeat(4),OWNER_LOGIN_KEY:'owner-secret-'.repeat(4),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'});
let pg, db, app, client, tokens;
const fetcher = (input,init) => app(input instanceof Request ? input : new Request(input,init));
const rpc = (args,token) => fetcher(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(token ? {Authorization:`Bearer ${token}`} : {})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'record_life_event',arguments:args}})});
const form = (path,params,headers = {}) => fetcher(`${config.base}${path}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(params)});
const count = async () => (await db.query('SELECT count(*)::integer AS n FROM life_events')).rows[0].n;
before(async () => {
  pg = new PGlite();
  await pg.exec(await readFile(new URL('../migrations/001-experiment.sql',import.meta.url),'utf8'));
  db = {query:(sql,values) => pg.query(sql,values),transaction:fn => pg.transaction(tx => fn({query:(sql,values) => tx.query(sql,values)}))};
  app = createApp(db,config);
  tokens = (await login(config.base,config,fetcher)).tokens;
  client = await mcpClient(config.base,tokens.access_token,fetcher);
});
after(async () => {await client?.close(); await pg?.close();});

test('official SDK initializes, discovers three tools and correct annotations',async () => {
  const listed = await client.listTools();
  assert.equal(listed.tools.length,3);
  const write = listed.tools.find(t => t.name === 'record_life_event');
  assert.equal(write.annotations.readOnlyHint,false);
  assert.equal(write.annotations.idempotentHint,true);
  // The generic SDK client strips extension fields; verify the raw wire metadata too.
  assert.deepEqual(write._meta.securitySchemes,[{type:'oauth2',scopes:['life.write']}]);
  const raw = await fetcher(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/list'})});
  const wire = await raw.json();
  assert.deepEqual(wire.result.tools.find(t => t.name === 'record_life_event').securitySchemes,[{type:'oauth2',scopes:['life.write']}]);
  const status = await client.callTool({name:'get_gm_status',arguments:{}});
  assert.equal(status.structuredContent.storage,'ready');
});
test('anonymous, forged and expired tokens cannot register events',async () => {
  const n = await count();
  for (const token of [undefined,'x'.repeat(43)]) assert.equal((await rpc(testEvent,token)).status,401);
  const expired = (await login(config.base,config,fetcher)).tokens.access_token;
  await db.query('UPDATE oauth_grants SET expires_at=now()-interval \'1 second\' WHERE hash=$1',[hash(expired)]);
  assert.equal((await rpc(testEvent,expired)).status,401);
  assert.equal(await count(),n);
});
test('PKCE, code replay, exact redirects, resource and owner login are enforced',async () => {
  const {tokenParams} = await login(config.base,config,fetcher);
  assert.equal((await form('/oauth/token',tokenParams)).status,400);
  assert.equal((await form('/oauth/token',{...tokenParams,client_secret:'wrong'})).status,401);
  assert.equal((await form('/oauth/token',{...tokenParams,resource:'https://other.example/mcp'})).status,400);
  const params = new URLSearchParams({client_id:config.clientId,redirect_uri:'https://evil.example',response_type:'code'});
  assert.equal((await fetcher(`${config.base}/oauth/authorize?${params}`)).status,400);
  params.set('redirect_uri',config.redirects[0]);
  params.set('code_challenge','x'.repeat(43)); params.set('code_challenge_method','plain');
  params.set('resource',config.resource);
  assert.equal((await fetcher(`${config.base}/oauth/authorize?${params}`)).status,400);
  params.set('code_challenge_method','S256');
  const html = await (await fetcher(`${config.base}/oauth/authorize?${params}`)).text();
  const ticket = /name="ticket" value="([A-Za-z0-9_-]+)"/.exec(html)[1];
  assert.equal((await form('/oauth/authorize',{ticket,owner_key:'wrong'},{Origin:config.base})).status,401);
  assert.equal((await form('/oauth/authorize',{ticket,owner_key:config.ownerKey},{Origin:'https://evil.example'})).status,403);
  const granted = await form('/oauth/authorize',{ticket,owner_key:config.ownerKey},{Origin:config.base});
  const code = new URL(granted.headers.get('location')).searchParams.get('code');
  assert.equal((await form('/oauth/token',{...tokenParams,code,code_verifier:'y'.repeat(43)})).status,400);
});
test('read scope cannot write; wrong audience fails authentication',async () => {
  const readTokens = (await login(config.base,config,fetcher,'life.read')).tokens;
  const readClient = await mcpClient(config.base,readTokens.access_token,fetcher);
  try {
    assert.equal((await readClient.callTool({name:'record_life_event',arguments:testEvent})).isError,true);
    assert.equal((await readClient.callTool({name:'get_gm_status',arguments:{}})).isError,false);
  } finally {await readClient.close();}
  await db.query("UPDATE oauth_grants SET payload=jsonb_set(payload,'{resource}',to_jsonb('https://other.example/mcp'::text)) WHERE hash=$1",[hash(readTokens.access_token)]);
  assert.equal((await rpc(testEvent,readTokens.access_token)).status,401);
});
test('refresh rotates once and revocation prevents subsequent access',async () => {
  const {tokens:initial} = await login(config.base,config,fetcher);
  const params = {grant_type:'refresh_token',refresh_token:initial.refresh_token,client_id:config.clientId,client_secret:config.clientSecret,resource:config.resource};
  const refreshed = await form('/oauth/token',params);
  assert.equal(refreshed.status,200);
  const next = await refreshed.json();
  assert.notEqual(next.refresh_token,initial.refresh_token);
  assert.equal((await form('/oauth/token',params)).status,400);
  await form('/oauth/revoke',{client_id:config.clientId,client_secret:config.clientSecret,token:next.access_token});
  assert.equal((await rpc(testEvent,next.access_token)).status,401);
});
test('canonical key + date + kind deduplicates without overwriting evidence',async () => {
  const first = (await client.callTool({name:'record_life_event',arguments:testEvent})).structuredContent;
  const second = (await client.callTool({name:'record_life_event',arguments:{...testEvent,event_key:'  SYNTHETIC-WALK-30M ',summary:'달리 표현한 동일 사건'}})).structuredContent;
  assert.equal(first.outcome,'recorded'); assert.equal(second.outcome,'duplicate');
  assert.equal(first.event.id,second.event.id);
  assert.equal(second.event.summary,testEvent.summary);
  const nextDay = (await client.callTool({name:'record_life_event',arguments:{...testEvent,occurred_on:'2026-10-15'}})).structuredContent;
  assert.equal(nextDay.outcome,'recorded');
  const real = (await client.callTool({name:'record_life_event',arguments:{...testEvent,kind:'real'}})).structuredContent;
  assert.equal(real.outcome,'recorded');
});
test('jokes, fiction and hypotheticals are skipped; invalid dates and extra fields fail',async () => {
  const n = await count();
  for (const kind of ['joke','fiction','hypothetical']) {
    const result = await client.callTool({name:'record_life_event',arguments:{...testEvent,kind}});
    assert.equal(result.structuredContent.outcome,'skipped');
  }
  for (const extra of [{occurred_on:'2026-02-30'},{summary:''},{event_key:'  '},{owner_key:'do-not-log-this'}]) {
    const result = await client.callTool({name:'record_life_event',arguments:{...testEvent,...extra}});
    assert.equal(result.isError,true);
  }
  assert.equal(await count(),n);
  const calls = await db.query('SELECT arguments FROM tool_calls');
  assert.ok(!JSON.stringify(calls.rows).includes('do-not-log-this'));
});
test('event query paginates and audit captures time, received event and outcome',async () => {
  const result = (await client.callTool({name:'list_life_events',arguments:{limit:1}})).structuredContent;
  assert.equal(result.events.length,1); assert.equal(result.next_offset,1);
  const page2 = (await client.callTool({name:'list_life_events',arguments:{limit:1,offset:1}})).structuredContent;
  assert.notEqual(result.events[0].id,page2.events[0].id);
  const calls = (await client.callTool({name:'get_gm_status',arguments:{}})).structuredContent.recent_calls;
  assert.ok(calls.every(c => c.called_at && c.completed_at && c.outcome));
  assert.ok(calls.some(c => c.outcome === 'skipped' || c.outcome === 'invalid_input'));
});
test('an audit failure rolls back the event and reports an error',async () => {
  const n = await count();
  const failingDb = {
    query:db.query,
    transaction:fn => db.transaction(tx => fn({query:(sql,values) => {if(sql.startsWith('INSERT INTO tool_calls')) throw new Error('injected audit failure'); return tx.query(sql,values);}})),
  };
  const failingApp = createApp(failingDb,config);
  const response = await failingApp(new Request(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${tokens.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'record_life_event',arguments:{...testEvent,event_key:'rollback-test'}}})}));
  const result = await response.json();
  assert.equal(result.result.isError,true);
  assert.equal(result.result.structuredContent.outcome,'storage_error');
  assert.equal(await count(),n);
});
test('origin, content type, request size and JSON shape are checked',async () => {
  assert.equal((await fetcher(`${config.base}/mcp`,{method:'POST',headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetcher(`${config.base}/mcp`,{method:'POST'})).status,415);
  assert.equal((await fetcher(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(17000)})).status,413);
  assert.equal((await fetcher(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},body:'['})).status,400);
  assert.equal((await fetcher(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},body:'[]'})).status,400);
});
