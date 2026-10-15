import type { Database } from './storage.ts';
import type { Identity } from './contracts.ts';
import type { GmAdapter } from './worker.ts';
import { GmWorker } from './worker.ts';
import { requestResult,FRESH_REQUEST } from './service.ts';

/** One invocation owns one GM call. No drain loop, recovery or automatic retry. */
export function inlineGm(db:Database,gm:GmAdapter,waitUntil:(work:Promise<unknown>)=>void,waitMs=15000) {
  return async (receipt:Record<string,any>,identity:Identity,started:number):Promise<Record<string,any>>=>{
    if(receipt.status!=='queued' || !(receipt as Record<symbol,unknown>)[FRESH_REQUEST])return receipt;
    const id=receipt.operation_id as string,owner=identity.subject;
    const worker=new GmWorker(db,gm,{leaseMs:300000,timeoutMs:270000});
    worker.inline=true;
    const work=(async()=>{
      const claim=await worker.claim({owner,requestId:id});
      if(!claim) {
        // A concurrent invocation may already own this exact operation.
        await db.transaction(async tx=>{
          await tx.query("UPDATE requests SET status='failed',error_code='game_busy' WHERE owner_id=$1 AND id=$2 AND status='queued'",[owner,id]);
          await tx.query("UPDATE jobs SET state='failed' WHERE owner_id=$1 AND request_id=$2 AND state='queued' AND EXISTS(SELECT 1 FROM requests WHERE id=$2 AND status='failed')",[owner,id]);
        });
        return db.transaction(tx=>requestResult(tx,owner,id));
      }
      const apiStarted=Date.now();
      try {
        const reply=await gm.generate(claim.context,AbortSignal.timeout(270000));
        await db.query('UPDATE attempts SET gm_api_ms=$2 WHERE id=$1',[claim.attemptId,Date.now()-apiStarted]);
        await worker.complete(claim,reply);
      } catch {
        await db.query('UPDATE attempts SET gm_api_ms=COALESCE(gm_api_ms,$2) WHERE id=$1',[claim.attemptId,Date.now()-apiStarted]);
        await worker.fail(claim);
      }
      await db.query(`UPDATE requests SET finalized_at=clock_timestamp(),total_ms=ceil(extract(epoch FROM clock_timestamp()-created_at)*1000)::bigint
        WHERE owner_id=$1 AND id=$2 AND status NOT IN ('queued','running')`,[owner,id]);
      return db.transaction(tx=>requestResult(tx,owner,id));
    })().catch(()=>{console.error(JSON.stringify({type:'inline_gm_error',operation_id:id}));return null;});
    // Register the SAME promise before returning, including for a disconnected client.
    waitUntil(work);
    let timer:ReturnType<typeof setTimeout>|undefined;
    let result:Record<string,any>|null|undefined;
    try {
      result=await Promise.race([work,new Promise<void>(resolve=>{timer=setTimeout(resolve,Math.max(0,waitMs-(Date.now()-started)));})]);
    } finally {clearTimeout(timer);}
    // Never wait on another database round-trip once the response deadline expired.
    return result??{...receipt,status:'running',retry_after_ms:1000};
  };
}
