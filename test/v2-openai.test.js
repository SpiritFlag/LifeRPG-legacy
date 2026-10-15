import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {OpenAiGm,createLiveOpenAiGm,GM_OUTPUT_SCHEMA} from '../src/v2/openai-gm.ts';
import {measureSyntheticGm} from '../src/v2/synthetic-metrics.ts';
import {readOpenAiConfig,reservation,costMicroUsd,SOL_PRICE} from '../src/v2/openai-config.ts';
import {GmWorker} from '../src/v2/worker.ts';
import {LifeRpgService} from '../src/v2/service.ts';
import {scopedDatabase} from '../src/v2/storage.ts';
import {configureBudget,budgetUsage,resumeBudgetJobs,operatingMonthlyBudget,configureOperatingMonthlyBudget,canReserve} from '../src/v2/budget.ts';
import {setMockBudget} from '../src/v2/admin.ts';
import {V2_SCOPES} from '../src/v2/contracts.ts';
import {deriveMemory} from '../src/v2/memory.ts';
import {createV2App} from '../src/v2/app.ts';
import {memoryProposal} from '../src/v2/memory-contracts.ts';
import {readConfig} from '../src/config.js';
import {login,mcpClient} from '../scripts/client.js';

const config=readOpenAiConfig({});
const context={operation_id:randomUUID(),kind:'start',input:{message:'[SYNTHETIC]'},initialized:false,xp:0,memories:[],events:[],previous_decision:null,target_event_id:null};
const wire={outcome:'commit',summary:'합성 판정',xp_delta:0,question:null,memories:[{kind:'identity',text:'합성 GM은 일관성과 자율성을 중시한다.'}],
  operations:[{op:'put',ref:'@hero',expected_version:0,visibility:'public',private_notes:null,body:{kind:'character',name:'합성 영웅',description:'테스트 모험가',level:1,stats:[],profession:null,location:null}}],reward_source:null,scene:null};
const envelope=(changes={},p=wire)=>({model:config.model,status:'completed',service_tier:'default',
  usage:{input_tokens:1000,input_tokens_details:{cached_tokens:100,cache_write_tokens:200},output_tokens:100,output_tokens_details:{reasoning_tokens:40},total_tokens:1100},
  output:[{type:'reasoning',summary:[]},{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({...p,memories:p.memories.map(m=>memoryProposal.parse(m))})}]}],...changes});
let pg,db;
before(async()=>{
  pg=new PGlite();
  for(const file of ['001-foundation.sql','002-openai-accounting.sql','003-rpg.sql','004-memory.sql'])await pg.exec(await readFile(new URL(`../migrations/v2/${file}`,import.meta.url),'utf8'));
  db=scopedDatabase({query:(s,v)=>pg.query(s,v),transaction:fn=>pg.transaction(tx=>fn({query:(s,v)=>tx.query(s,v)}))});
});
after(async()=>pg.close());
beforeEach(async()=>{await db.query('TRUNCATE games CASCADE');await configureBudget(db,{lifetime:10000000,daily:10000000,monthly:10000000});});
function fixture(transport=async()=>({status:200,body:envelope()})) {
  const identity={subject:randomUUID(),scopes:V2_SCOPES},service=new LifeRpgService(db,undefined,'openai');
  const gm=new OpenAiGm(config,transport),worker=new GmWorker(db,gm);
  const call=(tool,input)=>service.execute(tool,input,identity);
  const result=id=>call('read_liferpg',{view:'request',operation_id:id});
  const start=async()=>{await setMockBudget(db,identity.subject,1000000);return call('interact_with_gm',{request_id:randomUUID(),kind:'start',message:'[SYNTHETIC] start'});};
  return {identity,service,gm,worker,call,result,start};
}
const signal=()=>new AbortController().signal;

