import { createHash,randomUUID } from 'node:crypto';
import { EventConflict,serialized } from './storage.js';

/** Strip reserved private keys even inside free GM-authored narrative JSON.
 * @param {any} value @returns {any} */
export function publicProfile(value) {
  if(Array.isArray(value)) return value.map(publicProfile);
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([key])=>!key.startsWith('gm_')).map(([key,item])=>[key,publicProfile(item)]));
  return value;
}
/** @param {import('./database.js').Queryable} db @param {string} owner */
export async function initializationStatus(db,owner) {
  const draft=(await db.query("SELECT id,revision,kind FROM game_initializations WHERE owner_id=$1 AND status='preparing'",[owner])).rows[0];
  return draft ? {status:'preparing',initialization_id:draft.id,revision:draft.revision,kind:draft.kind} : {status:'unstarted'};
}
/** Caller holds the shared event/game write lock and a single transaction.
 * @param {import('./database.js').Queryable} db @param {string} owner @param {any} input
 * @param {boolean} allowSynthetic @param {(draft:any,chunks:any[],updateId:string)=>Promise<any>} finalize */
export async function applyInitialization(db,owner,input,allowSynthetic,finalize) {
  const hash=createHash('sha256').update(serialized(input)).digest('hex');
  const prior=(await db.query('SELECT input_hash,result FROM initialization_requests WHERE owner_id=$1 AND request_key=$2',[owner,input.request_key])).rows[0];
  if(prior) {
    if(prior.input_hash!==hash) throw new EventConflict('idempotency_conflict','Retry key was used with different initialization input');
    return {...prior.result,outcome:'replayed'};
  }
  if((await db.query('SELECT 1 FROM gm_updates u JOIN games g ON g.id=u.game_id WHERE g.owner_id=$1 AND u.request_key=$2',[owner,input.request_key])).rows.length) throw new EventConflict('idempotency_conflict','Request key already belongs to a game update');
  if((await db.query('SELECT 1 FROM games WHERE owner_id=$1',[owner])).rows.length) throw new EventConflict('already_initialized','A game already exists; initialization never resets it');
  const id=randomUUID();
  let draft,result;
  if(input.mode==='begin_initialization') {
    if(input.synthetic && !allowSynthetic) throw new EventConflict('initialization_disabled','Synthetic initialization requires explicit test configuration');
    if((await initializationStatus(db,owner)).status==='preparing') throw new EventConflict('initialization_in_progress','Continue or cancel the existing draft');
    draft=(await db.query(`INSERT INTO game_initializations(id,owner_id,kind,status,revision,character,starting_location)
      VALUES($1,$2,$3,'preparing',1,$4,$5) RETURNING *`,[randomUUID(),owner,input.synthetic ? 'test' : 'real',serialized(input.character),input.starting_location])).rows[0];
    result={outcome:'prepared',update_id:id,request_key:input.request_key,mode:input.mode,initialization:{status:'preparing',initialization_id:draft.id,revision:1,kind:draft.kind}};
  } else {
    draft=(await db.query('SELECT * FROM game_initializations WHERE id=$1 AND owner_id=$2 FOR UPDATE',[input.initialization_id,owner])).rows[0];
    if(!draft) throw new EventConflict('not_found','Initialization does not belong to this owner');
    if(draft.status!=='preparing') throw new EventConflict('initialization_closed','Initialization is no longer preparing');
    if(draft.revision!==input.expected_initialization_revision) throw new EventConflict('initialization_revision_conflict','Read current initialization revision',{current_initialization_revision:draft.revision});
    if(draft.kind==='test' && !allowSynthetic) throw new EventConflict('initialization_disabled','Synthetic initialization requires explicit test configuration');
    if(input.mode==='finalize_initialization') {
      const chunks=(await db.query("SELECT input FROM initialization_requests WHERE initialization_id=$1 AND input->>'mode' IN ('begin_initialization','prepare_initialization') ORDER BY sequence",[draft.id])).rows.map(r=>r.input);
      result=await finalize(draft,chunks,id);
      await db.query("UPDATE game_initializations SET status='completed',game_id=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1",[draft.id,result.after.game_id]);
    } else {
      const status=input.mode==='cancel_initialization' ? 'cancelled' : 'preparing';
      await db.query('UPDATE game_initializations SET status=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',[draft.id,status]);
      result={outcome:status==='cancelled' ? 'cancelled' : 'prepared',update_id:id,request_key:input.request_key,mode:input.mode,initialization:{status,initialization_id:draft.id,revision:draft.revision+1,kind:draft.kind}};
    }
  }
  if(!result.player_result) result.player_result={...result};
  await db.query('INSERT INTO initialization_requests(id,owner_id,initialization_id,request_key,input_hash,input,result) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,owner,draft.id,input.request_key,hash,serialized(input),serialized(result)]);
  return result;
}
