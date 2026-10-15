import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {scopedDatabase} from '../src/v2/storage.ts';
import {LifeRpgService} from '../src/v2/service.ts';
import {MockGm} from '../src/v2/mock-gm.ts';
import {inlineGm} from '../src/v2/inline.ts';
import {V2_SCOPES} from '../src/v2/contracts.ts';
import {createV2App} from '../src/v2/app.ts';
import {readConfig} from '../src/config.js';
import {login,mcpClient} from '../scripts/client.js';

test('single invocation MCP: immediate result, 15s pending, continuation, idempotency, timing and terminal failure',async()=>{
 const pg=new PGlite();
 try {
  for(const f of ['001-foundation.sql','002-openai-accounting.sql','003-rpg.sql','004-memory.sql','005-inline-timing.sql'])await pg.exec(await readFile(new URL(`../migrations/v2/${f}`,import.meta.url),'utf8'));
  const db=scopedDatabase({query:(s,v)=>pg.query(s,v),transaction:fn=>pg.transaction(tx=>fn({query:(s,v)=>tx.query(s,v)}))});
  const tasks=[];let delay=0,calls=0,signal,fail=false;
  const gm=new MockGm(),original=gm.generate.bind(gm);
  gm.generate=async(c,s)=>{calls++;signal=s;if(delay)await new Promise(r=>setTimeout(r,delay));if(fail)throw Error('private provider error');return original(c,s);};
  const runner=inlineGm(db,gm,p=>tasks.push(p));
  const config=readConfig({PUBLIC_BASE_URL:'https://v2.example',OAUTH_CLIENT_SECRET:'client-secret-'.repeat(4),OWNER_LOGIN_KEY:'owner-secret-'.repeat(4),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'});
  const app=createV2App(db,config,undefined,'openai',runner),fetcher=(u,i)=>app(u instanceof Request?u:new Request(u,i));
  const tokens=(await login(config.base,config,fetcher,V2_SCOPES.join(' '))).tokens;
  const client=await mcpClient(config.base,tokens.access_token,fetcher);
  try {
   assert.equal((await client.listTools()).tools.length,5);
   const call=async(name,args)=>(await client.callTool({name,arguments:args})).structuredContent;
   const start=await call('interact_with_gm',{kind:'start',request_id:randomUUID(),message:'test birth'});
   assert.equal(start.status,'committed');assert.ok(start.timing.total_ms>=start.timing.gm_api_ms);
   delay=16000;
   const args={request_id:randomUUID(),summary:'[test] 20 minute walk'};
   const began=Date.now(),pending=await call('submit_observation',args);
   assert.equal(pending.status,'running');assert.ok(Date.now()-began<15750);assert.equal(signal.aborted,false);
   assert.equal((await call('read_liferpg',{view:'request',operation_id:pending.operation_id})).status,'running');
   const duplicate=await call('submit_observation',args);assert.equal(duplicate.operation_id,pending.operation_id);assert.equal(calls,2);
   await Promise.all(tasks);
   const result=await call('read_liferpg',{view:'request',operation_id:pending.operation_id});
   assert.equal(result.status,'committed');assert.ok(result.timing.gm_api_ms>=16000);assert.ok(result.timing.total_ms>=result.timing.gm_api_ms);assert.equal(signal.aborted,false);
   const priorCalls=calls;await call('read_liferpg',{view:'game'});assert.equal(calls,priorCalls);
   delay=0;fail=true;
   const failed=await call('interact_with_gm',{kind:'action',request_id:randomUUID(),message:'test failure'});
   assert.equal(failed.status,'failed');assert.equal(failed.error_code,'gm_failed');
   assert.equal((await db.query("select count(*)::int n from jobs where state='queued'")).rows[0].n,0);
  }finally{await client.close();await Promise.all(tasks)}
 }finally{await pg.close()}
});
