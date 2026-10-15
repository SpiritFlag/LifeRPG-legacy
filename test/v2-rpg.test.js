import {before,beforeEach,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {scopedDatabase} from '../src/v2/storage.ts';
import {LifeRpgService} from '../src/v2/service.ts';
import {GmWorker} from '../src/v2/worker.ts';
import {MockGm} from '../src/v2/mock-gm.ts';
import {V2_SCOPES} from '../src/v2/contracts.ts';
import {publicRpg,effectiveStats} from '../src/v2/rpg.ts';
import {deriveMemory} from '../src/v2/memory.ts';
import {deletionManifest,applyDeletionManifest} from '../src/v2/privacy.ts';
import {OpenAiGm} from '../src/v2/openai-gm.ts';
import {readOpenAiConfig} from '../src/v2/openai-config.ts';

let pg,db;
before(async()=>{
  pg=new PGlite();for(const file of ['001-foundation.sql','002-openai-accounting.sql','003-rpg.sql','004-memory.sql'])await pg.exec(await readFile(new URL(`../migrations/v2/${file}`,import.meta.url),'utf8'));
  db=scopedDatabase({query:(s,v)=>pg.query(s,v),transaction:fn=>pg.transaction(tx=>fn({query:(s,v)=>tx.query(s,v)}))});
});
beforeEach(()=>db.query('TRUNCATE games CASCADE'));
after(()=>pg.close());
const put=(ref,body,expected_version=0,extra={})=>({op:'put',ref,body,expected_version,visibility:'public',private_notes:null,...extra});
const named=(kind,name,extra={})=>({kind,name,description:`[SYNTHETIC] ${name}`, ...extra});
const definition=(kind,name,effects=[],slots=[])=>named(kind,name,{effects,slots});
const inventory=(ref,definition,delta,expected_version=0)=>({op:'inventory',ref,definition,delta,expected_version});
const proposal=(operations=[],extra={})=>({outcome:'commit',summary:'GM draft: the record was rejected; XP is 999999.',xp_delta:0,memories:[],operations,reward_source:null,scene:null,...extra});
const reply=p=>({proposal:p,usage:{input_tokens:0,output_tokens:0,cost:0}});
function fixture() {
  const identity={subject:randomUUID(),scopes:V2_SCOPES},service=new LifeRpgService(db),worker=new GmWorker(db,new MockGm());
  const call=(name,input)=>service.execute(name,input,identity);
  const result=operation_id=>call('read_liferpg',{view:'request',operation_id});
  const game=()=>call('read_liferpg',{view:'game'});
  const execute=async(p,kind='action',extra={})=>{
    const request=kind==='observation'?{request_id:randomUUID(),summary:'[SYNTHETIC] completed walk',...extra}:{request_id:randomUUID(),kind,message:'[SYNTHETIC] world action',...extra};
    const receipt=await call(kind==='observation'?'submit_observation':'interact_with_gm',request);
    const claim=await worker.claim();assert.equal(claim?.requestId,receipt.operation_id);
    await worker.complete(claim,reply(p));return {receipt,result:await result(receipt.operation_id),claim,request};
  };
  const start=async()=>{
    const p=proposal([
      put('@town',named('place','등불 골짜기',{parent:null})),
      put('@keeper',named('npc','로안',{parent:'@town'}),0,{private_notes:'PRIVATE-SECRET: 로안은 용의 후손이다.'}),
      put('@profession',definition('profession','옥상 바람의 기록지기',[{name:'의지',value:1}])),inventory('@job','@profession',1),
      put('@skill',definition('skill','비에 젖은 별 읽기')),inventory('@learned','@skill',1),
      put('@potion',definition('item','은빛 물방울')),inventory('@bag','@potion',2),
      put('@blade',definition('equipment','잎새 검',[{name:'의지',value:2}],['손'])),inventory('@weapon','@blade',1),
      {op:'equip',ref:'@weapon',expected_version:1,slot:'손'},
      put('@quest',named('quest','우물의 불빛',{status:'offered',progress:0,target:2,location:'@town'})),
      put('@secret',named('world_event','PRIVATE-SECRET: 잠든 용',{status:'planned',location:'@town',participants:['@keeper']}),0,{visibility:'private'}),
      put('@hero',named('character','연우',{level:1,stats:[{name:'의지',value:3},{name:'민첩',value:2}],profession:'@profession',location:'@town'})),
    ],{memories:[{kind:'identity',text:'PRIVATE-SECRET: 자율적인 기록지기 GM'}],scene:{title:'등불의 시작',text:'우물에서 푸른 빛이 흔들린다.',dialogue:[{speaker:'@keeper',text:'빛을 따라가 볼까?'}],choices:[{label:'우물 살펴보기',action:'우물 가까이 간다.'}]}});
    const r=await execute(p,'start');assert.equal(r.result.status,'committed');return r;
  };
  return {identity,service,worker,call,result,game,execute,start};
}
const body=e=>{const {id,version,...b}=e;return b;};
const entity=(game,kind,name)=>game.entities.find(e=>e.kind===kind&&(!name||e.name===name));
const holding=(game,definition)=>game.entities.find(e=>e.kind==='holding'&&e.definition===definition.id);

test('full synthetic campaign: autonomous birth, growth, every feature kind, equipment, consumption, quest and world rewards',async()=>{
  const f=fixture(),born=await f.start();let g=await f.game();
  assert.equal(g.xp,0);assert.equal(g.effective_stats.find(s=>s.name==='의지').value,6);
  assert.ok(!JSON.stringify(g).includes('PRIVATE-SECRET'));assert.ok(!JSON.stringify(born.result).includes('PRIVATE-SECRET'));
  assert.equal(born.result.player_result.fiction.choices.length,1);
  assert.ok(!JSON.stringify(born.result).includes('999999'));
  const hero=entity(g,'character'),quest=entity(g,'quest');
  const grow=await f.execute(proposal([
    ...['trait','title','achievement'].flatMap((kind,i)=>[put(`@d${i}`,definition(kind,`자유 창작 ${kind}`)),inventory(`@h${i}`,`@d${i}`,1)]),
    put(hero.id,{...body(hero),level:3,stats:[{name:'의지',value:4},{name:'민첩',value:2}]},hero.version),
    put(quest.id,{...body(quest),status:'active',progress:1},quest.version),
  ],{xp_delta:7}),'observation');
  assert.equal(grow.result.status,'committed');assert.equal(grow.result.reality.status,'recorded');
  assert.ok(!('confirmed_new_report'in grow.claim.context.input));assert.equal(grow.claim.context.reality.status,'recorded');
  g=await f.game();assert.equal(g.xp,7);assert.equal(entity(g,'character').level,3);assert.equal(g.effective_stats.find(s=>s.name==='의지').value,7);
  for(const kind of ['profession','skill','trait','title','achievement','item','equipment'])assert.ok(entity(g,kind));
  let potion=entity(g,'item'),bag=holding(g,potion);
  const consumed=await f.execute(proposal([inventory(bag.id,potion.id,-1,bag.version)]));assert.equal(consumed.result.status,'committed');
  g=await f.game();bag=holding(g,potion);const q=entity(g,'quest');
  const reward=await f.execute(proposal([put(q.id,{...body(q),status:'completed',progress:2},q.version),inventory(bag.id,potion.id,3,bag.version)],{xp_delta:11,reward_source:q.id}));
  assert.equal(reward.result.status,'committed');g=await f.game();assert.equal(g.xp,18);assert.equal(holding(g,potion).quantity,4);
  bag=holding(g,potion);await f.execute(proposal([inventory(bag.id,potion.id,-4,bag.version)]));
  const replay=await f.call('interact_with_gm',reward.request);assert.equal(replay.operation_id,reward.receipt.operation_id);
  assert.equal(holding(await f.game(),potion).quantity,0);
  const tick=await f.execute(proposal([put('@rescue',named('world_event','NPC의 독립적인 구조',{status:'resolved',location:entity(g,'place').id,participants:[entity(g,'npc').id]})),{op:'advance_time',ticks:5}],{xp_delta:9,reward_source:'@rescue'}));
  assert.equal(tick.result.status,'committed');g=await f.game();assert.equal(g.xp,27);assert.equal(g.world_tick,5);
  assert.equal((await f.call('read_liferpg',{view:'records'})).records.length,1);
});

test('consumed quest rewards cannot be reissued under a new request key; entire mutation is rolled back',async()=>{
  const f=fixture();await f.start();let g=await f.game();let q=entity(g,'quest'),potion=entity(g,'item'),bag=holding(g,potion);
  await f.execute(proposal([put(q.id,{...body(q),status:'active'},q.version)]));g=await f.game();q=entity(g,'quest');
  await f.execute(proposal([put(q.id,{...body(q),status:'completed',progress:2},q.version),inventory(bag.id,potion.id,1,bag.version)],{reward_source:q.id}));
  g=await f.game();bag=holding(g,potion);await f.execute(proposal([inventory(bag.id,potion.id,-3,bag.version)]));
  g=await f.game();bag=holding(g,potion);const before=JSON.stringify(g);
  const duplicate=await f.execute(proposal([inventory(bag.id,potion.id,1,bag.version),put('@npc',named('npc','유출되면 안 되는 NPC',{parent:null}))],{reward_source:q.id}));
  assert.equal(duplicate.result.error_code,'rpg_reward_already_claimed');assert.equal(JSON.stringify(await f.game()),before);
});

for(const [name,make,code] of [
  ['negative inventory',g=>[inventory(holding(g,entity(g,'item')).id,entity(g,'item').id,-99,holding(g,entity(g,'item')).version)],'rpg_inventory_balance'],
  ['stale version',g=>[put(entity(g,'npc').id,body(entity(g,'npc')),999)],'rpg_version_conflict'],
  ['unknown ref',g=>[put(entity(g,'character').id,{...body(entity(g,'character')),location:randomUUID()},entity(g,'character').version)],'rpg_context_missing'],
  ['private reference in public entity',g=>[put('@hidden',named('npc','secret',{parent:null}),0,{visibility:'private'}),put('@edge',named('relation','leak',{from:entity(g,'npc').id,to:'@hidden',status:'active'}))],'rpg_private_reference'],
  ['cycle in place hierarchy',()=>[put('@a',named('place','A',{parent:'@b'})),put('@b',named('place','B',{parent:'@a'}))],'rpg_parent_cycle'],
  ['quest skipping active state',g=>[put(entity(g,'quest').id,{...body(entity(g,'quest')),status:'completed',progress:2},entity(g,'quest').version)],'rpg_quest_transition'],
  ['silent held definition edit',g=>[put(entity(g,'equipment').id,{...body(entity(g,'equipment')),effects:[{name:'의지',value:999}]},entity(g,'equipment').version)],'rpg_definition_in_use'],
  ['slot collision',g=>[put('@second',definition('equipment','다른 검',[],['손'])),inventory('@second_holding','@second',1),{op:'equip',ref:'@second_holding',expected_version:1,slot:'손'}],'rpg_slot_occupied'],
  ['unbacked world reward',()=>[],'rpg_reward_required'],
])test(`server rejects ${name} without partial game changes`,async()=>{
  const f=fixture();await f.start();const before=await f.game();
  const r=await f.execute(proposal(make(before),{xp_delta:5}));
  assert.equal(r.result.error_code,code);assert.deepEqual(await f.game(),before);
});

test('quest failure is terminal; equipment can be unequipped then lost',async()=>{
  const f=fixture();await f.start();let g=await f.game();const weapon=holding(g,entity(g,'equipment')),q=entity(g,'quest');
  const done=await f.execute(proposal([
    {op:'equip',ref:weapon.id,expected_version:weapon.version,slot:null},inventory(weapon.id,weapon.definition,-1,weapon.version+1),
    put(q.id,{...body(q),status:'failed'},q.version),
  ]));assert.equal(done.result.status,'committed');g=await f.game();assert.equal(entity(g,'quest').status,'failed');
  assert.equal(g.effective_stats.find(s=>s.name==='의지').value,4);assert.equal(holding(g,entity(g,'equipment')).quantity,0);
  const failed=entity(g,'quest');const reopen=await f.execute(proposal([put(failed.id,{...body(failed),status:'active'},failed.version)]));
  assert.equal(reopen.result.error_code,'rpg_quest_transition');
});

test('multiple birth clarifications preserve intent, input history and receipts without start_required deadlock',async()=>{
  const f=fixture();const first=await f.execute({outcome:'clarify',summary:'private',xp_delta:0,memories:[],question:'어떤 이름을 사용할까요?'},'start');
  assert.equal(first.result.status,'needs_input');
  const answer=await f.call('interact_with_gm',{request_id:randomUUID(),kind:'answer',question_id:first.result.question.question_id,message:'합성 모험가'});
  const c=await f.worker.claim();assert.equal(c.context.kind,'start');
  await f.worker.complete(c,reply({outcome:'clarify',summary:'private',xp_delta:0,memories:[],question:'어느 세계에서 시작할까요?'}));
  const second=await f.result(answer.operation_id);
  assert.deepEqual((await f.result(first.receipt.operation_id)).question,second.question);
  await f.call('interact_with_gm',{request_id:randomUUID(),kind:'answer',question_id:second.question.question_id,message:'등불 세계'});
  const last=await f.worker.claim();assert.equal(last.context.kind,'start');assert.equal(last.context.clarification_history.length,2);
  assert.equal(last.context.clarification_history[1].input.message,'합성 모험가');
  assert.ok(JSON.stringify(last.context).includes('어떤 이름'));
  await f.worker.complete(last,await new MockGm().generate(last.context,new AbortController().signal));
  assert.equal((await f.result(answer.operation_id)).status,'committed');assert.equal((await f.game()).initialized,true);
  assert.equal((await f.result(first.receipt.operation_id)).status,'committed');
});

test('appeal applies incremental compensation once and resolves a new head without duplicating an event reward',async()=>{
  const f=fixture();await f.start();const observation=await f.execute(proposal([],{xp_delta:8}),'observation');
  const appeal=await f.execute(proposal([],{xp_delta:-3}),'appeal',{decision_id:observation.result.decision_id});
  assert.equal(appeal.result.status,'committed');assert.equal((await f.game()).xp,5);
  await f.call('interact_with_gm',appeal.request);assert.equal((await f.game()).xp,5);
  await assert.rejects(()=>f.call('interact_with_gm',{...appeal.request,request_id:randomUUID()}),e=>e.code==='decision_superseded');
});

test('deletion purges public/private RPG versions, summaries, pending responses; clean fiction can reinterpret losses',async()=>{
  const f=fixture();await f.start();let g=await f.game();const marker='SYNTHETIC-DELETE-ALL-TRACES';
  const hero=entity(g,'character');
  const activity=await f.execute(proposal([
    put('@title',definition('title',marker)),inventory('@newtitle','@title',1),
    put('@npc',named('npc',marker,{parent:null}),0,{private_notes:marker}),
    put(hero.id,{...body(hero),description:marker},hero.version),
  ],{xp_delta:5,memories:[{kind:'reflection',text:marker}],scene:{title:'검증 장면',text:marker,dialogue:[],choices:[]}}),'observation',{summary:marker});
  const affected=(await db.query("SELECT public_payload,private_payload FROM rpg_entities WHERE owner_id=$1 AND kind='npc' AND private_payload IS NOT NULL ORDER BY version",[f.identity.subject])).rows;
  const sourced=(await db.query("SELECT payload_id FROM memories WHERE owner_id=$1 AND kind='reflection'",[f.identity.subject])).rows[0].payload_id;
  await deriveMemory(db,f.identity.subject,{kind:'summary',text:marker,source_payload_ids:[sourced]});
  const queued=await f.call('interact_with_gm',{request_id:randomUUID(),kind:'action',message:'[SYNTHETIC] next scene'});const late=await f.worker.claim();
  assert.ok(JSON.stringify(late.context).includes(marker));
  await f.call('delete_real_record',{request_id:randomUUID(),event_ids:activity.receipt.event_ids});
  const after=await f.worker.complete(late,reply(proposal([put('@late',named('npc',marker,{parent:null}))])));assert.equal(after.status,'discarded');
  assert.equal((await f.result(queued.operation_id)).status,'deleted');
  assert.ok(!JSON.stringify((await db.query('SELECT body FROM payloads')).rows).includes(marker));
  assert.ok(!JSON.stringify(await f.game()).includes(marker));
  const action=await f.call('interact_with_gm',{request_id:randomUUID(),kind:'action',message:'[SYNTHETIC] 새 허구로 세계 정리'});const clean=await f.worker.claim();
  assert.ok(!JSON.stringify(clean.context).includes(marker));assert.equal(clean.context.events.length,0);
  const shells=clean.context.rpg.entities.filter(e=>e.needs_reinterpretation);
  const operations=shells.map(e=>e.kind==='character'?put(e.id,named('character','새벽 모험가',{level:1,stats:[{name:'의지',value:3},{name:'민첩',value:2}],profession:null,location:null}),e.version):{op:'retire',ref:e.id,expected_version:e.version});
  operations.push(...clean.context.rpg.pending_reinterpretations.map(d=>({op:'resolve_reinterpretation',decision_id:d.id})));
  await f.worker.complete(clean,reply(proposal(operations,{xp_delta:-5,scene:{title:'새로운 역사',text:'골짜기의 기록은 새벽의 모험으로 이어진다.',dialogue:[],choices:[]}})));
  assert.equal((await f.result(action.operation_id)).status,'committed');g=await f.game();assert.equal(g.xp,0);assert.equal(g.reinterpretation_pending,0);
  assert.ok(g.entities.some(e=>e.name==='새벽 모험가'));assert.ok(!JSON.stringify((await db.query('SELECT body FROM payloads')).rows).includes(marker));
  assert.ok(affected.length>=1);
});

test('RPG commit DB failure rolls back all entities/rewards while source receipts remain',async()=>{
  const f=fixture();await f.start();const before=await f.game();
  const receipt=await f.call('interact_with_gm',{request_id:randomUUID(),kind:'action',message:'[SYNTHETIC] atomic failure'});const c=await f.worker.claim();
  const broken={...db,transaction:fn=>db.transaction(tx=>fn({query:(s,v)=>s.startsWith('INSERT INTO rpg_versions')?Promise.reject(new Error('synthetic disk failure')):tx.query(s,v)}))};
  await assert.rejects(()=>new GmWorker(broken,new MockGm()).complete(c,reply(proposal([put('@npc',named('npc','부분 저장 금지',{parent:null}))]))));
  assert.deepEqual(await f.game(),before);assert.equal((await f.result(receipt.operation_id)).status,'running');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM rpg_entities WHERE owner_id=$1',[f.identity.subject])).rows[0].n,before.entities.length+1);
});

test('birth without a character cannot initialize',async()=>{
  const f=fixture();const result=await f.execute(proposal([]),'start');
  assert.equal(result.result.error_code,'rpg_birth_required');assert.equal((await f.game()).initialized,false);
});

test('existing IDs belonging to another player cannot be referenced or overwritten',async()=>{
  const a=fixture(),b=fixture();await a.start();await b.start();
  const foreign=entity(await b.game(),'npc'),before=await b.game();
  const r=await a.execute(proposal([put(foreign.id,{...body(foreign),name:'forged'},foreign.version)]));
  assert.equal(r.result.error_code,'rpg_context_missing');assert.deepEqual(await b.game(),before);
});

test('deletion manifest scrubs RPG history from a restored snapshot',async()=>{
  const f=fixture();await f.start();const marker='SYNTHETIC-RESTORED-RPG-SECRET';
  const r=await f.execute(proposal([put('@lost',named('npc',marker,{parent:null}),0,{private_notes:marker})]),'observation',{summary:marker});
  const dump=await pg.dumpDataDir();await f.call('delete_real_record',{request_id:randomUUID(),event_ids:r.receipt.event_ids});
  const manifest=await deletionManifest(db),restored=await PGlite.create({loadDataDir:dump});
  try {
    const backup=scopedDatabase({query:(s,v)=>restored.query(s,v),transaction:fn=>restored.transaction(tx=>fn({query:(s,v)=>tx.query(s,v)}))});
    assert.ok(JSON.stringify((await backup.query('SELECT body FROM payloads')).rows).includes(marker));
    await applyDeletionManifest(backup,manifest);
    assert.ok(!JSON.stringify((await backup.query('SELECT body FROM payloads')).rows).includes(marker));
    const shells=(await backup.query('SELECT id FROM rpg_entities WHERE needs_reinterpretation')).rows;
    assert.equal(shells.length,1);
    const version=(await backup.query('SELECT public_payload,private_payload FROM rpg_versions WHERE entity_id=$1',[shells[0].id])).rows[0];
    assert.deepEqual(version,{public_payload:null,private_payload:null});
  } finally {await restored.close();}
});

test('public projection hides dangling edges transitively and excludes their effective stats',()=>{
  const wrap=(id,body,extra={})=>({id,version:1,visibility:'public',retired:false,needs_reinterpretation:false,body,...extra});
  const graph=[wrap('place',null,{needs_reinterpretation:true}),wrap('npc',named('npc','NPC',{parent:'place'})),
    wrap('relation',named('relation','link',{from:'npc',to:'hero',status:'active'})),
    wrap('hero',named('character','hero',{level:1,stats:[{name:'힘',value:3}],profession:null,location:'place'}))];
  assert.deepEqual(publicRpg(graph),[]);assert.deepEqual(effectiveStats(graph),[]);
});

test('OpenAI adapter accepts RPG operations offline with unchanged model/reasoning/budget limits',async()=>{
  const f=fixture();let calls=0;const config=readOpenAiConfig({});
  const gm=new OpenAiGm(config,async body=>{
    calls++;assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.reasoning.effort,'medium');assert.equal(body.text.format.strict,true);
    const p=calls===1?proposal([
      put('@town',named('place','마을',{parent:null})),
      put('@hero',named('character','영웅',{level:1,stats:[{name:'힘',value:2}],profession:null,location:'@town'})),
    ]):proposal([put('@event',named('world_event','종이 울렸다',{status:'resolved',location:null,participants:[]})),{op:'advance_time',ticks:1}],{reward_source:'@event',xp_delta:3});
    return {status:200,body:{model:config.model,status:'completed',service_tier:'default',usage:{input_tokens:100,output_tokens:50,total_tokens:150,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:10}},
      output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({...p,question:null})}]}]}};
  });
  for(const kind of ['start','action']) {
    const receipt=await f.call('interact_with_gm',{request_id:randomUUID(),kind,message:'[SYNTHETIC] RPG'});
    const c=await f.worker.claim(),r=await gm.generate(c.context,new AbortController().signal);assert.equal(r.failure,undefined);
    await f.worker.complete(c,r);assert.equal((await f.result(receipt.operation_id)).status,'committed');
  }
  assert.equal(calls,2);assert.equal((await f.game()).xp,3);assert.equal(gm.maxCost,61440);
  const huge=await gm.generate({operation_id:randomUUID(),kind:'action',input:{message:'가'.repeat(20000)},initialized:true,xp:3,memories:[],events:[],previous_decision:null,target_event_id:null},new AbortController().signal);
  assert.equal(huge.failure.code,'context_limit');assert.equal(huge.usage.cost,0);assert.equal(calls,2);
});

