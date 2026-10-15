import {before,beforeEach,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {scopedDatabase,savePayload} from '../src/v2/storage.ts';
import {LifeRpgService} from '../src/v2/service.ts';
import {GmWorker} from '../src/v2/worker.ts';
import {MockGm} from '../src/v2/mock-gm.ts';
import {OpenAiGm} from '../src/v2/openai-gm.ts';
import {readOpenAiConfig} from '../src/v2/openai-config.ts';
import {V2_SCOPES} from '../src/v2/contracts.ts';
import {memoryProposal} from '../src/v2/memory-contracts.ts';
import {commitMemories,deriveMemory} from '../src/v2/memory.ts';
import {deletionManifest,applyDeletionManifest} from '../src/v2/privacy.ts';

let pg,db;
before(async()=>{
  pg=new PGlite();for(const file of ['001-foundation.sql','002-openai-accounting.sql','003-rpg.sql','004-memory.sql'])await pg.exec(await readFile(new URL(`../migrations/v2/${file}`,import.meta.url),'utf8'));
  db=scopedDatabase({query:(s,v)=>pg.query(s,v),transaction:fn=>pg.transaction(tx=>fn({query:(s,v)=>tx.query(s,v)}))});
});
beforeEach(()=>db.query('TRUNCATE games CASCADE'));
after(()=>pg.close());
const mem=(kind,text,extra={})=>memoryProposal.parse({kind,text,...extra});
const proposal=(memories=[],operations=[])=>({outcome:'commit',summary:'private',xp_delta:0,memories,operations,scene:null,reward_source:null});
const reply=p=>({proposal:p,usage:{input_tokens:0,output_tokens:0,cost:0}});
const put=(ref,body)=>({op:'put',ref,expected_version:0,body,visibility:'public',private_notes:null});
const npc=(ref,name)=>put(ref,{kind:'npc',name,description:'synthetic',parent:null});
function fixture(gm=new MockGm()) {
  const identity={subject:randomUUID(),scopes:V2_SCOPES},service=new LifeRpgService(db),worker=new GmWorker(db,gm);
  const call=(name,input)=>service.execute(name,input,identity),result=id=>call('read_liferpg',{view:'request',operation_id:id});
  const queue=(kind='action',message='[SYNTHETIC] 다음 장면')=>call(kind==='observation'?'submit_observation':'interact_with_gm',kind==='observation'?{request_id:randomUUID(),summary:message}:{request_id:randomUUID(),kind,message});
  const start=async()=>{const r=await queue('start');await worker.runOnce();assert.equal((await result(r.operation_id)).status,'committed');};
  const turn=async(p,kind='action',message)=>{const r=await queue(kind,message),c=await worker.claim();assert.ok(c);await worker.complete(c,reply(p));return {c,r,result:await result(r.operation_id)};};
  return {identity,worker,call,result,queue,start,turn};
}
const offlineOpenAi=()=>new OpenAiGm(readOpenAiConfig({}),async()=>{throw new Error('No transport is permitted in memory campaign');});

test('80-turn campaign with 1000 old episodes preserves canon/identity across model swap and fits unchanged OpenAI bounds',async t=>{
  const sizing=offlineOpenAi(),contexts=[];let turns=0,summaries=0;
  const gm={model:'mock-campaign-a',maxCost:1,fitsContext:c=>sizing.fitsContext(c),async generate(c,signal){
    assert.ok(sizing.fitsContext(c));contexts.push(Buffer.byteLength(JSON.stringify(c)));
    if(c.kind==='start') {
      const r=await new MockGm().generate(c,signal);
      r.proposal.memories=[mem('identity','로안: 꾸준함과 독립적인 판단을 중시한다.'),
        mem('world','등불의 불꽃은 푸른색이다.',{claim_type:'canon',importance:3}),
        mem('world','PRIVATE-PLOT: 우물 아래의 잠든 용.',{claim_type:'canon',importance:3,unresolved:true})];return r;
    }
    turns++;assert.ok(c.memories.some(m=>m.kind==='identity'&&m.body.text.includes('로안')));
    assert.ok(c.memories.some(m=>m.body.text.includes('푸른색')));assert.ok(c.memories.some(m=>m.unresolved));
    assert.equal(c.events.length,1);assert.equal(c.events[0].claim_type,'reported_fact');
    assert.ok(c.context_omissions.memories>=950);
    const memories=[mem('episode',`합성 모험 ${turns}의 의미`,{importance:1})];
    if(turns%10===0)memories.push(mem('reflection',`판단 성찰 ${turns}: 결과보다 꾸준함을 살핀다.`),
      mem('identity',`로안: 꾸준함과 독립 판단, 개정 ${turns}.`,{reason:'누적 모험의 성찰을 채택한다.'}));
    const sources=c.memories.filter(m=>m.kind==='episode'||m.kind==='summary').slice(0,2);
    if(turns%8===0&&sources.length) {summaries++;memories.push(mem('summary','모험의 의미를 꾸준함의 관점으로 돌아본다.',{source_memory_ids:sources.map(m=>m.id),importance:2}));}
    return reply({...proposal(memories,[...Array.from({length:3},(_,i)=>npc(`@n${i}`,`기록관-${turns}-${i}`)),{op:'advance_time',ticks:1}]),xp_delta:1});
  }};
  const f=fixture(gm);await f.start();
  await db.transaction(async tx=>{
    await tx.query("INSERT INTO payloads(id,owner_id,kind,body) SELECT gen_random_uuid(),$1,'noise',jsonb_build_object('text','무관한 옛 대화 '||n,'entity_ids','[]'::jsonb) FROM generate_series(1,1000) n",[f.identity.subject]);
    await tx.query("INSERT INTO memories(id,owner_id,kind,payload_id,importance) SELECT gen_random_uuid(),owner_id,'episode',id,0 FROM payloads WHERE owner_id=$1 AND kind='noise'",[f.identity.subject]);
  });
  for(let i=1;i<=80;i++) {
    if(i===41)gm.model='mock-campaign-b';
    const r=await f.queue('observation',`[SYNTHETIC] 산책 완료 ${i}`);await f.worker.runOnce();
    const result=await f.result(r.operation_id);assert.equal(result.status,'committed',JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes('PRIVATE-PLOT'));
  }
  const game=await f.call('read_liferpg',{view:'game'});assert.equal(game.xp,80);assert.equal(game.world_tick,80);assert.equal(game.entities.length,242);
  assert.ok(!JSON.stringify(game).includes('PRIVATE-PLOT'));assert.ok(summaries>=8);
  const identity=(await db.query("SELECT version,previous_identity FROM memories WHERE owner_id=$1 AND kind='identity' AND active",[f.identity.subject])).rows[0];
  assert.equal(identity.version,9);assert.ok(identity.previous_identity);
  const attempts=(await db.query('SELECT model,context_manifest FROM attempts WHERE owner_id=$1 ORDER BY created_at',[f.identity.subject])).rows;
  assert.equal(attempts.length,81);assert.equal(new Set(attempts.map(a=>a.model)).size,2);
  assert.ok(attempts.every(a=>a.context_manifest.policy==='memory-v1'));
  assert.ok(attempts.at(-1).context_manifest.omissions.entities>200);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM memory_sources WHERE owner_id=$1 AND role=\'summary\'',[f.identity.subject])).rows[0].n>0,true);
  t.diagnostic(JSON.stringify({turns:80,entities:242,initial_noise_memories:1000,summary_turns:summaries,identity_versions:9,context_bytes_min:Math.min(...contexts),context_bytes_max:Math.max(...contexts),max_provenance_events:Math.max(...attempts.map(a=>a.context_manifest.event_versions.length)),gm_calls:81,paid_calls:0}));
});

