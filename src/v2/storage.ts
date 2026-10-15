import { createHash, randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../database.js';
import { DomainError } from './contracts.ts';
export type { Database, Queryable };

export function canonical(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value==='object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = (value:unknown) => createHash('sha256').update(canonical(value)).digest('hex');

// OAuth's unqualified queries also use isolated v2 tables, never v1 grants.
export function scopedDatabase(db:Database):Database {
  const transaction:Database['transaction'] = fn=>db.transaction(async tx=>{
    await tx.query('SET LOCAL search_path = liferpg_v2');
    return fn(tx);
  });
  return {transaction,query:(sql,values)=>transaction(tx=>tx.query(sql,values))};
}
export async function lockGame(tx:Queryable, owner:string) {
  await tx.query('INSERT INTO games(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
  return (await tx.query('SELECT * FROM games WHERE owner_id=$1 FOR UPDATE',[owner])).rows[0];
}
export async function activeEvent(tx:Queryable,owner:string,id:string) {
  const row=(await tx.query('SELECT * FROM events WHERE owner_id=$1 AND id=$2',[owner,id])).rows[0];
  if(!row) throw new DomainError('not_found');
  if(row.deleted_at) throw new DomainError('deleted');
  return row;
}

/** Every generated payload inherits ALL context roots, not model-authored citations. */
export async function savePayload(tx:Queryable,owner:string,kind:string,body:unknown,roots:string[]) {
  const ids=[...new Set(roots)];
  for(const id of ids) await activeEvent(tx,owner,id);
  const id=randomUUID();
  await tx.query('INSERT INTO payloads(id,owner_id,kind,body) VALUES($1,$2,$3,$4)',[id,owner,kind,JSON.stringify(body)]);
  for(const event of ids) await tx.query('INSERT INTO payload_sources(owner_id,payload_id,event_id) VALUES($1,$2,$3)',[owner,id,event]);
  return id;
}
export async function payloadRoots(tx:Queryable,owner:string,ids:string[]):Promise<string[]> {
  if(!ids.length) return [];
  return (await tx.query('SELECT DISTINCT event_id FROM payload_sources WHERE owner_id=$1 AND payload_id=ANY($2::uuid[])',[owner,ids])).rows.map(r=>r.event_id);
}
export async function loadPayload(tx:Queryable,owner:string,id:string|null) {
  if(!id) return null;
  return (await tx.query(`SELECT body FROM payloads p WHERE p.owner_id=$1 AND p.id=$2 AND NOT EXISTS(
    SELECT 1 FROM payload_sources s JOIN events e ON e.id=s.event_id WHERE s.payload_id=p.id AND e.deleted_at IS NOT NULL)`,[owner,id])).rows[0]?.body ?? null;
}

/** Remove source-dependent content atomically. Metadata is retained without the text/hash. */
export async function purgeSources(tx:Queryable,owner:string,ids:string[],deleted:boolean) {
  const affected=(await tx.query('SELECT DISTINCT payload_id FROM payload_sources WHERE owner_id=$1 AND event_id=ANY($2::uuid[])',[owner,ids])).rows.map(r=>r.payload_id);
  if(!affected.length) return 0;
  const requests=(await tx.query(`UPDATE requests SET status=$4,input_hash=NULL,error_code=NULL
    WHERE owner_id=$1 AND (input_payload=ANY($2::uuid[]) OR result_payload=ANY($2::uuid[]) OR event_ids && $3::uuid[])
    RETURNING id`,[owner,affected,ids,deleted?'deleted':'invalidated'])).rows.map(r=>r.id);
  await tx.query("UPDATE jobs SET state='cancelled',fencing=fencing+1,lease_until=NULL WHERE owner_id=$1 AND request_id=ANY($2::uuid[])",[owner,requests]);
  await tx.query("UPDATE questions SET state='expired' WHERE owner_id=$1 AND (payload_id=ANY($2::uuid[]) OR request_id=ANY($3::uuid[]))",[owner,affected,requests]);
  await tx.query('UPDATE memories SET active=false WHERE owner_id=$1 AND payload_id=ANY($2::uuid[])',[owner,affected]);
  await tx.query('UPDATE decisions SET needs_reinterpretation=true WHERE owner_id=$1 AND (payload_id=ANY($2::uuid[]) OR event_id=ANY($3::uuid[]))',[owner,affected,ids]);
  await tx.query('DELETE FROM payloads WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,affected]);
  return affected.length;
}