test('MCP rejects direct reward/operation fields and sanitized context distinguishes receipt from adjudication',async()=>{
  const f=fixture();await f.start();
  await assert.rejects(()=>f.call('interact_with_gm',{request_id:randomUUID(),kind:'action',message:'test',operations:[]}),e=>e.code==='invalid_input');
  await assert.rejects(()=>f.call('submit_observation',{request_id:randomUUID(),summary:'test',xp_delta:100}),e=>e.code==='invalid_input');
  const r=await f.execute(proposal([],{outcome:'no_change',summary:'I did not record this event.'}),'observation',{confirmed_new_report:false});
  assert.equal(r.result.reality.status,'recorded');assert.equal(r.result.status,'no_change');
  assert.ok(!JSON.stringify(r.result).includes('did not record'));assert.ok(!JSON.stringify(r.claim.context).includes('confirmed_new_report'));
  const corrected=await f.call('revise_real_record',{request_id:randomUUID(),event_id:r.receipt.event_ids[0],expected_version:1,summary:'[SYNTHETIC] corrected walk'});
  assert.equal(corrected.reality.status,'corrected');
  await f.call('delete_real_record',{request_id:randomUUID(),event_ids:r.receipt.event_ids});
  assert.equal((await f.result(corrected.operation_id)).reality.status,'deleted');
});

