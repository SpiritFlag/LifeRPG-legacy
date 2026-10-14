import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { applyGmUpdate,getGameContext,getGmUpdate } from '../src/growth-storage.js';
import { applyGmSchema,contextSchema } from '../src/growth-schema.js';
import { recordEvent,updateEvents,lockEventWrites,audit } from '../src/storage.js';
import { updateEventsSchema } from '../src/event-schema.js';
import { readPlayer,playerQuerySchema } from '../src/web-data.js';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { login,mcpClient,testEvent } from './client.js';

const target=JSON.parse(await readFile('.local/phase6/connection.json','utf8'));
const uri=new URL(target.url);
if(target.project_id!=='cool-waterfall-23850161' || target.branch_id!=='br-soft-art-a1xx9a51' || target.production_branch===target.branch_id || uri.hostname!=='ep-young-flower-a115sf9a.ap-southeast-1.aws.neon.tech' || uri.pathname!=='/liferpg_experiment' || uri.searchParams.get('sslmode')!=='verify-full') throw new Error('Refusing unverified isolated target');
const resume=process.argv.includes('--resume');
const previous=resume ? JSON.parse(await readFile('.local/phase6/neon-report.json','utf8')) : null;
const run=previous?.run || randomUUID(),report=previous || {run,started_at:new Date().toISOString(),target:{project_id:target.project_id,branch_id:target.branch_id,endpoint_id:target.endpoint_id,expires_at:target.expires_at},checks:[],measurements:{}};
if(resume) {report.checks=report.checks.filter(c=>c.outcome==='passed');delete report.error;report.outcome='resuming';}
const files=['001-experiment','002-life-event-history','003-gm-growth','004-questlines','005-character-content','006-world-memory','007-game-initialization'];
const migration=async n=>readFile(new URL(`../migrations/${files[n-1]}.sql`,import.meta.url),'utf8');
const options={connectionString:uri.href,statement_timeout:10000,connectionTimeoutMillis:10000,application_name:'liferpg-phase6-clone'};
const clone=new pg.Client(options);await clone.connect();
const scratchUri=new URL(uri);scratchUri.pathname='/liferpg_phase6_synthetic';
const pool=new pg.Pool({...options,connectionString:scratchUri.href,max:6,application_name:'liferpg-phase6-synthetic'});
const db={query:(sql,values)=>pool.query(sql,values),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
const check=async(name,fn)=>{if(resume && report.checks.some(c=>c.name===name && c.outcome==='passed')) return;const start=performance.now();try{const details=await fn();report.checks.push({name,outcome:'passed',elapsed_ms:Math.round(performance.now()-start),...(details ? {details} : {})});console.log(JSON.stringify(report.checks.at(-1)));}catch(e){report.checks.push({name,outcome:'failed',code:e.code || e.outcome,message:e.message,elapsed_ms:Math.round(performance.now()-start)});throw e;}finally{await writeFile('.local/phase6/neon-report.json',JSON.stringify(report,null,2));}};
const schema=async c=>(await c.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
const tables=async c=>(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename);
const fingerprint=async(c,table,fields=null)=>{
  assert.match(table,/^[a-z_]+$/);
  const value=fields ? `to_jsonb(t)-ARRAY[${(await schema(c)).filter(x=>x.table_name===table && !fields.includes(x.column_name)).map(x=>`'${x.column_name}'`).join(',')}]::text[]` : 'to_jsonb(t)';
  return (await c.query(`SELECT count(*)::int AS count,md5(COALESCE(string_agg(v::text,'' ORDER BY v::text),'')) AS digest FROM (SELECT ${value} AS v FROM public.${table} t) s`)).rows[0];
};
const allFingerprints=async c=>{const result={};for(const table of await tables(c)) result[table]=await fingerprint(c,table);return result;};
const apply=async(owner,input,source=db)=>source.transaction(tx=>applyGmUpdate(tx,owner,applyGmSchema.parse(input),true));
const context=async(owner,extra={})=>db.transaction(tx=>getGameContext(tx,owner,contextSchema.parse(extra)));
const publicContext=(owner,extra={})=>readPlayer(db,owner,playerQuerySchema.parse(extra));
const event=async(key=randomUUID())=>db.transaction(tx=>recordEvent(tx,{...testEvent,event_key:`phase6-${run}-${key}`}));
const reason='Phase 6 isolated synthetic verification',stats={STR:10,DEX:12,VIT:14,INT:16,CHA:8,LUK:6};
const begin=(key,extra={})=>({mode:'begin_initialization',request_key:key,expected_revision:0,reason,synthetic:true,character:{profile:{name:'Synthetic explorer',species:'Synthetic species',birth:'Synthetic birthplace',background:'Synthetic history',destiny:'Synthetic destiny',gm_notes:'PHASE6_PRIVATE_SENTINEL'},xp_total:300,stats},starting_location:'@start',content_changes:[{operation:'create_definition',ref:'@job',definition_key:'job',kind:'profession',name:'Synthetic profession',reason},{operation:'change_profession',ref:'@owned-job',acquisition_key:'job',definition:'@job',definition_version:1,reason}],world_changes:[{operation:'create_entity',ref:'@world',entity_key:'world',category:'world',kind:'world',name:'Synthetic world',reason},{operation:'create_entity',ref:'@start',entity_key:'start',category:'place',kind:'place',name:'Synthetic starting place',parent:'@world',reason}],...extra});
const next=(draft,mode,key,extra={})=>({mode,request_key:key,reason,initialization_id:draft.initialization.initialization_id,expected_initialization_revision:draft.initialization.revision,...extra});
const outcome=p=>p.then(value=>value.outcome,error=>error.outcome || error.code);
const waitForLock=async pid=>{const until=Date.now()+5000;while(Date.now()<until){const rows=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rows;if(rows.length) return;await new Promise(r=>setTimeout(r,25));}throw new Error('Expected PostgreSQL lock wait not observed');};
let mcp;
try {
  await check('verified direct TLS and distinct branch/database identity',async()=>{
    const identity=(await clone.query("SELECT current_database() AS database,current_user AS role,current_setting('server_version') AS version")).rows[0];
    assert.equal(identity.database,'liferpg_experiment');assert.equal(identity.role,'liferpg_owner');
    const socket=clone.connection.stream;assert.equal(socket.encrypted,true);assert.equal(socket.authorized,true);
    report.identity={...identity,tls:{encrypted:socket.encrypted,authorized:socket.authorized,protocol:socket.getProtocol()}};
    return report.identity;
  });
  const production=JSON.parse(await readFile('.local/phase6/production-inventory.json','utf8'));
  const originalSchema=resume ? production.columns : await schema(clone),originalTables=resume ? production.tables : await tables(clone),original=resume ? production.fingerprints : await allFingerprints(clone);
  await check('production clone matches read-only production fingerprints',async()=>{assert.deepEqual(original,production.fingerprints);assert.deepEqual(originalTables,production.tables);return Object.fromEntries(Object.entries(original).map(([k,v])=>[k,v.count]));});
  await check('001 duplicate apply is unchanged; 002 injected mid-migration failure rolls back DDL and data',async()=>{
    await clone.query(await migration(1));assert.deepEqual(await allFingerprints(clone),original);
    await assert.rejects(clone.query((await migration(2)).replace('COMMIT;','SELECT 1/0; COMMIT;')),e=>e.code==='22012');await clone.query('ROLLBACK');
    assert.deepEqual(await schema(clone),originalSchema);assert.deepEqual(await allFingerprints(clone),original);
  });
  for(let n=2;n<=7;n++) await check(`${files[n-1]} applies on clone, preserves original columns and creates no game`,async()=>{
    await clone.query(await migration(n));
    for(const t of originalTables) assert.deepEqual(await fingerprint(clone,t,originalSchema.filter(x=>x.table_name===t).map(x=>x.column_name)),original[t]);
    if(n>=3) assert.equal((await clone.query('SELECT count(*)::int AS n FROM games')).rows[0].n,0);
    const before=await allFingerprints(clone),schemaBefore=await schema(clone);
    await assert.rejects(clone.query(await migration(n)));await clone.query('ROLLBACK');assert.deepEqual(await schema(clone),schemaBefore);assert.deepEqual(await allFingerprints(clone),before);
  });
  await check('imported reality UUID/evidence/time/aliases and revision snapshots remain exact',async()=>{
    const r=(await clone.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE e.id=r.event_id AND e.evidence=r.evidence AND e.recorded_at=r.recorded_at AND e.version=1 AND r.version=1 AND r.after_state->>'summary'=e.summary AND r.after_state->>'id'=e.id::text AND a.event_id=e.id AND a.event_key=e.event_key AND a.occurred_on=e.occurred_on)::int AS preserved FROM life_events e JOIN life_event_revisions r ON r.event_id=e.id JOIN life_event_aliases a ON a.event_id=e.id`)).rows[0];assert.equal(r.total,6);assert.equal(r.preserved,6);return r;
  });
  // All following writes are against a separate empty synthetic database.
  await check('synthetic database migration chain and request receipt compatibility',async()=>{
    assert.equal((await tables(pool)).length,0);
    for(let n=1;n<=2;n++) await pool.query(await migration(n));
    const request=updateEventsSchema.parse({request_key:`old-event-${run}`,operations:[{operation:'create',event:{...testEvent,event_key:`compat-${run}`}}]});
    const eventReceipt=await db.transaction(tx=>updateEvents(tx,request));
    await pool.query(await migration(3));
    const old={mode:'initialize',request_key:`old-game-${run}`,expected_revision:0,reason,synthetic:true,character:{label:'Legacy synthetic',xp_total:0,stats}};
    const receipt=await apply('experiment-owner',old);
    for(let n=4;n<=7;n++) await pool.query(await migration(n));
    const replay=await apply('experiment-owner',old);assert.equal(replay.outcome,'replayed');assert.equal(replay.update_id,receipt.update_id);
    assert.equal((await db.transaction(tx=>updateEvents(tx,request))).outcome,'replayed');
    assert.equal((await db.transaction(tx=>getGmUpdate(tx,'experiment-owner',{request_key:old.request_key}))).update.update_id,receipt.update_id);
    report.compatibility={event_id:eventReceipt.results[0].event.id,gm_update_id:receipt.update_id};
  });
  await check('independent sessions contend on transaction advisory lock and release at commit',async()=>{
    const a=await pool.connect(),b=await pool.connect();try{
      await a.query('BEGIN');await lockEventWrites(a);await b.query('BEGIN');
      const holderPid=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,waiterPid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;assert.notEqual(holderPid,waiterPid);
      const blocked=lockEventWrites(b);await waitForLock(waiterPid);
      await a.query('COMMIT');await blocked;await b.query('COMMIT');return {holder_pid:holderPid,waiter_pid:waiterPid};
    }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
  });
  await check('same event concurrent recording produces one row/revision and one duplicate',async()=>{
    const key=randomUUID(),results=await Promise.all([event(key),event(key)]);assert.deepEqual(results.map(r=>r.outcome).sort(),['duplicate','recorded']);assert.equal(results[0].event.id,results[1].event.id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM life_event_revisions WHERE event_id=$1',[results[0].event.id])).rows[0].n,1);
  });
  const mainOwner=`phase6-main-${run}`;
  let draft;
  await check('begin competition creates one draft; exact retry survives later preparation',async()=>{
    const a=begin(`begin-a-${run}`),b=begin(`begin-b-${run}`);const results=await Promise.allSettled([apply(mainOwner,a),apply(mainOwner,b)]);const ok=results.find(r=>r.status==='fulfilled');draft=ok.value;
    assert.deepEqual(results.map(r=>r.status==='fulfilled' ? r.value.outcome : r.reason.outcome).sort(),['initialization_in_progress','prepared']);
    const retry=await apply(mainOwner,draft.request_key===a.request_key ? a : b);assert.equal(retry.outcome,'replayed');
  });
  await check('same draft revision prepare competition commits once and finalization competes once',async()=>{
    if(!draft) draft={initialization:(await context(mainOwner)).initialization};
    const changes=[{operation:'create_line',ref:'@story',line_key:'story',title:'Synthetic story',reason}];
    const inputs=[next(draft,'prepare_initialization',`prepare-a-${run}`,{quest_changes:changes}),next(draft,'prepare_initialization',`prepare-b-${run}`,{quest_changes:changes})];
    const results=await Promise.allSettled(inputs.map(input=>apply(mainOwner,input)));assert.deepEqual(results.map(r=>r.status==='fulfilled' ? r.value.outcome : r.reason.outcome).sort(),['initialization_revision_conflict','prepared']);draft=results.find(r=>r.status==='fulfilled').value;
    const finals=await Promise.allSettled([apply(mainOwner,next(draft,'finalize_initialization',`final-a-${run}`)),apply(mainOwner,next(draft,'finalize_initialization',`final-b-${run}`))]);assert.deepEqual(finals.map(r=>r.status==='fulfilled' ? r.value.outcome : r.reason.outcome).sort(),['already_initialized','committed']);
  });
  await check('same game revision GM competition commits once and exact successful replay stays stable',async()=>{
    const current=await context(mainOwner);const base={mode:'advance',expected_revision:current.revision,reason,character_change:{changes:{destiny:'Synthetic later destiny'},reason}};
    const inputs=[{...base,request_key:`gm-a-${run}`},{...base,request_key:`gm-b-${run}`}];
    const results=await Promise.allSettled(inputs.map(input=>apply(mainOwner,input)));assert.deepEqual(results.map(r=>r.status==='fulfilled' ? r.value.outcome : r.reason.outcome).sort(),['committed','revision_conflict']);
    const i=results.findIndex(r=>r.status==='fulfilled'),retry=await apply(mainOwner,inputs[i]);assert.equal(retry.outcome,'replayed');assert.equal(retry.update_id,results[i].value.update_id);
  });
  await check('independent sessions contend on game row lock and release at rollback',async()=>{
    const game=(await context(mainOwner)).game_id,a=await pool.connect(),b=await pool.connect();try{
      await a.query('BEGIN');await a.query('SELECT id FROM games WHERE id=$1 FOR UPDATE',[game]);await b.query('BEGIN');const waiterPid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;const blocked=b.query('SELECT id FROM games WHERE id=$1 FOR UPDATE',[game]);await waitForLock(waiterPid);await a.query('ROLLBACK');await blocked;await b.query('COMMIT');
    }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
  });
  await check('MVCC readers see preparing during uncommitted birth and completed only after commit',async()=>{
    const owner=`phase6-mvcc-${run}`,draft=await apply(owner,begin(`mvcc-${run}`));
    const writer=await pool.connect();try{
      await writer.query('BEGIN');await applyGmUpdate(writer,owner,applyGmSchema.parse(next(draft,'finalize_initialization',`mvcc-final-${run}`)),true);
      const [web,gm]=await Promise.all([publicContext(owner),context(owner)]);assert.equal(web.initialized,false);assert.equal(gm.initialized,false);assert.equal(web.initialization.status,'preparing');assert.equal(gm.character,undefined);
      await writer.query('COMMIT');assert.equal((await publicContext(owner)).initialized,true);
    }finally{await writer.query('ROLLBACK');writer.release();}
  });
  await check('MVCC failed birth rolls back every table; late receipt/audit failure permits exact retry',async()=>{
    const owner=`phase6-rollback-${run}`,draft=await apply(owner,begin(`rollback-${run}`)),input=next(draft,'finalize_initialization',`rollback-final-${run}`);
    for(const prefix of ['INSERT INTO gm_updates','INSERT INTO initialization_requests','INSERT INTO tool_calls']) {
      const source={query:db.query,transaction:fn=>db.transaction(tx=>fn({query:async(sql,values)=>{if(sql.startsWith(prefix)) throw new Error('Injected late persistence failure');return tx.query(sql,values);}}))};
      await assert.rejects(source.transaction(async tx=>{await applyGmUpdate(tx,owner,applyGmSchema.parse(input),true);await audit(tx,{id:randomUUID(),calledAt:new Date().toISOString(),tool:'apply_gm_update',args:{mode:input.mode},outcome:'committed',result:{outcome:'committed'}});}));
      assert.equal((await context(owner)).initialized,false);assert.equal((await pool.query('SELECT count(*)::int AS n FROM games WHERE owner_id=$1',[owner])).rows[0].n,0);
      await assert.rejects(db.transaction(tx=>getGmUpdate(tx,owner,{request_key:input.request_key})),e=>e.outcome==='not_found');
    }
    assert.equal((await apply(owner,input)).outcome,'committed');assert.equal((await apply(owner,input)).outcome,'replayed');
  });
  await check('lock_timeout aborts wait with 55P03, transaction rolls back and same event retries',async()=>{
    const a=await pool.connect(),b=await pool.connect(),key=randomUUID();try{
      await a.query('BEGIN');await lockEventWrites(a);await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='250ms'");
      await assert.rejects(recordEvent(b,{...testEvent,event_key:key}),e=>e.code==='55P03');await assert.rejects(b.query('SELECT 1'),e=>e.code==='25P02');await b.query('ROLLBACK');await a.query('COMMIT');
      assert.equal((await db.transaction(tx=>recordEvent(tx,{...testEvent,event_key:key}))).outcome,'recorded');
    }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
  });
  await check('statement_timeout aborts with 57014, including during birth, then exact finalization retries',async()=>{
    const owner=`phase6-timeout-${run}`,draft=await apply(owner,begin(`timeout-${run}`)),input=next(draft,'finalize_initialization',`timeout-final-${run}`);
    const timed={query:db.query,transaction:fn=>db.transaction(async tx=>{await tx.query("SET LOCAL statement_timeout='250ms'");return fn({query:async(sql,values)=>{if(sql.startsWith('INSERT INTO character_births')) await tx.query('SELECT pg_sleep(1)');return tx.query(sql,values);}});})};
    await assert.rejects(apply(owner,input,timed),e=>e.code==='57014');assert.equal((await context(owner)).initialized,false);assert.equal((await apply(owner,input)).outcome,'committed');
  });
  await check('real Neon web projection removes biography/world GM secrets from focus/history/chronicle',async()=>{
    const c=await context(mainOwner),privateFact={operation:'create_fact',ref:'@secret',fact_key:'secret',kind:'setting',title:'Hidden',body:'PHASE6_PRIVATE_SENTINEL',visibility:'gm',reason};
    await apply(mainOwner,{mode:'advance',request_key:`secret-${run}`,expected_revision:c.revision,reason,world_changes:[privateFact]});
    const web=await publicContext(mainOwner,{include_birth:true,include_character_history:true,include_chronicle:true,dashboard:true});assert.ok(!JSON.stringify(web).includes('PHASE6_PRIVATE_SENTINEL'));assert.equal(web.character_profile.gm_notes,undefined);
    const gm=await context(mainOwner);assert.ok(JSON.stringify(gm.gm_private).includes('PHASE6_PRIVATE_SENTINEL'));
  });
  await check('existing MCP SDK discovery, OAuth PKCE/refresh, scopes and event receipt replay work on actual Neon',async()=>{
    const config=readConfig({PUBLIC_BASE_URL:'https://phase6.example',OAUTH_CLIENT_SECRET:'synthetic-client-'.repeat(4),OWNER_LOGIN_KEY:'synthetic-owner-'.repeat(4),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect',ALLOW_SYNTHETIC_GAME:'true'});
    const app=createApp(db,config),fetcher=(input,init)=>app(input instanceof Request ? input : new Request(input,init));const {tokens}=await login(config.base,config,fetcher);
    mcp=await mcpClient(config.base,tokens.access_token,fetcher);assert.equal((await mcp.listTools()).tools.length,9);assert.equal((await mcp.callTool({name:'get_game_context',arguments:{}})).structuredContent.initialized,true);
    const args={request_key:`mcp-event-${run}`,operations:[{operation:'create',event:{...testEvent,event_key:`mcp-${run}`}}]};assert.equal((await mcp.callTool({name:'update_life_events',arguments:args})).structuredContent.outcome,'committed');assert.equal((await mcp.callTool({name:'update_life_events',arguments:args})).structuredContent.outcome,'replayed');
    const refresh=()=>fetcher(`${config.base}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:config.clientId,client_secret:config.clientSecret,resource:config.resource})});
    assert.equal((await refresh()).status,200);assert.equal((await refresh()).status,400);
    const readOnly=(await login(config.base,config,fetcher,'life.read')).tokens,reader=await mcpClient(config.base,readOnly.access_token,fetcher);try{assert.equal((await reader.callTool({name:'apply_gm_update',arguments:begin(`unauthorized-${run}`)})).structuredContent.outcome,'unauthorized');}finally{await reader.close();}
  });
  await check('initialization finalization measured across several world sizes',async()=>{
    report.measurements.finalize=[];
    for(const size of [0,20,60]) {
      const owner=`phase6-benchmark-${size}-${run}`;let draft=await apply(owner,begin(`benchmark-${size}-${run}`));
      for(let i=0;i<size;i+=20) draft=await apply(owner,next(draft,'prepare_initialization',`benchmark-${size}-${i}-${run}`,{world_changes:Array.from({length:Math.min(20,size-i)},(_,j)=>({operation:'create_entity',ref:`@npc-${i+j}`,entity_key:`npc-${i+j}`,category:'npc',kind:'npc',name:`Synthetic NPC ${i+j}`,parent:'@world',reason}))}));
      const start=performance.now();const result=await apply(owner,next(draft,'finalize_initialization',`benchmark-final-${size}-${run}`));assert.equal(result.outcome,'committed');
      report.measurements.finalize.push({entities:size+2,elapsed_ms:Math.round(performance.now()-start)});
    }
    return report.measurements.finalize;
  });
  await check('copied production events/audit/OAuth remain unchanged after all synthetic tests',async()=>{
    for(const t of originalTables) assert.deepEqual(await fingerprint(clone,t,originalSchema.filter(x=>x.table_name===t).map(x=>x.column_name)),original[t]);
    assert.equal((await clone.query('SELECT count(*)::int AS n FROM games')).rows[0].n,0);
  });
  report.completed_at=new Date().toISOString();report.outcome='passed';
} catch(error) {
  report.outcome='failed';report.error={code:error.code || error.outcome,message:error.message};process.exitCode=1;
  console.error(JSON.stringify({outcome:'failed',code:error.code || error.outcome,message:error.message}));
} finally {
  await mcp?.close();await pool.end();await clone.end();await writeFile('.local/phase6/neon-report.json',JSON.stringify(report,null,2));
}
