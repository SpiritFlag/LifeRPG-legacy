import { z } from 'zod';
import { lockGame } from './storage.ts';
import type { Database } from './storage.ts';

/** Trusted operator boundary, not exposed to MCP or GM proposals. Synthetic units only. */
export async function setMockBudget(db:Database,owner:string,value:unknown) {
  const limit=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(value);
  await db.transaction(async tx=>{
    await lockGame(tx,owner);
    await tx.query('UPDATE games SET budget_limit=$2 WHERE owner_id=$1',[owner,limit]);
    await tx.query("UPDATE jobs SET state='queued',available_at=clock_timestamp() WHERE owner_id=$1 AND state='blocked' AND request_id IN (SELECT id FROM requests WHERE owner_id=$1 AND error_code='budget_exhausted')",[owner]);
    await tx.query("UPDATE requests SET status='queued',error_code=NULL WHERE owner_id=$1 AND error_code='budget_exhausted'",[owner]);
  });
}
