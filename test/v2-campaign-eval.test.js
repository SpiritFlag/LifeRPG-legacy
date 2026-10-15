import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvaluation,DispatchGuard,CAP } from '../scripts/evaluate-v2-campaign.mjs';
import { MockGm } from '../src/v2/mock-gm.ts';
import { proposal } from '../src/v2/contracts.ts';
import { readOpenAiConfig,reservation } from '../src/v2/openai-config.ts';

test('new output cap cannot silently inherit or expand the historical $0.50 approval',async()=>{
  const config=readOpenAiConfig({}),prior={calls:2,reserved_micro_usd:122880};
  const entries=[],guard=new DispatchGuard(reservation(config),async e=>entries.push(e),prior);
  await guard.take('possible-only-after-new-approval');
  assert.equal(guard.reserved,327680);assert.equal(guard.calls,3);
  await assert.rejects(()=>guard.take('over-budget'));assert.equal(entries.length,1);
  await assert.rejects(()=>runEvaluation({dir:'must-not-be-created',config,prior,transport:()=>assert.fail('No HTTP')}),/outside approval/);
  assert.deepEqual(CAP,{calls:5,reserved_micro_usd:500000});
});

// Historical campaign fixtures deliberately keep their original 2,048-token cap and ledger amounts.
test('durable dispatch ceiling cannot be freed by settlement or an unknown response',async()=>{
  const entries=[],guard=new DispatchGuard(61440,async e=>entries.push(e));
  for(let i=0;i<CAP.calls;i++)await guard.take(`operation-${i}`);
  await assert.rejects(()=>guard.take('sixth'));
  assert.equal(entries.length,5);assert.equal(guard.reserved,307200);
  const budget=new DispatchGuard(300000,async()=>{});
  await budget.take('first');await assert.rejects(()=>budget.take('second'));
  const broken=new DispatchGuard(61440,async()=>{throw new Error('disk');});
  await assert.rejects(()=>broken.take('first'));assert.equal(broken.calls,1);
  const resumed=new DispatchGuard(61440,async()=>{},{calls:1,reserved_micro_usd:61440});
  for(let i=0;i<4;i++)await resumed.take('resumed-'+i);
  assert.equal(resumed.calls,5);assert.equal(resumed.reserved,307200);
  await assert.rejects(()=>resumed.take('fifth-new'));
});

test('offline five-turn evaluation traverses actual adapter, worker, accounting and isolated DB; refuses rerun',async()=>{
  const dir=join(await mkdtemp(join(tmpdir(),'liferpg-campaign-')),'evaluation');
  let calls=0;
  const transport=async(body,signal)=>{
    calls++;assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.reasoning.effort,'medium');
    const c=JSON.parse(body.input[0].content),reply=await new MockGm().generate(c,signal);
    const p=proposal.parse(reply.proposal);
    return {status:200,body:{model:body.model,status:'completed',service_tier:'default',
      usage:{input_tokens:100,output_tokens:100,total_tokens:200,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}},
      output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({...p,question:p.question??null})}]}]}};
  };
  const r=await runEvaluation({dir,config:readOpenAiConfig({GM_MAX_OUTPUT_TOKENS:'2048'}),transport});
  assert.equal(calls,5);assert.equal(r.api_calls,0);assert.equal(r.turns.length,5);
  assert.ok(r.turns.every(t=>t.receipt.status==='committed'));
  assert.equal(r.game.xp,10);assert.equal(r.records.records.length,2);
  assert.equal(r.samples.length,5);assert.ok(r.samples.every(s=>s.api_requests===1&&s.operation_id));
  assert.equal(r.attempts.length,5);assert.ok(r.attempts.every(a=>Number(a.actual_cost)===1200));
  const before=await readFile(join(dir,'dispatch.jsonl'),'utf8');
  await assert.rejects(()=>runEvaluation({dir,config:readOpenAiConfig({GM_MAX_OUTPUT_TOKENS:'2048'}),transport}));
  assert.equal(calls,5);assert.equal(await readFile(join(dir,'dispatch.jsonl'),'utf8'),before);
});

test('provider failure stops campaign at one call and preserves unknown cost reservation',async()=>{
  const dir=join(await mkdtemp(join(tmpdir(),'liferpg-campaign-')),'failure');let calls=0;
  const r=await runEvaluation({dir,config:readOpenAiConfig({GM_MAX_OUTPUT_TOKENS:'2048'}),transport:async()=>{calls++;return {status:503,body:null};}});
  assert.equal(calls,1);assert.equal(r.turns.length,1);
  assert.equal(r.turns[0].receipt.status,'retryable_error');assert.equal(r.turns[0].receipt.error_code,'gm_provider_temporary');
  assert.equal(r.attempts[0].actual_cost,null);assert.equal(Number(r.attempts[0].reserved_cost),61440);
  assert.equal(r.jobs[0].attempts,1);
});

test('resume inherits prior reservation and stops after four new turns without queueing fifth scenario',async()=>{
  const dir=join(await mkdtemp(join(tmpdir(),'liferpg-campaign-resume-')),'evaluation');let calls=0;
  const prior={calls:1,reserved_micro_usd:61440};
  const r=await runEvaluation({dir,config:readOpenAiConfig({GM_MAX_OUTPUT_TOKENS:'2048'}),prior,transport:async(body,signal)=>{
    calls++;const c=JSON.parse(body.input[0].content),p=proposal.parse((await new MockGm().generate(c,signal)).proposal);
    return {status:200,body:{model:body.model,status:'completed',service_tier:'default',
      usage:{input_tokens:100,output_tokens:100,total_tokens:200,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}},
      output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({...p,question:p.question??null})}]}]}};
  }});
  assert.equal(calls,4);assert.equal(r.turns.length,4);assert.equal(r.jobs.length,4);
  assert.ok(r.turns.every(t=>t.receipt.status==='committed'));
  assert.equal(r.cumulative_reserved_micro_usd,307200);assert.equal(r.usage.budget_limit,438560);
  assert.deepEqual(r.prior,prior);assert.deepEqual(r.unattempted_cases,[{case:5,request_id:'campaign-return'}]);
  const entries=(await readFile(join(dir,'dispatch.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
  assert.deepEqual(entries.map(e=>e.call),[2,3,4,5]);
});