test('retrieves an old named NPC, its place and linked memory ahead of unrelated recent chatter',async()=>{
  const f=fixture();await f.start();await f.turn(proposal([mem('world','분실된 열쇠를 찾는 중이다.',{entity_ids:['@keeper'],unresolved:true})],[npc('@keeper','단풍파수꾼')]));
  for(let i=0;i<25;i++)await deriveMemory(db,f.identity.subject,{kind:'episode',text:`무관한 최근 대화 ${i}`,source_payload_ids:[]});
  await f.queue('action','단풍파수꾼과 열쇠에 관해 이야기한다.');const c=await f.worker.claim();
  assert.ok(c.context.rpg.entities.some(e=>e.body?.name==='단풍파수꾼'));assert.ok(c.context.memories.some(m=>m.body.text.includes('열쇠')));
});

test('summary links original memories, inherits roots, and never promotes an NPC claim into canon',async()=>{
  const f=fixture();await f.start();await f.turn(proposal([mem('world','NPC는 달이 초록색이라고 주장한다.',{claim_type:'npc_claim',entity_ids:['@witness']})],[npc('@witness','증언자')]));
  await f.queue();const c=await f.worker.claim(),source=c.selectedMemories.find(m=>m.claim_type==='npc_claim');
  await f.worker.complete(c,reply(proposal([mem('summary','달은 초록색이다.',{claim_type:'canon',source_memory_ids:[source.id]})],[npc('@bad','부분 저장 금지')])));
  assert.equal((await f.result(c.requestId)).error_code,'summary_claim_promotion');
  assert.ok(!(await f.call('read_liferpg',{view:'game'})).entities.some(e=>e.name==='부분 저장 금지'));
});

