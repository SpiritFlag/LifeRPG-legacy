import { randomUUID } from 'node:crypto';
import { DomainError } from './contracts.ts';
import { savePayload } from './storage.ts';
import type { Queryable } from './storage.ts';
import type { EntityBody,Operation,Scene } from './rpg-contracts.ts';

type Holding={kind:'holding';definition:string;definition_version:number;quantity:number;slot:string|null};
type Body=EntityBody|Holding;
export type RpgEntity={id:string;kind:string;version:number;body:Body|null;private_notes:string|null;visibility:'public'|'private';retired:boolean;needs_reinterpretation:boolean;public_payload:string|null;private_payload:string|null};
function fail(code:string):never {throw new DomainError(code);}
const definitions=new Set(['profession','skill','trait','title','achievement','item','equipment']);
export async function readRpg(tx:Queryable,owner:string):Promise<RpgEntity[]> {
  const rows=(await tx.query(`SELECT e.*,p.body AS public_body,s.body AS private_body FROM rpg_entities e
    LEFT JOIN payloads p ON p.id=e.public_payload LEFT JOIN payloads s ON s.id=e.private_payload WHERE e.owner_id=$1 ORDER BY e.id`,[owner])).rows;
  if(rows.length>200)fail('rpg_context_limit');
  return rows.map(e=>({id:e.id,kind:e.kind,version:e.version,body:e.public_body??e.private_body?.body??null,
    private_notes:e.private_body?.notes??null,visibility:e.public_body?'public':'private',retired:e.retired,
    needs_reinterpretation:e.needs_reinterpretation,public_payload:e.public_payload,private_payload:e.private_payload}));
}
export function publicRpg(entities:RpgEntity[]) {
  const visible=visibleEntities(entities);
  return visible.map(e=>({id:e.id,version:e.version,...e.body}));
}
function references(b:Body):string[] {
  if(b.kind==='character')return [b.location,b.profession].filter((id):id is string=>!!id);
  if(b.kind==='holding')return [b.definition];
  if(b.kind==='relation')return [b.from,b.to];
  if(b.kind==='world_event')return [...(b.location?[b.location]:[]),...b.participants];
  if(b.kind==='quest')return b.location?[b.location]:[];
  return 'parent'in b&&b.parent?[b.parent]:[];
}
// Deletion may remove one end of an otherwise untainted edge. Hide the dependent
// projection too until a GM repairs it; never publish dangling private/erased IDs.
function visibleEntities(entities:RpgEntity[]) {
  let visible=entities.filter(e=>e.visibility==='public'&&e.body&&!e.retired&&!e.needs_reinterpretation);
  for(;;) {
    const ids=new Set(visible.map(e=>e.id));
    const next=visible.filter(e=>references(e.body!).every(id=>ids.has(id)));
    if(next.length===visible.length)return next;
    visible=next;
  }
}
export function effectiveStats(entities:RpgEntity[]) {
  entities=visibleEntities(entities);
  const character=entities.find(e=>e.body?.kind==='character'&&!e.retired&&!e.needs_reinterpretation)?.body;
  if(character?.kind!=='character')return [];
  const values=new Map(character.stats.map(s=>[s.name,s.value]));
  for(const holding of entities) {
    const h=holding.body;if(holding.retired||holding.needs_reinterpretation||h?.kind!=='holding'||!h.quantity)continue;
    const d=entities.find(e=>e.id===h.definition&&!e.retired&&!e.needs_reinterpretation)?.body;
    if(!d || !('effects' in d) || ['item'].includes(d.kind) || (d.kind==='equipment'&&!h.slot))continue;
    if(d.kind==='profession'&&character.profession!==h.definition)continue;
    for(const effect of d.effects)values.set(effect.name,(values.get(effect.name)??0)+effect.value);
  }
  return [...values].map(([name,value])=>({name,value}));
}

