import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { readOpenAiConfig, reservation } from '../src/v2/openai-config.ts';
import { OpenAiGm, createLiveOpenAiGm, GM_OUTPUT_SCHEMA } from '../src/v2/openai-gm.ts';
import { assertStructuredSchema } from '../src/v2/openai-schema.ts';
import { measureSyntheticGm } from '../src/v2/synthetic-metrics.ts';
import { scopedDatabase } from '../src/v2/storage.ts';
import { configureBudget, budgetUsage } from '../src/v2/budget.ts';
import { setOwnerBudget } from '../src/v2/admin.ts';
import { LifeRpgService } from '../src/v2/service.ts';
import { GmWorker } from '../src/v2/worker.ts';
import { V2_SCOPES } from '../src/v2/contracts.ts';
import { openDeletionJournal } from '../src/v2/privacy.ts';

// Frozen before dispatch. Player requests describe fiction; no game changes are injected.
export const CASES = [
  { tool:'interact_with_gm', input:{request_id:'campaign-birth',kind:'start',message:'[SYNTHETIC CAMPAIGN] 가상 모험가 아린의 작은 판타지 캠페인을 시작한다. 강가의 등불 마을을 배경으로, 시작 직업과 스킬 하나씩, 작은 퀘스트 하나, 안내자 NPC 한 명을 창작해 줘. GM만 아는 미해결 복선과 초기 판단 철학도 기억해 줘. 짧은 장면으로 시작하자.'}},
  { tool:'submit_observation', input:{request_id:'campaign-walk',summary:'[SYNTHETIC CAMPAIGN] 가상 플레이어가 오늘 20분간 걸었다. 중간에 쉬고 싶었지만 속도를 낮춰 끝까지 마쳤다.',occurred_on:'2026-10-15',timezone:'Asia/Seoul'}},
  { tool:'interact_with_gm', input:{request_id:'campaign-quest',kind:'action',message:'[SYNTHETIC CAMPAIGN] 아린은 처음 만난 안내자에게 돌아가 제안받은 작은 퀘스트를 맡고, 첫 단서를 살핀다. 안내자가 실제로 아는 것과 추측하는 것을 구분해 듣고 싶다. 아직 알 수 없는 비밀은 서둘러 밝히지 않는다.'}},
  { tool:'submit_observation', input:{request_id:'campaign-study',summary:'[SYNTHETIC CAMPAIGN] 가상 플레이어가 새로운 낱말을 15분 공부했다. 다 외웠다고 주장하지 않고 헷갈리는 세 단어를 표시해 다음 복습 대상으로 남겼다.',occurred_on:'2026-10-16',timezone:'Asia/Seoul'}},
  { tool:'interact_with_gm', input:{request_id:'campaign-return',kind:'action',message:'[SYNTHETIC CAMPAIGN] 아린은 처음의 안내자와 마을에 다시 돌아가, 지난 단서와 아직 해결되지 않은 일을 이어서 살핀다. 세계의 기존 사실을 존중해 다음 장면을 진행해 줘. GM은 이번 경험이 자신의 판단 철학에 변화를 줄 근거가 있는지 돌아보되, 필요할 때만 성찰과 변화를 비공개 기억에 남겨 줘.'}},
];
export const CAP = {calls:5,reserved_micro_usd:500000};
const migrations=['001-foundation.sql','002-openai-accounting.sql','003-rpg.sql','004-memory.sql'];
const json = (path,value) => writeFile(path,JSON.stringify(value,null,2)+'\n',{flush:true});
const hash = value => createHash('sha256').update(value).digest('hex');

async function fingerprints(paths) {
  const result={};
  async function visit(path) {
    const entries=await readdir(path,{withFileTypes:true});
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      const name=join(path,entry.name);
      if(entry.isDirectory())await visit(name);
      else if(entry.isFile())result[name]=hash(await readFile(name));
      else throw new Error('Unsupported filesystem entry');
    }
  }
  for(const path of paths)await visit(path);
  return result;
}
async function frozenCode() {
  return {...await fingerprints(['src/v2','migrations/v2']),
    'scripts/evaluate-v2-campaign.mjs':hash(await readFile('scripts/evaluate-v2-campaign.mjs'))};
}
async function oldSandbox(resume=false) {
  const files=['.local/v2-openai-synthetic-deletions.json','.local/v2-openai-reservation-reconciliation-64199b85.json'];
  const result=await fingerprints(['.local/v2-openai-synthetic',...(resume?['.local/v2-campaign-20261015']:[])]);
  for(const path of files)result[path]=hash(await readFile(path));
  return result;
}

