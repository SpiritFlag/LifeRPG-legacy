import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { login,mcpClient,testEvent } from '../scripts/client.js';
import { applyGmUpdate } from '../src/growth-storage.js';
import { applyGmSchema } from '../src/growth-schema.js';

const config=readConfig({PUBLIC_BASE_URL:'https://content.example',OAUTH_CLIENT_SECRET:'client-'.repeat(8),OWNER_LOGIN_KEY:'owner-'.repeat(8),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect',ALLOW_SYNTHETIC_GAME:'true'});
let pg,db,app,client,tokens,legacy,oldGrowth,oldQuest,refs,coreBefore;
const fetcher=(input,init)=>app(input instanceof Request ? input : new Request(input,init));
const call=(name,args={})=>client.callTool({name,arguments:args});
const context=async(args={})=>(await call('get_game_context',args)).structuredContent;
const event=async(key)=>(await call('record_life_event',{...testEvent,event_key:key})).structuredContent.event;
const judge=(e,fields={})=>({subject:{type:'event',event_id:e.id},sources:[{event_id:e.id,event_version:e.version}],reason:'Synthetic content reward',xp_delta:25,...fields});
const define=(ref,kind,key,fields={})=>({operation:'create_definition',ref,kind,definition_key:key,name:key,reason:'GM-created synthetic definition',...fields});
const grant=(ref,definition,key,fields={})=>({operation:'grant_feature',ref,definition,definition_version:1,acquisition_key:key,reason:'Synthetic acquisition',...fields});
const item=(ref,definition,key,fields={})=>({...grant(ref,definition,key),operation:'grant_inventory',mode:'individual',...fields});
const op=(operation,fields)=>({operation,reason:'Explicit synthetic GM decision',...fields});
const line=(ref,key)=>({operation:'create_line',ref,line_key:key,title:key,status:'active',reason:'Synthetic story'});
const advance=async(key,content_changes,fields={})=>(await call('apply_gm_update',{mode:'advance',request_key:key,expected_revision:(await context()).revision,reason:'Synthetic content update',content_changes,...fields})).structuredContent;
const tables=['game_definitions','game_definition_versions','character_features','inventory_entries','content_change_entries','questlines','quest_nodes','quest_change_entries','gm_updates','gm_adjudications','gm_change_entries'];
const counts=()=>Promise.all(tables.map(async table=>(await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n));
const coreSnapshot=()=>Promise.all(['life_events','life_event_revisions','characters','questlines','gm_updates','oauth_grants'].map(async table=>(await db.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS snapshot FROM ${table} t`)).rows[0].snapshot));
const focusedFeature=async id=>(await context({feature_id:id,include_content_history:true,content_limit:50})).content;
const focusedItem=async id=>(await context({inventory_id:id,include_content_history:true,content_limit:50})).content;
const raw=(handler,args)=>handler(new Request(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${tokens.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'apply_gm_update',arguments:args}})}));
const initial={mode:'initialize',request_key:'init',expected_revision:0,synthetic:true,reason:'Synthetic fixture',character:{label:'Synthetic content hero',xp_total:0,stats:{STR:10,DEX:10,VIT:10,INT:10,CHA:10,LUK:10}}};
before(async()=>{
  pg=new PGlite();
  for(const file of ['001-experiment.sql','002-life-event-history.sql','003-gm-growth.sql','004-questlines.sql']) await pg.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  db={query:(sql,values)=>pg.query(sql,values),transaction:fn=>pg.transaction(tx=>fn({query:(sql,values)=>tx.query(sql,values)}))};
  app=createApp(db,config);tokens=(await login(config.base,config,fetcher)).tokens;client=await mcpClient(config.base,tokens.access_token,fetcher);
  legacy=await event('before-005');
  const initialized=(await call('apply_gm_update',initial)).structuredContent;
  oldGrowth={mode:'advance',request_key:'before-005-growth',expected_revision:initialized.after.revision,reason:'Existing growth without content fields',adjudications:[judge(legacy)]};
  const growth=(await call('apply_gm_update',oldGrowth)).structuredContent;
  oldQuest={mode:'advance',request_key:'before-005-quest',expected_revision:growth.after.revision,reason:'Existing story without content fields',quest_changes:[line('@legacy','existing-story')]};
  assert.equal((await call('apply_gm_update',oldQuest)).structuredContent.outcome,'committed');
  coreBefore=await coreSnapshot();
  await pg.exec(await readFile(new URL('../migrations/005-character-content.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/006-world-memory.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/007-game-initialization.sql',import.meta.url),'utf8'));
});
after(async()=>{await client?.close();await pg?.close();});

test('005 preserves prior events, growth, quest IDs, receipts and OAuth without generating content',async()=>{
  assert.deepEqual(await coreSnapshot(),coreBefore);
  const c=await context();assert.equal(c.character.xp_total,25);assert.equal(c.questlines[0].line_key,'existing-story');
  assert.deepEqual(c.base_stats,c.character.stats);assert.deepEqual(c.display_stats,c.base_stats);
  assert.deepEqual((await counts()).slice(0,5),[0,0,0,0,0]);assert.equal(c.content.current_profession,null);
  for(const input of [initial,oldGrowth,oldQuest]) assert.equal((await call('apply_gm_update',input)).structuredContent.outcome,'replayed');
  const e=(await call('get_life_event',{event_id:legacy.id})).structuredContent;assert.equal(e.event.version,1);assert.equal(e.revisions[0].evidence,testEvent.evidence);
  await assert.rejects(pg.exec(await readFile(new URL('../migrations/005-character-content.sql',import.meta.url),'utf8')));await pg.exec('ROLLBACK');
  assert.equal((await context()).character.xp_total,25);
});

test('GM creates all seven kinds and grants new definitions through same-request typed refs',async()=>{
  const changes=[];
  for(const kind of ['profession','skill','trait','equipment','item','title','achievement']) changes.push(define(`@${kind}`,kind,`free-${kind}`,{description:`GM original ${kind}`,settings:{effect:'GM chooses its meaning',conditions:['No fixed tree'],details:{rarity:'unique'}}}));
  changes.push(grant('@career','@profession','career-first',{operation:'change_profession'}),grant('@ability','@skill','ability-first',{mastery:3,grade:'novice',state:{technique:'breathing'}}),grant('@passive','@trait','passive-first'),grant('@honor','@title','honor-first'),grant('@medal','@achievement','medal-first'),item('@blade','@equipment','blade-first',{durability:50,max_durability:100,grade:'rare'}),item('@potions','@item','potions-first',{mode:'stack',quantity:3}));
  const result=await advance('all-kinds',changes);assert.equal(result.outcome,'committed');refs=result.content_refs;assert.equal(Object.keys(refs).length,14);
  const c=await context();assert.equal(c.content.features.items.length,5);assert.equal(c.content.inventory.items.length,2);assert.equal(c.content.current_profession.id,refs['@career']);
  assert.equal(c.content.features.items.find(f=>f.id===refs['@ability']).definition.version,1);
  const detail=await focusedFeature(refs['@ability']);assert.equal(detail.features.items[0].state.technique,'breathing');assert.equal(detail.features.items[0].definition.settings.details.rarity,'unique');
  const receipt=(await call('get_gm_update',{update_id:result.update_id})).structuredContent.update;assert.deepEqual(receipt.content_changes,result.content_changes);assert.deepEqual(receipt.content_refs,refs);assert.deepEqual(receipt.stat_effects,result.stat_effects);
});

test('profession change ends prior occupation and preserves reasons and acquisition history',async()=>{
  const result=await advance('new-career',[define('@navigator','profession','Navigator',{settings:{conditions:'GM decides'}}),grant('@new','@navigator','career-next',{operation:'change_profession',reason:'The GM promotes the explorer'})]);
  assert.equal(result.content_changes.length,3);assert.equal(result.content_changes[1].before_state.status,'active');assert.equal(result.content_changes[1].after_state.status,'ended');
  const old=await focusedFeature(refs['@career']);assert.equal(old.features.items[0].status,'ended');assert.ok(old.features.items[0].ended_at);assert.equal(old.history.items.at(-1).reason,'The GM promotes the explorer');
  const c=await context({feature_statuses:['active','lost','ended']});assert.equal(c.content.features.items.filter(f=>f.kind==='profession' && f.status==='active').length,1);assert.equal(c.content.current_profession.id,result.content_refs['@new']);
  const duplicate=await advance('old-career-retry',[grant('@old',refs['@profession'],'career-first',{operation:'change_profession'})]);assert.equal(duplicate.outcome,'unchanged');assert.equal((await context()).content.current_profession.id,result.content_refs['@new']);
});

test('skill, trait, title and achievement mastery/grade changes and losses remain queryable',async()=>{
  const updated=await advance('skill-training',[op('update_feature',{feature:refs['@ability'],changes:{mastery:8,grade:'adept',state:{technique:'new technique'}}})]);
  assert.equal(updated.content_changes[0].before_state.mastery,3);assert.equal(updated.content_changes[0].after_state.mastery,8);
  const losses=await advance('feature-losses',['@ability','@passive','@honor','@medal'].map(k=>op('lose_feature',{feature:refs[k]})));assert.equal(losses.content_changes.length,4);
  for(const k of ['@ability','@passive','@honor','@medal']) {const d=await focusedFeature(refs[k]);assert.equal(d.features.items[0].status,'lost');assert.ok(d.history.items.some(h=>h.after_state.status==='lost'));}
  assert.equal((await advance('historical-training',[op('update_feature',{feature:refs['@ability'],changes:{mastery:9}})])).outcome,'feature_inactive');
  const reacquired=await advance('skill-reacquire',[grant('@regained',refs['@skill'],'skill-new-acquisition',{mastery:10,grade:'adept'})]);assert.notEqual(reacquired.content_refs['@regained'],refs['@ability']);
  assert.equal((await advance('double-active-skill',[grant('@bad',refs['@skill'],'another-active-skill')])).outcome,'feature_already_owned');
  assert.equal((await advance('repeat-loss',[op('lose_feature',{feature:refs['@ability']})])).outcome,'unchanged');
});

test('inventory quantity increments, consumption and loss preserve entries and stable grant identity',async()=>{
  assert.equal((await advance('potions-add',[op('adjust_quantity',{entry:refs['@potions'],quantity_delta:2})])).content_changes[0].after_state.quantity,5);
  assert.equal((await advance('potions-consume',[op('adjust_quantity',{entry:refs['@potions'],quantity_delta:-5})])).content_changes[0].after_state.status,'lost');
  const duplicate=await advance('potions-grant-again',[item('@same',refs['@item'],'potions-first',{mode:'stack',quantity:3})]);assert.equal(duplicate.outcome,'unchanged');assert.equal(duplicate.content_refs['@same'],refs['@potions']);assert.equal(duplicate.content_changes[0].after_state.quantity,0);
  assert.equal((await advance('underflow',[op('adjust_quantity',{entry:refs['@potions'],quantity_delta:-1})])).outcome,'invalid_inventory_quantity');
  const restored=await advance('explicit-restock',[op('adjust_quantity',{entry:refs['@potions'],quantity_delta:4})]);assert.equal(restored.content_changes[0].after_state.status,'owned');
  assert.equal((await advance('reused-grant-different-amount',[item('@wrong',refs['@item'],'potions-first',{mode:'stack',quantity:4})])).outcome,'acquisition_conflict');
  await advance('potions-lost',[op('lose_inventory',{entry:refs['@potions']})]);const d=await focusedItem(refs['@potions']);assert.equal(d.inventory.items[0].quantity,0);assert.ok(d.history.items.length>=5);
  assert.equal((await advance('lost-upgrade',[op('update_inventory',{entry:refs['@potions'],changes:{grade:'rare'}})])).outcome,'inventory_inactive');
});

test('individual equipment, free GM slots, conflicts and explicit swap enforce one occupant',async()=>{
  const a=await advance('equip-blade',[op('equip',{entry:refs['@blade'],slot:'Dream Hand'})]);assert.equal(a.content_changes[0].after_state.slot,'dream hand');
  const second=await advance('second-blade',[item('@second',refs['@equipment'],'blade-second')]),id=second.content_refs['@second'];
  assert.equal((await advance('slot-conflict',[op('equip',{entry:id,slot:'dream hand'})])).outcome,'equipment_slot_conflict');
  const swap=await advance('swap',[op('unequip',{entry:refs['@blade']}),op('equip',{entry:id,slot:'dream hand'})]);assert.equal(swap.content_changes[1].after_state.slot,'dream hand');
  assert.equal((await advance('extra-individual',[op('adjust_quantity',{entry:id,quantity_delta:1})])).outcome,'invalid_inventory_quantity');
  assert.equal((await advance('stack-equipment',[item('@bad',refs['@equipment'],'invalid-stack',{mode:'stack',quantity:2})])).outcome,'invalid_inventory_quantity');
  assert.equal((await advance('item-equip',[op('equip',{entry:refs['@potions'],slot:'pocket'})])).outcome,'inventory_not_equippable');
  const lost=await advance('consume-equipped',[op('adjust_quantity',{entry:id,quantity_delta:-1})]);assert.equal(lost.content_changes[0].after_state.slot,null);assert.equal(lost.content_changes[0].after_state.status,'lost');
  const c=await context();assert.deepEqual(c.character.stats,c.base_stats);assert.equal(c.base_stats.STR,10);
});

test('definition revisions pin held content and require explicit possession rebind',async()=>{
  const changed=await advance('blade-v2',[op('revise_definition',{definition:refs['@equipment'],expected_version:1,changes:{name:'Reimagined blade',description:'New lore',settings:{effect:'Explicit new effect'},stat_modifiers:{STR:4,DEX:2}}})]);
  assert.equal(changed.content_changes[0].after_state.version,2);
  let blade=(await focusedItem(refs['@blade'])).inventory.items[0];assert.equal(blade.definition.version,1);assert.equal(blade.definition.name,'free-equipment');assert.equal(blade.definition.stat_modifiers.STR,0);
  const d=(await context({definition_id:refs['@equipment'],content_limit:50})).content;assert.equal(d.definition_versions.items.length,2);assert.equal(d.definition_versions.items[0].settings.details.rarity,'unique');
  assert.equal((await advance('stale-definition',[op('revise_definition',{definition:refs['@equipment'],expected_version:1,changes:{name:'Stale overwrite'}})])).outcome,'definition_version_conflict');
  await advance('explicit-blade-rebind',[op('update_inventory',{entry:refs['@blade'],changes:{definition_version:2,grade:'legendary',durability:0,max_durability:100}}),op('equip',{entry:refs['@blade'],slot:'Dream Hand'})]);
  blade=(await focusedItem(refs['@blade'])).inventory.items[0];assert.equal(blade.definition.version,2);assert.equal(blade.definition.name,'Reimagined blade');assert.equal(blade.durability,0);
  await assert.rejects(db.query('UPDATE game_definition_versions SET name=$1 WHERE definition_id=$2',['Erased past',refs['@equipment']]));
  await assert.rejects(db.query('DELETE FROM content_change_entries WHERE target_id=$1',[refs['@blade']]));
});

test('six flat modifiers remain separate from basic stats and GM controls nonnumeric effects',async()=>{
  const before=await context();assert.equal(before.stat_modifiers.STR,4);assert.equal(before.display_stats.STR,14);
  const result=await advance('passive-effects',[define('@aura','trait','Unusual aura',{stat_modifiers:{STR:-20,DEX:3,VIT:2,INT:1,CHA:4,LUK:5},settings:{effect:'GM determines success, not a formula'}}),grant('@aura-owned','@aura','aura-acquired')]);
  assert.deepEqual(result.stat_effects.after.stat_modifiers,{STR:-16,DEX:5,VIT:2,INT:1,CHA:4,LUK:5});assert.equal(result.stat_effects.after.display_stats.STR,0);assert.deepEqual(result.before.character.stats,result.after.character.stats);
  const c=await context();assert.deepEqual(c.base_stats,{STR:10,DEX:10,VIT:10,INT:10,CHA:10,LUK:10});assert.equal(c.display_stats.STR,0);assert.equal(c.display_stats.DEX,15);
  const removed=await advance('effects-removed',[op('lose_feature',{feature:result.content_refs['@aura-owned']}),op('unequip',{entry:refs['@blade']})]);assert.deepEqual(removed.stat_effects.after.display_stats,c.base_stats);assert.equal(removed.stat_effects.after.stat_modifiers.STR,0);
  assert.equal((await advance('durability-over-max',[op('update_inventory',{entry:refs['@blade'],changes:{durability:101}})])).outcome,'invalid_durability');
});

test('request replay and stable definitions/acquisitions prevent duplicate rewards after later mutations',async()=>{
  const operations=[define('@d','item','stable-consumable'),item('@i','@d','stable-reward',{mode:'stack',quantity:2})],revision=(await context()).revision;
  const first=await advance('stable-request',operations,{expected_revision:revision});const id=first.content_refs['@i'];
  await advance('stable-consume',[op('adjust_quantity',{entry:id,quantity_delta:-2})]);
  const replay=await advance('stable-request',operations,{expected_revision:revision});assert.equal(replay.outcome,'replayed');assert.deepEqual(replay.content_changes,first.content_changes);assert.equal(replay.content_changes.at(-1).after_state.quantity,2);
  assert.equal((await focusedItem(id)).inventory.items[0].quantity,0);
  const again=await advance('stable-other-request',operations);assert.equal(again.outcome,'unchanged');assert.deepEqual(again.content_refs,first.content_refs);assert.equal(again.content_changes.at(-1).after_state.quantity,0);
  assert.equal((await advance('stable-request',[define('@other','item','different')],{expected_revision:revision})).outcome,'idempotency_conflict');
  assert.equal((await advance('definition-key-conflict',[define('@d','item','stable-consumable',{name:'Other meaning'})])).outcome,'definition_identity_conflict');
});

test('XP, base stats, quests and item reward share one version, receipt and transaction',async()=>{
  const e=await event('combined-content-source'),before=await context();
  const result=await advance('combined-content',[define('@gem','item','expedition-gem'),item('@reward','@gem','expedition-gem-reward')],{adjudications:[judge(e,{xp_delta:400,stats_delta:{STR:2}})],quest_changes:[line('@expedition','gem-expedition'),{operation:'link_event',questline:'@expedition',event_id:e.id,event_version:e.version,reason:'Story evidence'}]});
  assert.equal(result.outcome,'committed');assert.equal(result.after.revision,before.revision+1);assert.equal(result.after.character.xp_total,before.character.xp_total+400);assert.equal(result.after.character.stats.STR,12);assert.equal(result.after.character.level,3);
  assert.equal(result.quest_changes.length,2);assert.equal(result.content_changes.length,2);assert.equal(result.stat_effects.before.base_stats.STR,10);assert.equal(result.stat_effects.after.base_stats.STR,12);
  const stored=(await call('get_gm_update',{request_key:'combined-content'})).structuredContent.update;assert.deepEqual(stored.content_changes,result.content_changes);assert.equal(stored.changes[0].sources[0].event_id,e.id);assert.equal(stored.changes[0].sources[0].event_version,e.version);
});

test('invalid refs, kinds, numeric bounds and bounded JSON reject without partial content',async()=>{
  const invalids=[
    [[define('@temp','item','rollback-ref'),item('@bad','@absent','missing')],'content_reference_conflict'],
    [[grant('@wrong',refs['@equipment'],'wrong-feature-kind')],'content_kind_conflict'],
    [[item('@wrong',refs['@skill'],'wrong-item-kind')],'content_kind_conflict'],
    [[grant('@wrong',refs['@profession'],'profession-via-grant')],'content_kind_conflict'],
    [[grant('@wrong',randomUUID(),'missing-definition')],'definition_version_not_found'],
    [[op('update_feature',{feature:refs['@blade'],changes:{mastery:1}})],'content_not_found'],
    [[item('@bad',refs['@item'],'fractional',{quantity:1.5})],'invalid_input'],
    [[item('@bad',refs['@item'],'negative',{quantity:-1})],'invalid_input'],
    [[item('@bad',refs['@item'],'unsafe',{quantity:Number.MAX_SAFE_INTEGER+1})],'invalid_input'],
    [[op('update_feature',{feature:refs['@ability'],changes:{mastery:-1}})],'invalid_input'],
    [[define('@bad','trait','unknown-stat',{stat_modifiers:{WIS:1}})],'invalid_input'],
    [[define('@bad','trait','huge-json',{settings:{text:'x'.repeat(1001)}})],'invalid_input'],
    [[define('@bad','trait','deep-json',{settings:{a:{b:{c:{d:{e:'too deep'}}}}}})],'invalid_input'],
    [[define('@bad','trait','many-json',{settings:{list:Array(31).fill('x')}})],'invalid_input'],
    [[define('@same','trait','duplicate-ref'),grant('@same','@same','duplicate-ref-reward')],'invalid_input'],
    [[item('@typed',refs['@item'],'wrong-typed-ref'),grant('@bad','@typed','wrong-typed-feature')],'content_reference_conflict'],
  ];
  for(let i=0;i<invalids.length;i++){const before=await counts();assert.equal((await advance(`invalid-content-${i}`,invalids[i][0])).outcome,invalids[i][1]);assert.deepEqual(await counts(),before);}
  const missing=grant('@bad',refs['@trait'],'missing-version');delete missing.definition_version;assert.equal((await advance('missing-pinned-version',[missing])).outcome,'invalid_input');
});

test('aggregate modifier overflow and base-stat overflow roll back the full combined request',async()=>{
  const e=await event('modifier-overflow-source'),before=await context(),c=await counts();
  const result=await advance('modifier-overflow',[define('@overflow','trait','overflow-effect',{stat_modifiers:{STR:Number.MAX_SAFE_INTEGER}}),grant('@held','@overflow','overflow-acquisition')],{adjudications:[judge(e)],quest_changes:[line('@rolled','overflow-story')]});
  assert.equal(result.outcome,'stat_modifier_overflow');assert.deepEqual(await counts(),c);assert.deepEqual((await context()).character,before.character);assert.equal((await context()).revision,before.revision);
  const equip=await advance('positive-modifier',[op('equip',{entry:refs['@blade'],slot:'Overflow Hand'})]);assert.equal(equip.outcome,'committed');
  const e2=await event('base-plus-modifier-overflow'),current=await context();
  assert.equal((await advance('base-plus-modifier',undefined,{adjudications:[judge(e2,{xp_delta:0,stats_delta:{STR:Number.MAX_SAFE_INTEGER-current.base_stats.STR}})]})).outcome,'stat_modifier_overflow');
  assert.equal((await context()).base_stats.STR,current.base_stats.STR);await advance('overflow-unequip',[op('unequip',{entry:refs['@blade']})]);
});

test('same-version content requests cannot both commit',async()=>{
  const revision=(await context()).revision;
  const results=await Promise.all([advance('race-content-a',[define('@a','trait','race-content-a')],{expected_revision:revision}),advance('race-content-b',[define('@b','trait','race-content-b')],{expected_revision:revision})]);
  assert.deepEqual(results.map(r=>r.outcome).sort(),['committed','revision_conflict']);assert.equal((await context()).revision,revision+1);
});

test('definition, acquisition, history, character, receipt and audit failures roll back growth and quests too',async()=>{
  for(const prefix of ['INSERT INTO game_definition_versions','INSERT INTO character_features','INSERT INTO inventory_entries','INSERT INTO content_change_entries','UPDATE characters','INSERT INTO gm_updates','INSERT INTO tool_calls']) {
    const e=await event(`content-failure-${prefix}`),before=await context(),c=await counts();
    const args={mode:'advance',request_key:`content-failure-${prefix}`,expected_revision:before.revision,reason:'Combined atomic content test',adjudications:[judge(e)],quest_changes:[line('@line',`content-failure-${prefix}`)],content_changes:[define('@d','skill',`failure-skill-${prefix}`),grant('@f','@d',`failure-skill-${prefix}`),define('@item','item',`failure-item-${prefix}`),item('@i','@item',`failure-item-${prefix}`)]};
    const failingDb={query:db.query,transaction:fn=>db.transaction(tx=>fn({query:(sql,values)=>{if(sql.startsWith(prefix)) throw new Error('Injected failure');return tx.query(sql,values);}}))};
    const response=(await (await raw(createApp(failingDb,config),args)).json()).result;
    assert.equal(response.structuredContent.outcome,'storage_error');assert.deepEqual(await counts(),c);const after=await context();assert.deepEqual(after.character,before.character);assert.equal(after.revision,before.revision);
    assert.equal((await call('apply_gm_update',args)).structuredContent.outcome,'committed');
  }
});

test('content summaries, focused versions, possessions and past history are bounded and paginated',async()=>{
  const first=await context({content_limit:1,include_content_history:true,feature_statuses:['active','lost','ended'],inventory_statuses:['owned','lost']});
  for(const section of ['definitions','features','inventory','history']) {assert.equal(first.content[section].items.length,1);assert.ok(first.content[section].next_after_sequence);}
  assert.equal(first.content.definitions.items[0].definition.settings,undefined);assert.equal(first.content.features.items[0].state,undefined);
  const next=await context({content_limit:1,after_definition_sequence:first.content.definitions.next_after_sequence,after_feature_sequence:first.content.features.next_after_sequence,after_inventory_sequence:first.content.inventory.next_after_sequence,include_content_history:true,after_content_change_sequence:first.content.history.next_after_sequence,feature_statuses:['active','lost','ended'],inventory_statuses:['owned','lost']});
  for(const section of ['definitions','features','inventory','history']) assert.ok(next.content[section].items[0].sequence>first.content[section].items[0].sequence);
  const versions=(await context({definition_id:refs['@equipment'],content_limit:1})).content.definition_versions;assert.equal(versions.items[0].version,1);assert.equal(versions.next_after_version,1);
  const v2=(await context({definition_id:refs['@equipment'],content_limit:1,after_definition_version:versions.next_after_version})).content.definition_versions;assert.equal(v2.items[0].version,2);assert.equal(v2.next_after_version,null);
  const skills=await context({definition_kinds:['skill'],content_limit:50});assert.ok(skills.content.definitions.items.every(d=>d.kind==='skill'));
  const history=await focusedFeature(refs['@career']);assert.ok(history.history.items.every(h=>h.target_id===refs['@career']));
});

test('MCP tool count, OAuth scopes and game ownership remain enforced for content operations',async()=>{
  const tools=(await client.listTools()).tools;assert.equal(tools.length,9);assert.ok(JSON.stringify(tools.find(t=>t.name==='apply_gm_update').inputSchema).includes('content_changes'));
  const readerTokens=(await login(config.base,config,fetcher,'life.read')).tokens,reader=await mcpClient(config.base,readerTokens.access_token,fetcher);
  try{assert.equal((await reader.callTool({name:'get_game_context',arguments:{}})).isError,false);assert.equal((await reader.callTool({name:'apply_gm_update',arguments:{mode:'advance',request_key:'forbidden',expected_revision:1,reason:'blocked',content_changes:[define('@d','item','blocked')]}})).isError,true);}finally{await reader.close();}
  const foreign=await db.transaction(tx=>applyGmUpdate(tx,'foreign-content-owner',applyGmSchema.parse(initial),true));
  const granted=await db.transaction(tx=>applyGmUpdate(tx,'foreign-content-owner',applyGmSchema.parse({mode:'advance',request_key:'foreign-content',expected_revision:foreign.after.revision,reason:'Synthetic foreign fixture',content_changes:[define('@d','skill','foreign-skill'),grant('@f','@d','foreign-skill-acquisition')]}),true));
  assert.equal((await context({definition_id:granted.content_refs['@d']})).outcome,'content_not_found');assert.equal((await context({feature_id:granted.content_refs['@f']})).outcome,'content_not_found');
  assert.equal((await advance('foreign-grant',[grant('@bad',granted.content_refs['@d'],'foreign-grant')])).outcome,'definition_version_not_found');
  assert.equal((await advance('foreign-loss',[op('lose_feature',{feature:granted.content_refs['@f']})])).outcome,'content_not_found');
  const c=await context({content_limit:50});assert.equal(c.content.features.items.some(f=>f.id===granted.content_refs['@f']),false);
  const audit=(await db.query("SELECT arguments FROM tool_calls WHERE tool='apply_gm_update' AND arguments->>'request_key'='all-kinds'")).rows[0].arguments;
  assert.equal(audit.content_changes[0].kind,'profession');assert.equal(audit.content_changes[0].settings,undefined);assert.equal(audit.content_changes[8].state,undefined);
});
