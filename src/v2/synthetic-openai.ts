import { mkdir,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { readOpenAiConfig,reservation } from './openai-config.ts';
import { createLiveOpenAiGm } from './openai-gm.ts';
import { scopedDatabase } from './storage.ts';
import { configureBudget,budgetUsage,resumeBudgetJobs } from './budget.ts';
import { setOwnerBudget } from './admin.ts';
import { LifeRpgService } from './service.ts';
import { GmWorker } from './worker.ts';
import { V2_SCOPES } from './contracts.ts';
import { openDeletionJournal } from './privacy.ts';
import { measureSyntheticGm } from './synthetic-metrics.ts';

async function main() {
  const env=process.env,config=readOpenAiConfig(env);
  const limit=z.coerce.number().int().min(0).max(10000000);
  const limits={lifetime:limit.parse(env.GM_LIFETIME_BUDGET_MICRO_USD??150000),daily:limit.parse(env.GM_DAILY_BUDGET_MICRO_USD??150000),monthly:limit.parse(env.GM_MONTHLY_BUDGET_MICRO_USD??150000)};
  const execute=process.argv.includes('--execute');
  console.info(JSON.stringify({mode:execute?'paid_synthetic':'dry_run',model:config.model,reasoning:config.reasoning,
    max_input_tokens:config.maxInputTokens,max_output_tokens:config.maxOutputTokens,price_card:config.price,
    reservation_micro_usd:reservation(config),maximum_calls_this_run:2,maximum_reserved_micro_usd:2*reservation(config),limits},null,2));
  if(!execute)return; // No key access, no DB open, no networking in preflight.
  const gm=createLiveOpenAiGm(config,env); // Explicit approval + key gate before any filesystem/DB work.
  // A fixed synthetic sandbox. Never reads DATABASE_URL or the mock/production data directories.
  const dir=resolve('.local/v2-openai-synthetic');await mkdir(dir,{recursive:true});
  const pg=new PGlite(dir);
  try {
    const isNew=!(await pg.query("SELECT 1 FROM pg_namespace WHERE nspname='liferpg_v2'")).rows.length;
    if(isNew)await pg.exec(await readFile(new URL('../../migrations/v2/001-foundation.sql',import.meta.url),'utf8'));
    if(!(await pg.query("SELECT 1 FROM information_schema.tables WHERE table_schema='liferpg_v2' AND table_name='gm_budget'")).rows.length)
      await pg.exec(await readFile(new URL('../../migrations/v2/002-openai-accounting.sql',import.meta.url),'utf8'));
    const db=scopedDatabase({query:async(s,v)=>pg.query(s,v),transaction:fn=>pg.transaction(tx=>fn({query:async(s,v)=>tx.query(s,v)}))});
    const journal=await openDeletionJournal(db,resolve('.local/v2-openai-synthetic-deletions.json'),isNew);
    const identity={subject:'synthetic-openai-only',scopes:V2_SCOPES};
    await configureBudget(db,limits);
    await setOwnerBudget(db,identity.subject,limits.lifetime);
    await resumeBudgetJobs(db,identity.subject);
    const service=new LifeRpgService(db,journal.sync,'openai');
    const measured=measureSyntheticGm(gm,sample=>console.info(JSON.stringify({type:'synthetic_gm_measurement',...sample})));
    const worker=new GmWorker(db,measured,{leaseMs:30000,timeoutMs:120000});
    const cases=[
      {tool:'interact_with_gm' as const,input:{request_id:'synthetic-openai-start-v1',kind:'start',message:'[SYNTHETIC TEST] 가상 플레이어와 작은 판타지 세계를 시작합니다. 현실 인물 정보는 없습니다.'}},
      {tool:'submit_observation' as const,input:{request_id:'synthetic-openai-walk-v1',summary:'[SYNTHETIC TEST] 가상 평가용 플레이어가 20분간 걸었습니다.',occurred_on:'2026-10-15',timezone:'Asia/Seoul'}},
    ];
    for(const item of cases) {
      const receipt=await service.execute(item.tool,item.input,identity);
      if(['queued','retryable_error'].includes(receipt.status))await worker.runOnce(); // At most one dispatch per case, no paid retry loop.
      const result=await service.execute('read_liferpg',{view:'request',operation_id:receipt.operation_id},identity);
      console.info(JSON.stringify({case:item.input.request_id,result}));
      if(!['committed','no_change'].includes(result.status)){process.exitCode=1;break;}
    }
    console.info(JSON.stringify({usage:await service.execute('read_liferpg',{view:'usage'},identity),server_budget:await db.transaction(budgetUsage)}));
    await journal.sync();
  } finally {await pg.close();}
}
main().catch(()=>{console.error('Synthetic GM test stopped. Check configuration, approval, local schema, and safe request error codes. Provider/key/error bodies are not logged.');process.exitCode=1;});
