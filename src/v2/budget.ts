import { z } from 'zod';
import type { Database,Queryable } from './storage.ts';
import { lockGame } from './storage.ts';

export const budgetLimits=z.object({lifetime:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  daily:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),monthly:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
export async function budgetUsage(tx:Queryable) {
  // Outstanding charges carry across UTC boundaries; settlement is booked when received.
  return (await tx.query(`SELECT
    COALESCE(sum(CASE WHEN state='completed' THEN actual_cost ELSE reserved_cost END),0)::text AS lifetime,
    COALESCE(sum(CASE WHEN state<>'completed' THEN reserved_cost WHEN settled_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN actual_cost ELSE 0 END),0)::text AS daily,
    COALESCE(sum(CASE WHEN state<>'completed' THEN reserved_cost WHEN settled_at>=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN actual_cost ELSE 0 END),0)::text AS monthly
    FROM attempts WHERE provider='openai'`)).rows[0];
}
export async function canReserve(tx:Queryable,cost:number):Promise<boolean> {
  // All owners/workers share this lock. Caller locks its game first; no inverse lock order.
  const limits=(await tx.query('SELECT * FROM gm_budget WHERE id=true FOR UPDATE')).rows[0];
  if(!limits)return false;
  const used=await budgetUsage(tx);
  return ['lifetime','daily','monthly'].every(key=>BigInt(used[key])+BigInt(cost)<=BigInt(limits[`${key}_limit`]));
}
/** Trusted operator configuration only. It never resets consumed or unknown charges. */
export async function configureBudget(db:Database,raw:unknown) {
  const limits=budgetLimits.parse(raw);
  await db.transaction(async tx=>{
    await tx.query('UPDATE gm_budget SET lifetime_limit=$1,daily_limit=$2,monthly_limit=$3 WHERE id=true',[limits.lifetime,limits.daily,limits.monthly]);
  });
}

/** Explicit operator retry after raising a limit or crossing a UTC budget boundary. */
export async function resumeBudgetJobs(db:Database,owner:string) {
  await db.transaction(async tx=>{
    await lockGame(tx,owner);
    await tx.query("UPDATE jobs SET state='queued',available_at=clock_timestamp() WHERE owner_id=$1 AND state='blocked' AND request_id IN (SELECT id FROM requests WHERE owner_id=$1 AND error_code='budget_exhausted')",[owner]);
    await tx.query("UPDATE requests SET status='queued',error_code=NULL WHERE owner_id=$1 AND error_code='budget_exhausted'",[owner]);
  });
}