/** Count BEFORE sending; unknown outcomes consume both ceilings. No release/reset API. */
export class DispatchGuard {
  calls=0; reserved=0;
  constructor(perCall,persist,prior={calls:0,reserved_micro_usd:0}) {
    if(!Number.isSafeInteger(prior.calls)||prior.calls<0||prior.calls>CAP.calls||
      !Number.isSafeInteger(prior.reserved_micro_usd)||prior.reserved_micro_usd<0||prior.reserved_micro_usd>CAP.reserved_micro_usd)throw new Error('Invalid prior ledger');
    this.perCall=perCall;this.persist=persist;this.calls=prior.calls;this.reserved=prior.reserved_micro_usd;
  }
  available() {return this.calls<CAP.calls&&this.reserved+this.perCall<=CAP.reserved_micro_usd;}
  async take(operation_id) {
    if(!this.available())throw new Error('Evaluation cap reached');
    this.calls++;this.reserved+=this.perCall;
    const entry={call:this.calls,operation_id,reserved_micro_usd:this.perCall,cumulative_reserved_micro_usd:this.reserved,dispatch_authorized_at:new Date().toISOString()};
    await this.persist(entry); // A failed durable write prevents transport, conservatively consumes this slot.
    return entry;
  }
}

export async function runEvaluation({dir,config,transport,mode='offline',metadata={},prior={calls:0,reserved_micro_usd:0},onCreated=()=>{},verifyFrozen=async()=>{}}) {
  const guard=new DispatchGuard(reservation(config),entry=>appendFile(join(dir,'dispatch.jsonl'),JSON.stringify(entry)+'\n',{flush:true}),prior);
  if(config.model!=='gpt-6.1-sol'||config.reasoning!=='medium'||prior.reserved_micro_usd+reservation(config)*(CAP.calls-prior.calls)>CAP.reserved_micro_usd)throw new Error('Evaluation configuration outside approval');
  await mkdir(dir); // Exclusive new directory: rerunning cannot reset a previous ledger.
  onCreated();
  await json(join(dir,'plan.json'),{mode,config,cases:CASES,cap:CAP,prior,per_call_reservation:reservation(config),metadata,created_at:new Date().toISOString()});
  const samples=[],turns=[];let current=null,report;
  const bounded=new OpenAiGm(config,async(body,signal)=>{
    await verifyFrozen();
    const context=JSON.parse(body.input[0].content);
    await json(join(dir,`context-${current}.json`),context);
    await guard.take(context.operation_id);
    const response=await transport(body,signal);
    // The live adapter retains only allowlisted diagnostics for HTTP errors.
    // Successful output is synthetic audit data only.
    await json(join(dir,`response-${current}.json`),response);
    return response;
  });
  const measured=measureSyntheticGm(bounded,s=>samples.push(s));
  const gm={...measured,async generate(context,signal){
    const reply=await measured.generate(context,signal);
    await json(join(dir,`reply-${current}.json`),reply);
    return reply;
  }};
  const pg=new PGlite(join(dir,'db'));
  try {
    for(const file of migrations)await pg.exec(await readFile(`migrations/v2/${file}`,'utf8'));
    const db=scopedDatabase({query:(s,v)=>pg.query(s,v),transaction:fn=>pg.transaction(tx=>fn({query:(s,v)=>tx.query(s,v)}))});
    const journal=await openDeletionJournal(db,join(dir,'deletions.json'),true);
    const identity={subject:'synthetic-campaign-only',scopes:V2_SCOPES};
    const remainingBudget=CAP.reserved_micro_usd-prior.reserved_micro_usd;
    await configureBudget(db,{lifetime:remainingBudget,daily:remainingBudget,monthly:remainingBudget});
    await setOwnerBudget(db,identity.subject,remainingBudget);
    const service=new LifeRpgService(db,journal.sync,'openai');
    const worker=new GmWorker(db,gm,{leaseMs:30000,timeoutMs:120000});
    try {
      for(const [index,item] of CASES.entries()) {
        if(!guard.available())break; // Stop before queueing a case that cannot be dispatched.
        current=index+1;const started=performance.now();
        const queued=await service.execute(item.tool,item.input,identity);
        if(queued.status==='queued')await worker.runOnce(); // Never dispatch a retry, even if worker queued one.
        const receipt=await service.execute('read_liferpg',{view:'request',operation_id:queued.operation_id},identity);
        const turn={case:current,request_id:item.input.request_id,elapsed_ms:Math.round(performance.now()-started),receipt};
        turns.push(turn);await json(join(dir,'turns.json'),turns);
        console.info(JSON.stringify({case:current,status:receipt.status,error_code:receipt.error_code??null,
          api_calls:mode==='paid'?guard.calls-prior.calls:0,transport_calls:guard.calls-prior.calls,cumulative_calls:guard.calls}));
        if(!['committed','no_change'].includes(receipt.status))break;
      }
    } finally {
      const attempts=(await db.query('SELECT id,job_id,state,reserved_cost,actual_cost,model,input_tokens,output_tokens,usage_details,context_manifest,created_at,settled_at FROM attempts ORDER BY created_at')).rows;
      report={mode,prior,api_calls:mode==='paid'?guard.calls-prior.calls:0,transport_calls:guard.calls-prior.calls,
        cumulative_api_calls:mode==='paid'?guard.calls:0,cumulative_reserved_micro_usd:guard.reserved,
        unattempted_cases:CASES.slice(turns.length).map((c,i)=>({case:turns.length+i+1,request_id:c.input.request_id})),
        cap:CAP,samples,turns,attempts,
        usage:await service.execute('read_liferpg',{view:'usage'},identity),budget:await db.transaction(budgetUsage),
        game:await service.execute('read_liferpg',{view:'game'},identity),
        records:await service.execute('read_liferpg',{view:'records'},identity),
        memories:(await db.query('SELECT m.*,p.body FROM memories m LEFT JOIN payloads p ON p.id=m.payload_id ORDER BY m.created_at')).rows,
        jobs:(await db.query('SELECT id,state,attempts FROM jobs ORDER BY id')).rows};
      await json(join(dir,'report.json'),report);
      await journal.sync();
    }
  } finally {await pg.close();}
  return report;
}

