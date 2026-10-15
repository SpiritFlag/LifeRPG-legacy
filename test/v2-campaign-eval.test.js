import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvaluation,DispatchGuard,CAP } from '../scripts/evaluate-v2-campaign.mjs';
import { MockGm } from '../src/v2/mock-gm.ts';
import { proposal } from '../src/v2/contracts.ts';
import { readOpenAiConfig } from '../src/v2/openai-config.ts';

test('durable dispatch ceiling cannot be freed by settlement or an unknown response',async()=>{
  const entries=[],guard=new DispatchGuard(61440,async e=>entries.push(e));
  for(let i=0;i<CAP.calls;i++)await guard.take(`operation-${i}`);
  await assert.rejects(()=>guard.take('sixth'));
  assert.equal(entries.length,5);assert.equal(guard.reserved,307200);
  const budget=new DispatchGuard(300000,async()=>{});
  await budget.take('first');await assert.rejects(()=>budget.take('second'));
  const broken=new DispatchGuard(61440,async()=>{throw new Error('disk');});
  await assert.rejects(()=>broken.take('first'));assert.equal(broken.calls,1);
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
  const r=await runEvaluation({dir,config:readOpenAiConfig({}),transport});
  assert.equal(calls,5);assert.equal(r.api_calls,0);assert.equal(r.turns.length,5);
  assert.ok(r.turns.every(t=>t.receipt.status==='committed'));
  assert.equal(r.game.xp,10);assert.equal(r.records.records.length,2);
  assert.equal(r.samples.length,5);assert.ok(r.samples.every(s=>s.api_requests===1&&s.operation_id));
  assert.equal(r.attempts.length,5);assert.ok(r.attempts.every(a=>Number(a.actual_cost)===1200));
  const before=await readFile(join(dir,'dispatch.jsonl'),'utf8');
  await assert.rejects(()=>runEvaluation({dir,config:readOpenAiConfig({}),transport}));
  assert.equal(calls,5);assert.equal(await readFile(join(dir,'dispatch.jsonl'),'utf8'),before);
});

test('provider failure stops campaign at one call and preserves unknown cost reservation',async()=>{
  const dir=join(await mkdtemp(join(tmpdir(),'liferpg-campaign-')),'failure');let calls=0;
  const r=await runEvaluation({dir,config:readOpenAiConfig({}),transport:async()=>{calls++;return {status:503,body:null};}});
  assert.equal(calls,1);assert.equal(r.turns.length,1);
  assert.equal(r.turns[0].receipt.status,'retryable_error');assert.equal(r.turns[0].receipt.error_code,'gm_provider_temporary');
  assert.equal(r.attempts[0].actual_cost,null);assert.equal(Number(r.attempts[0].reserved_cost),61440);
  assert.equal(r.jobs[0].attempts,1);
});
