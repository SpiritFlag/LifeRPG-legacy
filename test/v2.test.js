import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {scopedDatabase,loadPayload} from '../src/v2/storage.ts';
import {LifeRpgService} from '../src/v2/service.ts';
import {GmWorker} from '../src/v2/worker.ts';
import {MockGm} from '../src/v2/mock-gm.ts';
import {deriveMemory} from '../src/v2/memory.ts';
import {deletionManifest,applyDeletionManifest,openDeletionJournal} from '../src/v2/privacy.ts';
import {setMockBudget} from '../src/v2/admin.ts';
import {createV2App} from '../src/v2/app.ts';
import {V2_SCOPES} from '../src/v2/contracts.ts';
import {readConfig} from '../src/config.js';
import {login,mcpClient} from '../scripts/client.js';

let pg,db;
const sql=(await Promise.all(['001-foundation.sql','003-rpg.sql','004-memory.sql'].map(file=>readFile(new URL(`../migrations/v2/${file}`,import.meta.url),'utf8')))).join('\n');
function adapter(pg) {return scopedDatabase({query:(s,v)=>pg.query(s,v),transaction:fn=>pg.transaction(tx=>fn({query:(s,v)=>tx.query(s,v)}))});}
before(async()=>{pg=new PGlite();await pg.exec(sql);db=adapter(pg);});
after(async()=>{await pg.close();});
function fixture(database=db) {
  const identity={subject:randomUUID(),scopes:V2_SCOPES};
  const service=new LifeRpgService(database);
  const worker=new GmWorker(database,new MockGm());
  const call=(tool,input,who=identity)=>service.execute(tool,input,who);
  const submit=(summary='[synthetic] Walk',extra={})=>call('submit_observation',{request_id:randomUUID(),summary,...extra});
  const result=id=>call('read_liferpg',{view:'request',operation_id:id});
  const game=()=>call('read_liferpg',{view:'game'});
  const start=async()=>{const r=await call('interact_with_gm',{request_id:randomUUID(),kind:'start',message:'Synthetic start'});await worker.runOnce();assert.equal((await result(r.operation_id)).status,'committed');return r;};
  return {identity,service,worker,call,submit,result,game,start};
}
const error=code=>e=>e.code===code;
const expire=claim=>db.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[claim.jobId]);

