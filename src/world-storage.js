import { randomUUID } from 'node:crypto';
import { EventConflict,serialized } from './storage.js';
import { z } from 'zod';

const tables={entity:'world_entities',relation:'world_relations',fact:'world_facts',memory:'gm_memories',journal:'adventure_journals'};
const linkTables={fact:'world_fact_links',memory:'gm_memory_links',journal:'adventure_journal_links'};
/** @param {import('./database.js').Queryable} db @param {string} gameId @param {string} type @param {string} id */
async function read(db,gameId,type,id) {
  const table=/** @type {any} */(tables)[type];
  const row=(await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE game_id=$1 AND id=$2`,[gameId,id])).rows[0]?.value;
  if(!row) throw new EventConflict('world_not_found','World record does not belong to this game');
  const links=/** @type {any} */(linkTables)[type];
  if(links) row.links=(await db.query(`SELECT entity_id,fact_id,questline_id,event_id,event_version FROM ${links} WHERE game_id=$1 AND record_id=$2 ORDER BY ordinal`,[gameId,id])).rows.map(r=>r.entity_id ? {type:'entity',id:r.entity_id} : r.fact_id ? {type:'world_fact',id:r.fact_id} : r.questline_id ? {type:'questline',id:r.questline_id} : {type:'event',event_id:r.event_id,event_version:r.event_version});
  return row;
}
/** @param {import('./database.js').Queryable} db @param {string} gameId @param {string} type @param {string|null} id */
async function visible(db,gameId,type,id) {return !id || (await db.query(`SELECT 1 FROM ${type==='entity' ? 'world_entities' : 'world_facts'} WHERE game_id=$1 AND id=$2 AND visibility='player'`,[gameId,id])).rows.length>0;}
const publicFields={
  entity:['id','sequence','game_id','entity_key','category','kind','name','description','status','state','parent_id','location_id','affiliation_id','active','visibility','version','recorded_at'],
  relation:['id','sequence','game_id','relation_key','from_entity_id','to_entity_id','from_character','to_character','kind','description','state','active','visibility','version','recorded_at'],
  fact:['id','sequence','game_id','fact_key','kind','title','body','truth','speaker_id','world_time','links','visibility','version','recorded_at','revealed_at'],
  memory:['id','sequence','game_id','memory_key','kind','title','body','active','links','visibility','version','recorded_at'],
  journal:['id','sequence','game_id','journal_key','title','body','world_time','links','visibility','version','recorded_at'],
  clock:['game_id','root_id','world_time','last_world_advanced_at'],
};
/** Explicit projection applies to snapshots as well as current rows. Never recursively copy private JSON.
 * @param {import('./database.js').Queryable} db @param {string} gameId @param {string} type @param {any} row */
export async function publicWorldState(db,gameId,type,row) {
  if(!row || (type!=='clock' && row.visibility!=='player')) return null;
  if(type==='relation' && (!(await visible(db,gameId,'entity',row.from_entity_id)) || !(await visible(db,gameId,'entity',row.to_entity_id)))) return null;
  if(type==='fact' && !(await visible(db,gameId,'entity',row.speaker_id))) return null;
  if(type==='clock' && !(await visible(db,gameId,'entity',row.root_id))) return null;
  const result=Object.fromEntries(/** @type {any} */(publicFields)[type].filter((/** @type {string} */k)=>k in row).map((/** @type {string} */k)=>[k,row[k]]));
  if(type==='entity') for(const field of ['parent_id','location_id','affiliation_id']) if(!(await visible(db,gameId,'entity',result[field]))) result[field]=null;
  if(row.links) {result.links=[];for(const link of row.links) if(link.type==='event' || link.type==='questline' || await visible(db,gameId,link.type==='entity' ? 'entity' : 'fact',link.id)) result.links.push(link);}
  return result;
}
/** @param {import('./database.js').Queryable} db @param {string} gameId @param {any[]} changes */
export async function publicWorldChanges(db,gameId,changes) {
  const result=[];
  for(const change of changes) {
    const before=await publicWorldState(db,gameId,change.target_type,change.before_state),after=await publicWorldState(db,gameId,change.target_type,change.after_state);
    // Private-only changes on an otherwise public entity do not create public announcements.
    if((!before && !after) || (before && after && serialized({...before,version:0})===serialized({...after,version:0}))) continue;
    result.push({outcome:change.outcome,target_type:change.target_type,target_id:change.target_id,before_state:before,after_state:after});
  }
  return result;
}
/** A separately named player result never contains world private snapshots or GM reasons.
 * @param {any} result */
export function playerGmResult(result) {
  /** @param {any[]} entries */
  const omitReasons=entries=>entries.map(({reason,...entry})=>entry);
  return {outcome:result.outcome,update_id:result.update_id,request_key:result.request_key,mode:result.mode,before:result.before,after:result.after,
    changes:omitReasons(result.changes || []),quest_changes:omitReasons(result.quest_changes || []),quest_refs:result.quest_refs || {},content_changes:omitReasons(result.content_changes || []),content_refs:result.content_refs || {},
    ...(result.initialization ? {initialization:result.initialization} : {}),...(result.character_profile ? {character_profile:result.character_profile,starting_location_id:result.starting_location_id} : {}),...(result.character_change ? {character_change:result.character_change} : {}),
    ...(result.stat_effects ? {stat_effects:result.stat_effects} : {}),world_changes:result.world_changes || [],world_refs:result.world_refs || {}};
}

/** @param {import('./database.js').Queryable} db @param {any} game @param {string} updateId @param {import('./world-schema.js').WorldOperation[]} operations @param {Record<string,string>} questRefs */
export async function applyWorldChanges(db,game,updateId,operations,questRefs) {
  /** @type {Map<string,{id:string,type:string}>} */ const refs=new Map();
  /** @type {any[]} */ const results=[];
  const touched=new Set();let advanced=false;
  /** @param {string} value @param {string} type */
  function resolve(value,type) {
    if(!value.startsWith('@')) return value;
    const item=refs.get(value);
    if(type==='questline' && questRefs[value]) return questRefs[value];
    if(!item || item.type!==type) throw new EventConflict('world_reference_conflict','Missing or incorrectly typed temporary world reference');return item.id;
  }
  /** @param {string} ref @param {string} id @param {string} type */
  function bind(ref,id,type) {if(refs.has(ref)) throw new EventConflict('invalid_input','World refs must be unique');refs.set(ref,{id,type});}
  /** @param {any[]} input @param {string|undefined} self */
  async function resolveLinks(input,self) {
    const links=[];
    for(const link of input) {
      if(link.type==='event') {
        const e=(await db.query('SELECT e.kind,r.after_state FROM life_events e JOIN life_event_revisions r ON r.event_id=e.id WHERE e.id=$1 AND r.version=$2',[link.event_id,link.event_version])).rows[0];
        if(!e || e.kind!==game.kind || e.after_state.kind!==game.kind) throw new EventConflict('invalid_world_source','Life event revision must exist and match game kind');links.push(link);
      } else {
        const type=link.type==='world_fact' ? 'fact' : link.type,id=resolve(link.id,type);
        if(type==='questline') {if(!(await db.query('SELECT 1 FROM questlines WHERE game_id=$1 AND id=$2',[game.id,id])).rows.length) throw new EventConflict('world_not_found','Questline does not belong to this game');}
        else await read(db,game.id,type,id);
        if(id===self) throw new EventConflict('invalid_world_source','A record cannot link to itself');links.push({...link,id});
      }
    }
    links.sort((a,b)=>serialized(a).localeCompare(serialized(b)));
    if(new Set(links.map(l=>serialized(l))).size!==links.length) throw new EventConflict('invalid_world_source','Links must be distinct');return links;
  }
  /** @param {string} type @param {any} before @param {any} after @param {string} reason */
  async function record(type,before,after,reason) {
    const changed=!before || serialized(before)!==serialized(after),target=type==='clock' ? after.root_id : after.id;
    const value={outcome:changed ? before ? 'updated' : 'created' : 'unchanged',target_type:type,target_id:target,reason,before_state:before || null,after_state:after};
    if(changed) await db.query('INSERT INTO world_change_entries(game_id,update_id,ordinal,target_type,target_id,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[game.id,updateId,results.length,type,target,reason,before ? serialized(before) : null,serialized(after)]);
    results.push(value);
  }
  /** @param {string} type @param {any} data @param {any} before @param {string|undefined} id */
  async function save(type,data,before,id) {
    const table=/** @type {any} */(tables)[type],target=id || before?.id || randomUUID(),links=data.links;
    if(before && Object.keys(data).every(k=>serialized(before[k])===serialized(data[k]))) return before;
    const columns=Object.keys(data).filter(k=>k!=='links'),values=columns.map(k=>typeof data[k]==='object' && data[k]!==null ? serialized(data[k]) : data[k]);
    if(before) await db.query(`UPDATE ${table} SET ${columns.map((k,i)=>`${k}=$${i+2},`).join('')}version=version+1 WHERE id=$1`,[target,...values]);
    else await db.query(`INSERT INTO ${table}(id,game_id,${columns.join(',')}) VALUES($1,$2,${columns.map((_,i)=>`$${i+3}`).join(',')})`,[target,game.id,...values]);
    if(links) {
      const linkTable=/** @type {any} */(linkTables)[type];
      await db.query(`DELETE FROM ${linkTable} WHERE game_id=$1 AND record_id=$2`,[game.id,target]);
      for(const [index,link] of links.entries()) await db.query(`INSERT INTO ${linkTable}(game_id,record_id,ordinal,entity_id,fact_id,questline_id,event_id,event_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[game.id,target,index,link.type==='entity' ? link.id : null,link.type==='world_fact' ? link.id : null,link.type==='questline' ? link.id : null,link.event_id || null,link.event_version || null]);
    }
    return read(db,game.id,type,target);
  }
  /** @param {any} data */
  async function validateEntity(data) {
    if(data.id && [data.parent_id,data.location_id,data.affiliation_id].includes(data.id)) throw new EventConflict('world_hierarchy_cycle','An entity cannot contain or locate itself');
    if(data.category==='world') {if(data.parent_id || data.location_id || data.affiliation_id) throw new EventConflict('invalid_world_hierarchy','Root cannot have parents, location or affiliation');return;}
    if(!data.parent_id) throw new EventConflict('invalid_world_hierarchy','Non-root entities require a parent');
    for(const [field,kinds] of /** @type {[string,string[]][]} */([['parent_id',['world','place','faction']],['location_id',['place']],['affiliation_id',['faction']]])) {
      if(!data[field]) continue;
      const target=await read(db,game.id,'entity',data[field]);if(!kinds.includes(target.category)) throw new EventConflict('invalid_world_hierarchy','Incompatible parent/location/affiliation category');
    }
  }
  for(const operation of operations) {
    if(operation.operation==='advance_world') {
      if(advanced) throw new EventConflict('invalid_input','Advance the world clock once per request');advanced=true;
      const root=(await db.query("SELECT id FROM world_entities WHERE game_id=$1 AND category='world'",[game.id])).rows[0];if(!root) throw new EventConflict('world_not_found','Create a root before advancing the world');
      const before=(await db.query('SELECT to_jsonb(c) AS value FROM world_clocks c WHERE game_id=$1',[game.id])).rows[0]?.value;
      const after=(await db.query(`INSERT INTO world_clocks(game_id,root_id,world_time,last_world_advanced_at) VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT(game_id) DO UPDATE SET world_time=EXCLUDED.world_time,last_world_advanced_at=EXCLUDED.last_world_advanced_at RETURNING to_jsonb(world_clocks) AS value`,[game.id,root.id,operation.world_time ? serialized(operation.world_time) : null])).rows[0].value;
      await record('clock',before,after,operation.reason);continue;
    }
    const [action,type]=operation.operation.split('_'),table=/** @type {any} */(tables)[type];
    const input=/** @type {any} */(operation);
    const before=action==='update' ? await read(db,game.id,type,resolve(input[type],type)) : null;
    const data=action==='update' ? {...input.changes} : Object.fromEntries(Object.entries(input).filter(([k])=>!['operation','ref','reason'].includes(k)));
    const id=before?.id || randomUUID();
    if(type==='entity') {
      for(const [field,column] of [['parent','parent_id'],['location','location_id'],['affiliation','affiliation_id']]) if(field in data) {data[column]=data[field] ? resolve(data[field],'entity') : null;delete data[field];}
      await validateEntity({...before,...data});
      if(!before && data.category==='world' && (await db.query("SELECT 1 FROM world_entities WHERE game_id=$1 AND category='world' AND entity_key<>$2",[game.id,data.entity_key])).rows.length) throw new EventConflict('world_root_conflict','A world root already exists');
    }
    if(type==='relation' && !before) {
      for(const side of ['from','to']) {data[`${side}_character`]=data[side].type==='character';data[`${side}_entity_id`]=data[side].type==='entity' ? resolve(data[side].id,'entity') : null;delete data[side];}
      const from=data.from_entity_id ? await read(db,game.id,'entity',data.from_entity_id) : null,to=data.to_entity_id ? await read(db,game.id,'entity',data.to_entity_id) : null;
      if(data.from_entity_id===data.to_entity_id || (from?.category!=='npc' && to?.category!=='npc')) throw new EventConflict('invalid_world_relation','Distinct endpoints and at least one NPC are required');
    }
    if(type==='fact') {
      if('speaker' in data) {data.speaker_id=data.speaker ? resolve(data.speaker,'entity') : null;delete data.speaker;}
      const next={...before,...data};
      if(next.truth==='canon' ? !!next.speaker_id : !next.speaker_id) throw new EventConflict('invalid_world_truth','Canon has no speaker; claims/beliefs require an NPC speaker');
      if(next.speaker_id && (await read(db,game.id,'entity',next.speaker_id)).category!=='npc') throw new EventConflict('invalid_world_truth','Speaker must be an NPC');
    }
    if(data.links) data.links=await resolveLinks(data.links,before?.id);
    // Stable create keys refer to current content; explicit updates preserve historical versions.
    if(!before) {
      const keyField=`${type}_key`;
      const existing=(await db.query(`SELECT id FROM ${table} WHERE game_id=$1 AND ${keyField}=$2`,[game.id,data[keyField]])).rows[0];
      if(existing) {
        const prior=await read(db,game.id,type,existing.id);
        if(Object.keys(data).some(k=>serialized(prior[k])!==serialized(data[k]))) throw new EventConflict('world_identity_conflict','World key exists with different current content; use update');
        bind(input.ref,existing.id,type);await record(type,prior,prior,input.reason);continue;
      }
    }
    if(type==='fact' && data.visibility==='player' && (!before || before.visibility!=='player')) data.revealed_at=new Date().toISOString();
    const after=await save(type,data,before,id);if(!before) bind(input.ref,after.id,type);
    if(type==='entity') touched.add(after.id);
    await record(type,before,after,input.reason);
  }
  // Each hierarchy is independent: a faction may reside in a city affiliated with it.
  // UNION terminates even in a rejected cycle; identifiers below are module constants.
  for(const id of touched) for(const column of ['parent_id','location_id','affiliation_id']) {
    const cycle=await db.query(`WITH RECURSIVE ancestry(id) AS (
      SELECT ${column} FROM world_entities WHERE game_id=$1 AND id=$2 AND ${column} IS NOT NULL
      UNION SELECT e.${column} FROM ancestry a JOIN world_entities e ON e.id=a.id AND e.game_id=$1 WHERE e.${column} IS NOT NULL
    ) SELECT 1 FROM ancestry WHERE id=$2`,[game.id,id]);
    if(cycle.rows.length) throw new EventConflict('world_hierarchy_cycle','An individual parent/location/affiliation hierarchy cannot cycle');
  }
  const publicChanges=await publicWorldChanges(db,game.id,results),publicRefs={};
  for(const [name,value] of refs) if(await publicWorldState(db,game.id,value.type,await read(db,game.id,value.type,value.id))) Object.assign(publicRefs,{[name]:value.id});
  return {changes:publicChanges,refs:publicRefs,private_changes:results,private_refs:Object.fromEntries([...refs].map(([name,value])=>[name,value.id])),changed:results.some(c=>c.outcome!=='unchanged')};
}

