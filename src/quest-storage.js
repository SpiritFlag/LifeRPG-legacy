import { randomUUID } from 'node:crypto';
import { EventConflict,serialized } from './storage.js';

const terminal=new Set(['completed','failed','abandoned']);
const storyFields=['title','description','goal','progress','ending','status'];
/** @param {any} before @param {any} after @param {boolean} reopen */
function transition(before,after,reopen) {
  if (reopen && (!terminal.has(before.status) || after.status !== 'active')) throw new EventConflict('invalid_quest_transition','Reopen requires a terminal state and target active');
  if (before.status === after.status) return;
  if (terminal.has(before.status)) {
    if (!reopen || after.status !== 'active') throw new EventConflict('quest_reopen_required','A finished story requires explicit reopen and reason');
    return;
  }
  const allowed=before.status === 'available' ? ['active',...terminal] : before.status === 'active' ? ['paused',...terminal] : ['active',...terminal];
  if (!allowed.includes(after.status)) throw new EventConflict('invalid_quest_transition','Quest status transition is not allowed');
}
/** @param {import('./database.js').Queryable} db @param {any} game @param {string} updateId @param {import('./quest-schema.js').QuestOperation[]} operations */
export async function applyQuestChanges(db,game,updateId,operations) {
  /** @type {Map<string,{id:string,type:string}>} */
  const refs=new Map();
  /** @type {any[]} */
  const results=[];
  const closures=[];
  const resolutions=new Set();
  const advances=new Set();
  const prerequisiteTargets=new Set();
  /** @param {string} ref @param {string} type */
  function resolve(ref,type) {
    if (!ref.startsWith('@')) return ref;
    const item=refs.get(ref);
    if (!item || item.type !== type) throw new EventConflict('quest_reference_conflict','Temporary reference is missing or has a different type',{reference:ref});
    return item.id;
  }
  /** @param {string} table @param {string} id */
  async function get(table,id) {
    const row=(await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE t.game_id=$1 AND t.id=$2`,[game.id,id])).rows[0]?.value;
    if (!row) throw new EventConflict('quest_not_found','Quest reference does not belong to this game',{id});
    return row;
  }
  /** @param {string} table @param {any} data @param {any} before */
  async function save(table,data,before) {
    // table/column names come only from this module and strict operation schemas.
    const columns=Object.keys(data),values=Object.values(data);
    if (before && columns.every(k=>serialized(before[k]) === serialized(data[k]))) return before;
    const sql=before ? `UPDATE ${table} SET ${columns.map((k,i)=>`${k}=$${i+2}`).join(',')},version=version+1 WHERE id=$1 RETURNING to_jsonb(${table}) AS value`
      : `INSERT INTO ${table}(id,${columns.join(',')}) VALUES($1,${columns.map((_,i)=>`$${i+2}`).join(',')}) RETURNING to_jsonb(${table}) AS value`;
    return (await db.query(sql,[before?.id || randomUUID(),...values])).rows[0].value;
  }
  /** @param {string} type @param {any} before @param {any} after @param {string} reason @param {string[]} retained */
  async function record(type,before,after,reason,retained=[]) {
    const changed=!before || before.version !== after.version;
    const result={outcome:changed ? before ? 'updated' : 'created' : 'unchanged',target_type:type,target_id:after.id,questline_id:type === 'line' ? after.id : type === 'line_link' ? after.from_id : after.questline_id,reason,retained_children:retained,before_state:before || null,after_state:after};
    if (changed) await db.query(`INSERT INTO quest_change_entries(game_id,update_id,ordinal,questline_id,target_type,target_id,reason,retained_children,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[game.id,updateId,results.length,result.questline_id,type,after.id,reason,serialized(retained),before ? serialized(before) : null,serialized(after)]);
    results.push(result);
  }
  /** @param {string} table @param {string} where @param {any[]} args */
  async function existing(table,where,args) {
    return (await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE t.game_id=$1 AND ${where}`,[game.id,...args])).rows[0]?.value;
  }
  for (const operation of operations) {
    if (operation.operation === 'create_line' || operation.operation === 'create_node') {
      if (refs.has(operation.ref)) throw new EventConflict('invalid_input','Temporary creation references must be unique');
      const line=operation.operation === 'create_node' ? await get('questlines',resolve(operation.questline,'line')) : null;
      const parent=operation.operation === 'create_node' && operation.parent ? await get('quest_nodes',resolve(operation.parent,'node')) : null;
      if (parent && (operation.operation !== 'create_node' || operation.kind !== 'quest' || parent.kind !== 'chapter' || parent.questline_id !== line.id)) throw new EventConflict('invalid_quest_parent','Quest parent must be a chapter in the same line');
      const type=operation.operation === 'create_line' ? 'line' : 'node';
      const table=type === 'line' ? 'questlines' : 'quest_nodes';
      const content=Object.fromEntries(storyFields.map(k=>[k,/** @type {any} */(operation)[k]]));
      const data=operation.operation === 'create_line' ? {game_id:game.id,line_key:operation.line_key,...content} : {game_id:game.id,questline_id:line.id,node_key:operation.node_key,kind:operation.kind,parent_id:parent?.id || null,...content};
      const before=operation.operation === 'create_line' ? await existing(table,'t.line_key=$2',[operation.line_key]) : await existing(table,'t.questline_id=$2 AND t.node_key=$3',[line.id,operation.node_key]);
      if (before && Object.keys(data).some(k=>serialized(before[k]) !== serialized(/** @type {any} */(data)[k]))) throw new EventConflict('quest_identity_conflict','Existing creation key requires explicit update',{id:before.id});
      const after=before || await save(table,data,null);
      refs.set(operation.ref,{id:after.id,type});
      await record(type,before,after,operation.reason);
      if (type === 'node' && !before && (after.status === 'active' || after.progress || after.ending)) advances.add(after.id);
      continue;
    }
    if (operation.operation === 'update_line' || operation.operation === 'update_node') {
      const type=operation.operation === 'update_line' ? 'line' : 'node',table=type === 'line' ? 'questlines' : 'quest_nodes';
      const id=resolve(operation.operation === 'update_line' ? operation.questline : operation.node,type);
      const before=await get(table,id),next={...before,...operation.changes};
      transition(before,next,operation.reopen);
      const retained=operation.retain_children.map(ref=>resolve(ref,'node'));
      for (const child of retained) {
        const node=await get('quest_nodes',child);
        if (type === 'line' ? node.questline_id !== id : before.kind !== 'chapter' || node.parent_id !== id) throw new EventConflict('invalid_quest_child','Retained child is not a descendant of this parent');
      }
      const after=await save(table,operation.changes,before);
      await record(type,before,after,operation.reason,retained);
      if (before.status !== after.status && (after.status === 'paused' || terminal.has(after.status))) closures.push({type,id,retained:new Set(retained)});
      if (type === 'node') {
        if ('status' in operation.changes) resolutions.add(id);
        if ((before.status !== after.status && (after.status === 'active' || terminal.has(after.status))) || before.progress !== after.progress || before.ending !== after.ending) advances.add(id);
      }
      continue;
    }
    if (operation.operation === 'link_nodes') {
      const from=await get('quest_nodes',resolve(operation.from,'node')),to=await get('quest_nodes',resolve(operation.to,'node'));
      if (from.id === to.id || from.questline_id !== to.questline_id) throw new EventConflict('invalid_quest_link','Node links need different nodes in the same line');
      const data={game_id:game.id,questline_id:from.questline_id,from_id:from.id,to_id:to.id,kind:operation.kind,label:operation.label,active:operation.active};
      const before=await existing('quest_node_links','t.from_id=$2 AND t.to_id=$3 AND t.kind=$4',[from.id,to.id,operation.kind]);
      const after=await save('quest_node_links',data,before);
      await record('node_link',before,after,operation.reason);
      if (operation.kind === 'prerequisite' && operation.active && (!before || before.version !== after.version)) prerequisiteTargets.add(to.id);
      continue;
    }
    if (operation.operation === 'link_lines') {
      const from=await get('questlines',resolve(operation.from,'line')),to=await get('questlines',resolve(operation.to,'line'));
      if (from.id === to.id) throw new EventConflict('invalid_quest_link','Cross-story links require different lines');
      const data={game_id:game.id,from_id:from.id,to_id:to.id,label:operation.label,active:operation.active};
      const before=await existing('questline_links','t.from_id=$2 AND t.to_id=$3',[from.id,to.id]);
      await record('line_link',before,await save('questline_links',data,before),operation.reason);
      continue;
    }
    const line=await get('questlines',resolve(operation.questline,'line'));
    const node=operation.node ? await get('quest_nodes',resolve(operation.node,'node')) : null;
    if (node && node.questline_id !== line.id) throw new EventConflict('invalid_quest_link','Event target node belongs to a different line');
    const event=(await db.query('SELECT r.after_state,e.kind FROM life_event_revisions r JOIN life_events e ON e.id=r.event_id WHERE r.event_id=$1 AND r.version=$2',[operation.event_id,operation.event_version])).rows[0];
    if (!event || event.kind !== game.kind || event.after_state.kind !== game.kind) throw new EventConflict('invalid_quest_event','Event revision is missing or belongs to a different real/test scope');
    const data={game_id:game.id,questline_id:line.id,node_id:node?.id || null,event_id:operation.event_id,event_version:operation.event_version,label:operation.label,active:operation.active};
    const before=await existing('event_quest_links','t.questline_id=$2 AND t.node_id IS NOT DISTINCT FROM $3::uuid AND t.event_id=$4',[line.id,node?.id || null,operation.event_id]);
    await record('event_link',before,await save('event_quest_links',data,before),operation.reason);
  }
  for (const closure of closures) {
    const children=(await db.query(`SELECT id,status FROM quest_nodes WHERE game_id=$1 AND ${closure.type === 'line' ? 'questline_id' : 'parent_id'}=$2`,[game.id,closure.id])).rows;
    for (const child of children) if (!terminal.has(child.status) && !resolutions.has(child.id) && !closure.retained.has(child.id)) throw new EventConflict('quest_children_unresolved','Explicitly resolve or retain every unfinished child',{child_id:child.id});
  }
  for (const id of advances) {
    const node=await get('quest_nodes',id),line=await get('questlines',node.questline_id);
    const parents=[{type:'line',row:line}];
    if (node.parent_id) parents.push({type:'node',row:await get('quest_nodes',node.parent_id)});
    for (const parent of parents) if (parent.row.status !== 'active') {
      const closing=closures.some(c=>c.type === parent.type && c.id === parent.row.id);
      if (!(closing && (terminal.has(node.status) || node.status === 'paused'))) throw new EventConflict('quest_parent_inactive','Advance requires active parents, or child resolution in the same parent closure',{parent_id:parent.row.id,node_id:node.id});
    }
    prerequisiteTargets.add(id);
  }
  const edges=(await db.query("SELECT from_id,to_id FROM quest_node_links WHERE game_id=$1 AND active AND kind='prerequisite'",[game.id])).rows;
  /** @type {Map<string,string[]>} */
  const graph=new Map();
  for (const edge of edges) graph.set(edge.from_id,[...(graph.get(edge.from_id) || []),edge.to_id]);
  const done=new Set(),visiting=new Set();
  /** @param {string} id */
  function visit(id) {
    if (visiting.has(id)) throw new EventConflict('quest_prerequisite_cycle','Prerequisite relationships cannot form a cycle');
    if (done.has(id)) return;
    visiting.add(id);for(const next of graph.get(id) || []) visit(next);visiting.delete(id);done.add(id);
  }
  for(const id of graph.keys()) visit(id);
  for(const id of prerequisiteTargets) {
    const target=await get('quest_nodes',id);
    if (!['active','completed'].includes(target.status)) continue;
    for(const edge of edges.filter(e=>e.to_id===id)) if ((await get('quest_nodes',edge.from_id)).status !== 'completed') throw new EventConflict('quest_prerequisite_unmet','All prerequisites must be completed before starting or completing the target',{node_id:id,prerequisite_id:edge.from_id});
  }
  return {changes:results,refs:Object.fromEntries([...refs].map(([key,value])=>[key,value.id])),changed:results.some(r=>r.outcome !== 'unchanged')};
}

/** @param {import('./database.js').Queryable} db @param {string} gameId @param {import('./quest-schema.js').QuestContextInput} input */
export async function getQuestContext(db,gameId,input) {
  const statuses=input.quest_statuses || (input.questline_id || input.event_id ? ['available','active','paused','completed','failed','abandoned'] : ['active']);
  const lines=(await db.query(`SELECT to_jsonb(q) AS value FROM questlines q WHERE game_id=$1 AND sequence>$2 AND status=ANY($3::text[])
    AND ($4::uuid IS NULL OR id=$4) AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM event_quest_links e WHERE e.game_id=q.game_id AND e.questline_id=q.id AND e.event_id=$5 AND e.active)) ORDER BY sequence LIMIT $6`,[gameId,input.after_quest_sequence,statuses,input.questline_id || null,input.event_id || null,input.quest_limit+1])).rows.map(r=>r.value);
  const summaries=lines.slice(0,input.quest_limit).map(line=>({id:line.id,sequence:line.sequence,line_key:line.line_key,title:line.title,status:line.status,version:line.version,goal:line.goal.slice(0,300),progress:line.progress.slice(0,300),ending:line.ending.slice(0,300),summary_truncated:[line.goal,line.progress,line.ending].some(text=>text.length>300)}));
  const result={questlines:summaries,next_after_quest_sequence:lines.length>input.quest_limit ? lines[input.quest_limit-1].sequence : null};
  if (!input.questline_id) return result;
  const line=(await db.query('SELECT to_jsonb(q) AS value FROM questlines q WHERE game_id=$1 AND id=$2',[gameId,input.questline_id])).rows[0]?.value;
  if (!line) throw new EventConflict('quest_not_found','Questline does not belong to this game');
  /** @param {string} table @param {string} where @param {number} cursor @param {number} limit */
  async function page(table,where,cursor,limit) {
    const rows=(await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE game_id=$1 AND (${where}) AND sequence>$3 ORDER BY sequence LIMIT $4`,[gameId,line.id,cursor,limit+1])).rows.map(r=>r.value);
    return {items:rows.slice(0,limit),next_after_sequence:rows.length>limit ? rows[limit-1].sequence : null};
  }
  return {...result,questline:line,
    nodes:await page('quest_nodes','questline_id=$2',input.after_node_sequence,input.node_limit),
    node_links:await page('quest_node_links','questline_id=$2',input.after_node_link_sequence,input.link_limit),
    line_links:await page('questline_links','from_id=$2 OR to_id=$2',input.after_line_link_sequence,input.link_limit),
    event_links:await page('event_quest_links','questline_id=$2',input.after_event_link_sequence,input.link_limit),
    history:await page('quest_change_entries',"questline_id=$2 OR (target_type='line_link' AND after_state->>'to_id'=$2::text)",input.after_quest_change_sequence,input.history_limit)};
}
