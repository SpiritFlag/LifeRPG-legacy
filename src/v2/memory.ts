import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lockGame,payloadRoots,loadPayload,savePayload } from './storage.ts';
import type { Database,Queryable } from './storage.ts';
import { DomainError } from './contracts.ts';
import { memoryProposal } from './memory-contracts.ts';
import type { MemoryProposal } from './memory-contracts.ts';

export type MemoryRow={id:string;kind:string;version:number;payload_id:string;claim_type:string;importance:number;unresolved:boolean;body:{text:string;entity_ids?:string[];reason?:string|null};score?:number};

/** Called inside the game transaction. All read context, not just model citations, is inherited. */
export async function commitMemories(tx:Queryable,owner:string,items:MemoryProposal[],options:{roots:string[];sources:MemoryRow[];entityIds:string[];payloadIds?:string[];aliases?:Map<string,string>;internal?:boolean}) {
  if(items.filter(m=>m.kind==='identity').length>1)throw new DomainError('identity_conflict');
  const replacements=items.flatMap(m=>m.replaces_memory_id?[m.replaces_memory_id]:[]);
  if(new Set(replacements).size!==replacements.length)throw new DomainError('memory_revision_conflict');
  const saved=[];
  for(const item of [...items].sort((a,b)=>Number(a.kind==='identity')-Number(b.kind==='identity'))) {
    const sources=item.source_memory_ids.map(id=>{
      const found=options.sources.find(s=>s.id===id);if(!found)throw new DomainError('memory_source_unavailable');return found;
    });
    if(new Set(item.source_memory_ids).size!==sources.length)throw new DomainError('memory_source_duplicate');
    if(item.kind==='summary'&&!sources.length&&!options.internal)throw new DomainError('summary_sources_required');
    if(item.kind==='summary'&&sources.length) {
      const types=new Set(sources.map(s=>s.claim_type));
      if(item.claim_type!=='mixed'&&(types.size!==1||!types.has(item.claim_type)))throw new DomainError('summary_claim_promotion');
    }
    if(['identity','reflection'].includes(item.kind)&&item.claim_type!=='interpretation')throw new DomainError('identity_claim_type');
    if(item.replaces_memory_id) {
      const prior=options.sources.find(s=>s.id===item.replaces_memory_id);
      if(!prior||prior.kind!==item.kind||prior.claim_type!==item.claim_type||item.kind==='identity')throw new DomainError('memory_revision_conflict');
      await tx.query('UPDATE memories SET active=false WHERE owner_id=$1 AND id=$2',[owner,prior.id]);
    }
    const refs=item.entity_ids.map(id=>{
      if(id.startsWith('@'))return options.aliases?.get(id)??(()=>{throw new DomainError('memory_entity_unavailable');})();
      if(!options.entityIds.includes(id))throw new DomainError('memory_entity_unavailable');return id;
    });
    if(item.claim_type==='npc_claim') {
      if(!refs.length||!(await tx.query("SELECT 1 FROM rpg_entities WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND kind='npc' AND NOT retired",[owner,refs])).rows.length)
        throw new DomainError('npc_claim_speaker_required');
    }
    const previous=item.kind==='identity'?(await tx.query("SELECT id FROM memories WHERE owner_id=$1 AND kind='identity' ORDER BY version DESC,created_at DESC LIMIT 1",[owner])).rows[0]:null;
    if(previous&&!options.internal&&(!item.reason||(!items.some(m=>m.kind==='reflection')&&!sources.some(m=>m.kind==='reflection'))))throw new DomainError('identity_reflection_required');
    const importance=Math.max(item.importance,...(item.kind==='summary'?sources.map(s=>s.importance):[]));
    const unresolved=item.unresolved||(item.kind==='summary'&&sources.some(s=>s.unresolved));
    const content=await savePayload(tx,owner,item.kind,{text:item.text,entity_ids:refs,reason:item.reason,source_payload_ids:options.payloadIds??options.sources.map(s=>s.payload_id)},options.roots);
    const version=Number((await tx.query('SELECT COALESCE(max(version),0)+1 AS version FROM memories WHERE owner_id=$1 AND kind=$2',[owner,item.kind])).rows[0].version);
    if(item.kind==='identity')await tx.query("UPDATE memories SET active=false WHERE owner_id=$1 AND kind='identity'",[owner]);
    const id=randomUUID();
    await tx.query(`INSERT INTO memories(id,owner_id,kind,version,payload_id,claim_type,importance,unresolved,previous_identity)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,owner,item.kind,version,content,item.claim_type,importance,unresolved,previous?.id??null]);
    for(const source of options.sources)await tx.query('INSERT INTO memory_sources(owner_id,memory_id,source_id,role) VALUES($1,$2,$3,$4)',[owner,id,source.id,item.kind==='summary'&&item.source_memory_ids.includes(source.id)?'summary':'context']);
    for(const source of saved)await tx.query("INSERT INTO memory_sources(owner_id,memory_id,source_id,role) VALUES($1,$2,$3,'context')",[owner,id,source.id]);
    saved.push({id,payload_id:content,version});
  }
  return saved;
}

const memoryInput=z.strictObject({kind:z.enum(['identity','episode','reflection','summary','world']),text:z.string().min(1).max(2000),source_payload_ids:z.array(z.uuid()).max(50)});
/** Internal consolidation boundary. Dependencies are inherited from the read set. */
export async function deriveMemory(db:Database,owner:string,raw:unknown) {
  const input=memoryInput.parse(raw);
  return db.transaction(async tx=>{
    await lockGame(tx,owner);
    for(const id of input.source_payload_ids) if(!await loadPayload(tx,owner,id)) throw new DomainError('source_unavailable');
    const roots=await payloadRoots(tx,owner,input.source_payload_ids);
    const sources=(await tx.query('SELECT m.*,p.body FROM memories m JOIN payloads p ON p.id=m.payload_id WHERE m.owner_id=$1 AND m.payload_id=ANY($2::uuid[])',[owner,input.source_payload_ids])).rows as MemoryRow[];
    const memory=memoryProposal.parse({kind:input.kind,text:input.text,claim_type:input.kind==='summary'?'mixed':'interpretation'});
    memory.source_memory_ids=sources.map(s=>s.id); // Trusted consolidation supports its original 50-source bound.
    const [result]=await commitMemories(tx,owner,[memory],{roots,sources,entityIds:[],payloadIds:input.source_payload_ids,internal:true});
    await tx.query('UPDATE games SET revision=revision+1 WHERE owner_id=$1',[owner]);
    return result;
  });
}