test('configuration defaults to Sol medium, explicit price required on model change, paid gate fails closed',async()=>{
  assert.equal(config.model,'gpt-6.1-sol');assert.equal(config.reasoning,'medium');
  assert.equal(config.maxOutputTokens,16384);assert.equal(config.maxInputTokens,16384);
  assert.equal(reservation(config),204800);
  assert.equal(operatingMonthlyBudget({}),10000000);
  assert.equal(operatingMonthlyBudget({GM_OPERATING_MONTHLY_BUDGET_MICRO_USD:'0'}),0);
  assert.throws(()=>operatingMonthlyBudget({GM_OPERATING_MONTHLY_BUDGET_MICRO_USD:'-1'}));
  assert.throws(()=>readOpenAiConfig({GM_MAX_OUTPUT_TOKENS:'16385'}));
  assert.throws(()=>readOpenAiConfig({GM_MODEL:'another-model'}));
  assert.equal(readOpenAiConfig({GM_MODEL:'another-model',GM_PRICE_CARD_JSON:JSON.stringify(SOL_PRICE)}).model,'another-model');
  assert.throws(()=>readOpenAiConfig({GM_REASONING_EFFORT:'none'}));
  assert.throws(()=>readOpenAiConfig({GM_MAX_INPUT_TOKENS:'500000'}));
  assert.throws(()=>createLiveOpenAiGm(config,{OPENAI_API_KEY:'synthetic-not-a-key'}),/disabled/);
  assert.throws(()=>createLiveOpenAiGm(config,{LIFERPG_ALLOW_PAID_SYNTHETIC:'I_APPROVE_PAID_SYNTHETIC'}),/OPENAI_API_KEY/);
});

test('synthetic timing uses operation_id without input request_id and cannot break or retry transport',async()=>{
  assert.equal(context.input.request_id,undefined);
  const samples=[];let calls=0;
  const gm=new OpenAiGm(config,async()=>{calls++;return {status:200,body:envelope()};});
  const measured=measureSyntheticGm(gm,s=>samples.push(s));
  const reply=await measured.generate(context,signal());
  assert.equal(reply.failure,undefined);assert.equal(calls,1);
  assert.equal(samples[0].operation_id,context.operation_id);assert.equal(samples[0].api_requests,1);
  assert.equal(samples[0].http_status,200);assert.ok(samples[0].http_elapsed_ms>=0);
  await measureSyntheticGm(gm,()=>{throw new Error('synthetic sink failure');}).generate(context,signal());
  assert.equal(calls,2);
  const failed=new OpenAiGm(config,async()=>{calls++;return {status:403,body:null};});
  const result=await measureSyntheticGm(failed,s=>samples.push(s)).generate(context,signal());
  assert.equal(calls,3);assert.equal(result.failure.code,'gm_provider_rejected');assert.equal(samples[1].http_status,403);
});

test('new output ceiling is sent and settled, incomplete output remains terminal, excess is rejected',async()=>{
  for(const [output,status,code] of [[3000,'completed',undefined],[16384,'completed',undefined],[16384,'incomplete','gm_incomplete'],[16385,'completed','gm_token_bound_exceeded']]) {
    const body=envelope({status,usage:{input_tokens:1000,output_tokens:output,total_tokens:1000+output,
      input_tokens_details:{cached_tokens:100,cache_write_tokens:200},output_tokens_details:{reasoning_tokens:2000}}});
    const r=await new OpenAiGm(config,async request=>{assert.equal(request.max_output_tokens,16384);return {status:200,body};}).generate(context,signal());
    assert.equal(r.failure?.code,code);assert.equal(r.usage.cost,1910+output*10);
  }
  assert.equal(costMicroUsd(SOL_PRICE,16384,0,16384,16384),reservation(config));
});

test('operating monthly setup preserves historic unknown/settled usage, other limits and jobs',async()=>{
  const f=fixture();await f.start();
  const oldWorker=new GmWorker(db,new OpenAiGm(readOpenAiConfig({GM_MAX_OUTPUT_TOKENS:'2048'}),async()=>({status:400,body:null})));
  await oldWorker.runOnce(); // Synthetic historical-sized unknown reservation.
  const settled=fixture();await settled.start();await settled.worker.runOnce();
  await configureBudget(db,{lifetime:7000000,daily:900000,monthly:500000});
  const before={attempts:(await db.query('SELECT * FROM attempts ORDER BY id')).rows,
    jobs:(await db.query('SELECT * FROM jobs ORDER BY id')).rows,games:(await db.query('SELECT * FROM games ORDER BY owner_id')).rows,
    usage:await db.transaction(budgetUsage)};
  assert.equal(before.usage.lifetime,String(61440+2910));
  await configureOperatingMonthlyBudget(db);
  assert.deepEqual((await db.query('SELECT * FROM attempts ORDER BY id')).rows,before.attempts);
  assert.deepEqual((await db.query('SELECT * FROM jobs ORDER BY id')).rows,before.jobs);
  assert.deepEqual((await db.query('SELECT * FROM games ORDER BY owner_id')).rows,before.games);
  assert.deepEqual(await db.transaction(budgetUsage),before.usage);
  const limits=(await db.query('SELECT * FROM gm_budget')).rows[0];
  assert.equal(Number(limits.monthly_limit),10000000);assert.equal(Number(limits.daily_limit),900000);assert.equal(Number(limits.lifetime_limit),7000000);
  await configureOperatingMonthlyBudget(db,Number(before.usage.monthly)+reservation(config)-1);
  assert.equal(await db.transaction(tx=>canReserve(tx,reservation(config))),false);
  await configureOperatingMonthlyBudget(db,Number(before.usage.monthly)+reservation(config));
  assert.equal(await db.transaction(tx=>canReserve(tx,reservation(config))),true);
});