test('canonical memory revision resolves a plot, retains history, and invalid identity evolution changes no game state',async()=>{
  const f=fixture();await f.start();await f.turn(proposal([mem('world','숨겨진 문은 닫혀 있다.',{claim_type:'canon',unresolved:true,importance:3})]));
  await f.queue();const c=await f.worker.claim(),old=c.selectedMemories.find(m=>m.unresolved);
  await f.worker.complete(c,reply(proposal([mem('world','숨겨진 문이 열렸다.',{claim_type:'canon',replaces_memory_id:old.id,importance:3})])));
  assert.equal((await db.query('SELECT active FROM memories WHERE id=$1',[old.id])).rows[0].active,false);
  assert.ok((await db.query('SELECT body FROM payloads WHERE id=$1',[old.payload_id])).rows.length);
  const failed=await f.turn(proposal([mem('identity','무조건 플레이어를 칭찬한다.')],[{op:'advance_time',ticks:10}]));
  assert.equal(failed.result.error_code,'identity_reflection_required');assert.equal((await f.call('read_liferpg',{view:'game'})).world_tick,0);
});

test('correction/deletion remove summaries, reflections and adopted identity; restored backup cannot revive them',async()=>{
  const f=fixture();await f.start();const marker='PRIVATE-SOURCE-ERASE';
  const first=await f.turn(proposal([mem('episode',marker)]),'observation',marker);
  const source=(await db.query("SELECT payload_id FROM memories WHERE owner_id=$1 AND kind='episode'",[f.identity.subject])).rows[0];
  const summary=await deriveMemory(db,f.identity.subject,{kind:'summary',text:`summary ${marker}`,source_payload_ids:[source.payload_id]});
  await deriveMemory(db,f.identity.subject,{kind:'reflection',text:`reflection ${marker}`,source_payload_ids:[summary.payload_id]});
  await f.turn(proposal([mem('reflection',`adoption ${marker}`),mem('identity',`로안 ${marker}`,{reason:'합성 성찰을 채택한다.'})]));
  const backup=await pg.dumpDataDir();
  await f.call('revise_real_record',{request_id:randomUUID(),event_id:first.r.event_ids[0],expected_version:1,summary:'[SYNTHETIC] corrected'});
  assert.ok(!JSON.stringify((await db.query('SELECT body FROM payloads')).rows).includes(marker));
  await f.call('delete_real_record',{request_id:randomUUID(),event_ids:first.r.event_ids});
  await f.queue();const c=await f.worker.claim();assert.equal(c.context.memory_status.identity,'erased');assert.ok(!JSON.stringify(c.context).includes(marker));
  const restored=await PGlite.create({loadDataDir:backup});
  try {
    const old=scopedDatabase({query:(s,v)=>restored.query(s,v),transaction:fn=>restored.transaction(tx=>fn({query:(s,v)=>tx.query(s,v)}))});
    await applyDeletionManifest(old,await deletionManifest(db));
    assert.ok(!JSON.stringify((await old.query('SELECT body FROM payloads')).rows).includes(marker));
    assert.equal((await old.query("SELECT count(*)::int AS n FROM memories WHERE kind='identity' AND active")).rows[0].n,0);
  } finally {await restored.close();}
});

test('another owner memory ID cannot be cited',async()=>{
  const f=fixture(),other=fixture();await f.start();await other.start();
  const foreign=(await db.query('SELECT id FROM memories WHERE owner_id=$1',[other.identity.subject])).rows[0].id;
  const invalid=await f.turn(proposal([mem('summary','invented source',{source_memory_ids:[foreign]})]));
  assert.equal(invalid.result.error_code,'memory_source_unavailable');
});

