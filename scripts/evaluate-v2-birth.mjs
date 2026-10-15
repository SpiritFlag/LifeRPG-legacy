import {readFile,readdir,stat,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {runEvaluation,CASES,CAP} from './evaluate-v2-campaign.mjs';
import {readOpenAiConfig,reservation} from '../src/v2/openai-config.ts';
import {createLiveOpenAiGm,GM_OUTPUT_SCHEMA} from '../src/v2/openai-gm.ts';
import {assertStructuredSchema} from '../src/v2/openai-schema.ts';

const dir=resolve('.local/v2-birth-20261015-16384'); // Exclusive; rerun cannot overwrite history.
const oldDirs=['.local/v2-openai-synthetic','.local/v2-campaign-20261015','.local/v2-campaign-20261015-resume-1'];
const oldFiles=['.local/v2-openai-synthetic-deletions.json','.local/v2-openai-reservation-reconciliation-64199b85.json'];
const sources=['src/v2','migrations/v2','scripts/evaluate-v2-campaign.mjs','scripts/evaluate-v2-birth.mjs'];
const json=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n',{flush:true});
async function hashes(paths) {
  const out={};
  async function visit(p) {
    if((await stat(p)).isDirectory())for(const n of (await readdir(p)).sort())await visit(join(p,n));
    else out[p]=createHash('sha256').update(await readFile(p)).digest('hex');
  }
  for(const p of paths)await visit(p);return out;
}
async function main() {
  const config=readOpenAiConfig(process.env),perCall=reservation(config);
  const reports=[],prior={calls:0,reserved_micro_usd:0};
  for(const p of oldDirs.slice(1)) {
    const report=JSON.parse(await readFile(join(p,'report.json'),'utf8'));
    const plan=JSON.parse(await readFile(join(p,'plan.json'),'utf8'));
    const entries=(await readFile(join(p,'dispatch.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    if(report.api_calls!==1||report.attempts.length!==1||entries.length!==1||JSON.stringify(plan.cases)!==JSON.stringify(CASES))throw Error('Historical ledger mismatch');
    prior.calls+=report.api_calls;prior.reserved_micro_usd+=Number(report.attempts[0].reserved_cost);
    if(entries[0].reserved_micro_usd!==Number(report.attempts[0].reserved_cost)||entries[0].call!==prior.calls||
      entries[0].cumulative_reserved_micro_usd!==prior.reserved_micro_usd||report.cumulative_reserved_micro_usd!==prior.reserved_micro_usd)throw Error('Historical dispatch mismatch');
    reports.push(report);
  }
  const previous=reports.flatMap(r=>r.attempts);
  if(prior.calls!==2||prior.reserved_micro_usd!==122880||previous[0].state!=='unknown'||previous[0].actual_cost!==null||
    Number(previous[0].reserved_cost)!==61440||previous[1].state!=='completed'||Number(previous[1].actual_cost)!==25786)throw Error('Historical usage mismatch');
  if(config.model!=='gpt-6.1-sol'||config.reasoning!=='medium'||config.maxOutputTokens!==16384||config.maxInputTokens!==16384||
    perCall!==204800||prior.reserved_micro_usd+perCall>CAP.reserved_micro_usd)throw Error('Configuration outside one-birth approval');
  console.info(JSON.stringify({mode:process.argv.includes('--execute')?'paid_birth':'offline_preflight',schema:assertStructuredSchema(GM_OUTPUT_SCHEMA),
    model:config.model,reasoning:config.reasoning,max_output_tokens:config.maxOutputTokens,key_present:!!process.env.OPENAI_API_KEY?.trim(),
    maximum_new_calls:1,prior,per_call_reservation:perCall,maximum_cumulative_reservation:prior.reserved_micro_usd+perCall,
    historical_experiment_cap:CAP,operating_monthly_policy_micro_usd:10000000,operating_budget_modified:false}));
  if(!process.argv.includes('--execute'))return;
  const live=createLiveOpenAiGm(config,process.env),code=await hashes(sources),old=await hashes([...oldDirs,...oldFiles]);
  let created=false,networkDispatches=0,result;
  try {
    result=await runEvaluation({dir,config,mode:'paid',prior,maximumNewCalls:1,metadata:{previous_attempts:previous,source_hashes:code,protected_hashes:old},
      onCreated:()=>{created=true;},verifyFrozen:async()=>{if(JSON.stringify(await hashes(sources))!==JSON.stringify(code))throw Error('Frozen source changed');},
      transport:async(body,signal)=>{
        if(networkDispatches!==0)throw Error('Single network dispatch already consumed');
        networkDispatches++;
        await appendFile(join(dir,'network-dispatch.jsonl'),JSON.stringify({request:networkDispatches,at:new Date().toISOString()})+'\n',{flush:true});
        return live.transport(body,signal);
      }});
    const attempts=[...previous,...result.attempts];
    const aggregate={scope:'campaign evaluations; original two-case synthetic remains separately preserved',
      actual_api_requests:prior.calls+networkDispatches,new_api_requests:networkDispatches,
      cumulative_reserved_micro_usd:result.cumulative_reserved_micro_usd,
      known_cost_micro_usd:attempts.reduce((n,a)=>n+(a.actual_cost===null?0:Number(a.actual_cost)),0),
      outstanding_micro_usd:attempts.reduce((n,a)=>n+(a.actual_cost===null?Number(a.reserved_cost):0),0),
      known_input_tokens:attempts.reduce((n,a)=>n+Number(a.input_tokens??0),0),known_output_tokens:attempts.reduce((n,a)=>n+Number(a.output_tokens??0),0),
      unknown_usage_requests:attempts.filter(a=>a.input_tokens===null||a.output_tokens===null).length};
    await json(join(dir,'cumulative.json'),aggregate);
    console.info(JSON.stringify({status:result.turns[0]?.receipt.status,error:result.turns[0]?.receipt.error_code??null,new_api_requests:networkDispatches,
      usage:result.usage,samples:result.samples,cumulative:aggregate}));
    if(result.turns.length!==1||result.turns[0].receipt.status!=='committed')process.exitCode=1;
  } finally {
    if(created)await json(join(dir,'preservation.json'),{protected_files:Object.keys(old).length,old_unchanged:JSON.stringify(old)===JSON.stringify(await hashes([...oldDirs,...oldFiles])),
      code_unchanged:JSON.stringify(code)===JSON.stringify(await hashes(sources)),network_dispatches:networkDispatches});
  }
}
main().catch(()=>{console.error('Birth evaluation stopped. Inspect safe local receipts; no repeat or budget reset.');process.exitCode=1;});