/** Full in-memory validation precedes writes; caller commits this with XP/decision/memory. */
export async function applyRpg(tx:Queryable,owner:string,input:{operations:Operation[];reward_source:string|null;scene:Scene|null},
  options:{kind:string;requestId:string;roots:string[];eventId:string|null;xpDelta:number;worldTick:number}) {
  const existing=await readRpg(tx,owner);
  const entities=new Map(existing.map(e=>[e.id,structuredClone(e)]));
  const aliases=new Map<string,string>();
  const history:RpgEntity[]=[];const changed=new Set<string>();const resolved:string[]=[];
  let tick=options.worldTick,benefit=options.xpDelta>0;
  const ref=(value:string)=>value.startsWith('@')?(aliases.get(value)??fail('rpg_unknown_ref')):value;
  const get=(value:string)=>entities.get(ref(value))??fail('rpg_unknown_ref');
  // Allocate aliases first for forward references. Existing IDs must be supplied with their version.
  for(const op of input.operations)if((op.op==='put'||op.op==='inventory')&&op.expected_version===0) {
    if(!op.ref.startsWith('@')||aliases.has(op.ref))fail('rpg_duplicate_alias');
    aliases.set(op.ref,randomUUID());
  }
  const mutate=(value:string,expected:number,kind:string,body:Body|null,visibility:'public'|'private',notes:string|null,retired=false)=>{
    const id=ref(value),old=entities.get(id);
    if((old?.version??0)!==expected)fail('rpg_version_conflict');
    if(old&&old.kind!==kind)fail('rpg_kind_immutable');
    if(old?.retired)fail('rpg_retired');
    const entity:RpgEntity={id,kind,version:expected+1,body,private_notes:notes,visibility,retired,needs_reinterpretation:false,public_payload:null,private_payload:null};
    entities.set(id,entity);history.push(structuredClone(entity));changed.add(id);return entity;
  };
  for(const op of input.operations) {
    if(op.op==='put') {
      const body=structuredClone(op.body),old=entities.get(ref(op.ref));
      if(body.kind==='character') {
        if(op.visibility!=='public')fail('rpg_character_private');
        if([...entities.values()].some(e=>e.kind==='character'&&e.id!==ref(op.ref)))fail('rpg_character_exists');
        if(body.profession)body.profession=ref(body.profession);if(body.location)body.location=ref(body.location);
        if(new Set(body.stats.map(s=>s.name)).size!==body.stats.length)fail('rpg_duplicate_stat');
        if(body.stats.some(s=>s.value<0))fail('rpg_negative_stat');
        const prior=old?.body;
        if(!prior||prior.kind!=='character'||body.level>prior.level||body.stats.some(s=>s.value>(prior.stats.find(p=>p.name===s.name)?.value??0)))benefit=true;
      } else if(body.kind==='quest') {
        if(body.location)body.location=ref(body.location);
        if(body.progress>body.target||(body.status==='completed'&&body.progress!==body.target))fail('rpg_quest_progress');
        const prior=old?.body;
        if(!prior&&body.status!=='offered'&&!old?.needs_reinterpretation)fail('rpg_quest_transition');
        if(prior?.kind==='quest') {
          const allowed={offered:['offered','active','failed'],active:['active','completed','failed'],completed:['completed'],failed:['failed']};
          if(!allowed[prior.status].includes(body.status)||body.progress<prior.progress||body.target!==prior.target)fail('rpg_quest_transition');
        }
      } else if(body.kind==='world_event') {
        if(body.location)body.location=ref(body.location);body.participants=body.participants.map(ref);
        const prior=old?.body;
        if(prior?.kind==='world_event'&&['resolved','cancelled'].includes(prior.status)&&body.status!==prior.status)fail('rpg_world_transition');
      } else if(body.kind==='relation') {
        body.from=ref(body.from);body.to=ref(body.to);if(body.from===body.to)fail('rpg_self_relation');
      } else if('parent' in body) {if(body.parent)body.parent=ref(body.parent);}
      else if('effects' in body) {
        if(new Set(body.effects.map(s=>s.name)).size!==body.effects.length||new Set(body.slots).size!==body.slots.length)fail('rpg_duplicate_stat');
        if(body.kind!=='equipment'&&body.slots.length)fail('rpg_invalid_slot');
        // Definition edits cannot silently change the effects of an existing possession.
        if(old&&[...entities.values()].some(e=>e.body?.kind==='holding'&&e.body.definition===old.id&&e.body.quantity>0&&!e.retired))fail('rpg_definition_in_use');
      }
      mutate(op.ref,op.expected_version,body.kind,body,op.visibility,op.private_notes);
    } else if(op.op==='inventory') {
      const definition=get(op.definition);if(!definition.body||!definitions.has(definition.kind)||definition.visibility!=='public'||definition.retired||definition.needs_reinterpretation)fail('rpg_invalid_definition');
      const old=entities.get(ref(op.ref)),h=old?.body;
      if(old&&(old.kind!=='holding'||(!h&&!old.needs_reinterpretation)))fail('rpg_kind_immutable');
      if(h?.kind==='holding'&&(h.definition!==definition.id||h.definition_version!==definition.version))fail('rpg_definition_version');
      const quantity=(h?.kind==='holding'?h.quantity:0)+op.delta;
      if(!Number.isSafeInteger(quantity)||quantity<0||quantity>1000000||op.delta===0)fail('rpg_inventory_balance');
      if(definition.kind!=='item'&&quantity>1)fail('rpg_unique_feature');
      if(op.delta>0)benefit=true;
      mutate(op.ref,op.expected_version,'holding',{kind:'holding',definition:definition.id,definition_version:definition.version,quantity,slot:quantity&&h?.kind==='holding'?h.slot:null},'public',null);
    } else if(op.op==='equip') {
      const e=get(op.ref),h=e.body;if(h?.kind!=='holding'||h.quantity!==1)fail('rpg_not_equippable');
      const d=get(h.definition).body;if(d?.kind!=='equipment'||(op.slot!==null&&!('slots' in d&&d.slots.includes(op.slot))))fail('rpg_invalid_slot');
      mutate(op.ref,op.expected_version,'holding',{...h,slot:op.slot},'public',null);
    } else if(op.op==='retire') {
      const e=get(op.ref);if(e.kind==='character')fail('rpg_character_retire');
      mutate(op.ref,op.expected_version,e.kind,null,e.visibility,null,true);
    } else if(op.op==='advance_time') {tick+=op.ticks;if(!Number.isSafeInteger(tick))fail('rpg_clock_overflow');}
    else {
      if(resolved.includes(op.decision_id))fail('rpg_duplicate_reinterpretation');
      const d=(await tx.query('SELECT 1 FROM decisions WHERE owner_id=$1 AND id=$2 AND needs_reinterpretation',[owner,op.decision_id])).rows[0];
      if(!d)fail('rpg_reinterpretation_unavailable');resolved.push(op.decision_id);
    }
  }
  const active=(id:string,kinds?:string[])=>{
    const e=entities.get(id);if(!e||e.retired||!e.body||e.needs_reinterpretation||(kinds&&!kinds.includes(e.kind)))fail('rpg_invalid_reference');return e!;
  };
  const slots=new Set<string>(),features=new Set<string>();
  for(const e of entities.values()) {
    const b=e.body;if(!b||e.retired||e.needs_reinterpretation)continue;
    const linked:string[]=[];
    if(b.kind==='character') {
      if(b.location){active(b.location,['place']);linked.push(b.location);}
      if(b.profession){active(b.profession,['profession']);linked.push(b.profession);
        if(![...entities.values()].some(h=>!h.retired&&h.body?.kind==='holding'&&h.body.definition===b.profession&&h.body.quantity===1))fail('rpg_profession_not_owned');}
    } else if(b.kind==='holding') {
      const d=active(b.definition);linked.push(b.definition);
      if(!definitions.has(d.kind)||d.version!==b.definition_version)fail('rpg_definition_version');
      const character=[...entities.values()].find(e=>e.body?.kind==='character'&&!e.needs_reinterpretation)?.body;
      if(b.quantity&&character?.kind==='character'&&d.body&&'effects'in d.body&&d.body.effects.some(s=>!character.stats.some(c=>c.name===s.name)))fail('rpg_unknown_stat');
      if(b.quantity&&d.kind!=='item'&&d.kind!=='equipment'){if(features.has(d.id))fail('rpg_duplicate_feature');features.add(d.id);}
      if(b.slot){if(slots.has(b.slot))fail('rpg_slot_occupied');slots.add(b.slot);}
    } else if(b.kind==='quest'||b.kind==='world_event') {
      if(b.location){active(b.location,['place']);linked.push(b.location);}
      if(b.kind==='world_event')for(const id of b.participants){active(id,['character','npc','faction']);linked.push(id);}
    } else if(b.kind==='relation') {active(b.from);active(b.to);linked.push(b.from,b.to);}
    else if('parent' in b&&b.parent) {
      active(b.parent,b.kind==='npc'?['place']: [b.kind]);linked.push(b.parent);
      let parent:string|null=b.parent;const seen=new Set([e.id]);
      while(parent){if(seen.has(parent))fail('rpg_parent_cycle');seen.add(parent);const p:Body|null=active(parent).body;parent=p&&'parent'in p?p.parent:null;}
    }
    if(e.visibility==='public'&&linked.some(id=>active(id).visibility!=='public'))fail('rpg_private_reference');
  }
  const all=[...entities.values()];
  if(options.kind==='start'&&!all.some(e=>e.kind==='character'&&e.body&&!e.retired))fail('rpg_birth_required');
  if(all.length>200)fail('rpg_entity_limit');
  if(effectiveStats(all).some(s=>Math.abs(s.value)>1000000))fail('rpg_stat_overflow');
  // Ordinary event and appeal entitlements are handled by the worker; independent rewards need a resolved source.
  let rewardId:string|null=null;
  if(input.reward_source) {
    const source=active(ref(input.reward_source));const b=source.body;
    if(!((b?.kind==='quest'&&b.status==='completed')||(b?.kind==='world_event'&&b.status==='resolved')))fail('rpg_reward_source');
    rewardId=source.id;
    if((await tx.query('SELECT 1 FROM rpg_reward_claims WHERE owner_id=$1 AND source_id=$2',[owner,rewardId])).rows.length)fail('rpg_reward_already_claimed');
  }
  if(benefit&&!options.eventId&&!['start','appeal'].includes(options.kind)&&!rewardId&&!resolved.length)fail('rpg_reward_required');
  if(resolved.length&&options.kind!=='action')fail('rpg_reinterpretation_requires_action');
  // Resolve presentation references only after graph validation, never expose private speakers.
  const presentation=input.scene?structuredClone(input.scene):null;
  if(presentation)for(const line of presentation.dialogue)if(line.speaker) {
    const speaker=active(ref(line.speaker));if(speaker.visibility!=='public')fail('rpg_private_reference');line.speaker=speaker.id;
  }
  // Every historical version is erasable and inherits the complete actual context provenance.
  for(const e of history) {
    const pub=e.visibility==='public'&&e.body?await savePayload(tx,owner,'rpg_public',e.body,options.roots):null;
    const priv=(e.private_notes||(e.visibility==='private'&&e.body))?await savePayload(tx,owner,'rpg_private',{notes:e.private_notes,body:e.visibility==='private'?e.body:null},options.roots):null;
    await tx.query(`INSERT INTO rpg_entities(id,owner_id,kind,version,public_payload,private_payload,retired) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,public_payload=EXCLUDED.public_payload,private_payload=EXCLUDED.private_payload,retired=EXCLUDED.retired,needs_reinterpretation=false`,[e.id,owner,e.kind,e.version,pub,priv,e.retired]);
    await tx.query('INSERT INTO rpg_versions(owner_id,entity_id,version,public_payload,private_payload) VALUES($1,$2,$3,$4,$5)',[owner,e.id,e.version,pub,priv]);
  }
  if(rewardId)await tx.query('INSERT INTO rpg_reward_claims(owner_id,source_id,request_id) VALUES($1,$2,$3)',[owner,rewardId,options.requestId]);
  for(const id of resolved)await tx.query('UPDATE decisions SET needs_reinterpretation=false WHERE owner_id=$1 AND id=$2',[owner,id]);
  await tx.query('UPDATE games SET world_tick=$2 WHERE owner_id=$1',[owner,tick]);
  const changes=all.filter(e=>changed.has(e.id)&&(e.visibility==='public'||existing.some(old=>old.id===e.id&&old.visibility==='public')))
    .map(e=>({kind:'entity' as const,id:e.id,entity_kind:e.kind,version:e.version,retired:e.retired,
      removed:e.retired||e.visibility!=='public',state:e.visibility==='public'?e.body:null}));
  return {changes,scene:presentation,world_tick:tick,effective_stats:effectiveStats(all)};
}