const chronicleCursor=z.strictObject({order:z.enum(['recorded','occurred','world']),known:z.number().int().min(0).max(1),number:z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),stamp:z.iso.datetime({offset:true}),type:z.enum(['life_event','world_fact','journal']),id:z.uuid()});
/** @param {import('./database.js').Queryable} db @param {any} game @param {any} input @param {boolean} gm */
async function chronicle(db,game,input,gm) {
  let cursor=null;
  if(input.after_chronicle) {try{cursor=chronicleCursor.parse(JSON.parse(Buffer.from(input.after_chronicle,'base64url').toString('utf8')));if(cursor.order!==input.chronicle_order) throw new Error();}catch{throw new EventConflict('invalid_input','Invalid chronicle cursor or different order');}}
  const rows=(await db.query(`WITH entries AS (
    SELECT 'life_event'::text AS type,e.id,to_jsonb(e) AS value,e.recorded_at,e.occurred_start AS occurred_at,e.occurred_on,e.timezone,NULL::jsonb AS world_time,
      CASE WHEN e.occurred_start IS NOT NULL THEN 'exact_or_range' WHEN e.occurred_on IS NOT NULL THEN 'date_helper' ELSE 'unknown' END AS occurrence_basis
      FROM life_events e WHERE e.kind=$1 AND ($3::uuid IS NULL OR e.id=$3) AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM event_quest_links l WHERE l.event_id=e.id AND l.questline_id=$4 AND l.active))
    UNION ALL SELECT 'world_fact',f.id,to_jsonb(f),f.recorded_at,NULL,NULL,NULL,f.world_time,'world' FROM world_facts f WHERE f.game_id=$2 AND f.kind IN ('event','history') AND ($5 OR f.visibility='player')
      AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM world_fact_links l WHERE l.record_id=f.id AND l.event_id=$3)) AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM world_fact_links l WHERE l.record_id=f.id AND l.questline_id=$4))
    UNION ALL SELECT 'journal',j.id,to_jsonb(j),j.recorded_at,NULL,NULL,NULL,j.world_time,'world' FROM adventure_journals j WHERE j.game_id=$2 AND ($5 OR j.visibility='player')
      AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM adventure_journal_links l WHERE l.record_id=j.id AND l.event_id=$3)) AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM adventure_journal_links l WHERE l.record_id=j.id AND l.questline_id=$4))
  ),ordered AS (SELECT *,
    CASE WHEN $6='world' THEN CASE WHEN world_time->>'order' IS NULL THEN 1 ELSE 0 END WHEN $6='occurred' THEN CASE WHEN occurred_at IS NULL AND occurred_on IS NULL THEN 1 ELSE 0 END ELSE 0 END AS known,
    CASE WHEN $6='world' THEN coalesce((world_time->>'order')::bigint,0) ELSE 0 END AS number,
    CASE WHEN $6='occurred' THEN coalesce(occurred_at,occurred_on::timestamp AT TIME ZONE timezone,recorded_at) ELSE recorded_at END AS stamp FROM entries)
    SELECT *,to_char(stamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_stamp FROM ordered
    WHERE ($7::integer IS NULL OR (known,number,stamp,type,id)>($7,$8::bigint,$9::timestamptz,$10,$11::uuid)) ORDER BY known,number,stamp,type,id LIMIT $12`,[game.kind,game.id,input.event_id || null,input.questline_id || null,gm,input.chronicle_order,cursor?.known ?? null,cursor?.number || 0,cursor?.stamp || null,cursor?.type || null,cursor?.id || null,input.world_limit+1])).rows;
  const items=[];
  for(const r of rows.slice(0,input.world_limit)) {
    const value=r.type==='life_event' ? r.value : await read(db,game.id,r.type==='journal' ? 'journal' : 'fact',r.id);
    const projected=gm || r.type==='life_event' ? value : await publicWorldState(db,game.id,r.type==='journal' ? 'journal' : 'fact',value);
    if(projected) items.push({type:r.type,id:r.id,recorded_at:r.recorded_at,occurrence_basis:r.occurrence_basis,world_time:r.world_time,value:projected});
  }
  const last=rows[input.world_limit-1];
  return {order:input.chronicle_order,items,next_cursor:rows.length>input.world_limit ? Buffer.from(serialized({order:input.chronicle_order,known:last.known,number:Number(last.number),stamp:last.cursor_stamp,type:last.type,id:last.id})).toString('base64url') : null};
}
/** @param {import('./database.js').Queryable} db @param {any} game @param {any} input @param {boolean} gm */
export async function getWorldContext(db,game,input,gm) {
  const limit=input.world_limit,focus=input.world_entity_id || input.world_fact_id || input.memory_id || input.journal_id;
  // Focus ownership/visibility checks precede pagination; hidden IDs look like missing IDs.
  for(const [type,id] of [['entity',input.world_entity_id],['fact',input.world_fact_id],['memory',input.memory_id],['journal',input.journal_id]]) if(id) {
    const value=await read(db,game.id,type,id);if(!gm && input.view==='player' && !(await publicWorldState(db,game.id,type,value))) throw new EventConflict('world_not_found','World record is unavailable');
  }
  /** @param {string} type @param {string} conditions @param {any[]} params @param {number} cursor */
  async function page(type,conditions,params,cursor) {
    const table=/** @type {any} */(tables)[type];
    const rows=(await db.query(`SELECT t.id,t.sequence FROM ${table} t WHERE t.game_id=$1 AND t.sequence>$2 AND ($4 OR t.visibility='player') AND ${conditions} ORDER BY t.sequence LIMIT $3`,[game.id,cursor,limit+1,gm,...params])).rows;
    const items=[];
    for(const row of rows.slice(0,limit)) {
      let value=await read(db,game.id,type,row.id);if(!gm) value=await publicWorldState(db,game.id,type,value);if(!value) continue;
      if(!focus) {for(const field of ['description','body','gm_notes']) if(typeof value[field]==='string' && value[field].length>300) {value[field]=value[field].slice(0,300);value.summary_truncated=true;}for(const field of ['state','gm_state']) if(value[field]) {value[`${field}_omitted`]=Object.keys(value[field]).length>0;delete value[field];}}
      items.push(value);
    }
    return {items,next_after_sequence:rows.length>limit ? Number(rows[limit-1].sequence) : null};
  }
  const query=input.world_query ? `%${input.world_query.replace(/[\\%_]/g,'\\$&')}%` : null;
  const entities=await page('entity','($5::uuid IS NULL OR t.id=$5 OR t.parent_id=$5 OR t.location_id=$5 OR t.affiliation_id=$5) AND ($6::text IS NULL OR t.name ILIKE $6 OR t.description ILIKE $6 OR ($4 AND t.gm_notes ILIKE $6))',[input.world_entity_id || null,query],input.after_world_entity_sequence);
  const relations=await page('relation','($5::uuid IS NULL OR t.from_entity_id=$5 OR t.to_entity_id=$5) AND ($6::text IS NULL OR t.kind ILIKE $6 OR t.description ILIKE $6 OR ($4 AND t.gm_notes ILIKE $6))',[input.world_entity_id || null,query],input.after_world_relation_sequence);
  /** @param {string} type @param {string|undefined} id @param {number} cursor */
  const linkedPage=(type,id,cursor)=>page(type,`($5::uuid IS NULL OR t.id=$5) AND ($6::text IS NULL OR t.title ILIKE $6 OR t.body ILIKE $6 OR ($4 AND t.gm_notes ILIKE $6))
    AND ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM ${/** @type {any} */(linkTables)[type]} l WHERE l.record_id=t.id AND l.entity_id=$7))
    AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM ${/** @type {any} */(linkTables)[type]} l WHERE l.record_id=t.id AND l.event_id=$8))
    AND ($9::uuid IS NULL OR EXISTS(SELECT 1 FROM ${/** @type {any} */(linkTables)[type]} l WHERE l.record_id=t.id AND l.questline_id=$9))
    AND ($10::uuid IS NULL OR EXISTS(SELECT 1 FROM ${/** @type {any} */(linkTables)[type]} l WHERE l.record_id=t.id AND l.fact_id=$10)) ${type==='memory' && !id ? 'AND t.active=$11' : ''}`,[id || null,query,input.world_entity_id || null,input.event_id || null,input.questline_id || null,type==='fact' ? null : input.world_fact_id || null,...(type==='memory' && !id ? [input.memory_active] : [])],cursor);
  const facts=await linkedPage('fact',input.world_fact_id,input.after_world_fact_sequence),memories=await linkedPage('memory',input.memory_id,input.after_memory_sequence),journals=await linkedPage('journal',input.journal_id,input.after_journal_sequence);
  const clock=(await db.query(`SELECT to_jsonb(c) AS clock,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS server_time_utc,
    greatest(0,extract(epoch FROM clock_timestamp()-c.last_world_advanced_at)*1000)::bigint AS elapsed_real_ms FROM world_clocks c WHERE game_id=$1`,[game.id])).rows[0];
  const shownClock=clock && (gm || await publicWorldState(db,game.id,'clock',clock.clock));
  const result={entities,relations,facts,memories,journals,clock:shownClock ? {...clock.clock,server_time_utc:clock.server_time_utc,elapsed_real_ms:Number(clock.elapsed_real_ms)} : {world_time:null,last_world_advanced_at:null,server_time_utc:new Date().toISOString(),elapsed_real_ms:null}};
  if(input.include_world_history) {
    const rows=(await db.query('SELECT * FROM world_change_entries WHERE game_id=$1 AND sequence>$2 AND ($3::uuid IS NULL OR target_id=$3) ORDER BY sequence LIMIT $4',[game.id,input.after_world_change_sequence,focus || null,limit+1])).rows;
    const items=[];
    for(const row of rows.slice(0,limit)) {if(gm) items.push(row);else {const changes=await publicWorldChanges(db,game.id,[row]);if(changes.length) items.push({...changes[0],sequence:Number(row.sequence),update_id:row.update_id,recorded_at:row.recorded_at});}}
    Object.assign(result,{history:{items,next_after_sequence:rows.length>limit ? Number(rows[limit-1].sequence) : null}});
  }
  if(input.include_chronicle) Object.assign(result,{chronicle:await chronicle(db,game,input,gm)});
  return result;
}