test('v2 official MCP contract, OAuth isolation, minimal tools and explicit scopes',async()=>{
  const config=readConfig({PUBLIC_BASE_URL:'https://v2.example',OAUTH_CLIENT_SECRET:'client-secret-'.repeat(4),OWNER_LOGIN_KEY:'owner-secret-'.repeat(4),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'});
  const app=createV2App(db,config);
  const fetcher=(url,init)=>app(url instanceof Request?url:new Request(url,init));
  const tokens=(await login(config.base,config,fetcher,V2_SCOPES.join(' '))).tokens;
  const client=await mcpClient(config.base,tokens.access_token,fetcher);
  try {
    const tools=(await client.listTools()).tools;
    assert.deepEqual(tools.map(t=>t.name),['submit_observation','interact_with_gm','read_liferpg','revise_real_record','delete_real_record']);
    assert.ok(tools.every(t=>t.description.length<230 && !t.annotations.openWorldHint));
    const started=await client.callTool({name:'interact_with_gm',arguments:{request_id:randomUUID(),kind:'start',message:'synthetic'}});
    assert.equal(started.structuredContent.status,'queued');
    await new GmWorker(db,new MockGm()).runOnce();
    const r=await client.callTool({name:'submit_observation',arguments:{request_id:randomUUID(),summary:'MCP synthetic'}});
    assert.equal(r.structuredContent.status,'queued');
    await new GmWorker(db,new MockGm()).runOnce();
    const receipt=await client.callTool({name:'read_liferpg',arguments:{view:'request',operation_id:r.structuredContent.operation_id}});
    assert.equal(receipt.structuredContent.status,'committed');
    const legacy=await client.callTool({name:'apply_gm_update',arguments:{}});
    assert.equal(legacy.structuredContent.error_code,'unknown_tool');
    const forbiddenTokens=(await login(config.base,config,fetcher,'life.read life.write')).tokens;
    const restricted=await mcpClient(config.base,forbiddenTokens.access_token,fetcher);
    try {assert.equal((await restricted.callTool({name:'submit_observation',arguments:{request_id:randomUUID(),summary:'synthetic'}})).structuredContent.error_code,'forbidden');}
    finally {await restricted.close();}
  } finally {await client.close();}
});

test('read-only calls do not create a game; ownership and input contracts fail closed',async()=>{
  const f=fixture();
  await f.game();
  assert.equal((await db.query('SELECT 1 FROM games WHERE owner_id=$1',[f.identity.subject])).rows.length,0);
  await assert.rejects(()=>f.submit('bad',{xp_delta:999}),error('invalid_input'));
  await assert.rejects(()=>f.submit('bad',{occurred_on:'2026-02-30'}),error('invalid_input'));
  const r=await f.submit();
  await assert.rejects(()=>fixture().result(r.operation_id),error('not_found'));
  await assert.rejects(()=>fixture().call('delete_real_record',{request_id:randomUUID(),event_ids:r.event_ids}),error('not_found'));
  // Drain unstarted observation into blocked state so other fixtures can claim work.
  await f.worker.runOnce();
});

test('idempotency is persistent; same key/different input conflicts and exact observations cannot duplicate rewards',async()=>{
  const f=fixture();await f.start();
  const input={request_id:randomUUID(),summary:'[synthetic] same fact'};
  const [a,b]=await Promise.all([f.call('submit_observation',input),f.call('submit_observation',input)]);
  assert.equal(a.operation_id,b.operation_id);
  await assert.rejects(()=>f.call('submit_observation',{...input,summary:'different'}),error('idempotency_conflict'));
  await f.worker.runOnce();
  const replay=await new LifeRpgService(db).execute('submit_observation',input,f.identity);
  assert.equal(replay.status,'committed');
  const duplicate=await f.submit(input.summary);
  assert.equal(duplicate.status,'no_change');
  assert.equal((await f.game()).xp,5);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM reward_entitlements WHERE owner_id=$1',[f.identity.subject])).rows[0].n,1);
});

test('worker lease recovery fences late responses and applies effects only once',async()=>{
  const f=fixture();await f.start();const r=await f.submit();
  const old=await f.worker.claim();assert.ok(old);
  assert.equal(await new GmWorker(db,new MockGm()).claim(),null);
  await expire(old);
  const fresh=await new GmWorker(db,new MockGm()).claim();assert.ok(fresh.fencing>old.fencing);
  const gm=new MockGm();
  assert.equal((await f.worker.complete(old,await gm.generate(old.context,new AbortController().signal))).status,'discarded');
  await f.worker.complete(fresh,await gm.generate(fresh.context,new AbortController().signal));
  assert.equal((await f.result(r.operation_id)).status,'committed');
  assert.equal((await f.game()).xp,5);
});

test('correction is immediate without game permission, invalidates old text and late GM output',async()=>{
  const f=fixture();await f.start();const r=await f.submit('[synthetic] incorrect secret marker');
  const claim=await f.worker.claim();
  const corrected=await f.call('revise_real_record',{request_id:randomUUID(),event_id:r.event_ids[0],expected_version:1,summary:'[synthetic] corrected'}, {...f.identity,scopes:['life.write']});
  assert.equal(corrected.event_version,2);
  await f.worker.complete(claim,await new MockGm().generate(claim.context,new AbortController().signal));
  assert.equal((await f.result(r.operation_id)).status,'invalidated');
  assert.equal((await f.game()).xp,0);
  const records=await f.call('read_liferpg',{view:'records'});
  assert.equal(records.records[0].body.summary,'[synthetic] corrected');
  assert.equal((await db.query("SELECT 1 FROM payloads WHERE owner_id=$1 AND body::text LIKE '%incorrect secret marker%'",[f.identity.subject])).rows.length,0);
  await assert.rejects(()=>f.call('revise_real_record',{request_id:randomUUID(),event_id:r.event_ids[0],expected_version:1,summary:'stale'}),error('event_version_conflict'));
});

test('deletion purges transitive memory/identity/receipts and cannot replay old input or model output',async()=>{
  const f=fixture();await f.start();const r=await f.submit('[synthetic] ERASE-ME');await f.worker.runOnce();
  const receipt=await f.result(r.operation_id);
  const original=(await db.query('SELECT payload_id FROM decisions WHERE id=$1',[receipt.decision_id])).rows[0].payload_id;
  const summary=await deriveMemory(db,f.identity.subject,{kind:'summary',text:'ERASE-ME second generation',source_payload_ids:[original]});
  const identity=await deriveMemory(db,f.identity.subject,{kind:'identity',text:'ERASE-ME third generation',source_payload_ids:[summary.payload_id]});
  const action=await f.call('interact_with_gm',{request_id:randomUUID(),kind:'action',message:'Synthetic next scene'});
  const pending=await f.worker.claim();assert.ok(pending.roots.includes(r.event_ids[0]));
  const input={request_id:randomUUID(),event_ids:r.event_ids};
  const d=await f.call('delete_real_record',input,{...f.identity,scopes:['life.delete']});
  assert.equal(d.deletion.live_status,'live_purged');assert.equal(d.deletion.backup_status,'not_verified');
  assert.equal((await f.call('delete_real_record',input)).operation_id,d.operation_id);
  await f.worker.complete(pending,await new MockGm().generate(pending.context,new AbortController().signal));
  assert.equal((await f.result(action.operation_id)).status,'deleted');
  assert.equal((await f.result(r.operation_id)).player_result,undefined);
  assert.equal(await loadPayload(db,f.identity.subject,identity.payload_id),null);
  assert.equal((await f.call('read_liferpg',{view:'records'})).records.length,0);
  assert.equal((await db.query("SELECT 1 FROM payloads WHERE owner_id=$1 AND body::text LIKE '%ERASE-ME%'",[f.identity.subject])).rows.length,0);
  assert.equal((await db.query('SELECT input_hash FROM requests WHERE id=$1',[r.operation_id])).rows[0].input_hash,null);
  assert.equal((await f.game()).xp,5); // abstract game effects survive for later reinterpretation
  assert.equal((await f.game()).reinterpretation_pending,1);
  await assert.rejects(()=>f.submit('new auto report'),error('automatic_capture_paused'));
  const explicit=await f.submit('new explicitly requested fact',{confirmed_new_report:true});assert.equal(explicit.status,'queued');
  await f.worker.runOnce();
});

test('questions resume once, expire on deletion, and appeals do not re-award base XP',async()=>{
  const f=fixture();await f.start();const r=await f.submit('synthetic uncertain',{unknowns:['duration']});await f.worker.runOnce();
  const pending=await f.result(r.operation_id);assert.equal(pending.status,'needs_input');
  const input={request_id:randomUUID(),kind:'answer',question_id:pending.question.question_id,message:'30 minutes'};
  const answer=await f.call('interact_with_gm',input);
  assert.equal((await f.call('interact_with_gm',input)).operation_id,answer.operation_id);
  await assert.rejects(()=>f.call('interact_with_gm',{...input,request_id:randomUUID()}),error('question_not_open'));
  await f.worker.runOnce();
  const decision=await f.result(answer.operation_id);
  assert.equal((await f.result(r.operation_id)).status,'committed');
  const appeal=await f.call('interact_with_gm',{request_id:randomUUID(),kind:'appeal',decision_id:decision.decision_id,message:'Please reconsider'});
  await f.worker.runOnce();assert.equal((await f.result(appeal.operation_id)).status,'no_change');assert.equal((await f.game()).xp,5);
  const other=await f.submit('another uncertain',{unknowns:['time']});await f.worker.runOnce();const question=(await f.result(other.operation_id)).question;
  await f.call('delete_real_record',{request_id:randomUUID(),event_ids:other.event_ids});
  await assert.rejects(()=>f.call('interact_with_gm',{request_id:randomUUID(),kind:'answer',question_id:question.question_id,message:'answer'}),error('question_not_open'));
});

test('invalid output and timeout consume bounded attempts; budget is reserved, unknown cost is retained',async()=>{
  const f=fixture();await f.start();await db.query('UPDATE games SET budget_limit=1 WHERE owner_id=$1',[f.identity.subject]);
  const r=await f.submit();
  const claim=await f.worker.claim();await f.worker.fail(claim);
  await db.query("UPDATE jobs SET available_at=clock_timestamp() WHERE id=$1",[claim.jobId]);
  await f.worker.runOnce();assert.equal((await f.result(r.operation_id)).status,'blocked_budget');
  assert.equal((await f.call('read_liferpg',{view:'usage'})).models[0].outstanding,'1');
  // Deletion is independent of exhausted budget and game.play scope.
  await f.call('delete_real_record',{request_id:randomUUID(),event_ids:r.event_ids},{...f.identity,scopes:['life.delete']});
  const g=fixture();await g.start();const invalid=await g.submit();
  for(let i=0;i<3;i++) {
    const c=await g.worker.claim();assert.ok(c);
    await g.worker.complete(c,{proposal:{outcome:'commit',summary:'bad',xp_delta:Infinity},usage:{cost:0,input_tokens:0,output_tokens:0}});
    await db.query('UPDATE jobs SET available_at=clock_timestamp() WHERE id=$1',[c.jobId]);
  }
  assert.equal((await g.result(invalid.operation_id)).status,'failed');assert.equal((await g.game()).xp,0);
  const h=fixture();await h.start();const hung=await h.submit();
  const hanging={model:'mock-v2',maxCost:1,generate:()=>new Promise(()=>{})};
  await new GmWorker(db,hanging,{timeoutMs:5}).runOnce();assert.equal((await h.result(hung.operation_id)).error_code,'gm_timeout');
  await h.call('delete_real_record',{request_id:randomUUID(),event_ids:hung.event_ids});
});

test('commit failure rolls back decision, XP, memory and receipt; persisted claim can be retried',async()=>{
  const f=fixture();await f.start();const r=await f.submit();const claim=await f.worker.claim();
  const broken={...db,transaction:fn=>db.transaction(tx=>fn({query:(s,v)=>s.startsWith('INSERT INTO memories')?Promise.reject(new Error('synthetic disk failure')):tx.query(s,v)}))};
  await assert.rejects(()=>new GmWorker(broken,new MockGm()).complete(claim,{proposal:{outcome:'commit',summary:'synthetic',xp_delta:5,memories:[{kind:'episode',text:'synthetic'}]},usage:{cost:0,input_tokens:0,output_tokens:0}}));
  assert.equal((await f.game()).xp,0);assert.equal((await f.result(r.operation_id)).status,'running');
  await expire(claim);await f.worker.runOnce();assert.equal((await f.result(r.operation_id)).status,'committed');assert.equal((await f.game()).xp,5);
});

test('disk-backed jobs and deletion tombstones survive a full database reopen',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'liferpg-v2-test-'));
  let disk;
  try {
    disk=new PGlite(dir);await disk.exec(sql);let database=adapter(disk);const f=fixture(database);await f.start();const r=await f.submit('persistent synthetic');
    await disk.close();disk=new PGlite(dir);database=adapter(disk);
    await new GmWorker(database,new MockGm()).runOnce();
    const service=new LifeRpgService(database);
    assert.equal((await service.execute('read_liferpg',{view:'request',operation_id:r.operation_id},f.identity)).status,'committed');
    await service.execute('delete_real_record',{request_id:randomUUID(),event_ids:r.event_ids},f.identity);
    await disk.close();disk=new PGlite(dir);database=adapter(disk);
    assert.equal((await new LifeRpgService(database).execute('read_liferpg',{view:'request',operation_id:r.operation_id},f.identity)).status,'deleted');
  } finally {
    await disk?.close();
    const target=resolve(dir),parent=resolve(tmpdir());
    if(!target.startsWith(parent+ '\\') && !target.startsWith(parent+'/')) throw new Error('Unsafe test cleanup');
    await rm(target,{recursive:true,force:true});
  }
});