test('operating preflight is read-only and does not inherit old synthetic budget settings',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'liferpg-operating-preflight-'));
  const script=fileURLToPath(new URL('../src/v2/openai-preflight.ts',import.meta.url));
  const options={cwd:dir,env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,OPENAI_API_KEY:'SYNTHETIC-SECRET',
    GM_MONTHLY_BUDGET_MICRO_USD:'150000',DATABASE_URL:'must-not-connect'}};
  try {
    const {stdout}=await promisify(execFile)(process.execPath,[script],options),r=JSON.parse(stdout);
    assert.equal(r.mode,'offline_preflight');assert.equal(r.max_output_tokens,16384);assert.equal(r.reservation_micro_usd,204800);
    assert.equal(r.operating_monthly_budget_micro_usd,10000000);assert.equal(r.empty_month_worst_case_calls,48);
    assert.equal(r.budget_applied,false);assert.equal(r.ledger_checked,false);assert.equal(r.paid_calls_authorized,false);
    assert.ok(!stdout.includes('SYNTHETIC-SECRET'));assert.deepEqual(await readdir(dir),[]);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('synthetic CLI dry-run needs no key/DB and --execute without approval fails before creating data',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'liferpg-openai-preflight-'));
  const script=fileURLToPath(new URL('../src/v2/synthetic-openai.ts',import.meta.url));
  const options={cwd:dir,env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,OPENAI_API_KEY:'SYNTHETIC-SECRET'}};
  try {
    const result=await promisify(execFile)(process.execPath,[script],options);
    assert.equal(JSON.parse(result.stdout).mode,'dry_run');assert.ok(!result.stdout.includes('SYNTHETIC-SECRET'));
    assert.deepEqual(await readdir(dir),[]);
    await assert.rejects(()=>promisify(execFile)(process.execPath,[script,'--execute'],options),e=>e.code===1 && !e.stderr.includes('SYNTHETIC-SECRET'));
    assert.deepEqual(await readdir(dir),[]);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('local fake HTTP Responses endpoint validates strict request and cached/write/reasoning accounting',async()=>{
  let sent,calls=0;
  const server=createServer(async(req,res)=>{
    calls++;assert.equal(req.url,'/v1/responses');let raw='';for await(const chunk of req)raw+=chunk;
    sent=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(envelope()));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/v1/responses`;
    const gm=new OpenAiGm(config,async(body,abort)=>{const r=await fetch(url,{method:'POST',body:JSON.stringify(body),signal:abort});return {status:r.status,body:await r.json()};});
    const reply=await gm.generate(context,signal());
    assert.equal(calls,1);assert.equal(sent.model,config.model);assert.equal(sent.reasoning.effort,'medium');
    assert.equal(sent.store,false);assert.equal(sent.service_tier,'default');assert.equal(sent.truncation,'disabled');
    assert.equal(sent.max_output_tokens,16384);
    assert.equal(sent.text.format.strict,true);assert.deepEqual(sent.text.format.schema,GM_OUTPUT_SCHEMA);
    assert.deepEqual(GM_OUTPUT_SCHEMA.required,['outcome','summary','xp_delta','question','memories','operations','reward_source','scene']);
    assert.equal(sent.tools,undefined);assert.equal(sent.previous_response_id,undefined);
    assert.equal(reply.proposal.question,undefined);assert.equal(reply.usage.cost,2910);
    assert.equal(reply.usage.details.reasoning_tokens,40);assert.equal(costMicroUsd(SOL_PRICE,1,1,0,0),1);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('refusal, incomplete, invalid JSON and unverified usage never become proposals; usage survives rejection',async()=>{
  const cases=[
    [envelope({status:'incomplete'}),'gm_incomplete',2910],
    [envelope({output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'synthetic private text'}]}]}),'gm_refused',2910],
    [envelope({output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'broken'}]}]}),'invalid_gm_output',2910],
    [envelope({}, {...wire,extra:'injection'}),'invalid_gm_output',2910],
    ...[8,9].map(importance=>[envelope({output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({...wire,memories:[{...memoryProposal.parse({kind:'episode',text:'synthetic'}),importance}]})}]}]}),'invalid_gm_output',2910]),
    [envelope({}, {...wire,outcome:'no_change',xp_delta:5}),'invalid_gm_output',2910],
    [envelope({usage:null}),'gm_usage_unverified',undefined],
    [envelope({service_tier:'ultrafast'}),'gm_usage_unverified',null],
    [envelope({model:'unknown-model'}),'gm_usage_unverified',null],
  ];
  for(const [body,code,cost]of cases) {
    const reply=await new OpenAiGm(config,async()=>({status:200,body})).generate(context,signal());
    assert.equal(reply.proposal,null);assert.equal(reply.failure.code,code);assert.equal(reply.usage?.cost,cost);
    assert.ok(!JSON.stringify(reply).includes('synthetic private text'));
  }
});

test('oversized context is rejected before HTTP; provider/transport failures expose only fixed codes',async()=>{
  let calls=0;const gm=new OpenAiGm(config,async()=>{calls++;throw new Error('SECRET synthetic prompt');});
  assert.equal((await gm.generate({...context,input:{message:'가'.repeat(10000)}},signal())).failure.code,'context_limit');
  assert.equal(calls,0);
  const failed=await gm.generate(context,signal());assert.equal(calls,1);assert.ok(!JSON.stringify(failed).includes('SECRET'));
  for(const status of [400,401,429,500]) {
    const r=await new OpenAiGm(config,async()=>({status,body:{error:'SECRET'}})).generate(context,signal());
    assert.equal(r.failure.retryable,status>=429);assert.equal(r.usage,undefined);
  }
});

test('actual adapter through worker commits once, records versioned price and real token counts',async()=>{
  let calls=0;
  const f=fixture(async body=>{calls++;const c=JSON.parse(body.input[0].content);return {status:200,body:envelope({},c.kind==='start'?wire:{...wire,operations:[],xp_delta:7,memories:[{kind:'episode',text:'합성 산책의 의미'}]})};});
  const start=await f.start();await f.worker.runOnce();assert.equal((await f.result(start.operation_id)).status,'committed');
  const input={request_id:'same-request',summary:'[SYNTHETIC] walk'};
  const r=await f.call('submit_observation',input);await f.worker.runOnce();
  assert.equal((await f.result(r.operation_id)).status,'committed');
  assert.equal((await f.call('submit_observation',input)).operation_id,r.operation_id);
  assert.equal(await f.worker.runOnce(),false);assert.equal(calls,2);
  assert.equal((await f.call('read_liferpg',{view:'game'})).xp,7);
  const usage=await f.call('read_liferpg',{view:'usage'});
  assert.equal(usage.models[0].input_tokens,'2000');assert.equal(usage.models[0].settled,'5820');
  assert.equal(usage.models[0].cached_tokens,'200');assert.equal(usage.models[0].price_card.id,SOL_PRICE.id);
  assert.equal((await db.transaction(budgetUsage)).lifetime,'5820');
});

test('global budget blocks different owners, unknown charges carry across day/month and operator resume preserves spend',async()=>{
  await configureBudget(db,{lifetime:204800,daily:204800,monthly:204800});
  const a=fixture(),b=fixture();const ra=await a.start();const rb=await b.start();
  const c=await a.worker.claim();assert.ok(c);
  const other=c.owner===a.identity.subject?b:a;const otherReceipt=c.owner===a.identity.subject?rb:ra;
  assert.equal(await other.worker.claim(),null);
  assert.equal((await other.result(otherReceipt.operation_id)).status,'blocked_budget');
  await a.worker.fail(c);
  // Force prior-month timestamp to prove unknown charges do not disappear with a window reset.
  await db.query("UPDATE attempts SET created_at=clock_timestamp()-interval '40 days'");
  assert.deepEqual(await db.transaction(budgetUsage),{lifetime:'204800',daily:'204800',monthly:'204800'});
  await configureBudget(db,{lifetime:1000000,daily:1000000,monthly:1000000});
  await resumeBudgetJobs(db,other.identity.subject);
  assert.equal((await other.result(otherReceipt.operation_id)).status,'queued');
  assert.equal((await db.transaction(budgetUsage)).lifetime,'204800');
});

test('each server budget window independently blocks before dispatch; settled windows roll over without resetting lifetime',async()=>{
  for(const window of ['lifetime','daily','monthly']) {
    await configureBudget(db,{lifetime:1000000,daily:1000000,monthly:1000000,[window]:204799});
    let called=false;const f=fixture(async()=>{called=true;return {status:200,body:envelope()};});
    const r=await f.start();await f.worker.runOnce();assert.equal(called,false);
    assert.equal((await f.result(r.operation_id)).status,'blocked_budget');
  }
  await configureBudget(db,{lifetime:1000000,daily:1000000,monthly:1000000});
  const f=fixture();await f.start();await f.worker.runOnce();
  await db.query("UPDATE attempts SET settled_at=clock_timestamp()-interval '40 days'");
  assert.deepEqual(await db.transaction(budgetUsage),{lifetime:'2910',daily:'0',monthly:'0'});
});

test('refused output is paid once without retry; no provider body remains in DB',async()=>{
  const f=fixture(async()=>({status:200,body:envelope({output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'UNIQUE-SYNTHETIC-REFUSAL'}]}]})}));
  const r=await f.start();await f.worker.runOnce();
  assert.equal((await f.result(r.operation_id)).error_code,'gm_refused');assert.equal(await f.worker.runOnce(),false);
  assert.equal((await db.transaction(budgetUsage)).lifetime,'2910');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM decisions')).rows[0].n,0);
  for(const table of ['payloads','attempts','requests'])assert.ok(!JSON.stringify((await db.query(`SELECT * FROM ${table}`)).rows).includes('UNIQUE-SYNTHETIC-REFUSAL'));
});

test('HTTP 400 diagnostics stay internal while worker preserves unknown reservation and fixed public error',async()=>{
  const diagnostic={code:'invalid_json_schema',param:'text.format.schema',request_id:'req_'+'a'.repeat(32)};
  let calls=0;const f=fixture(async()=>{calls++;return {status:400,body:null,diagnostic};});
  const r=await f.start();await f.worker.runOnce();assert.equal(await f.worker.runOnce(),false);
  const receipt=await f.result(r.operation_id);
  assert.equal(calls,1);assert.equal(receipt.error_code,'gm_provider_rejected');
  assert.ok(!JSON.stringify(receipt).includes(diagnostic.request_id));
  assert.equal((await db.transaction(budgetUsage)).lifetime,'204800');
  const attempt=(await db.query('SELECT state,actual_cost,input_tokens,output_tokens FROM attempts')).rows[0];
  assert.deepEqual(attempt,{state:'unknown',actual_cost:null,input_tokens:null,output_tokens:null});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM decisions')).rows[0].n,0);
});

test('game transaction failure cannot roll back already known usage; replayed settlement charges once',async()=>{
  const f=fixture();const r=await f.start();const claim=await f.worker.claim();
  const reply=await f.gm.generate(claim.context,signal());
  const broken={...db,transaction:fn=>db.transaction(tx=>fn({query:(s,v)=>s.startsWith('INSERT INTO memories')?Promise.reject(new Error('synthetic storage failure')):tx.query(s,v)}))};
  await assert.rejects(()=>new GmWorker(broken,f.gm).complete(claim,reply));
  assert.equal((await f.result(r.operation_id)).status,'running');
  assert.equal((await db.transaction(budgetUsage)).lifetime,'2910');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM decisions')).rows[0].n,0);
  await f.worker.complete(claim,reply);await f.worker.complete(claim,reply);
  assert.equal((await db.transaction(budgetUsage)).lifetime,'2910');
  assert.equal((await f.result(r.operation_id)).status,'committed');
});

test('lost response retains reservation and bounded retries; timeout aborts transport',async()=>{
  const f=fixture(async()=>{throw new Error('secret');});
  await setMockBudget(db,f.identity.subject,1000000);
  const r=await f.start();
  for(let i=0;i<3;i++){await f.worker.runOnce();await db.query('UPDATE jobs SET available_at=clock_timestamp()');}
  assert.equal((await f.result(r.operation_id)).status,'failed');
  assert.equal((await db.transaction(budgetUsage)).lifetime,String(3*204800));
  assert.equal(await f.worker.runOnce(),false);
  let aborted=false;
  const slow=fixture(async(_body,s)=>new Promise((_,reject)=>s.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true})));
  const sr=await slow.start();const worker=new GmWorker(db,slow.gm,{timeoutMs:20,leaseMs:1000});
  await worker.runOnce();assert.equal(aborted,true);assert.equal((await slow.result(sr.operation_id)).status,'retryable_error');
});

test('delete during real adapter generation discards output but settles cost, purges derived identity and never restores text',async()=>{
  const f=fixture();await f.start();await f.worker.runOnce();
  const r=await f.call('submit_observation',{request_id:randomUUID(),summary:'SYNTHETIC-ERASE-ME'});
  const claim=await f.worker.claim();assert.ok(claim);
  await f.call('delete_real_record',{request_id:randomUUID(),event_ids:r.event_ids});
  const reply=await f.gm.generate(claim.context,signal());
  assert.equal((await f.worker.complete(claim,reply)).status,'discarded');
  assert.equal((await f.result(r.operation_id)).status,'deleted');
  assert.equal((await db.transaction(budgetUsage)).lifetime,'5820');
  assert.ok(!JSON.stringify((await db.query('SELECT * FROM payloads')).rows).includes('SYNTHETIC-ERASE-ME'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM decisions')).rows[0].n,1);
});

test('OpenAI-derived memory inherits transitive provenance and is removed on deletion',async()=>{
  const f=fixture(async body=>{const c=JSON.parse(body.input[0].content);return {status:200,body:envelope({},c.kind==='start'?wire:{...wire,operations:[],memories:[{kind:'episode',text:'SYNTHETIC-EVIDENCE'}]})};});
  await f.start();await f.worker.runOnce();
  const r=await f.call('submit_observation',{request_id:randomUUID(),summary:'SYNTHETIC-ROOT'});await f.worker.runOnce();
  const source=(await db.query("SELECT payload_id FROM memories WHERE kind='episode'")).rows[0].payload_id;
  await deriveMemory(db,f.identity.subject,{kind:'identity',text:'SYNTHETIC-DERIVED',source_payload_ids:[source]});
  await f.call('delete_real_record',{request_id:randomUUID(),event_ids:r.event_ids});
  const content=JSON.stringify((await db.query('SELECT * FROM payloads')).rows);
  for(const s of ['SYNTHETIC-ROOT','SYNTHETIC-EVIDENCE','SYNTHETIC-DERIVED'])assert.ok(!content.includes(s));
});

test('MCP OpenAI mode keeps five tools and accurately marks remote paid effects; reads never call GM',async()=>{
  const auth=readConfig({PUBLIC_BASE_URL:'https://synthetic.example',OAUTH_CLIENT_SECRET:'synthetic-client-'.repeat(4),OWNER_LOGIN_KEY:'synthetic-owner-'.repeat(4),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'});
  const app=createV2App(db,auth,undefined,'openai');const fetcher=(url,init)=>app(url instanceof Request?url:new Request(url,init));
  const tokens=(await login(auth.base,auth,fetcher,V2_SCOPES.join(' '))).tokens;
  const client=await mcpClient(auth.base,tokens.access_token,fetcher);
  try {
    const tools=(await client.listTools()).tools;assert.equal(tools.length,5);
    assert.deepEqual(tools.filter(t=>t.annotations.openWorldHint).map(t=>t.name),['submit_observation','interact_with_gm']);
    const r=await client.callTool({name:'read_liferpg',arguments:{view:'usage'}});
    assert.equal(r.structuredContent.unit,'micro_usd');assert.equal(r.structuredContent.mode,'openai');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM attempts')).rows[0].n,0);
    const receipt=await client.callTool({name:'interact_with_gm',arguments:{request_id:randomUUID(),kind:'start',message:'[SYNTHETIC] MCP start'}});
    assert.equal(receipt.structuredContent.status,'queued');
    await db.query('UPDATE games SET budget_limit=1000000');
    await new GmWorker(db,new OpenAiGm(config,async()=>({status:200,body:envelope()}))).runOnce();
    const committed=await client.callTool({name:'read_liferpg',arguments:{view:'request',operation_id:receipt.structuredContent.operation_id}});
    assert.equal(committed.structuredContent.status,'committed');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM attempts')).rows[0].n,1);
  } finally {await client.close();}
});
