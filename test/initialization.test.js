import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { login,mcpClient,testEvent } from '../scripts/client.js';
import { readPlayer,playerQuerySchema } from '../src/web-data.js';
import { getGmUpdate,applyGmUpdate } from '../src/growth-storage.js';
import { applyGmSchema } from '../src/growth-schema.js';

const config=readConfig({PUBLIC_BASE_URL:'https://birth.example',OAUTH_CLIENT_SECRET:'client-'.repeat(8),OWNER_LOGIN_KEY:'owner-'.repeat(8),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'});
const secret='BIRTH_GM_SECRET';
const stats={STR:10,DEX:12,VIT:15,INT:18,CHA:9,LUK:7};
const profile={name:'Synthetic archivist',species:'Starborn',birth:'Born at a fictional lighthouse',background:'A fictional wandering archivist',destiny:'Find the missing constellation',gm_notes:secret,narrative:{chapter:'First dawn',nested:{gm_secret:secret}},gm_state:{twist:secret}};
const reason='Synthetic birth fixture';
const entity=(ref,category,parent=null,extra={})=>({operation:'create_entity',ref,entity_key:ref.slice(1),category,kind:category,name:ref.slice(1),parent,reason,...extra});
const definition=(ref,kind,extra={})=>({operation:'create_definition',ref,definition_key:ref.slice(1),kind,name:ref.slice(1),reason,...extra});
const line={operation:'create_line',ref:'@story',line_key:'story',title:'Synthetic first journey',status:'active',reason};
const profession=[definition('@archivist','profession'),{operation:'change_profession',ref:'@job',acquisition_key:'job',definition:'@archivist',definition_version:1,reason}];
const world=[entity('@world','world'),entity('@harbor','place','@world')];
const begin=(extra={})=>({mode:'begin_initialization',request_key:'birth-begin',expected_revision:0,reason,character:{profile,xp_total:650,stats},starting_location:'@harbor',content_changes:profession,world_changes:world,...extra});
const finish=(draft,extra={})=>({mode:'finalize_initialization',request_key:'birth-finalize',reason,initialization_id:draft.initialization.initialization_id,expected_initialization_revision:draft.initialization.revision,...extra});
const prepare=(draft,extra)=>({mode:'prepare_initialization',request_key:randomUUID(),reason,initialization_id:draft.initialization.initialization_id,expected_initialization_revision:draft.initialization.revision,...extra});
const liveTables=['games','characters','gm_updates','gm_adjudications','gm_adjudication_sources','gm_change_entries','questlines','quest_nodes','game_definitions','game_definition_versions','character_features','inventory_entries','world_entities','world_relations','world_facts','gm_memories','adventure_journals','world_change_entries','character_profiles','character_births','character_profile_changes'];

async function fixture(t,with007=true) {
  const pg=new PGlite();
  for(const file of ['001-experiment','002-life-event-history','003-gm-growth','004-questlines','005-character-content','006-world-memory',...(with007 ? ['007-game-initialization'] : [])]) await pg.exec(await readFile(new URL(`../migrations/${file}.sql`,import.meta.url),'utf8'));
  const db={query:(sql,values)=>pg.query(sql,values),transaction:fn=>pg.transaction(tx=>fn({query:(sql,values)=>tx.query(sql,values)}))};
  const app=createApp(db,config),fetcher=(input,init)=>app(input instanceof Request ? input : new Request(input,init));
  const tokens=(await login(config.base,config,fetcher)).tokens,client=await mcpClient(config.base,tokens.access_token,fetcher);
  t.after(async()=>{await client.close();await pg.close();});
  const call=async(name,args={})=>{const {call_id,...value}=(await client.callTool({name,arguments:args})).structuredContent;return value;};
  const raw=async(handler,args,token=tokens.access_token)=>{
    const res=await handler(new Request(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(token ? {Authorization:`Bearer ${token}`} : {})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'apply_gm_update',arguments:args}})}));
    return (await res.json()).result?.structuredContent || {http_status:res.status};
  };
  const counts=async()=>Promise.all(liveTables.map(async table=>(await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n));
  return {pg,db,app,client,call,raw,counts,event:async(kind='real',key=randomUUID())=>(await call('record_life_event',{...testEvent,kind,event_key:key})).event,web:input=>readPlayer(db,'experiment-owner',playerQuerySchema.parse(input || {}))};
}

