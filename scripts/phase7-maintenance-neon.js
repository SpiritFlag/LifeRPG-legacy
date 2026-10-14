// Only synthetic Phase 6 DB. Does not touch the restored production copy.
import { readFile,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { connectDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { login,testEvent } from './client.js';
const connection=JSON.parse(await readFile('.local/phase6/connection.json','utf8'));
assert.equal(connection.branch_id,'br-soft-art-a1xx9a51');
const url=new URL(connection.url);assert.equal(url.hostname,'ep-young-flower-a115sf9a.ap-southeast-1.aws.neon.tech');
url.pathname='/liferpg_phase6_synthetic';url.hostname='ep-young-flower-a115sf9a-pooler.ap-southeast-1.aws.neon.tech';
const db=connectDatabase(url.href),env={PUBLIC_BASE_URL:'https://phase7-synthetic.example',OAUTH_CLIENT_SECRET:'synthetic-client-'.repeat(4),OWNER_LOGIN_KEY:'synthetic-owner-'.repeat(4),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'};
const config=readConfig(env),app=createApp(db,config),fetcher=(input,init)=>app(input instanceof Request ? input : new Request(input,init));
const policy=JSON.parse(await readFile('docs/phase7-maintenance-rule.json','utf8'));
assert.equal(policy.action.mitigate.action,'deny');
assert.deepEqual(policy.conditionGroup.map(g=>g.conditions[0]),[{type:'path',op:'pre',value:'/mcp'},{type:'path',op:'pre',value:'/oauth'}]);
const snapshot=async()=>{const rows={};for(const table of ['life_events','life_event_revisions','tool_calls','oauth_grants','auth_attempts','games','gm_updates']) rows[table]=(await db.query(`SELECT count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM ${table} t`)).rows[0];return rows;};
try {
  const {tokens,tokenParams}=await login(config.base,config,fetcher);
  const before=await snapshot();let queries=0;
  const guardedDb={query:(...args)=>{queries++;return db.query(...args);},transaction:(...args)=>{queries++;return db.transaction(...args);}};
  const maintenance=createApp(guardedDb,readConfig({...env,MAINTENANCE_WRITES:'true'}));
  const requests=[
    new Request(`${config.base}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${tokens.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'record_life_event',arguments:testEvent}})}),
    ...[['/oauth/token',{...tokenParams,grant_type:'refresh_token',refresh_token:tokens.refresh_token}],['/oauth/revoke',{client_id:config.clientId,client_secret:config.clientSecret,token:tokens.access_token}],['/oauth/authorize',{owner_key:config.ownerKey,ticket:'test-ticket'}]].map(([route,params])=>new Request(`${config.base}${route}`,{method:'POST',body:new URLSearchParams(params)}))
  ];
  for(const request of requests) assert.equal((await maintenance(request)).status,503);
  let policyCases=0;
  // A LOCAL interpretation of the proposed WAF policy; actual Vercel enforcement
  // must be tested under the approved Phase 8 maintenance window.
  for(const host of ['liferpg-mcp-experiment.vercel.app','liferpg.spiritflag.work','old-deployment.example']) for(const route of ['/mcp','/oauth/authorize','/oauth/token','/oauth/revoke']) for(const method of ['GET','POST','OPTIONS','DELETE','PUT','PATCH']) {
    const request=new Request(`https://${host}${route}`,{method});
    const blocked=policy.conditionGroup.some(g=>g.conditions.every(c=>new URL(request.url).pathname.startsWith(c.value)));
    assert.equal(blocked,true);policyCases++;
  }
  assert.equal(queries,0);assert.deepEqual(await snapshot(),before);
  const retired=JSON.parse(await readFile('docs/phase7-retired-writer-rule.json','utf8'));
  assert.equal(retired.action.mitigate.action,'deny');
  let retirementCases=0;
  for(const host of ['liferpg-mcp-experiment.vercel.app','liferpg.spiritflag.work','old-deployment.example']) for(const route of ['/mcp','/oauth/authorize','/oauth/token','/oauth/revoke','/health','/.well-known/oauth-authorization-server','/api/player']) {
    const blocked=retired.conditionGroup.some(g=>g.conditions.every(c=>c.type==='path' ? route.startsWith(c.value) : host!==c.value));
    assert.equal(blocked,host!=='liferpg-mcp-experiment.vercel.app' && (route.startsWith('/mcp') || route.startsWith('/oauth')));retirementCases++;
  }
  assert.equal((await maintenance(new Request(`${config.base}/health`))).status,200);
  assert.equal((await fetcher(`${config.base}/oauth/token`,{method:'POST',body:new URLSearchParams({...tokenParams,grant_type:'refresh_token',refresh_token:tokens.refresh_token})})).status,200);
  const report={checked_at:new Date().toISOString(),branch:'br-soft-art-a1xx9a51',database:'liferpg_phase6_synthetic',app_requests:4,app_status:503,db_calls_while_blocked:queries,all_fingerprints_unchanged:true,grants_usable_after_unblock:true,local_policy_cases:policyCases,retirement_policy_cases:retirementCases,remote_firewall_applied:false};
  await writeFile('.local/phase7/maintenance-neon.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {await db.close();}