test('separate deletion manifest scrubs an older restored snapshot before it can be served',async()=>{
  const f=fixture();await f.start();const r=await f.submit('RESTORE-MUST-NOT-RETURN');await f.worker.runOnce();
  // Model an old backup using PGlite's SQL dump, not a live production copy.
  const dump=await pg.dumpDataDir();
  await f.call('delete_real_record',{request_id:randomUUID(),event_ids:r.event_ids});
  const manifest=await deletionManifest(db);
  const restored=await PGlite.create({loadDataDir:dump});
  try {
    const backup=adapter(restored);
    assert.ok((await backup.query("SELECT 1 FROM payloads WHERE body::text LIKE '%RESTORE-MUST-NOT-RETURN%'" )).rows.length);
    await applyDeletionManifest(backup,manifest);
    assert.equal((await backup.query("SELECT 1 FROM payloads WHERE body::text LIKE '%RESTORE-MUST-NOT-RETURN%'" )).rows.length,0);
    assert.equal((await new LifeRpgService(backup).execute('read_liferpg',{view:'request',operation_id:r.operation_id},f.identity)).status,'deleted');
  } finally {await restored.close();}
});

test('local deletion journal fails closed if missing; acknowledgment waits for durable tombstones',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'liferpg-v2-journal-'));const file=join(dir,'deletions.json');
  try {
    await assert.rejects(()=>openDeletionJournal(db,file,false),/keep API and worker stopped/);
    const journal=await openDeletionJournal(db,file,true);
    const f=fixture();await f.start();const r=await f.submit('journal synthetic');await f.worker.runOnce();
    const service=new LifeRpgService(db,journal.sync);
    await service.execute('delete_real_record',{request_id:randomUUID(),event_ids:r.event_ids},f.identity);
    const recorded=JSON.parse(await readFile(file,'utf8'));
    assert.ok(recorded.owners.find(o=>o.owner_id===f.identity.subject).event_ids.includes(r.event_ids[0]));
    assert.equal(JSON.stringify(recorded).includes('journal synthetic'),false);
  } finally {
    const target=resolve(dir),parent=resolve(tmpdir());
    if(!target.startsWith(parent+'\\') && !target.startsWith(parent+'/')) throw new Error('Unsafe journal cleanup');
    await rm(target,{recursive:true,force:true});
  }
});

