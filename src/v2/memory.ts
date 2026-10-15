import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lockGame,payloadRoots,loadPayload,savePayload } from './storage.ts';
import type { Database } from './storage.ts';
import { DomainError } from './contracts.ts';

const memoryInput=z.strictObject({kind:z.enum(['identity','episode','reflection','summary','world']),text:z.string().min(1).max(2000),source_payload_ids:z.array(z.uuid()).max(50)});
/** Internal consolidation boundary. Dependencies are inherited from the read set. */
export async function deriveMemory(db:Database,owner:string,raw:unknown) {
  const input=memoryInput.parse(raw);
  return db.transaction(async tx=>{
    await lockGame(tx,owner);
    for(const id of input.source_payload_ids) if(!await loadPayload(tx,owner,id)) throw new DomainError('source_unavailable');
    const roots=await payloadRoots(tx,owner,input.source_payload_ids);
    const payload=await savePayload(tx,owner,input.kind,{text:input.text},roots);
    const version=Number((await tx.query('SELECT COALESCE(max(version),0)+1 AS version FROM memories WHERE owner_id=$1 AND kind=$2',[owner,input.kind])).rows[0].version);
    if(input.kind==='identity') await tx.query("UPDATE memories SET active=false WHERE owner_id=$1 AND kind='identity'",[owner]);
    const id=randomUUID();
    await tx.query('INSERT INTO memories(id,owner_id,kind,version,payload_id) VALUES($1,$2,$3,$4,$5)',[id,owner,input.kind,version,payload]);
    await tx.query('UPDATE games SET revision=revision+1 WHERE owner_id=$1',[owner]);
    return {id,payload_id:payload,version};
  });
}
