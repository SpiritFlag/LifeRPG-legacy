import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { login,mcpClient,testEvent } from '../scripts/client.js';
import { questOperationSchema } from '../src/quest-schema.js';

const config=readConfig({PUBLIC_BASE_URL:'https://quests.example',OAUTH_CLIENT_SECRET:'client-'.repeat(8),OWNER_LOGIN_KEY:'owner-'.repeat(8),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect',ALLOW_SYNTHETIC_GAME:'true'});
let pg,db,app,client,tokens,legacy,oldGrowth,story;
const fetcher=(input,init)=>app(input instanceof Request ? input : new Request(input,init));
const call=(name,args={})=>client.callTool({name,arguments:args});
const context=async(args={})=>(await call('get_game_context',args)).structuredContent;
const event=async(key)=>(await call('record_life_event',{...testEvent,event_key:key})).structuredContent.event;
const judge=e=>({subject:{type:'event',event_id:e.id},sources:[{event_id:e.id,event_version:e.version}],reason:'Synthetic story reward',xp_delta:25});
const line=(ref,key,fields={})=>({operation:'create_line',ref,line_key:key,title:key,status:'active',reason:'Synthetic continuous story',...fields});
const node=(ref,questline,key,fields={})=>({operation:'create_node',ref,questline,node_key:key,kind:'quest',title:key,reason:'Synthetic scene',...fields});
const editLine=(questline,changes,fields={})=>({operation:'update_line',questline,changes,reason:'GM story decision',...fields});
const editNode=(node,changes,fields={})=>({operation:'update_node',node,changes,reason:'GM scene decision',...fields});
const apply=async(key,quest_changes,fields={})=>call('apply_gm_update',{mode:'advance',request_key:key,expected_revision:(await context()).revision,reason:'Synthetic quest update',quest_changes,...fields});
const detail=id=>context({questline_id:id,node_limit:50,link_limit:50,history_limit:50});
const tables=['questlines','quest_nodes','quest_node_links','questline_links','event_quest_links','quest_change_entries','gm_updates','gm_adjudications','gm_change_entries'];
const counts=()=>Promise.all(tables.map(async table=>(await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n));
const raw=async(handler,args)=>handler(new Request(`${config.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${tokens.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'apply_gm_update',arguments:args}})}));
before(async()=>{
  pg=new PGlite();
  for (const file of ['001-experiment.sql','002-life-event-history.sql','003-gm-growth.sql']) await pg.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  db={query:(sql,values)=>pg.query(sql,values),transaction:fn=>pg.transaction(tx=>fn({query:(sql,values)=>tx.query(sql,values)}))};
  app=createApp(db,config);tokens=(await login(config.base,config,fetcher)).tokens;client=await mcpClient(config.base,tokens.access_token,fetcher);
  legacy=await event('before-004');
  const initial=(await call('apply_gm_update',{mode:'initialize',request_key:'init',expected_revision:0,synthetic:true,reason:'Synthetic fixture',character:{label:'Synthetic story hero',xp_total:0,stats:{STR:10,DEX:10,VIT:10,INT:10,CHA:10,LUK:10}}})).structuredContent;
  oldGrowth={mode:'advance',request_key:'before-004-growth',expected_revision:initial.after.revision,reason:'Existing growth input without quest fields',adjudications:[judge(legacy)]};
  await call('apply_gm_update',oldGrowth);
  await pg.exec(await readFile(new URL('../migrations/004-questlines.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/005-character-content.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/006-world-memory.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/007-game-initialization.sql',import.meta.url),'utf8'));
  await pg.exec(await readFile(new URL('../migrations/008-real-task-quests.sql',import.meta.url),'utf8'));
});
after(async()=>{await client?.close();await pg?.close();});

test('legacy quest inputs omit task defaults so saved retry hashes remain compatible',()=>{
  const parsed=questOperationSchema.parse(line('@legacy','legacy-input'));
  assert.equal('real_task' in parsed,false);assert.equal('recurrence' in parsed,false);assert.equal('user_consent' in parsed,false);
});

test('004 preserves existing events/growth receipts and creates no story',async()=>{
  const c=await context();assert.equal(c.character.xp_total,25);assert.deepEqual(c.questlines,[]);
  const replay=(await call('apply_gm_update',oldGrowth)).structuredContent;
  assert.equal(replay.outcome,'replayed');assert.equal(replay.after.character.xp_total,25);
  const e=(await call('get_life_event',{event_id:legacy.id})).structuredContent;
  assert.equal(e.event.version,1);assert.equal(e.revisions[0].evidence,testEvent.evidence);
  assert.deepEqual((await counts()).slice(0,6),[0,0,0,0,0,0]);
});

test('multiple active lines, chapters, quests, branches and cross-story links share one request',async()=>{
  const before=await context();
  const result=(await apply('stories',[
    line('@sea','ocean-expedition',{description:'Fantasy adventure inspired by diving',goal:'Discover the submerged archive'}),line('@craft','crafting-story'),
    node('@chapter','@sea','chapter-one',{kind:'chapter',status:'active'}),
    node('@first','@sea','first-scene',{parent:'@chapter',status:'active'}),node('@second','@sea','second-scene',{parent:'@chapter'}),node('@third','@sea','optional-branch',{parent:'@chapter'}),
    {operation:'link_nodes',from:'@first',to:'@second',kind:'prerequisite',reason:'First scene opens the second'},
    {operation:'link_nodes',from:'@first',to:'@second',kind:'branch',label:'Explore the archive',reason:'GM branch'},
    {operation:'link_nodes',from:'@first',to:'@third',kind:'branch',label:'Visit the reef',reason:'GM alternative'},
    {operation:'link_lines',from:'@sea',to:'@craft',label:'Recovered material inspires another story',reason:'Cross-story connection'},
  ])).structuredContent;
  assert.equal(result.outcome,'committed');story=result.quest_refs;
  assert.equal(Object.keys(story).length,6);assert.equal(result.quest_changes.length,10);
  assert.equal(result.after.revision,before.revision+1);assert.deepEqual(result.after.character,before.character);
  assert.equal((await context()).questlines.length,2);
  const d=await detail(story['@sea']);assert.equal(d.nodes.items.length,4);assert.equal(d.node_links.items.length,3);assert.equal(d.line_links.items.length,1);
  assert.ok(d.history.items.every(h=>h.update_id===result.update_id));
  const saved=(await call('get_gm_update',{update_id:result.update_id})).structuredContent.update;
  assert.deepEqual(saved.quest_refs,result.quest_refs);assert.deepEqual(saved.quest_changes,result.quest_changes);
});

test('prerequisites gate advancement and final atomic state permits finishing prerequisite before target',async()=>{
  const before=await detail(story['@sea']);
  assert.equal((await apply('too-early',[editNode(story['@second'],{status:'active'})])).structuredContent.outcome,'quest_prerequisite_unmet');
  assert.equal((await detail(story['@sea'])).nodes.items.find(n=>n.id===story['@second']).status,'available');
  const result=(await apply('choose-branch',[editNode(story['@second'],{status:'active',progress:'Entered the archive'}),editNode(story['@first'],{status:'completed',ending:'The seal opened'})])).structuredContent;
  assert.equal(result.outcome,'committed');assert.equal(result.quest_changes[1].before_state.status,'active');
  const d=await detail(story['@sea']);assert.equal(d.nodes.items.find(n=>n.id===story['@third']).status,'available');
  assert.deepEqual(result.before.character,result.after.character);assert.ok(d.history.items.length>before.history.items.length);
});

test('prerequisite cycles, self links, wrong parents and cross-line node references roll back',async()=>{
  const invalids=[
    [{operation:'link_nodes',from:story['@first'],to:story['@first'],kind:'branch',reason:'Invalid self link'}],'invalid_quest_link',
    [node('@bad',story['@craft'],'bad-parent',{parent:story['@chapter']})],'invalid_quest_parent',
    [line('@temporary','must-roll-back'),node('@missing','@absent','missing')],'quest_reference_conflict',
  ];
  for(let i=0;i<invalids.length;i+=2){const c=await counts();assert.equal((await apply(`invalid-${i}`,invalids[i])).structuredContent.outcome,invalids[i+1]);assert.deepEqual(await counts(),c);}
  const c=await counts();
  const cycle=await apply('cycle',[node('@a',story['@sea'],'cycle-a'),node('@b',story['@sea'],'cycle-b'),{operation:'link_nodes',from:'@a',to:'@b',kind:'prerequisite',reason:'A before B'},{operation:'link_nodes',from:'@b',to:'@a',kind:'prerequisite',reason:'B before A'}]);
  assert.equal(cycle.structuredContent.outcome,'quest_prerequisite_cycle');assert.deepEqual(await counts(),c);
  const foreignNode=(await apply('other-line-node',[node('@other',story['@craft'],'other-line-node')])).structuredContent.quest_refs['@other'];
  assert.equal((await apply('cross-line-node-link',[{operation:'link_nodes',from:story['@first'],to:foreignNode,kind:'branch',reason:'Must use line links instead'}])).structuredContent.outcome,'invalid_quest_link');
});

test('pause requires child dispositions and paused parents prevent isolated child advancement',async()=>{
  assert.equal((await apply('pause-unresolved',[editLine(story['@sea'],{status:'paused'})])).structuredContent.outcome,'quest_children_unresolved');
  const retained=[story['@chapter'],story['@second'],story['@third']];
  const paused=(await apply('pause-resolved',[editLine(story['@sea'],{status:'paused'},{retain_children:retained})])).structuredContent;
  assert.equal(paused.outcome,'committed');assert.deepEqual(paused.quest_changes[0].retained_children,retained);
  assert.equal((await apply('child-while-paused',[editNode(story['@second'],{progress:'Must not advance'})])).structuredContent.outcome,'quest_parent_inactive');
  assert.equal((await apply('invalid-backwards',[editLine(story['@sea'],{status:'available'})])).structuredContent.outcome,'invalid_quest_transition');
  assert.ok((await context({quest_statuses:['paused']})).questlines.some(l=>l.id===story['@sea']));
  await apply('resume',[editLine(story['@sea'],{status:'active'})]);
  await apply('pause-chapter',[editNode(story['@chapter'],{status:'paused'},{retain_children:[story['@second'],story['@third']]})]);
  assert.equal((await apply('child-while-chapter-paused',[editNode(story['@second'],{progress:'Blocked by chapter'})])).structuredContent.outcome,'quest_parent_inactive');
  await apply('resume-chapter',[editNode(story['@chapter'],{status:'active'})]);
});

test('endings and explicit reopen preserve history and require parent-aware child closure',async()=>{
  const close=(await apply('complete-story',[
    editLine(story['@sea'],{status:'completed',ending:'The archive was restored'}),
    editNode(story['@chapter'],{status:'completed',ending:'First chapter ended'}),
    editNode(story['@second'],{status:'completed',ending:'Archive explored'}),editNode(story['@third'],{status:'abandoned',ending:'Other path left behind'}),
  ])).structuredContent;
  assert.equal(close.outcome,'committed');assert.equal((await detail(story['@sea'])).questline.ending,'The archive was restored');
  assert.equal((await apply('implicit-reopen',[editLine(story['@sea'],{status:'active'})])).structuredContent.outcome,'quest_reopen_required');
  assert.equal((await apply('child-reopen-alone',[editNode(story['@second'],{status:'active'},{reopen:true})])).structuredContent.outcome,'quest_parent_inactive');
  const reopen=(await apply('explicit-reopen',[editLine(story['@sea'],{status:'active'},{reopen:true}),editNode(story['@chapter'],{status:'active'},{reopen:true}),editNode(story['@second'],{status:'active',goal:'A new continuation'},{reopen:true})])).structuredContent;
  assert.equal(reopen.outcome,'committed');const d=await detail(story['@sea']);assert.equal(d.questline.ending,'The archive was restored');
  assert.ok(d.history.items.some(h=>h.target_id===story['@sea'] && h.before_state?.status==='completed' && h.after_state.status==='active'));
  assert.ok(d.history.items.some(h=>h.target_id===story['@sea'] && h.after_state.ending==='The archive was restored' && h.after_state.status==='completed'));
  await assert.rejects(db.query('DELETE FROM quest_change_entries'),/append-only/);
});

test('available stories can fail or be abandoned and finished history is queryable',async()=>{
  const create=(await apply('past-stories',[line('@failed','failed-story',{status:'available'}),line('@abandoned','abandoned-story',{status:'available'})])).structuredContent;
  await apply('past-endings',[editLine(create.quest_refs['@failed'],{status:'failed',ending:'The opportunity passed'}),editLine(create.quest_refs['@abandoned'],{status:'abandoned',ending:'GM chose another story'})]);
  const old=await context({quest_statuses:['failed','abandoned']});assert.equal(old.questlines.length,2);
  assert.ok(old.questlines.every(l=>l.ending));
});

test('three independent dives link to a story and one dive links to several stories without changing facts',async()=>{
  const dives=[await event('dive-1'),await event('dive-2'),await event('dive-3')];
  const before=await context();
  const links=dives.map(e=>({operation:'link_event',questline:story['@sea'],event_id:e.id,event_version:e.version,label:'Inspiration for the fantasy expedition',reason:'Separate confirmed dive'}));
  links.push({...links[0],questline:story['@craft']});
  const result=(await apply('diving-links',links)).structuredContent;assert.equal(result.quest_changes.length,4);assert.deepEqual(result.before.character,result.after.character);
  assert.equal(result.after.revision,before.revision+1);
  const related=await context({event_id:dives[0].id});assert.equal(related.questlines.length,2);
  const d=await detail(story['@sea']);assert.equal(d.event_links.items.length,3);assert.equal(new Set(d.event_links.items.map(l=>l.event_id)).size,3);
  const first=(await call('get_life_event',{event_id:dives[0].id})).structuredContent;assert.equal(first.event.version,1);assert.equal(first.revisions.length,1);
  const enriched=(await call('update_life_events',{request_key:'dive-enrich',operations:[{operation:'enrich',event_id:dives[0].id,expected_version:1,reason:'More facts',evidence:'Synthetic depth',changes:{facts:['Depth 18m']}}]})).structuredContent.results[0].event;
  const changed=(await apply('link-enriched',[{...links[0],event_version:enriched.version}])).structuredContent;
  assert.equal(changed.quest_changes[0].before_state.event_version,1);assert.equal(changed.quest_changes[0].after_state.event_version,2);
  assert.equal(changed.quest_changes[0].target_id,result.quest_changes[0].target_id);
  assert.equal((await call('get_life_event',{event_id:dives[0].id})).structuredContent.revisions.length,2);
  story.dives=dives;story.dives[0]=enriched;
});

test('growth and quest changes commit together with one game version and a shared receipt',async()=>{
  const e=await event('reward-and-story'),before=await context();
  const result=(await apply('reward-and-story',[line('@rewarded','rewarded-story'),node('@scene','@rewarded','rewarded-scene',{status:'active'}),{operation:'link_event',questline:'@rewarded',node:'@scene',event_id:e.id,event_version:e.version,reason:'Story source'}],{adjudications:[judge(e)]})).structuredContent;
  assert.equal(result.after.character.xp_total,before.character.xp_total+25);assert.equal(result.after.revision,before.revision+1);
  assert.equal(result.changes.length,1);assert.equal(result.quest_changes.length,3);assert.equal(result.quest_refs['@scene'],result.quest_changes[1].target_id);
  const stored=(await call('get_gm_update',{request_key:'reward-and-story'})).structuredContent.update;assert.deepEqual(stored.quest_changes,result.quest_changes);
});

test('request replay and stable creation keys prevent duplicate story objects',async()=>{
  const operations=[line('@stable','stable-creation')],revision=(await context()).revision;
  const first=(await apply('stable-key',operations,{expected_revision:revision})).structuredContent;
  const retry=(await apply('stable-key',operations,{expected_revision:revision})).structuredContent;
  assert.equal(retry.outcome,'replayed');assert.deepEqual(retry.quest_refs,first.quest_refs);assert.deepEqual(retry.quest_changes,first.quest_changes);
  const duplicate=(await apply('different-request',operations)).structuredContent;assert.equal(duplicate.outcome,'unchanged');assert.deepEqual(duplicate.quest_refs,first.quest_refs);
  assert.equal((await apply('changed-creation',[line('@changed','stable-creation',{title:'Different story'})])).structuredContent.outcome,'quest_identity_conflict');
  assert.equal((await apply('stable-key',[line('@stable','other-key')],{expected_revision:revision})).structuredContent.outcome,'idempotency_conflict');
});

test('same-version story requests cannot both commit',async()=>{
  const revision=(await context()).revision;
  const requests=await Promise.all([apply('race-a',[line('@a','race-a')],{expected_revision:revision}),apply('race-b',[line('@b','race-b')],{expected_revision:revision})]);
  assert.deepEqual(requests.map(r=>r.structuredContent.outcome).sort(),['committed','revision_conflict']);assert.equal((await context()).revision,revision+1);
});

test('a late quest failure rolls back preceding growth and all quest changes',async()=>{
  const e=await event('late-failure'),before=await context(),c=await counts();
  const result=await apply('late-failure',[line('@rolled','rolled-back'),node('@wrong','@absent','wrong')],{adjudications:[judge(e)]});
  assert.equal(result.structuredContent.outcome,'quest_reference_conflict');assert.deepEqual(await counts(),c);
  const after=await context();assert.deepEqual(after.character,before.character);assert.equal(after.revision,before.revision);
});

test('node/history/character/receipt/audit storage failures roll back the whole combined request',async()=>{
  for(const prefix of ['INSERT INTO quest_nodes','INSERT INTO quest_change_entries','UPDATE characters','INSERT INTO gm_updates','INSERT INTO tool_calls']) {
    const e=await event(`failure-${prefix}`),before=await context(),c=await counts();
    const args={mode:'advance',request_key:`failure-${prefix}`,expected_revision:before.revision,reason:'Combined atomic test',adjudications:[judge(e)],quest_changes:[line('@line',`failure-${prefix}`),node('@quest','@line','scene',{status:'active'})]};
    const failingDb={query:db.query,transaction:fn=>db.transaction(tx=>fn({query:(sql,values)=>{if(sql.startsWith(prefix)) throw new Error('Injected failure');return tx.query(sql,values);}}))};
    const response=(await (await raw(createApp(failingDb,config),args)).json()).result;
    assert.equal(response.structuredContent.outcome,'storage_error');assert.deepEqual(await counts(),c);
    const after=await context();assert.deepEqual(after.character,before.character);assert.equal(after.revision,before.revision);
    assert.equal((await call('apply_gm_update',args)).structuredContent.outcome,'committed');
  }
});

test('bounded detail/history and link deactivation preserve IDs and past relations',async()=>{
  const page=await context({questline_id:story['@sea'],node_limit:1,history_limit:1,link_limit:1});
  assert.equal(page.nodes.items.length,1);assert.ok(page.nodes.next_after_sequence);assert.ok(page.history.next_after_sequence);
  const next=await context({questline_id:story['@sea'],node_limit:1,after_node_sequence:page.nodes.next_after_sequence});assert.ok(next.nodes.items[0].sequence>page.nodes.next_after_sequence);
  const e=story.dives[2],d=await detail(story['@sea']),old=d.event_links.items.find(l=>l.event_id===e.id);
  const unlink=(await apply('deactivate-event',[{operation:'link_event',questline:story['@sea'],event_id:e.id,event_version:e.version,active:false,reason:'GM removes story connection'}])).structuredContent;
  assert.equal(unlink.quest_changes[0].target_id,old.id);assert.equal(unlink.quest_changes[0].before_state.active,true);
  assert.deepEqual((await context({event_id:e.id})).questlines,[]);assert.equal((await detail(story['@sea'])).event_links.items.find(l=>l.id===old.id).active,false);
  const reactivate=await apply('reactivate-event',[{operation:'link_event',questline:story['@sea'],event_id:e.id,event_version:e.version,active:true,reason:'GM reconnects the event'}]);assert.equal(reactivate.structuredContent.quest_changes[0].target_id,old.id);
});

test('no added tools, OAuth scopes and strict operations remain enforced; foreign stories stay private',async()=>{
  assert.equal((await client.listTools()).tools.length,10);
  const readerTokens=(await login(config.base,config,fetcher,'life.read')).tokens,reader=await mcpClient(config.base,readerTokens.access_token,fetcher);
  try{assert.equal((await reader.callTool({name:'apply_gm_update',arguments:{mode:'advance',request_key:'blocked',expected_revision:1,reason:'blocked',quest_changes:[line('@x','blocked')]}})).isError,true);}finally{await reader.close();}
  assert.equal((await apply('unknown-field',[{...line('@unknown','unknown'),world:'No world implementation'}])).structuredContent.outcome,'invalid_input');
  const real=(await call('record_life_event',{...testEvent,event_key:'synthetic-real-classification',kind:'real'})).structuredContent.event;
  assert.equal((await apply('real-event-link',[{operation:'link_event',questline:story['@sea'],event_id:real.id,event_version:1,reason:'Must not mix real and test'}])).structuredContent.outcome,'invalid_quest_event');
  assert.equal((await apply('wrong-node-event-link',[{operation:'link_event',questline:story['@craft'],node:story['@first'],event_id:legacy.id,event_version:1,reason:'Wrong line'}])).structuredContent.outcome,'invalid_quest_link');
  const gameId=randomUUID(),lineId=randomUUID();
  await db.query("INSERT INTO games(id,owner_id,kind,revision,rules_version) VALUES($1,'foreign-story-owner','test',1,'growth-v1')",[gameId]);
  await db.query("INSERT INTO questlines(id,game_id,line_key,title,description,goal,progress,ending,status) VALUES($1,$2,'foreign','Foreign','','','','','active')",[lineId,gameId]);
  assert.equal((await call('get_game_context',{questline_id:lineId})).structuredContent.outcome,'quest_not_found');
  assert.equal((await apply('foreign-story',[editLine(lineId,{status:'completed'})])).structuredContent.outcome,'quest_not_found');
  assert.equal((await context()).questlines.some(l=>l.id===lineId),false);
});


test('real tasks require consent, default to one-time and preserve facts without registration rewards',async()=>{
  const before=await context(),c=await counts();
  const task=line('@task','sort-papers',{title:'흩어진 길드 기록의 복원',description:'길드의 기록을 제자리로 돌려놓자.',real_task:'이번 주 서류 정리'});
  assert.equal((await apply('task-without-consent',[task])).structuredContent.outcome,'quest_consent_required');
  assert.deepEqual(await counts(),c);
  assert.equal((await apply('task-false-consent',[{...task,user_consent:false}])).structuredContent.outcome,'invalid_input');
  const operations=[{...task,user_consent:true}],revision=(await context()).revision;
  const created=(await apply('task-create',operations,{expected_revision:revision})).structuredContent;
  assert.equal(created.outcome,'committed');assert.deepEqual(created.after.character,before.character);
  const id=created.quest_refs['@task'],q=(await detail(id)).questline;
  assert.equal(q.real_task,task.real_task);assert.equal(q.recurrence,null);assert.equal(q.title,task.title);
  assert.equal((await context()).questlines.find(q=>q.id===id).real_task,task.real_task);
  assert.equal((await apply('task-create',operations,{expected_revision:revision})).structuredContent.outcome,'replayed');
  assert.equal((await apply('task-duplicate',operations)).structuredContent.outcome,'unchanged');
  assert.equal((await apply('task-repeat-without-consent',[editLine(id,{recurrence:'매주 월요일'})])).structuredContent.outcome,'quest_consent_required');
  await apply('task-complete',[editLine(id,{status:'completed',ending:'기록 복원을 마쳤다.'})]);
  assert.equal((await apply('task-implicit-repeat',[editLine(id,{status:'active'},{reopen:true})])).structuredContent.outcome,'quest_consent_required');
  assert.equal((await detail(id)).questline.status,'completed');
  assert.equal((await apply('task-agreed-reopen',[editLine(id,{status:'active'},{reopen:true,user_consent:true})])).structuredContent.outcome,'committed');
});

test('explicit recurring nodes reuse reopen/history and confirmed event rewards once per occurrence',async()=>{
  assert.equal((await apply('repeat-without-task',[line('@badrepeat','bad-repeat',{recurrence:'매일',user_consent:true})])).structuredContent.outcome,'invalid_quest_task');
  const created=(await apply('repeat-create',[line('@routine','routine-line'),node('@routinequest','@routine','walk-routine',{status:'active',title:'숲길의 순찰자',real_task:'20분 산책',recurrence:'매일',user_consent:true})])).structuredContent;
  const id=created.quest_refs['@routinequest'],lineId=created.quest_refs['@routine'];
  for(let round=1;round<=2;round++) {
    const e=await event('recurring-walk-'+round),before=await context();
    const operations=[editNode(id,{status:'completed',ending:'순찰 '+round+'회 완료'}),{operation:'link_event',questline:lineId,node:id,event_id:e.id,event_version:e.version,reason:'Confirmed separate occurrence'}];
    const fields={adjudications:[judge(e)],expected_revision:before.revision};
    const result=(await apply('recurring-completion-'+round,operations,fields)).structuredContent;
    assert.equal(result.after.character.xp_total,before.character.xp_total+25);
    assert.equal((await apply('recurring-completion-'+round,operations,fields)).structuredContent.outcome,'replayed');
    if(round===1) {
      const reopened=(await apply('recurring-next-occurrence',[editNode(id,{status:'active',progress:'두 번째 순찰'},{reopen:true})])).structuredContent;
      assert.deepEqual(reopened.before.character,reopened.after.character);
      assert.equal(reopened.quest_changes[0].after_state.ending,'순찰 1회 완료');
    }
  }
  const d=await detail(lineId),q=d.nodes.items.find(q=>q.id===id);
  assert.equal(q.real_task,'20분 산책');assert.equal(q.recurrence,'매일');assert.equal(q.status,'completed');
  assert.equal(d.event_links.items.length,2);
  assert.ok(d.history.items.some(h=>h.target_id===id && h.before_state?.status==='completed' && h.after_state.status==='active'));
  assert.equal((await apply('stop-repeat',[editNode(id,{recurrence:null},{user_consent:true})])).structuredContent.outcome,'committed');
  assert.equal((await apply('stopped-repeat-reopen',[editNode(id,{status:'active'},{reopen:true})])).structuredContent.outcome,'quest_consent_required');
});