test('budget changes are operator-only and can resume blocked jobs; read privacy scopes are enforced',async()=>{
  const f=fixture();await f.start();await setMockBudget(db,f.identity.subject,0);
  const r=await f.submit('budget synthetic');await f.worker.runOnce();
  assert.equal((await f.result(r.operation_id)).status,'blocked_budget');
  await setMockBudget(db,f.identity.subject,10);await f.worker.runOnce();
  assert.equal((await f.result(r.operation_id)).status,'committed');
  await assert.rejects(()=>f.call('read_liferpg',{view:'request',operation_id:r.operation_id},{...f.identity,scopes:['game.read']}),error('forbidden'));
  await assert.rejects(()=>f.call('submit_observation',{request_id:randomUUID(),summary:'synthetic',budget_limit:100}),error('invalid_input'));
});

test('clarification keeps its target event separate from inherited memory provenance',async()=>{
  const f=fixture();await f.start();const first=await f.submit('first synthetic activity');await f.worker.runOnce();
  const second=await f.submit('second synthetic activity',{unknowns:['duration']});await f.worker.runOnce();
  const q=(await f.result(second.operation_id)).question;
  const answer=await f.call('interact_with_gm',{request_id:randomUUID(),kind:'answer',question_id:q.question_id,message:'confirmed duration'});
  assert.deepEqual(answer.event_ids,second.event_ids);
  const claim=await f.worker.claim();assert.ok(claim.roots.includes(first.event_ids[0]) && claim.roots.includes(second.event_ids[0]));
  await f.worker.complete(claim,await new MockGm().generate(claim.context,new AbortController().signal));
  assert.equal((await f.game()).xp,10);
  assert.equal((await db.query('SELECT event_id FROM decisions WHERE request_id=$1',[answer.operation_id])).rows[0].event_id,second.event_ids[0]);
});