test('NPC/place/faction relationships evolve and removal repairs references without exposing private replacements',async()=>{
  const f=fixture();await f.start();let g=await f.game();const npc=entity(g,'npc');
  await f.execute(proposal([
    put('@guild',named('faction','우물의 파수꾼',{parent:null})),
    put('@bond',named('relation','수호의 약속',{from:npc.id,to:'@guild',status:'active'})),
    put('@garden',named('place','달빛 정원',{parent:entity(g,'place').id})),
    put(npc.id,{...body(npc),parent:'@garden'},npc.version),
  ]));
  g=await f.game();assert.equal(entity(g,'relation').status,'active');
  const bond=entity(g,'relation'),guild=entity(g,'faction'),keeper=entity(g,'npc');
  const result=await f.execute(proposal([
    {op:'retire',ref:bond.id,expected_version:bond.version},{op:'retire',ref:guild.id,expected_version:guild.version},
    put(keeper.id,{...body(keeper),description:'PRIVATE-NEW-SECRET'},keeper.version,{visibility:'private',private_notes:'PRIVATE-NEW-SECRET'}),
  ]));
  assert.equal(result.result.status,'committed');assert.ok(!JSON.stringify(result.result).includes('PRIVATE-NEW-SECRET'));
  const removal=result.result.player_result.changes.find(c=>c.id===keeper.id);assert.equal(removal.removed,true);assert.equal(removal.state,null);
  assert.ok(!(await f.game()).entities.some(e=>e.id===keeper.id||e.id===guild.id||e.id===bond.id));
});

test('appeal clarification retains the prior decision and compensates incrementally',async()=>{
  const f=fixture();await f.start();const event=await f.execute(proposal([],{xp_delta:8}),'observation');
  const appeal=await f.execute({outcome:'clarify',summary:'private',xp_delta:0,memories:[],question:'재검토할 근거는 무엇인가요?'},'appeal',{decision_id:event.result.decision_id});
  const answer=await f.call('interact_with_gm',{request_id:randomUUID(),kind:'answer',message:'합성 설명',question_id:appeal.result.question.question_id});
  const c=await f.worker.claim();assert.equal(c.context.kind,'appeal');assert.equal(c.context.previous_decision.decision_id,event.result.decision_id);
  await f.worker.complete(c,reply(proposal([],{xp_delta:-2})));
  assert.equal((await f.result(answer.operation_id)).status,'committed');assert.equal((await f.game()).xp,6);
  await assert.rejects(()=>f.call('interact_with_gm',{request_id:randomUUID(),kind:'appeal',message:'다시',decision_id:event.result.decision_id}),e=>e.code==='decision_superseded');
});
