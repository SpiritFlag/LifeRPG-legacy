import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { login, mcpClient, testEvent } from '../scripts/client.js';

const config=readConfig({PUBLIC_BASE_URL:'https://history.example',OAUTH_CLIENT_SECRET:'client-'.repeat(8),OWNER_LOGIN_KEY:'owner-'.repeat(8),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'});
let pg,db,app,client,tokens,legacy;
const fetcher=(input,init)=>app(input instanceof Request ? input : new Request(input,init));
const call=async(name,args)=>(await client.callTool({name,arguments:args}));
const update=async(request_key,operations)=>(await call('update_life_events',{request_key,operations}));
const create=(key,fields={})=>({operation:'create',event:{...testEvent,event_key:key,...fields}});
const edit=(event,changes,fields={})=>({operation:'enrich',event_id:event.id,expected_version:event.version,reason:'Confirmed additional facts',evidence:'Synthetic follow-up report',changes,...fields});
const read=async(event_id,fields={})=>(await call('get_life_event',{event_id,...fields})).structuredContent;
const n=async(table)=>(await db.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n;
before(async()=>{
  pg=new PGlite();
  await pg.exec(await readFile(new URL('../migrations/001-experiment.sql',import.meta.url),'utf8'));
  legacy=(await pg.query('INSERT INTO life_events(id,occurred_on,event_key,kind,summary,evidence,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),testEvent.occurred_on,'legacy-event','test',testEvent.summary,testEvent.evidence,'2026-10-01T12:00:00Z'])).rows[0];
  await pg.query('INSERT INTO tool_calls(id,called_at,tool,arguments,outcome,event_id,result) VALUES ($1,now(),$2,$3,$4,$5,$6)',[randomUUID(),'record_life_event','{}','recorded',legacy.id,'{}']);
  await pg.query("INSERT INTO oauth_grants(hash,kind,payload,expires_at) VALUES ('legacy-hash','access','{}',now()+interval '1 hour')");
  await pg.exec(await readFile(new URL('../migrations/002-life-event-history.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/003-gm-growth.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/004-questlines.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/005-character-content.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/006-world-memory.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/007-game-initialization.sql',import.meta.url),'utf8'));
  db={query:(sql,values)=>pg.query(sql,values),transaction:fn=>pg.transaction(tx=>fn({query:(sql,values)=>tx.query(sql,values)}))};
  app=createApp(db,config);
  tokens=(await login(config.base,config,fetcher)).tokens;
  client=await mcpClient(config.base,tokens.access_token,fetcher);
});
after(async()=>{await client?.close();await pg?.close();});

test('additive migration preserves original UUID, evidence, recorded time, audits and grants',async()=>{
  const result=await read(legacy.id);
  for(const field of ['id','summary','evidence','event_key','kind']) assert.equal(result.event[field],legacy[field]);
  assert.equal(new Date(result.event.recorded_at).toISOString(),legacy.recorded_at.toISOString());
  assert.equal(result.event.occurred_on,testEvent.occurred_on);
  assert.equal(result.event.occurred_start,null);
  assert.equal(result.event.reported_at,null);
  assert.equal(result.revisions[0].operation,'import');
  assert.equal(result.revisions[0].report_time_source,'unknown');
  assert.equal(result.revisions[0].reported_at,null);
  assert.equal(result.revisions[0].after_state.id,legacy.id);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM oauth_grants WHERE hash='legacy-hash'")).rows[0].n,1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM tool_calls WHERE event_id=$1 AND outcome='recorded'",[legacy.id])).rows[0].n,1);
  await assert.rejects(db.query('UPDATE life_event_revisions SET evidence=$2 WHERE event_id=$1',[legacy.id,'overwrite']),/append-only/);
  await assert.rejects(db.query('DELETE FROM life_event_aliases WHERE event_id=$1',[legacy.id]),/append-only/);
});

test('three dives reported at different times stay independent; cross-chat enrichment preserves first dive UUID',async()=>{
  const start=await n('life_events');
  const first=(await update('dive-first',[create('dive-1',{facts:['First dive completed'],reported_at:'2026-10-14T15:00:00+09:00',source_ref:'conversation-a/message-1'})])).structuredContent.results[0].event;
  const others=await update('dive-evening',[create('dive-2',{source_ref:'conversation-a/message-2'}),create('dive-3',{source_ref:'conversation-a/message-2'})]);
  assert.equal(others.structuredContent.results.length,2);
  const ids=[first.id,...others.structuredContent.results.map(r=>r.event.id)];
  assert.equal(new Set(ids).size,3);
  assert.equal(await n('life_events'),start+3);
  const enriched=await update('dive-depth',[edit(first,{facts:['Maximum depth 18m'],summary:'First dive, depth 18m'},{source_ref:'conversation-b/message-4',reported_at:'2026-10-14T22:00:00+09:00'})]);
  assert.equal(enriched.structuredContent.results[0].outcome,'enriched');
  assert.equal(enriched.structuredContent.results[0].event.id,first.id);
  const history=await read(first.id);
  assert.deepEqual(history.event.facts,['First dive completed','Maximum depth 18m']);
  assert.equal(history.event.version,2);
  assert.equal(history.event.occurred_start,null);
  assert.equal(new Date(history.event.reported_at).toISOString(),'2026-10-14T06:00:00.000Z');
  assert.equal(new Date(history.revisions[1].reported_at).toISOString(),'2026-10-14T13:00:00.000Z');
  assert.equal(history.revisions[0].source_ref,'conversation-a/message-1');
  assert.equal(history.revisions[1].source_ref,'conversation-b/message-4');
  assert.equal(history.revisions[1].before_state.version,1);
  assert.equal(history.revisions[1].after_state.occurred_on,testEvent.occurred_on);
  assert.ok(history.revisions.every(r=>r.recorded_at));
  const page=await read(first.id,{limit:1});
  assert.equal(page.next_after_version,1);
  assert.equal((await read(first.id,{after_version:page.next_after_version})).revisions[0].version,2);
  const corrected=await update('dive-depth-corrected',[edit(history.event,{facts:['First dive completed','Maximum depth 16m'],summary:'First dive, corrected depth 16m'},{operation:'correct',reason:'User corrected depth 18m to 16m'})]);
  assert.equal(corrected.structuredContent.results[0].event.version,3);
  const correctionHistory=await read(first.id);
  assert.ok(correctionHistory.revisions[2].before_state.facts.includes('Maximum depth 18m'));
  assert.ok(correctionHistory.revisions[2].after_state.facts.includes('Maximum depth 16m'));
  assert.ok(!correctionHistory.event.facts.includes('Maximum depth 18m'));
});

test('correction preserves history and old date/key lookup; old registration cannot resurrect an event',async()=>{
  const first=(await update('wrong-date',[create('wrong-date')])).structuredContent.results[0].event;
  const correction=await update('correct-date',[edit(first,{occurred_on:'2026-10-13',event_key:'corrected-dive',summary:'Corrected factual date'},{operation:'correct',reason:'User corrected the date and distinguishing key'})]);
  const current=correction.structuredContent.results[0].event;
  assert.equal(current.id,first.id);
  assert.equal(current.version,2);
  const old=await call('record_life_event',{...testEvent,event_key:'wrong-date'});
  assert.equal(old.structuredContent.outcome,'duplicate');
  assert.equal(old.structuredContent.event.id,first.id);
  assert.equal(old.structuredContent.event.occurred_on,'2026-10-13');
  const search=await call('list_life_events',{occurred_on:testEvent.occurred_on,event_key:'wrong-date'});
  assert.equal(search.structuredContent.events[0].id,first.id);
  const history=await read(first.id);
  assert.equal(history.aliases.length,2);
  assert.equal(history.revisions[1].before_state.occurred_on,testEvent.occurred_on);
  assert.equal(history.revisions[1].after_state.occurred_on,'2026-10-13');
  const other=(await update('alias-target',[create('alias-target')])).structuredContent.results[0].event;
  const collision=await update('collision',[edit(other,{event_key:'wrong-date'},{operation:'correct'})]);
  assert.equal(collision.structuredContent.outcome,'identity_conflict');
  assert.equal((await read(other.id)).event.version,1);
});

test('unknown occurrence and report times stay null; known instants validate against local date and timezone',async()=>{
  const first=(await update('unknown-first',[create('unknown-first',{occurred_on:null,timezone:null})])).structuredContent.results[0].event;
  assert.equal(first.time_precision,'unknown');
  assert.equal(first.occurred_on,null);
  assert.equal(first.occurred_start,null);
  assert.equal(first.reported_at,null);
  const unknownDuplicate=await update('unknown-duplicate',[create('unknown-first',{occurred_on:null,timezone:null})]);
  assert.equal(unknownDuplicate.structuredContent.results[0].outcome,'duplicate');
  assert.equal(unknownDuplicate.structuredContent.results[0].event.id,first.id);
  const resolved=await update('unknown-resolved',[edit(first,{occurred_on:'2026-10-13',time_precision:'exact',occurred_start:'2026-10-13T10:30:00+09:00',timezone:'Asia/Seoul'})]);
  assert.equal(resolved.isError,false);
  assert.equal((await read(first.id)).revisions[0].report_time_source,'unknown');
  const wrong=await update('timezone-wrong',[create('timezone-wrong',{time_precision:'exact',occurred_start:'2026-10-13T23:00:00Z'})]);
  assert.equal(wrong.isError,false); // Oct 14 in Asia/Seoul, despite UTC date Oct 13.
  const range=await update('time-range',[create('time-range',{time_precision:'range',occurred_start:'2026-10-14T22:00:00+09:00',occurred_end:'2026-10-15T01:00:00+09:00'})]);
  assert.equal(range.isError,false);
  const invalids=[
    {occurred_on:'2026-02-30'},
    {time_precision:'exact',occurred_start:'2026-10-14T10:00:00'},
    {time_precision:'exact',occurred_start:'2026-10-13T00:00:00Z'},
    {time_precision:'range',occurred_start:'2026-10-14T01:00:00Z',occurred_end:'2026-10-14T00:00:00Z'},
    {timezone:'Invented/Zone'},
    {occurred_on:null,time_precision:'date'},
  ];
  for (const [i,fields] of invalids.entries()) assert.equal((await update(`time-invalid-${i}`,[create(`time-invalid-${i}`,fields)])).isError,true);
});

test('retry receipts are stable; same key with different input conflicts; no-change enrichment adds no revision',async()=>{
  const operations=[create('retry-event')];
  const first=await update('retry-key',operations);
  const replay=await update('retry-key',operations);
  assert.equal(replay.structuredContent.outcome,'replayed');
  assert.deepEqual(replay.structuredContent.results,first.structuredContent.results);
  assert.equal((await update('retry-key',[create('different-event')])).structuredContent.outcome,'idempotency_conflict');
  const event=first.structuredContent.results[0].event;
  const unchanged=await update('unchanged',[edit(event,{summary:event.summary})]);
  assert.equal(unchanged.structuredContent.results[0].outcome,'unchanged');
  assert.equal((await read(event.id)).revisions.length,1);
  await assert.rejects(db.query("DELETE FROM life_event_requests WHERE request_key='retry-key'"),/append-only/);
  const duplicate=await update('duplicate-new-key',[create('retry-event')]);
  assert.equal(duplicate.structuredContent.results[0].outcome,'duplicate');
  assert.equal(duplicate.structuredContent.results[0].event.id,event.id);
  const before=await n('life_events');
  const collision=await update('batch-same-event',[create('same-batch-event'),create('same-batch-event')]);
  assert.equal(collision.structuredContent.outcome,'invalid_input');
  assert.equal(await n('life_events'),before);
});

test('parallel duplicate submissions and competing versions cannot add duplicates or overwrite updates',async()=>{
  const initial=await Promise.all([update('parallel-a',[create('parallel')]),update('parallel-b',[create('parallel')])]);
  assert.deepEqual(initial.map(r=>r.structuredContent.results[0].outcome).sort(),['duplicate','recorded']);
  const event=initial[0].structuredContent.results[0].event;
  assert.equal(event.id,initial[1].structuredContent.results[0].event.id);
  const competing=await Promise.all([update('compete-a',[edit(event,{facts:['A']})]),update('compete-b',[edit(event,{facts:['B']})])]);
  assert.deepEqual(competing.map(r=>r.structuredContent.outcome).sort(),['committed','version_conflict']);
  const history=await read(event.id);
  assert.equal(history.event.version,2);
  assert.equal(history.revisions.length,2);
  assert.equal(history.event.facts.length,1);
});

test('a late version/identity error rolls back the entire batch, identities, revisions and retry receipt',async()=>{
  const event=(await update('atomic-initial',[create('atomic-initial')])).structuredContent.results[0].event;
  await update('atomic-enrich',[edit(event,{facts:['new']})]);
  const counts=await Promise.all(['life_events','life_event_aliases','life_event_revisions','life_event_requests'].map(n));
  const failure=await update('atomic-failure',[create('must-roll-back'),edit(event,{summary:'stale'})]);
  assert.equal(failure.structuredContent.outcome,'version_conflict');
  assert.deepEqual(await Promise.all(['life_events','life_event_aliases','life_event_revisions','life_event_requests'].map(n)),counts);
  assert.equal((await read(event.id)).event.version,2);
  assert.equal((await update('must-correct',[edit({...event,version:2},{occurred_on:'2026-10-13'})])).structuredContent.outcome,'correction_required');
});

test('revision or audit failures roll back all facts and receipts; the exact retry can then succeed',async()=>{
  for (const table of ['life_event_revisions','tool_calls']) {
    const operations=[create(`rollback-${table}`),create(`rollback-${table}-2`)];
    const args={request_key:`rollback-${table}`,operations};
    const counts=await Promise.all(['life_events','life_event_aliases','life_event_revisions','life_event_requests'].map(n));
    const failingDb={query:db.query,transaction:fn=>db.transaction(tx=>fn({query:(sql,values)=>{if(sql.startsWith(`INSERT INTO ${table}`)) throw new Error('Injected storage failure');return tx.query(sql,values);}}))};
    const failingApp=createApp(failingDb,config);
    const response=await failingApp(new Request(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${tokens.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'update_life_events',arguments:args}})}));
    assert.equal((await response.json()).result.structuredContent.outcome,'storage_error');
    assert.deepEqual(await Promise.all(['life_events','life_event_aliases','life_event_revisions','life_event_requests'].map(n)),counts);
    assert.equal((await update(args.request_key,operations)).structuredContent.outcome,'committed');
  }
});