test('sixty provenance sources stay erasable without sending sixty old real reports',async()=>{
  const f=fixture();await f.start();const roots=[],payloadIds=[];
  await db.transaction(async tx=>{
    for(let i=0;i<60;i++) {
      const id=randomUUID();roots.push(id);await tx.query('INSERT INTO events(id,owner_id) VALUES($1,$2)',[id,f.identity.subject]);
      const p=await savePayload(tx,f.identity.subject,'real_event',{summary:`HISTORICAL-RAW-${i}`},[id]);payloadIds.push(p);
      await tx.query('INSERT INTO event_versions(owner_id,event_id,version,payload_id) VALUES($1,$2,1,$3)',[f.identity.subject,id,p]);
    }
    await commitMemories(tx,f.identity.subject,[mem('summary','오래된 모험을 짧게 돌아본다.',{importance:3})],{roots,sources:[],entityIds:[],payloadIds,internal:true});
  });
  await f.queue();const c=await f.worker.claim();assert.equal(c.roots.length,60);assert.equal(c.eventVersions.length,60);
  assert.equal(c.context.events.length,0);assert.ok(!JSON.stringify(c.context).includes('HISTORICAL-RAW'));
  assert.ok(c.context.memories.some(m=>m.kind==='summary'));
  await f.worker.complete(c,reply(proposal([mem('reflection','DEPENDENT-REFLECTION')])));
  await f.call('delete_real_record',{request_id:randomUUID(),event_ids:[roots[30]]});
  assert.ok(!JSON.stringify((await db.query('SELECT body FROM payloads')).rows).includes('DEPENDENT-REFLECTION'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM events WHERE deleted_at IS NULL')).rows[0].n,59);
});

test('required input overflow fails before reserving cost or calling GM',async()=>{
  let calls=0;const gm={model:'bounded-mock',maxCost:1,fitsContext:()=>false,async generate(){calls++;return reply(proposal());}};
  const f=fixture(gm),r=await f.queue('start');assert.equal(await f.worker.runOnce(),false);
  assert.equal((await f.result(r.operation_id)).error_code,'required_context_limit');assert.equal(calls,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM attempts')).rows[0].n,0);
});

test('a memory cited by ID remains mandatory even outside the recent candidate window',async()=>{
  const f=fixture();await f.start();const old=await deriveMemory(db,f.identity.subject,{kind:'episode',text:'OLD-TARGET-MEMORY',source_payload_ids:[]});
  await db.transaction(async tx=>{
    await tx.query("INSERT INTO payloads(id,owner_id,kind,body) SELECT gen_random_uuid(),$1,'noise',jsonb_build_object('text','recent noise '||n) FROM generate_series(1,250) n",[f.identity.subject]);
    await tx.query("INSERT INTO memories(id,owner_id,kind,payload_id) SELECT gen_random_uuid(),owner_id,'episode',id FROM payloads WHERE owner_id=$1 AND kind='noise'",[f.identity.subject]);
  });
  await f.queue('action',`이 기억을 검토한다: ${old.id}`);const c=await f.worker.claim();
  assert.ok(c.context.memories.some(m=>m.id===old.id&&m.body.text==='OLD-TARGET-MEMORY'));
});

test('omitted RPG entities cannot be changed by guessing a valid same-owner ID',async()=>{
  const f=fixture();await f.start();await f.turn(proposal([],Array.from({length:20},(_,i)=>npc(`@n${i}`,`별도 인물 ${i}`))));
  f.worker.gm.fitsContext=c=>Buffer.byteLength(JSON.stringify(c))<1800;
  const all=(await f.call('read_liferpg',{view:'game'})).entities;
  await f.queue();const c=await f.worker.claim();assert.ok(c.context.context_omissions.entities>0);
  const unseen=all.find(e=>!c.entityIds.includes(e.id)),{id,version,...body}=unseen;
  await f.worker.complete(c,reply(proposal([],[{...put(id,{...body,name:'forged'}),expected_version:version}])));
  assert.equal((await f.result(c.requestId)).error_code,'rpg_context_missing');
  assert.deepEqual((await f.call('read_liferpg',{view:'game'})).entities,all);
});

test('deletion during a selected summary turn discards new private reflection and preserves known usage',async()=>{
  const f=fixture();await f.start();const source=await f.turn(proposal([mem('episode','DELETE-IN-FLIGHT')]),'observation','[SYNTHETIC] DELETE-IN-FLIGHT');
  const episode=(await db.query("SELECT payload_id FROM memories WHERE owner_id=$1 AND kind='episode'",[f.identity.subject])).rows[0];
  await deriveMemory(db,f.identity.subject,{kind:'summary',text:'DELETE-IN-FLIGHT compact',source_payload_ids:[episode.payload_id]});
  await f.queue();const c=await f.worker.claim();assert.ok(c.context.memories.some(m=>m.kind==='summary'));
  await f.call('delete_real_record',{request_id:randomUUID(),event_ids:source.r.event_ids});
  const result=await f.worker.complete(c,{proposal:proposal([mem('reflection','LATE-PRIVATE-TEXT')]),usage:{cost:1,input_tokens:3,output_tokens:2}});
  assert.equal(result.status,'discarded');assert.ok(!JSON.stringify((await db.query('SELECT body FROM payloads')).rows).includes('LATE-PRIVATE-TEXT'));
  assert.equal(Number((await db.query('SELECT actual_cost FROM attempts WHERE id=$1',[c.attemptId])).rows[0].actual_cost),1);
});
