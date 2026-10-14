import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { growthFromXp,STAT_KEYS } from '../src/growth-schema.js';
import { login,mcpClient,testEvent } from '../scripts/client.js';

const config=readConfig({PUBLIC_BASE_URL:'https://growth.example',OAUTH_CLIENT_SECRET:'client-'.repeat(8),OWNER_LOGIN_KEY:'owner-'.repeat(8),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect',ALLOW_SYNTHETIC_GAME:'true'});
let pg,db,app,client,tokens,legacy;
const fetcher=(input,init)=>app(input instanceof Request ? input : new Request(input,init));
const call=(name,args={})=>client.callTool({name,arguments:args});
const context=async()=>(await call('get_game_context')).structuredContent;
const createEvent=async(key,kind='test')=>(await call('record_life_event',{...testEvent,event_key:key,kind})).structuredContent.event;
const judge=(event,fields={})=>({subject:{type:'event',event_id:event.id},sources:[{event_id:event.id,event_version:event.version}],reason:'Synthetic GM judgment',...fields});
const apply=async(key,adjudications,expected_revision)=>(await call('apply_gm_update',{mode:'advance',request_key:key,expected_revision:expected_revision ?? (await context()).revision,reason:'Synthetic GM change',adjudications}));
const initialize={mode:'initialize',request_key:'initialize',expected_revision:0,reason:'Synthetic fixture only',synthetic:true,character:{label:'Synthetic test character',xp_total:0,stats:{STR:10,DEX:10,VIT:10,INT:10,CHA:10,LUK:10}}};
const n=async(table)=>(await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const ledgerTables=['gm_updates','gm_adjudications','gm_adjudication_sources','gm_change_entries'];
const counts=()=>Promise.all(ledgerTables.map(n));
const raw=async(handler,name,args,token=tokens.access_token)=>handler(new Request(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(token ? {Authorization:`Bearer ${token}`} : {})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));
before(async()=>{
  pg=new PGlite();
  for (const file of ['001-experiment.sql','002-life-event-history.sql']) await pg.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  db={query:(sql,values)=>pg.query(sql,values),transaction:fn=>pg.transaction(tx=>fn({query:(sql,values)=>tx.query(sql,values)}))};
  app=createApp(db,config);
  tokens=(await login(config.base,config,fetcher)).tokens;
  client=await mcpClient(config.base,tokens.access_token,fetcher);
  legacy=await createEvent('phase-one-existing');
  await pg.exec(await readFile(new URL('../migrations/003-gm-growth.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/004-questlines.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/005-character-content.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/006-world-memory.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/007-game-initialization.sql',import.meta.url),'utf8'));
});
after(async()=>{await client?.close();await pg?.close();});

test('growth-v1 exact thresholds, multiple levels and maximum safe integer boundaries',()=>{
  for (const [xp,level] of [[0,1],[99,1],[100,2],[299,2],[300,3],[599,3],[600,4],[1000,5]]) assert.equal(growthFromXp(xp).level,level);
  assert.deepEqual(growthFromXp(650),{level:4,xp_in_level:50,xp_for_next_level:400,xp_to_next_level:350});
  const growth=growthFromXp(Number.MAX_SAFE_INTEGER),level=BigInt(growth.level),xp=BigInt(Number.MAX_SAFE_INTEGER);
  assert.ok(50n*level*(level-1n)<=xp);
  assert.ok(50n*level*(level+1n)>xp);
  assert.equal(BigInt(growth.xp_to_next_level),50n*level*(level+1n)-xp);
  for(const value of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>growthFromXp(value),RangeError);
});

test('003 preserves phase-one UUID/version/evidence/history and OAuth without creating a game',async()=>{
  assert.equal(await n('games'),0);assert.equal(await n('characters'),0);
  const original=(await call('get_life_event',{event_id:legacy.id})).structuredContent;
  assert.equal(original.event.id,legacy.id);assert.equal(original.event.version,1);
  assert.equal(original.revisions[0].evidence,testEvent.evidence);
  assert.equal(original.aliases[0].event_id,legacy.id);
  assert.equal((await context()).initialized,false);
  assert.equal((await call('get_gm_status')).structuredContent.storage,'ready');
  assert.equal((await apply('before-initialize',[judge(legacy)],1)).structuredContent.outcome,'not_initialized');
});

test('only enabled synthetic initialization succeeds once; initialization failure rolls back all state',async()=>{
  const disabled=createApp(db,{...config,allowSyntheticGame:false});
  assert.equal((await (await raw(disabled,'apply_gm_update',initialize)).json()).result.structuredContent.outcome,'initialization_disabled');
  assert.equal((await call('apply_gm_update',{...initialize,synthetic:false})).structuredContent.outcome,'invalid_input');
  const failingDb={query:db.query,transaction:fn=>db.transaction(tx=>fn({query:(sql,values)=>{if(sql.startsWith('INSERT INTO gm_updates')) throw new Error('Injected receipt failure');return tx.query(sql,values);}}))};
  const failed=(await (await raw(createApp(failingDb,config),'apply_gm_update',initialize)).json()).result;
  assert.equal(failed.structuredContent.outcome,'storage_error');
  assert.equal(await n('games'),0);assert.equal(await n('characters'),0);assert.deepEqual(await counts(),[0,0,0,0]);
  const first=(await call('apply_gm_update',initialize)).structuredContent;
  assert.equal(first.after.kind,'test');assert.equal(first.after.revision,1);assert.equal(first.after.character.level,1);
  assert.deepEqual(first.after.character.stats,initialize.character.stats);
  const replay=(await call('apply_gm_update',initialize)).structuredContent;
  assert.equal(replay.outcome,'replayed');assert.equal(replay.update_id,first.update_id);
  assert.equal((await call('apply_gm_update',{...initialize,request_key:'initialize-again'})).structuredContent.outcome,'already_initialized');
  assert.equal(await n('games'),1);assert.equal(await n('characters'),1);
});

test('XP acquisition, multiple level gains, losses and six-stat deltas are applied and recorded',async()=>{
  const e=await createEvent('growth-gain');
  const gain=(await apply('growth-gain',[judge(e,{xp_delta:650,stats_delta:{STR:1,DEX:2,VIT:3,INT:4,CHA:5,LUK:6}})])).structuredContent;
  assert.equal(gain.after.character.xp_total,650);assert.equal(gain.after.character.level,4);assert.equal(gain.changes[0].level_delta,3);
  assert.deepEqual(gain.after.character.stats,{STR:11,DEX:12,VIT:13,INT:14,CHA:15,LUK:16});
  const next=await createEvent('growth-next-level');
  assert.equal((await apply('growth-next-level',[judge(next,{xp_delta:350})])).structuredContent.after.character.level,5);
  const lossEvent=await createEvent('growth-loss');
  const loss=(await apply('growth-loss',[judge(lossEvent,{xp_delta:-1000,stats_delta:{STR:-1,DEX:-2,VIT:-3,INT:-4,CHA:-5,LUK:-6}})])).structuredContent;
  assert.equal(loss.after.character.xp_total,0);assert.equal(loss.after.character.level,1);assert.equal(loss.changes[0].level_delta,-4);
  assert.deepEqual(loss.after.character.stats,initialize.character.stats);
  const saved=(await call('get_gm_update',{update_id:loss.update_id})).structuredContent.update;
  assert.deepEqual(saved.changes,loss.changes);
  assert.equal(saved.changes[0].before_state.xp_total,1000);assert.equal(saved.changes[0].xp_delta,-1000);
});

test('invalid XP/stats, underflow, overflow, fractional values and unknown stats are rejected without side effects',async()=>{
  const e=await createEvent('invalid-growth');
  for (const [key,fields,outcome] of [
    ['negative-xp',{xp_delta:-1},'invalid_growth'],
    ['negative-stat',{stats_delta:{STR:-11}},'invalid_growth'],
    ['overflow-stat',{stats_delta:{STR:Number.MAX_SAFE_INTEGER}},'invalid_growth'],
    ['fraction',{xp_delta:0.5},'invalid_input'],
    ['unsafe',{xp_delta:Number.MAX_SAFE_INTEGER+1},'invalid_input'],
    ['unknown-stat',{stats_delta:{AGI:1}},'invalid_input'],
    ['fixed-level',{level:99},'invalid_input'],
  ]) {
    const before=await context(),c=await counts();
    assert.equal((await apply(key,[judge(e,fields)])).structuredContent.outcome,outcome);
    const after=await context();assert.deepEqual(after.character,before.character);assert.equal(after.revision,before.revision);assert.deepEqual(await counts(),c);
  }
  const max=(await apply('max-xp',[judge(e,{xp_delta:Number.MAX_SAFE_INTEGER})])).structuredContent;
  assert.equal(max.after.character.xp_total,Number.MAX_SAFE_INTEGER);
  const extra=await createEvent('xp-overflow');
  assert.equal((await apply('xp-overflow',[judge(extra,{xp_delta:1})])).structuredContent.outcome,'invalid_growth');
  await apply('max-xp-reset',[judge(extra,{xp_delta:-Number.MAX_SAFE_INTEGER})]);
});

test('request replay and judgment deduplication work independently, including receipt lookup',async()=>{
  const e=await createEvent('judgment-retry');
  const judgment=judge(e,{xp_delta:80});
  const expected=(await context()).revision;
  const first=(await apply('judgment-retry',[judgment],expected)).structuredContent;
  const replay=(await apply('judgment-retry',[judgment],expected)).structuredContent;
  assert.equal(replay.outcome,'replayed');assert.deepEqual(replay.after,first.after);assert.deepEqual(replay.changes,first.changes);
  const duplicate=(await apply('new-request-same-judgment',[{...judgment,reason:'Rephrased reason, same decision'}])).structuredContent;
  assert.equal(duplicate.outcome,'unchanged');assert.equal(duplicate.changes[0].outcome,'duplicate');
  assert.equal(duplicate.changes[0].xp_delta,0);assert.equal(duplicate.after.revision,first.after.revision);assert.equal(duplicate.after.character.xp_total,first.after.character.xp_total);
  assert.equal((await apply('same-basis-different-reward',[judge(e,{xp_delta:81})])).structuredContent.outcome,'adjudication_conflict');
  assert.equal((await apply('judgment-retry',[judge(e,{xp_delta:81})],expected)).structuredContent.outcome,'idempotency_conflict');
  assert.deepEqual((await call('get_gm_update',{request_key:'judgment-retry'})).structuredContent.update.after,first.after);
});

test('phase-one enrichment invalidates game revision and enables linked extra reward, no-change and loss',async()=>{
  const e=await createEvent('enriched-judgment');
  const first=(await apply('enriched-initial',[judge(e,{xp_delta:100})])).structuredContent;
  const enrich=async(event,request_key,fact)=>(await call('update_life_events',{request_key,operations:[{operation:'enrich',event_id:event.id,expected_version:event.version,reason:'New synthetic fact',evidence:'Additional evidence',changes:{facts:[fact]}}]})).structuredContent.results[0].event;
  const second=await enrich(e,'enriched-fact-2','depth 18m');
  const prior=first.changes[0].adjudication_id;
  assert.equal((await apply('outdated-game',[judge(second,{previous_id:prior,xp_delta:20})],first.after.revision)).structuredContent.outcome,'revision_conflict');
  const extra=(await apply('enriched-extra',[judge(second,{previous_id:prior,xp_delta:20})])).structuredContent;
  assert.equal(extra.changes[0].xp_delta,20);
  const third=await enrich(second,'enriched-fact-3','site name confirmed');
  const noChange=(await apply('enriched-no-change',[judge(third,{previous_id:extra.changes[0].adjudication_id})])).structuredContent;
  assert.equal(noChange.outcome,'committed');assert.equal(noChange.changes[0].xp_delta,0);
  assert.deepEqual(noChange.after.character,extra.after.character);
  const fourth=await enrich(third,'enriched-fact-4','new fact without automatic reward');
  const loss=(await apply('enriched-loss',[judge(fourth,{previous_id:noChange.changes[0].adjudication_id,xp_delta:-30})])).structuredContent;
  assert.equal(loss.after.character.xp_total,extra.after.character.xp_total-30);
  const oldReplay=await apply('enriched-initial',[judge(e,{xp_delta:100})],first.before.revision);
  assert.equal(oldReplay.structuredContent.outcome,'replayed');assert.deepEqual(oldReplay.structuredContent.after,first.after);
  const records=(await call('list_gm_adjudications',{event_id:e.id})).structuredContent.adjudications;
  assert.equal(records.length,4);assert.equal(records[1].previous_id,records[0].id);assert.equal(records[1].sources[0].event_version,2);
  assert.equal(records[1].sources[0].revision.evidence,'Additional evidence');
  assert.equal(records[0].sources[0].revision.after_state.id,e.id);
});

test('several independent events support one stable group judgment without ordering-based duplicates',async()=>{
  const events=await Promise.all([createEvent('group-1'),createEvent('group-2'),createEvent('group-3')]);
  const judgment={subject:{type:'event_group',key:'three-dive-expedition'},sources:events.map(e=>({event_id:e.id,event_version:e.version})),reason:'Three synthetic dives together',xp_delta:50};
  const first=(await apply('group-first',[judgment])).structuredContent;
  const duplicate=(await apply('group-reverse',[{...judgment,sources:[...judgment.sources].reverse()}])).structuredContent;
  assert.equal(duplicate.outcome,'unchanged');assert.equal(duplicate.changes[0].adjudication_id,first.changes[0].adjudication_id);
  const stored=(await call('list_gm_adjudications',{event_id:events[1].id})).structuredContent.adjudications[0];
  assert.equal(stored.sources.length,3);assert.equal(stored.subject_type,'event_group');
  assert.equal((await apply('group-duplicate-source',[{...judgment,subject:{type:'event_group',key:'duplicate-source'},sources:[judgment.sources[0],judgment.sources[0]]}])).structuredContent.outcome,'invalid_input');
});

test('explicit same-evidence correction preserves the previous judgment and applies only a delta once',async()=>{
  const e=await createEvent('correction');
  const first=(await apply('correction-original',[judge(e,{xp_delta:80})])).structuredContent;
  const id=first.changes[0].adjudication_id;
  const correction=judge(e,{previous_id:id,correction_of:id,xp_delta:-20,reason:'Correct original excess reward with a negative delta'});
  const changed=(await apply('correction-applied',[correction])).structuredContent;
  assert.equal(changed.after.character.xp_total,first.after.character.xp_total-20);
  const duplicate=(await apply('correction-again',[correction])).structuredContent;
  assert.equal(duplicate.outcome,'unchanged');assert.equal(duplicate.changes[0].xp_delta,0);
  const caseVariant={...correction,subject:{type:'event',event_id:e.id.toUpperCase()},sources:[{event_id:e.id.toUpperCase(),event_version:e.version}],previous_id:changed.changes[0].adjudication_id.toUpperCase(),correction_of:id.toUpperCase()};
  assert.equal((await apply('correction-case-variant',[caseVariant])).structuredContent.outcome,'unchanged');
  const records=(await call('list_gm_adjudications',{event_id:e.id})).structuredContent.adjudications;
  assert.equal(records.length,2);assert.equal(records[0].xp_delta,80);assert.equal(records[1].xp_delta,-20);assert.equal(records[1].correction_of,id);
  for (const table of ledgerTables) await assert.rejects(db.query(`DELETE FROM ${table}`),/append-only/);
});

test('invalid source kind/version/subject/parent cannot create a judgment or award',async()=>{
  const e=await createEvent('source-test'),real=await createEvent('source-real','real');
  const before=await context(),c=await counts();
  assert.equal((await apply('real-source',[judge(real,{xp_delta:100})])).structuredContent.outcome,'source_kind_conflict');
  assert.equal((await apply('missing-source',[judge({...e,id:randomUUID()})])).structuredContent.outcome,'source_not_found');
  assert.equal((await apply('invalid-parent',[judge(e,{previous_id:randomUUID()})])).structuredContent.outcome,'adjudication_version_conflict');
  assert.equal((await apply('invalid-correction',[judge(e,{correction_of:randomUUID()})])).structuredContent.outcome,'invalid_correction');
  assert.equal((await apply('subject-not-source',[{...judge(e),subject:{type:'event',event_id:randomUUID()}}])).structuredContent.outcome,'invalid_input');
  assert.deepEqual((await context()).character,before.character);assert.deepEqual(await counts(),c);
  const newer=(await call('update_life_events',{request_key:'source-updated',operations:[{operation:'enrich',event_id:e.id,expected_version:1,reason:'Synthetic new fact',evidence:'New fact',changes:{facts:['new']}}]})).structuredContent.results[0].event;
  assert.equal(newer.version,2);
  assert.equal((await apply('outdated-source',[judge(e,{xp_delta:100})])).structuredContent.outcome,'event_version_conflict');
});

test('same game revision competing requests give one commit and one conflict',async()=>{
  const a=await createEvent('compete-a'),b=await createEvent('compete-b');
  const revision=(await context()).revision;
  const result=await Promise.all([apply('compete-a',[judge(a,{xp_delta:1})],revision),apply('compete-b',[judge(b,{xp_delta:2})],revision)]);
  assert.deepEqual(result.map(r=>r.structuredContent.outcome).sort(),['committed','revision_conflict']);
  assert.equal((await context()).revision,revision+1);
});

test('late invalid delta rolls back every judgment, source, growth entry, character and receipt',async()=>{
  const a=await createEvent('atomic-a'),b=await createEvent('atomic-b');
  const before=await context(),c=await counts();
  const result=await apply('atomic-growth',[judge(a,{xp_delta:10}),judge(b,{stats_delta:{STR:-1000}})]);
  assert.equal(result.structuredContent.outcome,'invalid_growth');
  const after=await context();assert.equal(after.revision,before.revision);assert.deepEqual(after.character,before.character);assert.deepEqual(await counts(),c);
});

test('failures at sources/history/character/receipt/audit roll back fully and exact retry succeeds',async()=>{
  for (const prefix of ['INSERT INTO gm_adjudication_sources','INSERT INTO gm_change_entries','UPDATE characters','INSERT INTO gm_updates','INSERT INTO tool_calls']) {
    const e=await createEvent(`fail-${prefix}`),before=await context(),c=await counts();
    const input={mode:'advance',request_key:`failure-${prefix}`,expected_revision:before.revision,reason:'Synthetic atomic failure',adjudications:[judge(e,{xp_delta:1})]};
    const failingDb={query:db.query,transaction:fn=>db.transaction(tx=>fn({query:(sql,values)=>{if(sql.startsWith(prefix)) throw new Error('Injected storage failure');return tx.query(sql,values);}}))};
    const response=(await (await raw(createApp(failingDb,config),'apply_gm_update',input)).json()).result;
    assert.equal(response.structuredContent.outcome,'storage_error');
    const after=await context();assert.equal(after.revision,before.revision);assert.deepEqual(after.character,before.character);assert.deepEqual(await counts(),c);
    assert.equal((await call('get_gm_update',{request_key:input.request_key})).structuredContent.outcome,'not_found');
    assert.equal((await call('apply_gm_update',input)).structuredContent.outcome,'committed');
  }
});

test('new tools retain OAuth scopes, strict shapes, bounded history and annotations',async()=>{
  const readTokens=(await login(config.base,config,fetcher,'life.read')).tokens,reader=await mcpClient(config.base,readTokens.access_token,fetcher);
  const writeTokens=(await login(config.base,config,fetcher,'life.write')).tokens,writer=await mcpClient(config.base,writeTokens.access_token,fetcher);
  try {
    assert.equal((await reader.callTool({name:'apply_gm_update',arguments:initialize})).isError,true);
    for (const name of ['get_game_context','list_gm_adjudications','get_gm_update']) assert.equal((await writer.callTool({name,arguments:{}})).isError,true);
  } finally {await reader.close();await writer.close();}
  for(const name of ['get_game_context','list_gm_adjudications','apply_gm_update','get_gm_update']) assert.equal((await raw(app,name,{},null)).status,401);
  assert.equal((await call('apply_gm_update',{...initialize,owner_id:'foreign-owner'})).structuredContent.outcome,'invalid_input');
  assert.equal((await call('apply_gm_update',{...initialize,secret:'do-not-log-growth-secret'})).structuredContent.outcome,'invalid_input');
  assert.ok(!JSON.stringify((await db.query('SELECT arguments FROM tool_calls')).rows).includes('do-not-log-growth-secret'));
  const page=(await call('list_gm_adjudications',{limit:1})).structuredContent;
  assert.equal(page.adjudications.length,1);assert.ok(page.next_after_sequence>0);
  const next=(await call('list_gm_adjudications',{limit:1,after_sequence:page.next_after_sequence})).structuredContent;
  assert.ok(next.adjudications[0].sequence>page.next_after_sequence);
  const tools=(await client.listTools()).tools;
  assert.equal(tools.find(t=>t.name==='apply_gm_update').annotations.destructiveHint,true);
  assert.equal(tools.find(t=>t.name==='apply_gm_update').annotations.idempotentHint,true);
  assert.equal(tools.find(t=>t.name==='get_gm_update').annotations.readOnlyHint,true);
  assert.equal(STAT_KEYS.length,6);
});

test('multiple judgments record intermediate values and one atomic game revision',async()=>{
  const a=await createEvent('multi-a'),b=await createEvent('multi-b'),before=await context();
  const result=(await apply('multi-success',[judge(a,{xp_delta:7,stats_delta:{DEX:1}}),judge(b,{xp_delta:3,stats_delta:{VIT:-1}})])).structuredContent;
  assert.equal(result.after.character.xp_total,before.character.xp_total+10);
  assert.equal(result.after.revision,before.revision+1);
  assert.equal(result.changes[0].before_state.xp_total,before.character.xp_total);
  assert.deepEqual(result.changes[1].before_state,result.changes[0].after_state);
  assert.equal(result.changes[1].after_state.xp_total,result.after.character.xp_total);
  assert.equal(result.after.character.stats.DEX,before.character.stats.DEX+1);
  assert.equal(result.after.character.stats.VIT,before.character.stats.VIT-1);
});

test('legacy and phase-one writers invalidate game versions only on successful factual changes',async()=>{
  const before=await context(),e=await createEvent('legacy-version');
  assert.equal((await context()).revision,before.revision+1);
  const duplicate=await createEvent('legacy-version');
  assert.equal(duplicate.id,e.id);assert.equal((await context()).revision,before.revision+1);
  const unchanged=await call('update_life_events',{request_key:'legacy-unchanged',operations:[{operation:'enrich',event_id:e.id,expected_version:e.version,reason:'No new facts',evidence:testEvent.evidence,changes:{summary:e.summary}}]});
  assert.equal(unchanged.structuredContent.results[0].outcome,'unchanged');assert.equal((await context()).revision,before.revision+1);
  const failingDb={query:db.query,transaction:fn=>db.transaction(tx=>fn({query:(sql,values)=>{if(sql.startsWith('INSERT INTO tool_calls')) throw new Error('Injected legacy audit failure');return tx.query(sql,values);}}))};
  const count=await n('life_events');
  const failed=(await (await raw(createApp(failingDb,config),'record_life_event',{...testEvent,event_key:'legacy-trigger-rollback'})).json()).result;
  assert.equal(failed.structuredContent.outcome,'storage_error');assert.equal(await n('life_events'),count);assert.equal((await context()).revision,before.revision+1);
});

test('game and receipt queries cannot read a different owner',async()=>{
  const gameId=randomUUID(),updateId=randomUUID();
  await db.query("INSERT INTO games(id,owner_id,kind,revision,rules_version) VALUES($1,'foreign-owner','test',1,'growth-v1')",[gameId]);
  await db.query("INSERT INTO characters(game_id,label,xp_total,str,dex,vit,int,cha,luk) VALUES($1,'Foreign synthetic character',0,0,0,0,0,0,0)",[gameId]);
  await db.query("INSERT INTO gm_updates(id,game_id,request_key,input_hash,reason,result) VALUES($1,$2,'foreign-only','hash','Foreign synthetic fixture','{\"marker\":\"foreign-private-marker\"}')",[updateId,gameId]);
  assert.equal((await call('get_gm_update',{update_id:updateId})).structuredContent.outcome,'not_found');
  assert.equal((await call('get_gm_update',{request_key:'foreign-only'})).structuredContent.outcome,'not_found');
  assert.equal((await context()).character.label,initialize.character.label);
});