async function main() {
  const config=readOpenAiConfig(process.env);
  const resume=process.argv.includes('--resume-approved');
  const prior={calls:0,reserved_micro_usd:0};let priorReport=null;
  if(resume) {
    priorReport=JSON.parse(await readFile('.local/v2-campaign-20261015/report.json','utf8'));
    const plan=JSON.parse(await readFile('.local/v2-campaign-20261015/plan.json','utf8'));
    const entries=(await readFile('.local/v2-campaign-20261015/dispatch.jsonl','utf8')).trim().split('\n').map(s=>JSON.parse(s));
    if(priorReport.api_calls!==1||entries.length!==1||entries[0].call!==1||entries[0].cumulative_reserved_micro_usd!==61440||
      priorReport.cumulative_reserved_micro_usd!==61440||priorReport.attempts.length!==1||priorReport.attempts[0].actual_cost!==null||
      Number(priorReport.attempts[0].reserved_cost)!==61440||priorReport.attempts[0].state!=='unknown'||
      JSON.stringify(plan.cases)!==JSON.stringify(CASES)||JSON.stringify(plan.config)!==JSON.stringify(config))throw new Error('Prior ledger or frozen scenario/config mismatch');
    prior.calls=1;prior.reserved_micro_usd=61440;
  }
  const preflight={schema_preflight:assertStructuredSchema(GM_OUTPUT_SCHEMA),model:config.model,reasoning:config.reasoning,max_input_tokens:config.maxInputTokens,max_output_tokens:config.maxOutputTokens,
    price_card:config.price,key_present:!!process.env.OPENAI_API_KEY?.trim(),cap:CAP,
    prior,maximum_new_calls:CAP.calls-prior.calls,per_call_reserved_micro_usd:reservation(config),
    maximum_reserved_micro_usd:prior.reserved_micro_usd+reservation(config)*(CAP.calls-prior.calls)};
  console.info(JSON.stringify(preflight,null,2));
  if(config.model!=='gpt-6.1-sol'||config.reasoning!=='medium'||reservation(config)*CASES.length>CAP.reserved_micro_usd)throw new Error('Preflight configuration failed');
  if(!process.argv.includes('--execute'))return;
  const live=createLiveOpenAiGm(config,process.env);
  const dir=resolve(resume?'.local/v2-campaign-20261015-resume-1':'.local/v2-campaign-20261015');
  const code=await frozenCode(),old=await oldSandbox(resume);
  const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  let result,created=false;
  try {
    result=await runEvaluation({dir,config,mode:'paid',prior,transport:live.transport,metadata:{head,code_hashes:code,old_sandbox_hashes:old,prior_report:priorReport},onCreated:()=>{created=true;},verifyFrozen:async()=>{
      if(JSON.stringify(await frozenCode())!==JSON.stringify(code))throw new Error('Frozen source changed');
    }});
  } finally {
    // Do not replace artifacts when an exclusive-directory check refused a rerun.
    if(created) {
      await json(join(dir,'preservation.json'),{head,code_hashes:code,old_sandbox_hashes:old,old_sandbox_unchanged:JSON.stringify(old)===JSON.stringify(await oldSandbox(resume)),
        code_unchanged:JSON.stringify(code)===JSON.stringify(await frozenCode())});
    }
  }
  console.info(JSON.stringify({report:join(dir,'report.json'),api_calls:result.api_calls,reserved:result.cumulative_reserved_micro_usd,usage:result.usage}));
  if(result.turns.length!==Math.min(CASES.length,CAP.calls-prior.calls)||result.turns.some(t=>!['committed','no_change'].includes(t.receipt.status)))process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{
  console.error('Campaign stopped. Inspect local safe receipts/report; no retries or budget reset performed.');process.exitCode=1;
});