test('007 migration preserves existing events, game, receipts, growth and OAuth; creates no birth',async t=>{
  const f=await fixture(t,false),e=await f.event();
  const old={mode:'initialize',request_key:'old-test',expected_revision:0,reason,synthetic:true,character:{label:'legacy synthetic',xp_total:100,stats}};
  await f.raw(createApp(f.db,{...config,allowSyntheticGame:true}),old);
  const tables=['games','characters','gm_updates','gm_change_entries','life_events','life_event_revisions','life_event_aliases','oauth_grants','tool_calls'];
  const snapshot=async()=>Promise.all(tables.map(async table=>(await f.db.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS value FROM ${table} t`)).rows[0].value));
  const before=await snapshot();
  await f.pg.exec(await readFile(new URL('../migrations/007-game-initialization.sql',import.meta.url),'utf8'));
  assert.deepEqual(await snapshot(),before);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM character_births')).rows[0].n,0);
  assert.equal((await f.call('get_life_event',{event_id:e.id})).event.id,e.id);
  assert.equal((await f.raw(createApp(f.db,{...config,allowSyntheticGame:true}),old)).outcome,'replayed');
  await assert.rejects(f.pg.exec(await readFile(new URL('../migrations/007-game-initialization.sql',import.meta.url),'utf8')));await f.pg.exec('ROLLBACK');
});

test('formal real-kind birth stores GM profile, growth, seven content kinds, world, NPC, quests and immutable origin',async t=>{
  const f=await fixture(t),e=await f.event(),eventBefore=(await f.call('get_life_event',{event_id:e.id}));
  const contents=[...profession];
  for(const kind of ['skill','trait','title','achievement']) contents.push(definition(`@${kind}`,kind),{operation:'grant_feature',ref:`@owned-${kind}`,acquisition_key:kind,definition:`@${kind}`,definition_version:1,reason});
  contents.push(definition('@staff','equipment',{stat_modifiers:{INT:4}}),{operation:'grant_inventory',ref:'@owned-staff',acquisition_key:'staff',definition:'@staff',definition_version:1,mode:'individual',reason},{operation:'equip',entry:'@owned-staff',slot:'hand',reason},definition('@ink','item'),{operation:'grant_inventory',ref:'@owned-ink',acquisition_key:'ink',definition:'@ink',definition_version:1,mode:'stack',quantity:3,reason});
  const draft=await f.call('apply_gm_update',begin({content_changes:contents,quest_changes:[line,{operation:'create_node',ref:'@chapter',questline:'@story',node_key:'chapter',kind:'chapter',title:'First chapter',status:'active',reason},{operation:'create_node',ref:'@quest',questline:'@story',parent:'@chapter',node_key:'quest',kind:'quest',title:'Meet the keeper',reason},{operation:'link_event',questline:'@story',node:'@quest',event_id:e.id,event_version:e.version,reason}],birth_sources:[{event_id:e.id,event_version:e.version,reason:'Past experience reflected in initial XP and biography'}],world_changes:[...world,entity('@nation','faction','@world'),entity('@keeper','npc','@world',{location:'@harbor',affiliation:'@nation'}),{operation:'create_relation',ref:'@mentor',relation_key:'mentor',from:{type:'entity',id:'@keeper'},to:{type:'character'},kind:'mentor',reason},{operation:'create_fact',ref:'@history',fact_key:'history',kind:'history',title:'Founding',body:'Synthetic world history',reason},{operation:'create_fact',ref:'@secret',fact_key:'secret',kind:'foreshadowing',title:'Secret',body:secret,visibility:'gm',reason},{operation:'create_memory',ref:'@memory',memory_key:'memory',title:'GM plan',body:secret,links:[{type:'world_fact',id:'@secret'}],reason},{operation:'create_journal',ref:'@journal',journal_key:'journal',title:'First dawn',body:'A fictional adventure begins',links:[{type:'entity',id:'@keeper'},{type:'questline',id:'@story'},{type:'event',event_id:e.id,event_version:e.version}],reason}]}));
  assert.equal(draft.outcome,'prepared');
  const result=await f.call('apply_gm_update',finish(draft));assert.equal(result.outcome,'committed');
  assert.equal(result.after.kind,'real');assert.equal(result.after.revision,1);assert.equal(result.after.character.level,4);assert.equal(result.after.character.xp_total,650);assert.deepEqual(result.after.character.stats,stats);
  assert.equal(result.stat_effects.after.display_stats.INT,22);assert.equal(result.content_changes.length,contents.length);
  const ctx=await f.call('get_game_context',{include_birth:true});assert.equal(ctx.content.current_profession.kind,'profession');assert.equal(ctx.world.entities.items.length,4);assert.equal(ctx.questlines.length,1);assert.equal(ctx.birth.character.profile.birth,profile.birth);assert.equal(ctx.gm_private.character_profile.gm_notes,secret);
  assert.equal(ctx.gm_private.world.memories.items.length,1);assert.equal(ctx.world.journals.items.length,1);
  assert.deepEqual((await f.call('get_life_event',{event_id:e.id})),eventBefore);
  const saved=(await f.call('get_gm_update',{update_id:result.update_id})).update;assert.equal(saved.birth_sources[0].sources[0].event_id,e.id);
  for(const table of ['character_births','character_profile_changes','initialization_requests']) await assert.rejects(f.db.query(`DELETE FROM ${table}`));
});

test('preparing state hides all draft content from GM context, web, player receipts and ordinary advancement',async t=>{
  const f=await fixture(t);assert.equal((await f.web()).initialization.status,'unstarted');
  const draft=await f.call('apply_gm_update',begin());
  assert.deepEqual(await f.counts(),liveTables.map(()=>0));
  const ctx=await f.call('get_game_context',{include_birth:true,include_chronicle:true,world_entity_id:randomUUID()});assert.equal(ctx.initialized,false);assert.equal(ctx.initialization.status,'preparing');assert.equal(ctx.character,undefined);assert.equal(ctx.gm_private,undefined);
  const web=await f.web({include_birth:true});assert.deepEqual(web,{initialized:false,initialization:{status:'preparing',kind:'real'}});
  const player=(await f.call('get_gm_update',{update_id:draft.update_id,view:'player'})).update;assert.ok(!JSON.stringify(player).includes(secret));assert.equal(player.after,undefined);
  const gm=(await f.call('get_gm_update',{request_key:'birth-begin'})).update;assert.equal(gm.gm_private.preparation_input.character.profile.gm_notes,secret);
  const advance=await f.call('apply_gm_update',{mode:'advance',request_key:'too-early',expected_revision:1,reason,world_changes:[entity('@early','world')]});assert.equal(advance.outcome,'not_initialized');
});

test('exact begin/prepare/finalize retries replay receipts; key conflicts and duplicate initialization never reset',async t=>{
  const f=await fixture(t),input=begin(),draft=await f.call('apply_gm_update',input);
  assert.equal((await f.call('apply_gm_update',input)).update_id,draft.update_id);
  assert.equal((await f.call('apply_gm_update',{...input,reason:'Different'})).outcome,'idempotency_conflict');
  assert.equal((await f.call('apply_gm_update',{...input,request_key:'second-begin'})).outcome,'initialization_in_progress');
  const chunk=prepare(draft,{quest_changes:[line]}),added=await f.call('apply_gm_update',chunk);
  assert.equal((await f.call('apply_gm_update',chunk)).outcome,'replayed');assert.equal(added.initialization.revision,2);
  const finalInput=finish(added),result=await f.call('apply_gm_update',finalInput),before=await f.counts();
  assert.equal((await f.call('apply_gm_update',finalInput)).outcome,'replayed');assert.equal((await f.call('get_gm_update',{request_key:finalInput.request_key})).update.update_id,result.update_id);
  assert.equal((await f.call('apply_gm_update',input)).outcome,'replayed');
  assert.equal((await f.call('apply_gm_update',{...input,request_key:'new-birth'})).outcome,'already_initialized');
  assert.equal((await f.call('apply_gm_update',{...finalInput,request_key:'second-finalize'})).outcome,'already_initialized');
  assert.deepEqual(await f.counts(),before);
});

test('multiple chunks support more than forty world entities and cross-chunk typed refs with no fixed NPC quota',async t=>{
  const f=await fixture(t);let draft=await f.call('apply_gm_update',begin({world_changes:[world[0]],quest_changes:[line]}));
  for(let batch=0;batch<3;batch++) draft=await f.call('apply_gm_update',prepare(draft,{world_changes:[...(batch===0 ? [world[1]] : []),...Array.from({length:20},(_,i)=>entity(`@npc-${batch}-${i}`,'npc','@world')),...(batch===2 ? [{operation:'create_journal',ref:'@first',journal_key:'first',title:'First adventure',body:'Synthetic',links:[{type:'questline',id:'@story'},{type:'entity',id:'@npc-0-0'}],reason}] : [])]}));
  assert.equal((await f.web()).initialized,false);assert.deepEqual(await f.counts(),liveTables.map(()=>0));
  const result=await f.call('apply_gm_update',finish(draft));assert.equal(result.outcome,'committed');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM world_entities')).rows[0].n,62);
  const page=await f.call('get_game_context',{world_limit:50});assert.equal(page.world.entities.items.length,50);assert.ok(page.world.entities.next_after_sequence);
});

test('birth event base is reserved without double growth; new events and enrichment use normal subsequent judgments',async t=>{
  const f=await fixture(t),e=await f.event(),draft=await f.call('apply_gm_update',begin({birth_sources:[{event_id:e.id,event_version:e.version,reason}]}));await f.call('apply_gm_update',finish(draft));
  const adjudicate=async(key,event,fields={})=>f.call('apply_gm_update',{mode:'advance',request_key:key,expected_revision:(await f.call('get_game_context')).revision,reason,adjudications:[{subject:{type:'event',event_id:event.id},sources:[{event_id:event.id,event_version:event.version}],reason,...fields}]});
  assert.equal((await adjudicate('repeat-bonus',e,{xp_delta:100})).outcome,'adjudication_conflict');
  assert.equal((await adjudicate('repeat-review',e)).outcome,'unchanged');
  const head=(await f.call('list_gm_adjudications',{event_id:e.id})).adjudications[0];assert.equal(Number(head.xp_delta),0);
  const enriched=await f.call('update_life_events',{request_key:'new-fact',operations:[{operation:'enrich',event_id:e.id,expected_version:e.version,reason,evidence:'Synthetic newly discovered depth',changes:{facts:['Synthetic deeper dive']}}]});assert.equal(enriched.outcome,'committed');
  const current=(await f.call('get_life_event',{event_id:e.id})).event;
  assert.equal((await adjudicate('extra-growth',current,{previous_id:head.id,xp_delta:50})).after.character.xp_total,700);
  const newEvent=await f.event();assert.equal((await adjudicate('new-history',newEvent,{xp_delta:25})).after.character.xp_total,725);
  assert.equal((await f.call('get_game_context',{include_birth:true})).birth.character.xp_total,650);
});

test('real/test evidence mixing, stale event facts and duplicate birth sources fail atomically',async t=>{
  for(const caseName of ['kind','stale','duplicate']) {
    const f=await fixture(t),e=await f.event(caseName==='kind' ? 'test' : 'real');
    const source={event_id:e.id,event_version:e.version,reason};
    const draft=await f.call('apply_gm_update',begin({birth_sources:caseName==='duplicate' ? [source,source] : [source]}));
    if(caseName==='stale') await f.call('update_life_events',{request_key:'changed',operations:[{operation:'enrich',event_id:e.id,expected_version:e.version,reason,evidence:'Synthetic new information',changes:{facts:['More synthetic context']}}]});
    const result=await f.call('apply_gm_update',finish(draft));assert.equal(result.outcome,caseName==='kind' ? 'source_kind_conflict' : caseName==='stale' ? 'event_version_conflict' : 'invalid_input');
    assert.deepEqual(await f.counts(),liveTables.map(()=>0));assert.equal((await f.web()).initialization.status,'preparing');
  }
});

test('late invalid references and incomplete world/job rollback; cancellation permits a corrected new draft',async t=>{
  for(const extra of [{content_changes:undefined},{world_changes:[world[0]]},{quest_changes:[line,{operation:'create_node',ref:'@bad',questline:'@missing',node_key:'bad',kind:'quest',title:'bad',reason}]}]) {
    const f=await fixture(t),draft=await f.call('apply_gm_update',begin(extra));
    const failed=await f.call('apply_gm_update',finish(draft));assert.notEqual(failed.outcome,'committed');assert.deepEqual(await f.counts(),liveTables.map(()=>0));
    const cancel={...finish(draft),mode:'cancel_initialization',request_key:'cancel'};
    assert.equal((await f.call('apply_gm_update',cancel)).outcome,'cancelled');assert.equal((await f.call('apply_gm_update',cancel)).outcome,'replayed');
    assert.equal((await f.web()).initialization.status,'unstarted');
    const corrected=await f.call('apply_gm_update',begin({request_key:'corrected'}));assert.equal((await f.call('apply_gm_update',finish(corrected,{request_key:'corrected-final'}))).outcome,'committed');
  }
});

test('every finalization storage boundary including audit fails without live state, then exact retry succeeds',async t=>{
  const boundaries=['INSERT INTO games','INSERT INTO characters','INSERT INTO quest_nodes','INSERT INTO game_definition_versions','INSERT INTO inventory_entries','INSERT INTO world_change_entries','INSERT INTO gm_adjudication_sources','INSERT INTO gm_change_entries','INSERT INTO character_profiles','INSERT INTO character_profile_changes','INSERT INTO character_births','INSERT INTO gm_updates','UPDATE game_initializations','INSERT INTO initialization_requests','INSERT INTO tool_calls'];
  for(const prefix of boundaries) {
    const f=await fixture(t),e=await f.event();
    const draft=await f.call('apply_gm_update',begin({birth_sources:[{event_id:e.id,event_version:e.version,reason}],quest_changes:[line,{operation:'create_node',ref:'@quest',questline:'@story',node_key:'quest',kind:'quest',title:'Synthetic',reason}],content_changes:[...profession,definition('@item','item'),{operation:'grant_inventory',ref:'@owned',acquisition_key:'owned',definition:'@item',definition_version:1,mode:'stack',reason}]}));
    const failedDb={query:f.db.query,transaction:fn=>f.db.transaction(tx=>fn({query:(sql,values)=>{if(sql.startsWith(prefix)) throw new Error('Injected birth failure');return tx.query(sql,values);}}))};
    const input=finish(draft),failed=await f.raw(createApp(failedDb,config),input);
    assert.equal(failed.outcome,'storage_error',prefix);assert.deepEqual(await f.counts(),liveTables.map(()=>0),prefix);
    assert.equal((await f.call('get_game_context')).initialization.revision,1);
    assert.equal((await f.call('get_gm_update',{request_key:input.request_key})).outcome,'not_found');
    assert.equal((await f.call('apply_gm_update',input)).outcome,'committed',prefix);
  }
});

test('begin and prepare receipt/audit failures rollback drafts and retain exact retry semantics',async t=>{
  const f=await fixture(t);
  for(const prefix of ['INSERT INTO initialization_requests','INSERT INTO tool_calls']) {
    const failedDb={query:f.db.query,transaction:fn=>f.db.transaction(tx=>fn({query:(sql,values)=>{if(sql.startsWith(prefix)) throw new Error('Injected draft failure');return tx.query(sql,values);}}))};
    const input=begin({request_key:prefix});assert.equal((await f.raw(createApp(failedDb,config),input)).outcome,'storage_error');assert.equal((await f.web()).initialization.status,'unstarted');
  }
  const draft=await f.call('apply_gm_update',begin());
  const input=prepare(draft,{quest_changes:[line]});
  const failedDb={query:f.db.query,transaction:fn=>f.db.transaction(tx=>fn({query:(sql,values)=>{if(sql.startsWith('INSERT INTO initialization_requests')) throw new Error('Injected append failure');return tx.query(sql,values);}}))};
  assert.equal((await f.raw(createApp(failedDb,config),input)).outcome,'storage_error');assert.equal((await f.call('get_game_context')).initialization.revision,1);
  assert.equal((await f.call('apply_gm_update',input)).initialization.revision,2);
});

test('profile evolution preserves birth and paginated history; public GM/web views never leak private biography or world',async t=>{
  const f=await fixture(t),draft=await f.call('apply_gm_update',begin({world_changes:[...world,{operation:'create_fact',ref:'@secret',fact_key:'secret',kind:'setting',title:'Hidden origin',body:secret,visibility:'gm',reason}]}));
  const initial=await f.call('apply_gm_update',finish(draft));
  const evolve={mode:'advance',request_key:'destiny-evolves',expected_revision:1,reason,character_change:{changes:{name:'New synthetic name',destiny:'A newly chosen fictional destiny',gm_notes:`${secret}-evolved`},reason}};
  assert.equal((await f.call('apply_gm_update',evolve)).outcome,'committed');assert.equal((await f.call('apply_gm_update',evolve)).outcome,'replayed');
  const ctx=await f.call('get_game_context',{view:'player',include_birth:true,include_character_history:true,history_limit:1,include_world_history:true,include_chronicle:true});assert.equal(ctx.character.label,'New synthetic name');assert.equal(ctx.birth.character.profile.name,profile.name);assert.equal(ctx.character_history.items.length,1);assert.ok(ctx.character_history.next_after_sequence);assert.ok(!JSON.stringify(ctx).includes(secret));
  const later=await f.call('get_game_context',{include_character_history:true,after_character_change_sequence:ctx.character_history.next_after_sequence});assert.equal(later.character_history.items[0].after_state.destiny,evolve.character_change.changes.destiny);assert.equal(later.gm_private.character_history.items[0].reason,reason);
  assert.deepEqual(later.gm_private.character_profile.narrative,profile.narrative);assert.deepEqual(later.gm_private.character_profile.gm_state,profile.gm_state);
  assert.equal((await f.call('apply_gm_update',{...evolve,request_key:'empty-profile',expected_revision:2,character_change:{changes:{},reason}})).outcome,'invalid_input');
  for(const id of [initial.update_id,(await f.call('get_gm_update',{request_key:evolve.request_key})).update.update_id]) assert.ok(!JSON.stringify((await f.call('get_gm_update',{update_id:id,view:'player'})).update).includes(secret));
  const web=await f.web({include_birth:true,include_character_history:true,include_chronicle:true,dashboard:true});assert.ok(!JSON.stringify(web).includes(secret));assert.equal(web.initialization.status,'completed');assert.equal(web.character_profile.gm_notes,undefined);
  assert.ok(!JSON.stringify((await f.db.query('SELECT arguments FROM tool_calls')).rows).includes(secret));
});

test('numeric/profile schema, OAuth scopes, foreign owner, synthetic gate and request namespace stay strict',async t=>{
  const f=await fixture(t);
  for(const input of [begin({owner_id:'injected'}),begin({character:{profile,xp_total:-1,stats}}),begin({character:{profile,xp_total:0.5,stats}}),begin({character:{profile,xp_total:10,level:2,stats}}),begin({character:{profile:{...profile,species:''},xp_total:10,stats}}),begin({character:{profile,xp_total:10,stats:{...stats,AGI:1}}})]) assert.equal((await f.call('apply_gm_update',input)).outcome,'invalid_input');
  assert.equal((await f.call('apply_gm_update',begin({synthetic:true}))).outcome,'initialization_disabled');
  const roFetcher=(input,init)=>f.app(input instanceof Request ? input : new Request(input,init));const ro=(await login(config.base,config,roFetcher,'life.read')).tokens;
  assert.equal((await f.raw(f.app,begin(),ro.access_token)).outcome,'unauthorized');assert.ok([401,403].includes((await f.raw(f.app,begin(),null)).http_status));
  const draft=await f.call('apply_gm_update',begin());
  await assert.rejects(f.db.transaction(tx=>getGmUpdate(tx,'other-owner',{update_id:draft.update_id})),e=>e.outcome==='not_found');
  await assert.rejects(f.db.transaction(tx=>applyGmUpdate(tx,'other-owner',applyGmSchema.parse(finish(draft)),false)),e=>e.outcome==='not_found');
  await f.call('apply_gm_update',finish(draft));
  assert.equal((await f.call('apply_gm_update',{mode:'advance',request_key:'birth-begin',expected_revision:1,reason,character_change:{changes:{destiny:'Next'},reason}})).outcome,'idempotency_conflict');
  assert.equal((await f.client.listTools()).tools.length,10);
});

test('same-revision concurrent preparations/finalizations commit once and synthetic full births remain distinct',async t=>{
  const f=await fixture(t),syntheticApp=createApp(f.db,{...config,allowSyntheticGame:true}),e=await f.event('test');
  let draft=await f.raw(syntheticApp,begin({synthetic:true,birth_sources:[{event_id:e.id,event_version:e.version,reason}]}));
  const a=prepare(draft,{quest_changes:[line]}),b=prepare(draft,{quest_changes:[{...line,ref:'@other',line_key:'other'}]});
  const results=await Promise.all([f.raw(syntheticApp,a),f.raw(syntheticApp,b)]);assert.deepEqual(results.map(r=>r.outcome).sort(),['initialization_revision_conflict','prepared']);draft=results.find(r=>r.outcome==='prepared');
  const finals=await Promise.all([f.raw(syntheticApp,finish(draft)),f.raw(syntheticApp,finish(draft,{request_key:'other-final'}))]);assert.deepEqual(finals.map(r=>r.outcome).sort(),['already_initialized','committed']);
  assert.equal((await f.web()).kind,'test');assert.equal((await f.call('get_game_context')).kind,'test');assert.equal((await f.db.query('SELECT count(*)::int AS n FROM games')).rows[0].n,1);
});

test('web and GM reads queued during a finalization never return its intermediate live rows',async t=>{
  for(const shouldFail of [false,true]) {
    const f=await fixture(t),draft=await f.call('apply_gm_update',begin());
    let reached,release;
    const checkpoint=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const pausedDb={query:f.db.query,transaction:fn=>f.db.transaction(tx=>fn({query:async(sql,values)=>{
      const result=await tx.query(sql,values);
      if(sql.startsWith('INSERT INTO characters')) {reached();await gate;if(shouldFail) throw new Error('Injected mid-birth failure');}
      return result;
    }}))};
    const committing=f.raw(createApp(pausedDb,config),finish(draft));await checkpoint;
    const web=f.web({include_birth:true}),gm=f.call('get_game_context',{include_birth:true});release();
    const [result,webResult,gmResult]=await Promise.all([committing,web,gm]);
    assert.equal(result.outcome,shouldFail ? 'storage_error' : 'committed');
    for(const value of [webResult,gmResult]) {
      assert.equal(value.initialized,!shouldFail);
      if(shouldFail) {assert.equal(value.character,undefined);assert.equal(value.initialization.status,'preparing');}
      else {assert.ok(value.birth);assert.ok(value.content.current_profession);assert.equal(value.world.entities.items.length,2);}
    }
  }
});
