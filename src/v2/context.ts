import { DomainError } from './contracts.ts';
import { readRpg,references,effectiveStats } from './rpg.ts';
import type { RpgEntity } from './rpg.ts';
import type { Queryable } from './storage.ts';
import type { GmContext } from './worker.ts';
import type { MemoryRow } from './memory.ts';

export const CONTEXT_POLICY='memory-v1';
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value),'utf8');

/** Local deterministic retrieval; no embeddings, provider sessions, or second model call. */
export async function selectContext(tx:Queryable,owner:string,base:GmContext,fits:(c:GmContext)=>boolean) {
  const all=(await readRpg(tx,owner)).filter(e=>!e.retired),byId=new Map(all.map(e=>[e.id,e]));
  const stats=effectiveStats(all);
  const holdings=new Map<string,string[]>();
  for(const e of all)if(e.body?.kind==='holding'&&e.body.quantity)holdings.set(e.body.definition,[...(holdings.get(e.body.definition)??[]),e.id]);
  const search=[base.input.summary,base.input.message,...(base.clarification_history??[]).map(h=>JSON.stringify(h))].filter(Boolean).join(' ').toLocaleLowerCase();
  const requestedIds:string[]=search.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)??[];
  const terms=[...new Set(search.match(/[\p{L}\p{N}]{2,}/gu)??[])].filter(s=>!['input','message','summary','history','synthetic','test'].includes(s)).slice(0,24);
  const mentioned=all.filter(e=>search.includes(e.id)||(e.body&&'name'in e.body&&search.includes(e.body.name.toLocaleLowerCase())));
  const core=new Set(all.filter(e=>e.kind==='character'||(e.body?.kind==='holding'&&e.body.slot)).map(e=>e.id));
  for(const e of mentioned)core.add(e.id);
  const linked=(ids:Iterable<string>)=>{
    const result=new Set(ids),queue=[...result];
    while(queue.length) {
      const e=byId.get(queue.pop()!);if(!e)continue;
      const refs=e.body&&!e.needs_reinterpretation?references(e.body):[];
      // Owned definitions need their holding/version as well for inventory changes.
      refs.push(...(holdings.get(e.id)??[]));
      for(const id of refs)if(byId.has(id)&&!result.has(id)){result.add(id);queue.push(id);}
    }
    return result;
  };
  let entityIds=linked(core);
  const candidates=(await tx.query(`SELECT m.*,p.body,
    (CASE WHEN m.kind='identity' THEN 10000 ELSE 0 END + CASE WHEN m.id::text=ANY($4::text[]) THEN 20000 ELSE 0 END
    + CASE WHEN m.claim_type='canon' THEN 350 ELSE 0 END
    + CASE WHEN m.unresolved THEN 280 ELSE 0 END + m.importance*20
    + CASE WHEN EXISTS(SELECT 1 FROM unnest($2::text[]) term WHERE position(term in lower(p.body::text))>0) THEN 240 ELSE 0 END
    + CASE WHEN COALESCE(p.body->'entity_ids','[]'::jsonb) ?| $3::text[] THEN 200 ELSE 0 END
    + CASE WHEN m.kind='summary' THEN 40 ELSE 0 END) AS score
    FROM memories m JOIN payloads p ON p.id=m.payload_id WHERE m.owner_id=$1 AND m.active
    AND NOT EXISTS(SELECT 1 FROM payload_sources s JOIN events e ON e.id=s.event_id WHERE s.payload_id=p.id AND e.deleted_at IS NOT NULL)
    ORDER BY score DESC,m.created_at DESC,m.id LIMIT 160`,[owner,terms,[...entityIds],requestedIds])).rows as MemoryRow[];
  const memoryTotal=Number((await tx.query('SELECT count(*) AS n FROM memories WHERE owner_id=$1 AND active AND payload_id IS NOT NULL',[owner])).rows[0].n);
  const identity=candidates.find(m=>m.kind==='identity');
  let memories=candidates.filter(m=>m===identity||requestedIds.includes(m.id));
  entityIds=linked([...entityIds,...memories.flatMap(m=>(m.body.entity_ids??[]).filter(id=>byId.has(id)))]);
  const pending=(await tx.query('SELECT id,xp_delta FROM decisions WHERE owner_id=$1 AND needs_reinterpretation ORDER BY created_at,id LIMIT 8',[owner])).rows;
  const pendingTotal=Number((await tx.query('SELECT count(*) AS n FROM decisions WHERE owner_id=$1 AND needs_reinterpretation',[owner])).rows[0].n);
  const identityHistory=Number((await tx.query("SELECT count(*) AS n FROM memories WHERE owner_id=$1 AND kind='identity'",[owner])).rows[0].n);
  const project=(e:RpgEntity)=>({id:e.id,kind:e.kind,version:e.version,visibility:e.visibility,needs_reinterpretation:e.needs_reinterpretation,
    body:e.needs_reinterpretation?null:e.body,private_notes:e.needs_reinterpretation?null:e.private_notes});
  const build=():GmContext=>({...base,effective_stats:stats,
    memories:memories.map(m=>({id:m.id,kind:m.kind,version:m.version,claim_type:m.claim_type,importance:m.importance,unresolved:m.unresolved,body:{text:m.body.text,entity_ids:m.body.entity_ids??[],reason:m.body.reason??null}})),
    rpg:{entities:[...entityIds].map(id=>project(byId.get(id)!)),pending_reinterpretations:pending},
    memory_status:{identity:identity?'present':identityHistory?'erased':'new',consolidation_due:memoryTotal>=12},
    context_omissions:{memories:memoryTotal-memories.length,entities:all.length-entityIds.size,pending_reinterpretations:pendingTotal-pending.length},
  });
  if(!fits(build()))throw new DomainError('required_context_limit');
  // Summaries stand in for their originals, without deleting or reclassifying the originals.
  const links=(await tx.query(`SELECT s.memory_id,s.source_id FROM memory_sources s JOIN memories m ON m.id=s.memory_id
    WHERE s.owner_id=$1 AND s.role='summary' AND m.active AND m.payload_id IS NOT NULL AND s.memory_id=ANY($2::uuid[])`,[owner,candidates.map(m=>m.id)])).rows;
  const covered=new Set<string>();
  const ranked=[
    ...candidates.filter(m=>!memories.includes(m)).map(m=>({score:m.score??0,m,e:undefined as RpgEntity|undefined})),
    ...all.filter(e=>!entityIds.has(e.id)).map(e=>({score:e.needs_reinterpretation?170:e.kind==='world_event'&&e.visibility==='private'?160:
      e.body?.kind==='quest'&&e.body.status==='active'?140:e.body?.kind==='holding'&&e.body.quantity?100:
      e.body&&'parent'in e.body&&e.body.parent&&entityIds.has(e.body.parent)?110:10,m:undefined as MemoryRow|undefined,e})),
  ].sort((a,b)=>b.score-a.score);
  for(const candidate of ranked) {
    const {m,e}=candidate;
    if(m&&covered.has(m.id)&&!search.includes(m.id))continue;
    const beforeEntities=entityIds,beforeMemories=memories;
    entityIds=linked([...entityIds,...(e?[e.id]:(m?.body.entity_ids??[]).filter(id=>byId.has(id)))]);
    if(m)memories=[...memories,m];
    if(!fits(build())){entityIds=beforeEntities;memories=beforeMemories;continue;}
    if(m?.kind==='summary')for(const link of links)if(link.memory_id===m.id)covered.add(link.source_id);
  }
  const context=build();
  const selected=[...entityIds].map(id=>byId.get(id)!);
  return {context,memories,entityIds:[...entityIds],pendingIds:pending.map(d=>d.id),
    payloadIds:[...memories.map(m=>m.payload_id),...selected.filter(e=>!e.needs_reinterpretation).flatMap(e=>[e.public_payload,e.private_payload].filter((id):id is string=>!!id))],
    manifest:{policy:CONTEXT_POLICY,selected_memory_ids:memories.map(m=>m.id),selected_entity_ids:[...entityIds],omissions:context.context_omissions,context_bytes:bytes(context)}};
}

export const defaultContextFits=(context:GmContext)=>bytes(context)<=16000;