test('new tools enforce authentication/scopes, strict shapes, correction reason, missing IDs and bounded audit inputs',async()=>{
  const readTokens=(await login(config.base,config,fetcher,'life.read')).tokens;
  const reader=await mcpClient(config.base,readTokens.access_token,fetcher);
  try { assert.equal((await reader.callTool({name:'update_life_events',arguments:{request_key:'blocked',operations:[create('blocked')]}})).isError,true); } finally {await reader.close();}
  const writeTokens=(await login(config.base,config,fetcher,'life.write')).tokens;
  const writer=await mcpClient(config.base,writeTokens.access_token,fetcher);
  try {assert.equal((await writer.callTool({name:'get_life_event',arguments:{event_id:legacy.id}})).isError,true);} finally {await writer.close();}
  for (const name of ['update_life_events','get_life_event']) {
    const response=await fetcher(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}})});
    assert.equal(response.status,401);
  }
  assert.equal((await update('missing',[edit({id:randomUUID(),version:1},{summary:'missing'})])).structuredContent.outcome,'not_found');
  assert.equal((await update('invalid-secret',[create('invalid-secret',{owner_key:'nested-do-not-log'})])).structuredContent.outcome,'invalid_input');
  const noReason=edit({id:legacy.id,version:1},{summary:'correction'},{operation:'correct'});
  delete noReason.reason;
  assert.equal((await update('no-reason',[noReason])).structuredContent.outcome,'invalid_input');
  assert.equal((await update('too-many',Array.from({length:11},(_,i)=>create(`too-many-${i}`)))).isError,true);
  assert.ok(!JSON.stringify((await db.query('SELECT arguments FROM tool_calls')).rows).includes('nested-do-not-log'));
  const listed=await client.listTools();
  assert.equal(listed.tools.find(t=>t.name==='update_life_events').annotations.destructiveHint,true);
  assert.equal(listed.tools.find(t=>t.name==='update_life_events').annotations.idempotentHint,true);
  assert.equal(listed.tools.find(t=>t.name==='get_life_event').annotations.readOnlyHint,true);
});
