import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { login, testEvent } from '../scripts/client.js';

const env={PUBLIC_BASE_URL:'https://liferpg.example',OAUTH_CLIENT_SECRET:'client-secret-'.repeat(4),OWNER_LOGIN_KEY:'owner-secret-'.repeat(4),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'};
test('maintenance prevents authenticated MCP writes and OAuth rotation/revocation without DB or audit changes',async()=>{
  const pg=new PGlite();
  try {
    for(const name of ['001-experiment.sql','002-life-event-history.sql']) await pg.exec(await readFile(`migrations/${name}`,'utf8'));
    let queries=0;
    const db={query:(sql,values)=>{queries++;return pg.query(sql,values);},transaction:fn=>{queries++;return pg.transaction(tx=>fn({query:(sql,values)=>tx.query(sql,values)}));}};
    const config=readConfig(env), normal=createApp(db,config);
    const fetcher=(input,init)=>normal(input instanceof Request ? input : new Request(input,init));
    const {tokens,tokenParams}=await login(config.base,config,fetcher);
    const fingerprint=async()=>JSON.stringify((await pg.query("SELECT * FROM (SELECT 'grants' AS name,to_jsonb(t) AS row FROM oauth_grants t UNION ALL SELECT 'audit',to_jsonb(t) FROM tool_calls t UNION ALL SELECT 'attempts',to_jsonb(t) FROM auth_attempts t UNION ALL SELECT 'events',to_jsonb(t) FROM life_events t) s ORDER BY name,row::text")).rows);
    const before=await fingerprint(), beforeQueries=queries;
    const maintenance=createApp(db,readConfig({...env,MAINTENANCE_WRITES:'true'}));
    const requests=[
      new Request(`${config.base}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${tokens.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'record_life_event',arguments:testEvent}})}),
      ...[['/oauth/token',{...tokenParams,grant_type:'refresh_token',refresh_token:tokens.refresh_token}],['/oauth/revoke',{client_id:config.clientId,client_secret:config.clientSecret,token:tokens.access_token}],['/oauth/authorize',{owner_key:config.ownerKey,ticket:'test-ticket'}]].map(([route,params])=>new Request(`${config.base}${route}`,{method:'POST',headers:{Origin:config.base},body:new URLSearchParams(params)}))
    ];
    for(const request of requests) {const response=await maintenance(request);assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('retry-after'),'300');}
    assert.equal(queries,beforeQueries);assert.equal(await fingerprint(),before);
    // Existing grant remains usable when the maintenance window ends.
    assert.equal((await fetcher(`${config.base}/oauth/token`,{method:'POST',body:new URLSearchParams({...tokenParams,grant_type:'refresh_token',refresh_token:tokens.refresh_token})})).status,200);
  } finally {await pg.close();}
});

test('maintenance covers all methods and canonical, custom, and old deployment URLs',async()=>{
  const db={query:()=>{throw new Error('DB access forbidden');},transaction:()=>{throw new Error('DB access forbidden');}};
  const app=createApp(db,readConfig({...env,MAINTENANCE_WRITES:'true'}));
  for(const host of ['liferpg-mcp-experiment.vercel.app','liferpg.spiritflag.work','old-deployment.example']) {
    for(const route of ['/mcp','/mcp/','/oauth/authorize','/oauth/token','/oauth/revoke']) {
      for(const method of ['GET','POST','OPTIONS','DELETE','PUT','PATCH']) assert.equal((await app(new Request(`https://${host}${route}`,{method}))).status,503);
    }
  }
  assert.equal((await app(new Request(`${env.PUBLIC_BASE_URL}/health`))).status,200);
  const discovery=await app(new Request(`${env.PUBLIC_BASE_URL}/.well-known/oauth-authorization-server`));assert.equal(discovery.status,200);assert.equal((await discovery.json()).issuer,env.PUBLIC_BASE_URL);
});

test('Vercel entry rejects before configuration/DB initialization and disabled maintenance preserves discovery',async()=>{
  const saved=process.env.MAINTENANCE_WRITES;process.env.MAINTENANCE_WRITES='true';
  try {const entry=await import('../api/server.js');for(const method of ['GET','POST','OPTIONS','DELETE']) assert.equal((await entry[method](new Request('https://old-deployment.example/oauth/token',{method}))).status,503);}
  finally {if(saved===undefined) delete process.env.MAINTENANCE_WRITES;else process.env.MAINTENANCE_WRITES=saved;}
  const normal=createApp({query:()=>{throw new Error('Unexpected DB access');},transaction:()=>{throw new Error('Unexpected DB access');}},readConfig(env));
  assert.equal((await normal(new Request(`${env.PUBLIC_BASE_URL}/mcp`,{method:'GET'}))).status,405);
  assert.equal((await normal(new Request(`${env.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp`))).status,200);
});
