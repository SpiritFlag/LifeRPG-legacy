import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { login,mcpClient,testEvent } from '../scripts/client.js';
import { applyGmUpdate } from '../src/growth-storage.js';
import { applyGmSchema } from '../src/growth-schema.js';
import { serialized } from '../src/storage.js';

const config=readConfig({PUBLIC_BASE_URL:'https://world.example',OAUTH_CLIENT_SECRET:'client-'.repeat(8),OWNER_LOGIN_KEY:'owner-'.repeat(8),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect',ALLOW_SYNTHETIC_GAME:'true'});
let pg,db,app,client,tokens,legacy,oldInputs,coreBefore,refs;
const fetcher=(input,init)=>app(input instanceof Request ? input : new Request(input,init));
const call=(name,args={})=>client.callTool({name,arguments:args});
const context=async(args={})=>(await call('get_game_context',args)).structuredContent;
const gm=async(args={})=>(await context(args)).gm_private.world;
const player=async(args={})=>context({view:'player',...args});
const event=async(key)=>(await call('record_life_event',{...testEvent,event_key:key})).structuredContent.event;
const judge=(e,fields={})=>({subject:{type:'event',event_id:e.id},sources:[{event_id:e.id,event_version:e.version}],reason:'Synthetic GM judgment',xp_delta:25,...fields});
const entity=(ref,category,key,fields={})=>({operation:'create_entity',ref,category,entity_key:key,kind:category,name:key,reason:'Synthetic entity',...fields});
const fact=(ref,key,fields={})=>({operation:'create_fact',ref,fact_key:key,kind:'event',title:key,body:'Synthetic world history',reason:'Synthetic fact',...fields});
const memory=(ref,key,fields={})=>({operation:'create_memory',ref,memory_key:key,title:key,body:'Remember the unfinished scene',reason:'Synthetic memory',...fields});
const journal=(ref,key,fields={})=>({operation:'create_journal',ref,journal_key:key,title:key,body:'Synthetic adventure narrative',reason:'Synthetic journal',...fields});
const relation=(ref,key,from,to,fields={})=>({operation:'create_relation',ref,relation_key:key,from,to,kind:'GM-defined relationship',reason:'Synthetic relationship',...fields});
const endpoint=id=>({type:'entity',id});
const linkEntity=id=>({type:'entity',id});
const linkFact=id=>({type:'world_fact',id});
const linkQuest=id=>({type:'questline',id});
const linkEvent=e=>({type:'event',event_id:e.id,event_version:e.version});
const op=(operation,fields)=>({operation,reason:'Explicit synthetic GM decision',...fields});
const line=(ref,key)=>({operation:'create_line',ref,line_key:key,title:key,status:'active',reason:'Synthetic story'});
const advance=async(key,world_changes,fields={})=>(await call('apply_gm_update',{mode:'advance',request_key:key,expected_revision:(await context()).revision,reason:'Synthetic world update',world_changes,...fields})).structuredContent;
const initial={mode:'initialize',request_key:'init',expected_revision:0,synthetic:true,reason:'Synthetic fixture',character:{label:'Synthetic world hero',xp_total:0,stats:{STR:10,DEX:10,VIT:10,INT:10,CHA:10,LUK:10}}};
const tables=['world_entities','world_relations','world_facts','gm_memories','adventure_journals','world_fact_links','gm_memory_links','adventure_journal_links','world_clocks','world_change_entries','questlines','quest_change_entries','game_definitions','inventory_entries','gm_updates','gm_adjudications','gm_change_entries'];
const counts=()=>Promise.all(tables.map(async table=>(await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n));
const coreSnapshot=()=>Promise.all(['life_events','life_event_revisions','characters','questlines','gm_updates','oauth_grants','game_definitions','inventory_entries'].map(async table=>(await db.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS value FROM ${table} t`)).rows[0].value));
const raw=(handler,args)=>handler(new Request(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${tokens.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'apply_gm_update',arguments:args}})}));
before(async()=>{
  pg=new PGlite();
  for(const file of ['001-experiment.sql','002-life-event-history.sql','003-gm-growth.sql','004-questlines.sql','005-character-content.sql']) await pg.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  db={query:(sql,values)=>pg.query(sql,values),transaction:fn=>pg.transaction(tx=>fn({query:(sql,values)=>tx.query(sql,values)}))};
  app=createApp(db,config);tokens=(await login(config.base,config,fetcher)).tokens;client=await mcpClient(config.base,tokens.access_token,fetcher);
  legacy=await event('before-006');const created=(await call('apply_gm_update',initial)).structuredContent;
  const prior={mode:'advance',request_key:'prior-combined',expected_revision:created.after.revision,reason:'Existing input without world fields',adjudications:[judge(legacy)],quest_changes:[line('@old','old-story')],content_changes:[{operation:'create_definition',ref:'@old-item',definition_key:'old-item',kind:'item',name:'old-item',reason:'Existing content'},{operation:'grant_inventory',ref:'@old-owned',definition:'@old-item',definition_version:1,acquisition_key:'old-owned',mode:'stack',quantity:2,reason:'Existing reward'}]};
  const previous=(await call('apply_gm_update',prior)).structuredContent;assert.equal(previous.outcome,'committed');
  // Import a synthetic Phase 3B-shaped no-change receipt with no new player projection.
  // Append directly; immutable receipt/history protections are never disabled.
  const legacyInput={mode:'advance',request_key:'legacy-receipt',expected_revision:previous.after.revision,reason:'Legacy receipt',adjudications:[judge(legacy)]};
  const oldResult={outcome:'unchanged',update_id:randomUUID(),request_key:legacyInput.request_key,mode:'advance',reason:'Legacy receipt',before:previous.after,after:previous.after,changes:[{...previous.changes[0],outcome:'duplicate',before_state:previous.after.character,after_state:previous.after.character,xp_delta:0,stats_delta:{STR:0,DEX:0,VIT:0,INT:0,CHA:0,LUK:0},level_delta:0}],quest_changes:[],quest_refs:{},content_changes:[],content_refs:{}};
  const hash=createHash('sha256').update(serialized(applyGmSchema.parse(legacyInput))).digest('hex');
  await db.query('INSERT INTO gm_updates(id,game_id,request_key,input_hash,reason,result) VALUES($1,$2,$3,$4,$5,$6)',[oldResult.update_id,previous.after.game_id,legacyInput.request_key,hash,legacyInput.reason,serialized(oldResult)]);
  oldInputs=[initial,prior,legacyInput];coreBefore=await coreSnapshot();
  await pg.exec(await readFile(new URL('../migrations/006-world-memory.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/007-game-initialization.sql',import.meta.url),'utf8'));
});
after(async()=>{await client?.close();await pg?.close();});

test('006 preserves events, growth, content, quests, receipts and OAuth and generates no world',async()=>{
  assert.deepEqual(await coreSnapshot(),coreBefore);assert.deepEqual((await counts()).slice(0,10),Array(10).fill(0));
  for(const input of oldInputs) assert.equal((await call('apply_gm_update',input)).structuredContent.outcome,'replayed');
  const oldReceipt=(await call('get_gm_update',{request_key:'legacy-receipt'})).structuredContent.update;assert.equal(oldReceipt.player_result,undefined);
  const projected=(await call('get_gm_update',{request_key:'legacy-receipt',view:'player'})).structuredContent.update;assert.equal(projected.reason,undefined);assert.deepEqual(projected.world_changes,[]);
  const c=await context();assert.equal(c.character.xp_total,25);assert.equal(c.content.inventory.items[0].quantity,2);assert.equal(c.world.entities.items.length,0);assert.equal(c.gm_private.world.clock.last_world_advanced_at,null);
  await assert.rejects(pg.exec(await readFile(new URL('../migrations/006-world-memory.sql',import.meta.url),'utf8')));await pg.exec('ROLLBACK');assert.deepEqual(await coreSnapshot(),coreBefore);
});

test('GM creates a root, arbitrary places/factions and NPC affiliations and relations together',async()=>{
  const result=await advance('world-foundation',[
    entity('@root','world','Synthetic World',{kind:'boundless realm',description:'A world independent from reality'}),
    entity('@nation','place','Sea Kingdom',{kind:'country',parent:'@root'}),entity('@city','place','Port',{kind:'floating city',parent:'@nation'}),
    entity('@guild','faction','Tide Guild',{kind:'independent order',parent:'@root',location:'@city'}),
    entity('@captain','npc','Captain',{parent:'@root',location:'@city',affiliation:'@guild',state:{personality:'cautious',background:'formerly a cartographer',situation:'waiting at the port'}}),
    entity('@scholar','npc','Scholar',{parent:'@root',location:'@city'}),
    relation('@allies','captain-scholar',endpoint('@captain'),endpoint('@scholar'),{description:'Former rivals',state:{attitude:'wary'}}),
    relation('@player-bond','captain-player',endpoint('@captain'),{type:'character'},{description:'Trust earned by exploration'}),
    relation('@guild-bond','captain-guild',endpoint('@captain'),endpoint('@guild'),{description:'Member of the guild'}),
  ]);assert.equal(result.outcome,'committed');refs=result.gm_private.world_refs;assert.equal(Object.keys(refs).length,9);assert.deepEqual(result.world_refs,refs);assert.equal(result.gm_private.world_changes.length,9);
  const c=await gm({world_entity_id:refs['@captain']});assert.equal(c.entities.items[0].state.personality,'cautious');assert.equal(c.entities.items[0].location_id,refs['@city']);assert.equal(c.relations.items.length,3);
  const p=await player();assert.equal(p.gm_private,undefined);assert.equal(p.world.entities.items.length,6);
});

test('entity identity and relation changes/endings retain full reasons and before/after history',async()=>{
  const result=await advance('world-evolution',[op('update_entity',{entity:refs['@captain'],changes:{name:'Captain of the Tide',status:'returned from expedition',state:{personality:'steadfast',background:'cartographer',situation:'preparing a voyage'}}}),op('update_relation',{relation:refs['@allies'],changes:{description:'Reconciled allies',state:{attitude:'trusting'}}}),op('update_relation',{relation:refs['@guild-bond'],changes:{active:false},reason:'The captain resigned voluntarily'})]);
  assert.equal(result.world_changes.length,3);assert.equal(result.gm_private.world_changes[0].target_id,refs['@captain']);assert.equal(result.gm_private.world_changes[2].before_state.active,true);assert.equal(result.gm_private.world_changes[2].after_state.active,false);
  const history=(await gm({world_entity_id:refs['@captain'],include_world_history:true})).history.items;assert.equal(history[0].after_state.name,'Captain');assert.equal(history.at(-1).after_state.name,'Captain of the Tide');
  const relationHistory=(await gm({include_world_history:true,world_limit:50})).history.items.filter(h=>h.target_id===refs['@guild-bond']);assert.equal(relationHistory.at(-1).reason,'The captain resigned voluntarily');
});

test('wrong references, hierarchy categories, self links and multi-entity cycles roll back',async()=>{
  const bad=[
    [[entity('@bad','place','missing-parent',{parent:randomUUID()})],'world_not_found'],
    [[entity('@bad','place','no-parent')],'invalid_world_hierarchy'],
    [[entity('@bad','place','npc-parent',{parent:refs['@captain']})],'invalid_world_hierarchy'],
    [[op('update_entity',{entity:refs['@city'],changes:{parent:refs['@city']}})],'world_hierarchy_cycle'],
    [[op('update_entity',{entity:refs['@nation'],changes:{parent:refs['@city']}})],'world_hierarchy_cycle'],
    [[op('update_entity',{entity:refs['@city'],changes:{location:refs['@nation']}}),op('update_entity',{entity:refs['@nation'],changes:{location:refs['@city']}})],'world_hierarchy_cycle'],
    [[entity('@new-faction','faction','cycle-faction',{parent:refs['@root'],affiliation:refs['@guild']}),op('update_entity',{entity:refs['@guild'],changes:{affiliation:'@new-faction'}})],'world_hierarchy_cycle'],
    [[op('update_entity',{entity:refs['@captain'],changes:{affiliation:refs['@city']}})],'invalid_world_hierarchy'],
    [[entity('@other','world','Another root')],'world_root_conflict'],
    [[relation('@bad','self-npc',endpoint(refs['@captain']),endpoint(refs['@captain']))],'invalid_world_relation'],
    [[relation('@bad','no-npc',endpoint(refs['@guild']),{type:'character'})],'invalid_world_relation'],
    [[entity('@new','place','must-rollback',{parent:refs['@root']}),memory('@wrong','wrong-source',{links:[linkEntity('@absent')]})],'world_reference_conflict'],
    [[memory('@m','wrong-type'),journal('@j','wrong-type-source',{links:[linkEntity('@m')]})],'world_reference_conflict'],
  ];
  for(let i=0;i<bad.length;i++){const before=await counts(),revision=(await context()).revision;assert.equal((await advance(`invalid-world-${i}`,bad[i][0])).outcome,bad[i][1]);assert.deepEqual(await counts(),before);assert.equal((await context()).revision,revision);}
  assert.equal((await advance('valid-cross-hierarchy',[op('update_entity',{entity:refs['@city'],changes:{affiliation:refs['@guild']}})])).outcome,'committed');
});

test('canon, NPC claims/beliefs and historical corrections preserve prior truth and world times',async()=>{
  const result=await advance('world-truth',[
    fact('@history','old-history',{kind:'history',body:'The guild founded the port',world_time:{label:'Era of Tides, year 12',order:12},links:[linkEntity(refs['@city'])]}),
    fact('@claim','captain-claim',{kind:'setting',truth:'claim',speaker:refs['@captain'],body:'The captain claims a second archive exists'}),
    fact('@belief','scholar-belief',{kind:'foreshadowing',truth:'belief',speaker:refs['@scholar'],body:'The scholar believes the seal will break'}),
  ]);Object.assign(refs,result.gm_private.world_refs);
  const fixed=await advance('correct-history',[op('update_fact',{fact:refs['@history'],changes:{body:'The port predates the guild',world_time:{label:'Before the Tide Era',order:-5}},reason:'A recovered chronicle corrects the founding date'})]);
  assert.equal(fixed.gm_private.world_changes[0].before_state.world_time.order,12);assert.equal(fixed.gm_private.world_changes[0].after_state.world_time.order,-5);
  const h=(await gm({world_fact_id:refs['@history'],include_world_history:true})).history.items;assert.equal(h.length,2);assert.equal(h[0].after_state.body,'The guild founded the port');assert.equal(h[1].reason,'A recovered chronicle corrects the founding date');assert.ok(h[1].recorded_at);
  assert.equal((await advance('claim-no-speaker',[fact('@bad','no-speaker',{truth:'claim'})])).outcome,'invalid_world_truth');
  assert.equal((await advance('claim-wrong-speaker',[fact('@bad','wrong-speaker',{truth:'belief',speaker:refs['@city']})])).outcome,'invalid_world_truth');
  const canon=await advance('claim-confirmed',[op('update_fact',{fact:refs['@claim'],changes:{truth:'canon',speaker:null}})]);assert.equal(canon.gm_private.world_changes[0].before_state.truth,'claim');assert.equal(canon.gm_private.world_changes[0].after_state.truth,'canon');
});

test('private snapshots, nested GM JSON, reasons, links, summaries and receipts stay outside player results',async()=>{
  const secret='SECRET-NEVER-PUBLISH',result=await advance('secret-separation',[
    entity('@hidden','npc','Hidden Agent',{parent:refs['@root'],visibility:'gm',description:secret,gm_notes:secret,gm_state:{nested:{secret}}}),
    op('update_entity',{entity:refs['@captain'],changes:{gm_notes:secret,gm_state:{nested:{secret}}},reason:secret}),
    fact('@secret','secret-truth',{kind:'foreshadowing',body:secret,visibility:'gm',gm_notes:secret,links:[linkEntity('@hidden')]}),
    relation('@secret-relation','hidden-relationship',endpoint(refs['@captain']),endpoint('@hidden'),{visibility:'player',description:secret}),
    memory('@secret-memory','secret-memory',{body:secret,links:[linkFact('@secret')]}),
    journal('@public-journal','public-with-private-metadata',{body:'The captain prepared for a voyage',gm_notes:secret,gm_state:{nested:[secret]},links:[linkEntity(refs['@captain']),linkEntity('@hidden'),linkFact('@secret')]}),
    journal('@hidden-journal','secret-journal',{visibility:'gm',body:secret}),
  ],{reason:secret});Object.assign(refs,result.gm_private.world_refs);
  assert.ok(JSON.stringify(result.gm_private).includes(secret));assert.ok(!JSON.stringify(result.player_result).includes(secret));assert.equal(result.world_refs['@hidden'],undefined);assert.equal(result.world_refs['@secret-relation'],undefined);
  assert.ok(!result.world_changes.some(c=>c.target_id===refs['@captain']));
  const p=await player({include_world_history:true,include_chronicle:true,world_limit:50});assert.ok(!JSON.stringify(p).includes(secret));assert.equal(p.gm_private,undefined);
  const publicJournal=p.world.journals.items.find(j=>j.id===refs['@public-journal']);assert.deepEqual(publicJournal.links,[linkEntity(refs['@captain'])]);
  const searched=await player({world_query:secret,world_limit:50});for(const key of ['entities','relations','facts','memories','journals']) assert.equal(searched.world[key].items.length,0);
  assert.equal((await player({world_fact_id:refs['@secret']})).outcome,'world_not_found');
  assert.ok((await gm({world_fact_id:refs['@secret']})).facts.items.some(f=>f.body===secret));
  const saved=(await call('get_gm_update',{request_key:'secret-separation',view:'player'})).structuredContent.update;assert.ok(!JSON.stringify(saved).includes(secret));assert.deepEqual(saved,result.player_result);
});

test('reveal and conceal are explicit and public history never reveals formerly private text',async()=>{
  const result=await advance('reveal-secret',[op('update_fact',{fact:refs['@secret'],changes:{visibility:'player',body:'The seal protects a lost archive'},reason:'GM reveals the safe public truth'})]);
  assert.equal(result.world_changes[0].before_state,null);assert.equal(result.world_changes[0].after_state.body,'The seal protects a lost archive');assert.ok(result.world_changes[0].after_state.revealed_at);
  const p=await player({world_fact_id:refs['@secret'],include_world_history:true,world_limit:50});assert.ok(!JSON.stringify(p).includes('SECRET-NEVER-PUBLISH'));assert.equal(p.world.facts.items[0].body,'The seal protects a lost archive');assert.equal(p.world.history.items[0].before_state,null);
  const hidden=await advance('conceal-secret',[op('update_fact',{fact:refs['@secret'],changes:{visibility:'gm',body:'SECRET-SECOND-TRUTH'},reason:'SECRET-PRIVATE-REASON'})]);assert.equal(hidden.world_changes[0].after_state,null);assert.ok(!JSON.stringify(hidden.player_result).includes('SECRET-SECOND-TRUTH'));assert.ok(!JSON.stringify(hidden.player_result).includes('SECRET-PRIVATE-REASON'));
  const history=await player({include_world_history:true,world_limit:50});assert.ok(!JSON.stringify(history).includes('SECRET-SECOND-TRUTH'));
});

test('long-term memory updates, deactivation and linked event versions retain originals',async()=>{
  const created=await advance('memory-continuity',[memory('@continuity','continuity',{body:'Continue the port story',links:[linkEntity(refs['@captain']),linkFact(refs['@history']),linkEvent(legacy)]})]);const id=created.gm_private.world_refs['@continuity'];
  const updated=await advance('memory-new-scene',[op('update_memory',{memory:id,changes:{body:'Next scene: the sunken archive',links:[linkEntity(refs['@scholar']),linkEvent(legacy)]}})]);assert.equal(updated.gm_private.world_changes[0].before_state.body,'Continue the port story');
  await advance('memory-deactivate',[op('update_memory',{memory:id,changes:{active:false}})]);
  assert.ok(!(await gm()).memories.items.some(m=>m.id===id));assert.ok((await gm({memory_active:false})).memories.items.some(m=>m.id===id));
  const focused=await gm({memory_id:id,include_world_history:true});assert.equal(focused.memories.items[0].active,false);assert.equal(focused.history.items.length,3);assert.equal(focused.history.items[0].after_state.links.find(l=>l.type==='event').event_version,1);
  const original=(await call('get_life_event',{event_id:legacy.id})).structuredContent;assert.equal(original.event.version,1);assert.equal(original.revisions[0].evidence,testEvent.evidence);
  const linksOnly=await advance('memory-links-only',[op('update_memory',{memory:id,changes:{links:[]}})]);assert.equal(linksOnly.outcome,'committed');assert.deepEqual((await gm({memory_id:id})).memories.items[0].links,[]);
});

test('same-request journals link quests, independent reality events and new world history',async()=>{
  const dives=await Promise.all(['dive-1','dive-2','dive-3'].map(k=>event(k)));
  const result=await advance('journal-expedition',[
    entity('@island','place','New Island',{kind:'island',parent:refs['@root']}),entity('@guide','npc','New Guide',{parent:refs['@root'],location:'@island'}),
    fact('@voyage','world-voyage',{body:'An expedition reached the archive',world_time:{label:'Tide Era, day 20',order:20},links:[linkEntity('@island'),linkQuest('@ocean'),...dives.map(linkEvent)]}),
    journal('@log','ocean-log',{body:'Three dives inspired an expedition in the fantasy world',world_time:{label:'Tide Era, day 20',order:20},links:[linkEntity('@guide'),linkFact('@voyage'),linkQuest('@ocean'),...dives.map(linkEvent)]}),
    journal('@other-log','other-story-log',{body:'Another storyline continues concurrently',links:[linkQuest('@craft')]}),
    memory('@trip-memory','trip-memory',{links:[linkFact('@voyage'),linkQuest('@ocean')]}),
  ],{quest_changes:[line('@ocean','ocean-story'),line('@craft','craft-story')]});Object.assign(refs,result.gm_private.world_refs);Object.assign(refs,result.quest_refs);
  const c=await gm({journal_id:refs['@log']});assert.equal(c.journals.items[0].links.filter(l=>l.type==='event').length,3);assert.equal(c.journals.items[0].links.find(l=>l.type==='world_fact').id,refs['@voyage']);
  const related=await gm({event_id:dives[0].id});assert.ok(related.journals.items.some(j=>j.id===refs['@log']));assert.ok(related.facts.items.some(f=>f.id===refs['@voyage']));
  const factRelated=await gm({world_fact_id:refs['@voyage']});assert.deepEqual(factRelated.memories.items.map(m=>m.id),[refs['@trip-memory']]);assert.deepEqual(factRelated.journals.items.map(j=>j.id),[refs['@log']]);
  for(const dive of dives) assert.equal((await call('get_life_event',{event_id:dive.id})).structuredContent.event.version,1);
});

test('chronicle paginates multiple stories and keeps recorded, real occurrence and world time separate',async()=>{
  for(const order of ['recorded','occurred','world']) {
    let cursor,ids=[],loops=0;
    do {const w=await gm({include_chronicle:true,chronicle_order:order,world_limit:2,...(cursor ? {after_chronicle:cursor} : {})});const c=w.chronicle;ids.push(...c.items.map(r=>`${r.type}:${r.id}`));cursor=c.next_cursor;assert.ok(++loops<30);}while(cursor);
    assert.equal(new Set(ids).size,ids.length);assert.ok(ids.some(k=>k===`journal:${refs['@log']}`));assert.ok(ids.some(k=>k===`journal:${refs['@other-log']}`));
  }
  const ordered=(await gm({include_chronicle:true,chronicle_order:'world',world_limit:50})).chronicle.items;const known=ordered.filter(r=>r.world_time?.order!==null && r.world_time?.order!==undefined);assert.deepEqual(known.map(r=>r.world_time.order),[...known.map(r=>r.world_time.order)].sort((a,b)=>a-b));
  const real=(await gm({include_chronicle:true,chronicle_order:'occurred',world_limit:50})).chronicle.items.find(r=>r.type==='life_event');assert.equal(real.occurrence_basis,'date_helper');assert.equal(real.value.occurred_start,null);assert.equal(real.value.reported_at,null);assert.equal(real.world_time,null);
  const worldRow=ordered.find(r=>r.id===refs['@voyage']);assert.equal(worldRow.value.world_time.label,'Tide Era, day 20');assert.ok(worldRow.recorded_at);assert.equal(worldRow.value.occurred_start,undefined);
  const scoped=(await gm({questline_id:refs['@ocean'],include_chronicle:true,world_limit:50})).chronicle.items;assert.ok(scoped.some(r=>r.id===refs['@log']));assert.ok(!scoped.some(r=>r.id===refs['@other-log']));
  assert.equal((await context({include_chronicle:true,after_chronicle:'not-a-cursor'})).outcome,'invalid_input');
  const first=(await gm({include_chronicle:true,world_limit:1})).chronicle;assert.equal((await context({include_chronicle:true,chronicle_order:'world',after_chronicle:first.next_cursor})).outcome,'invalid_input');
});

test('world progression is explicit, elapsed real time is visible and no XP/actions run automatically',async()=>{
  const before=await context();assert.equal(before.world.clock.last_world_advanced_at,null);
  const revision=before.revision,result=await advance('explicit-world-time',[op('advance_world',{world_time:{label:'Tide Era, morning 21',order:21}})],{expected_revision:revision});assert.equal(result.outcome,'committed');assert.equal(result.after.character.xp_total,before.character.xp_total);
  const clock=(await gm()).clock;assert.equal(clock.world_time.order,21);assert.ok(clock.elapsed_real_ms>=0);assert.ok(clock.server_time_utc);assert.ok(clock.last_world_advanced_at);
  const replay=await advance('explicit-world-time',[op('advance_world',{world_time:{label:'Tide Era, morning 21',order:21}})],{expected_revision:revision});assert.equal(replay.outcome,'replayed');assert.equal((await gm()).clock.last_world_advanced_at,clock.last_world_advanced_at);
  const observed=await context();assert.equal(observed.revision,result.after.revision);assert.deepEqual(observed.character,result.after.character);
  await advance('unknown-world-time',[op('advance_world',{world_time:null})]);assert.equal((await gm()).clock.world_time,null);
  const n=await counts();assert.equal((await advance('duplicate-clock-op',[op('advance_world',{world_time:null}),op('advance_world',{world_time:null})])).outcome,'invalid_input');assert.deepEqual(await counts(),n);
});

test('growth, quests, inventory, world, NPC memory and journal commit with one receipt and version',async()=>{
  const e=await event('whole-game-update'),before=await context();
  const result=await advance('whole-game-update',[entity('@shore','place','Distant Shore',{parent:refs['@root']}),entity('@npc','npc','Shore Guardian',{parent:refs['@root'],location:'@shore'}),fact('@arrival','arrival-history',{links:[linkEntity('@shore'),linkEvent(e)]}),memory('@m','arrival-memory',{links:[linkEntity('@npc'),linkFact('@arrival'),linkQuest('@line')]}),journal('@j','arrival-journal',{links:[linkFact('@arrival'),linkQuest('@line'),linkEvent(e)]})],{adjudications:[judge(e,{xp_delta:100,stats_delta:{DEX:2}})],quest_changes:[line('@line','arrival-story')],content_changes:[{operation:'create_definition',ref:'@item',definition_key:'shore-item',kind:'item',name:'Shore Pearl',reason:'Synthetic reward'},{operation:'grant_inventory',ref:'@owned',definition:'@item',definition_version:1,acquisition_key:'shore-reward',mode:'individual',reason:'Synthetic reward'}]});
  assert.equal(result.outcome,'committed');assert.equal(result.after.revision,before.revision+1);assert.equal(result.after.character.xp_total,before.character.xp_total+100);assert.equal(result.after.character.stats.DEX,12);assert.equal(result.quest_changes.length,1);assert.equal(result.content_changes.length,2);assert.equal(result.gm_private.world_changes.length,5);
  const saved=(await call('get_gm_update',{update_id:result.update_id})).structuredContent.update;assert.deepEqual(saved.gm_private,result.gm_private);assert.deepEqual(saved.player_result,result.player_result);
});

test('stable world keys, exact retries and game version conflicts prevent duplicate state',async()=>{
  const operations=[entity('@stable','place','stable-place',{parent:refs['@root']})],revision=(await context()).revision;
  const first=await advance('stable-world',operations,{expected_revision:revision}),replay=await advance('stable-world',operations,{expected_revision:revision});assert.equal(replay.outcome,'replayed');assert.deepEqual(replay.gm_private,first.gm_private);
  const again=await advance('stable-world-other-request',operations);assert.equal(again.outcome,'unchanged');assert.deepEqual(again.gm_private.world_refs,first.gm_private.world_refs);
  assert.equal((await advance('stable-world-different-content',[entity('@stable','place','stable-place',{parent:refs['@root'],name:'Other place'})])).outcome,'world_identity_conflict');
  assert.equal((await advance('stable-world',[entity('@x','place','new-place',{parent:refs['@root']})],{expected_revision:revision})).outcome,'idempotency_conflict');
  const current=(await context()).revision,results=await Promise.all([advance('world-race-a',[memory('@a','race-a')],{expected_revision:current}),advance('world-race-b',[memory('@b','race-b')],{expected_revision:current})]);assert.deepEqual(results.map(r=>r.outcome).sort(),['committed','revision_conflict']);
});

test('late world errors and storage failures roll back every growth/story/content/world change',async()=>{
  for(const prefix of ['INSERT INTO world_entities','INSERT INTO world_relations','INSERT INTO world_facts','INSERT INTO gm_memories','INSERT INTO adventure_journals','INSERT INTO world_fact_links','INSERT INTO world_change_entries','INSERT INTO world_clocks','UPDATE characters','INSERT INTO gm_updates','INSERT INTO tool_calls']) {
    const e=await event(`world-failure-${prefix}`),before=await context(),n=await counts();
    const args={mode:'advance',request_key:`world-failure-${prefix}`,expected_revision:before.revision,reason:'Combined atomic synthetic test',adjudications:[judge(e)],quest_changes:[line('@l',`world-failure-${prefix}`)],content_changes:[{operation:'create_definition',ref:'@item',definition_key:`world-item-${prefix}`,kind:'item',name:'Synthetic item',reason:'Synthetic'},{operation:'grant_inventory',ref:'@own',definition:'@item',definition_version:1,acquisition_key:`world-item-${prefix}`,mode:'individual',reason:'Synthetic'}],world_changes:[entity('@npc','npc',`world-npc-${prefix}`,{parent:refs['@root']}),relation('@r',`world-relation-${prefix}`,endpoint('@npc'),{type:'character'}),fact('@f',`world-fact-${prefix}`,{links:[linkEntity('@npc'),linkEvent(e)]}),memory('@m',`world-memory-${prefix}`,{links:[linkFact('@f')]}),journal('@j',`world-journal-${prefix}`,{links:[linkQuest('@l'),linkFact('@f')]}),op('advance_world',{world_time:null})]};
    const failingDb={query:db.query,transaction:fn=>db.transaction(tx=>fn({query:(sql,values)=>{if(sql.startsWith(prefix)) throw new Error('Injected failure');return tx.query(sql,values);}}))};
    const response=(await (await raw(createApp(failingDb,config),args)).json()).result;assert.equal(response.structuredContent.outcome,'storage_error');assert.deepEqual(await counts(),n);const after=await context();assert.deepEqual(after.character,before.character);assert.equal(after.revision,before.revision);
    assert.equal((await call('apply_gm_update',args)).structuredContent.outcome,'committed');
  }
  const e=await event('late-world-source-error'),before=await context(),n=await counts();
  const bad=await advance('late-world-source-error',[entity('@new','place','late-rollback',{parent:refs['@root']}),journal('@j','late-rollback-log',{links:[linkFact(randomUUID())]})],{adjudications:[judge(e)],quest_changes:[line('@l','late-world-rollback')]});assert.equal(bad.outcome,'world_not_found');assert.deepEqual(await counts(),n);assert.deepEqual((await context()).character,before.character);
});

test('world and history queries are bounded, focused and searchable without replacing source histories',async()=>{
  const first=await gm({world_limit:1,include_world_history:true});for(const section of ['entities','relations','facts','memories','journals','history']) {assert.equal(first[section].items.length,1);assert.ok(first[section].next_after_sequence);}
  const next=await gm({world_limit:1,after_world_entity_sequence:first.entities.next_after_sequence,after_world_relation_sequence:first.relations.next_after_sequence,after_world_fact_sequence:first.facts.next_after_sequence,after_memory_sequence:first.memories.next_after_sequence,after_journal_sequence:first.journals.next_after_sequence,include_world_history:true,after_world_change_sequence:first.history.next_after_sequence});
  for(const section of ['entities','relations','facts','memories','journals','history']) assert.ok(next[section].items[0].sequence>first[section].items[0].sequence);
  const search=await gm({world_query:'Captain',world_limit:50});assert.ok(search.entities.items.some(e=>e.id===refs['@captain']));assert.ok(search.entities.items.length<first.entities.items.length+20);
  await assert.rejects(db.query('DELETE FROM world_change_entries WHERE target_id=$1',[refs['@captain']]));
  const c=await context();assert.equal(c.content.inventory.items.find(i=>i.acquisition_key==='old-owned').quantity,2);assert.ok(c.questlines.some(q=>q.line_key==='old-story'));
});

test('strict inputs, source integrity, OAuth scopes and foreign world references are rejected',async()=>{
  const invalids=[fact('@bad','bad-time',{world_time:{label:'made-up',order:1.5}}),entity('@bad','place','unknown-field',{parent:refs['@root'],owner_id:'forged'}),memory('@bad','deep-state',{gm_state:{a:{b:{c:{d:{e:'x'}}}}}})];
  for(let i=0;i<invalids.length;i++) assert.equal((await advance(`strict-world-${i}`,[invalids[i]])).outcome,'invalid_input');
  assert.equal((await advance('bad-event-version',[journal('@bad','bad-version',{links:[{type:'event',event_id:legacy.id,event_version:99}]})])).outcome,'invalid_world_source');
  const real=(await call('record_life_event',{...testEvent,event_key:'real-classification',kind:'real'})).structuredContent.event;
  assert.equal((await advance('real-test-source',[journal('@bad','real-test-source',{links:[linkEvent(real)]})])).outcome,'invalid_world_source');
  const foreign=await db.transaction(tx=>applyGmUpdate(tx,'foreign-world-owner',applyGmSchema.parse(initial),true));
  const root=await db.transaction(tx=>applyGmUpdate(tx,'foreign-world-owner',applyGmSchema.parse({mode:'advance',request_key:'foreign-world',expected_revision:foreign.after.revision,reason:'Foreign synthetic fixture',world_changes:[entity('@world','world','foreign-world')]}),true));const id=root.gm_private.world_refs['@world'];
  assert.equal((await context({world_entity_id:id})).outcome,'world_not_found');assert.equal((await advance('foreign-world-update',[op('update_entity',{entity:id,changes:{name:'Forged'}})])).outcome,'world_not_found');
  assert.equal((await client.listTools()).tools.length,9);const readerTokens=(await login(config.base,config,fetcher,'life.read')).tokens,reader=await mcpClient(config.base,readerTokens.access_token,fetcher);
  try{assert.equal((await reader.callTool({name:'get_game_context',arguments:{view:'player'}})).isError,false);assert.equal((await reader.callTool({name:'apply_gm_update',arguments:{mode:'advance',request_key:'blocked-world',expected_revision:1,reason:'blocked',world_changes:[memory('@m','blocked')]}})).isError,true);}finally{await reader.close();}
  const audit=(await db.query("SELECT arguments FROM tool_calls WHERE tool='apply_gm_update' AND arguments->>'request_key'='secret-separation'")).rows[0].arguments;assert.equal(audit.world_changes[0].operation,'create_entity');assert.equal(audit.world_changes[0].gm_notes,undefined);assert.equal(audit.world_changes[0].description,undefined);
});
