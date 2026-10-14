import { createHash, randomUUID } from 'node:crypto';
import { EventConflict, lockEventWrites, serialized } from './storage.js';
import { growthFromXp, STAT_KEYS,adjudicationSchema } from './growth-schema.js';
import { publicProfile,initializationStatus,applyInitialization } from './initialization-storage.js';
import { applyQuestChanges,getQuestContext } from './quest-storage.js';
import { applyContentChanges,getContentContext,getStatEffects } from './content-storage.js';
import { applyWorldChanges,getWorldContext,playerGmResult } from './world-storage.js';

const zeroStats = () => ({STR:0,DEX:0,VIT:0,INT:0,CHA:0,LUK:0});
/** @param {any} value */
const digest = value => createHash('sha256').update(serialized(value)).digest('hex');
/** @param {import('./database.js').Queryable} db @param {string} owner @param {boolean} lock */
async function loadGame(db,owner,lock=false) {
  return (await db.query(`SELECT g.*,to_jsonb(c) AS character FROM games g JOIN characters c ON c.game_id=g.id WHERE g.owner_id=$1 ${lock ? 'FOR UPDATE OF g' : ''}`,[owner])).rows[0];
}
/** @param {any} game */
function state(game) {
  const c=game.character;
  const stats=Object.fromEntries(STAT_KEYS.map(k=>[k,Number(c[k.toLowerCase()])]));
  const xp=Number(c.xp_total);
  return {game_id:game.id,kind:game.kind,revision:game.revision,rules_version:game.rules_version,character:{label:c.label,xp_total:xp,...growthFromXp(xp),stats}};
}
/** @param {import('./database.js').Queryable} db @param {string} owner @param {import('zod').infer<typeof import('./growth-schema.js').contextSchema>} input */
export async function getGameContext(db,owner,input) {
  // The snapshot covers both character state and the recent judgment summary.
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  const game=await loadGame(db,owner);
  if (!game) return {outcome:'ok',initialized:false,initialization:await initializationStatus(db,owner)};
  const profile=(await db.query('SELECT profile FROM character_profiles WHERE game_id=$1',[game.id])).rows[0]?.profile;
  const birth=input.include_birth ? (await db.query('SELECT * FROM character_births WHERE game_id=$1',[game.id])).rows[0] : null;
  const profileRows=input.include_character_history ? (await db.query('SELECT * FROM character_profile_changes WHERE game_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',[game.id,input.after_character_change_sequence,input.history_limit+1])).rows : [];
  const profileHistory={items:profileRows.slice(0,input.history_limit).map(r=>({sequence:Number(r.sequence),update_id:r.update_id,before_state:publicProfile(r.before_state),after_state:publicProfile(r.after_state),recorded_at:r.recorded_at})),next_after_sequence:profileRows.length>input.history_limit ? Number(profileRows[input.history_limit-1].sequence) : null};
  const recent=await db.query(`SELECT id,sequence,subject_type,subject_key,aspect_key,previous_id,correction_of,reason,xp_delta,stats_delta,recorded_at FROM gm_adjudications WHERE game_id=$1 ORDER BY sequence DESC LIMIT 11`,[game.id]);
  const privateWorld=input.view==='gm' ? await getWorldContext(db,game,input,true) : null;
  return {outcome:'ok',initialized:true,initialization:{status:'completed',kind:game.kind},...state(game),...(profile ? {character_profile:publicProfile(profile)} : {}),...(birth ? {birth:{...birth,character:publicProfile(birth.character)}} : {}),...(input.include_character_history ? {character_history:profileHistory} : {}),...await getStatEffects(db,game.id,state(game).character.stats),recent_adjudications:recent.rows.slice(0,10).map(r=>({...r,...(input.view==='player' ? {reason:undefined} : {}),sequence:Number(r.sequence),xp_delta:Number(r.xp_delta)})),more_adjudications:recent.rows.length>10,...await getQuestContext(db,game.id,input),content:await getContentContext(db,game.id,input),world:await getWorldContext(db,game,input,false),...(privateWorld ? {gm_private:{world:privateWorld,...(profile ? {character_profile:profile} : {}),...(birth ? {birth} : {}),...(input.include_character_history ? {character_history:{...profileHistory,items:profileRows.slice(0,input.history_limit)}} : {})}} : {})};
}
/** @param {import('./database.js').Queryable} db @param {string} owner @param {import('./growth-schema.js').ListAdjudicationsInput} input */
export async function listAdjudications(db,owner,input) {
  const subject=input.subject;
  const key=subject?.type === 'event' ? subject.event_id : subject?.key;
  const rows=(await db.query(`SELECT to_jsonb(j) AS adjudication,
    (SELECT jsonb_agg(jsonb_build_object('event_id',s.event_id,'event_version',s.event_version,'revision',to_jsonb(r)) ORDER BY s.event_id)
      FROM gm_adjudication_sources s JOIN life_event_revisions r ON r.event_id=s.event_id AND r.version=s.event_version WHERE s.adjudication_id=j.id) AS sources
    FROM gm_adjudications j JOIN games g ON g.id=j.game_id WHERE g.owner_id=$1 AND j.sequence>$2
      AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM gm_adjudication_sources s WHERE s.adjudication_id=j.id AND s.event_id=$3))
      AND ($4::text IS NULL OR (j.subject_type=$4 AND j.subject_key=$5)) AND ($6::text IS NULL OR j.aspect_key=$6)
    ORDER BY j.sequence LIMIT $7`,[owner,input.after_sequence,input.event_id || null,subject?.type || null,key || null,input.aspect_key || null,input.limit+1])).rows;
  const items=rows.slice(0,input.limit).map(r=>({...r.adjudication,sources:r.sources}));
  return {outcome:'ok',adjudications:items,next_after_sequence:rows.length>input.limit ? items.at(-1).sequence : null};
}
/** @param {import('./database.js').Queryable} db @param {string} owner @param {{update_id?:string,request_key?:string,view?:string}} input */
export async function getGmUpdate(db,owner,input) {
  const row=(await db.query(`SELECT u.result FROM gm_updates u JOIN games g ON g.id=u.game_id WHERE g.owner_id=$1
    AND ($2::uuid IS NULL OR u.id=$2) AND ($3::text IS NULL OR u.request_key=$3)`,[owner,input.update_id || null,input.request_key || null])).rows[0];
  if (!row) {
    const pending=(await db.query(`SELECT result,input FROM initialization_requests WHERE owner_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::text IS NULL OR request_key=$3)`,[owner,input.update_id || null,input.request_key || null])).rows[0];
    if(!pending) throw new EventConflict('not_found','Stored GM update does not exist');
    return {outcome:'ok',update:input.view==='player' ? pending.result.player_result : {...pending.result,gm_private:{...pending.result.gm_private,preparation_input:pending.input}}};
  }
  return {outcome:'ok',update:input.view==='player' ? row.result.player_result || playerGmResult(row.result) : row.result};
}
/** @param {number} before @param {number} delta @param {string} field */
function changedNumber(before,delta,field) {
  const value=BigInt(before)+BigInt(delta);
  if (value<0n || value>BigInt(Number.MAX_SAFE_INTEGER)) throw new EventConflict('invalid_growth','Growth must stay within nonnegative safe integers',{field});
  return Number(value);
}
/** @param {any} before @param {import('./growth-schema.js').AdjudicationInput} judgment */
function changedCharacter(before,judgment) {
  const xp=changedNumber(before.xp_total,judgment.xp_delta,'xp_total');
  const stats=Object.fromEntries(STAT_KEYS.map(k=>[k,changedNumber(before.stats[k],judgment.stats_delta[k],k)]));
  return {...before,xp_total:xp,...growthFromXp(xp),stats};
}
/** @param {import('./database.js').Queryable} db @param {string} gameId @param {string} updateId @param {number} ordinal @param {any} change */
async function appendChange(db,gameId,updateId,ordinal,change) {
  await db.query(`INSERT INTO gm_change_entries(game_id,update_id,ordinal,adjudication_id,before_state,after_state,xp_delta,stats_delta,level_delta)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[gameId,updateId,ordinal,change.adjudication_id || null,change.before_state ? serialized(change.before_state) : null,serialized(change.after_state),change.xp_delta,serialized(change.stats_delta),change.level_delta]);
}
/** @param {import('./database.js').Queryable} db @param {string} gameId @param {string} updateId @param {string} key @param {string} hash @param {string} reason @param {any} result */
async function saveUpdate(db,gameId,updateId,key,hash,reason,result) {
  await db.query('INSERT INTO gm_updates(id,game_id,request_key,input_hash,reason,result) VALUES($1,$2,$3,$4,$5,$6)',[updateId,gameId,key,hash,reason,serialized(result)]);
}
/** @param {import('./database.js').Queryable} db @param {any} game @param {string} updateId @param {import('./growth-schema.js').AdjudicationInput} input @param {any} current */
async function applyAdjudication(db,game,updateId,input,current) {
  const sources=[...input.sources].sort((a,b)=>a.event_id.localeCompare(b.event_id));
  if (new Set(sources.map(s=>s.event_id)).size !== sources.length) throw new EventConflict('invalid_input','An event can appear only once in judgment sources');
  const subject=input.subject;
  if (subject.type === 'event' && !sources.some(s=>s.event_id===subject.event_id)) throw new EventConflict('invalid_input','The subject event must be among the sources');
  if (subject.type === 'event_group' && sources.length<2) throw new EventConflict('invalid_input','An event group needs at least two independent sources');
  const subjectKey=subject.type === 'event' ? subject.event_id : subject.key;
  const topic=[game.id,subject.type,subjectKey,input.aspect_key];
  const basisHash=digest(sources);
  const effectHash=digest({xp_delta:input.xp_delta,stats_delta:input.stats_delta});
  const duplicate=(await db.query(`SELECT * FROM gm_adjudications WHERE game_id=$1 AND subject_type=$2 AND subject_key=$3 AND aspect_key=$4
    AND basis_hash=$5 AND correction_of IS NOT DISTINCT FROM $6::uuid`,[...topic,basisHash,input.correction_of])).rows[0];
  if (duplicate) {
    if (duplicate.effect_hash !== effectHash) throw new EventConflict('adjudication_conflict','Same evidence was judged differently; use an explicit correction',{adjudication_id:duplicate.id});
    return {outcome:'duplicate',adjudication_id:duplicate.id,subject,aspect_key:input.aspect_key,sources,previous_id:duplicate.previous_id,correction_of:duplicate.correction_of,reason:duplicate.reason,before_state:current,after_state:current,xp_delta:0,stats_delta:zeroStats(),level_delta:0};
  }
  const evidence=[];
  for (const source of sources) {
    const row=(await db.query(`SELECT e.kind,e.version AS current_version,r.after_state FROM life_event_revisions r JOIN life_events e ON e.id=r.event_id WHERE r.event_id=$1 AND r.version=$2`,[source.event_id,source.event_version])).rows[0];
    if (!row) throw new EventConflict('source_not_found','Event revision does not exist',{event_id:source.event_id});
    if (row.kind !== game.kind || row.after_state.kind !== game.kind) throw new EventConflict('source_kind_conflict','Synthetic games accept test events only');
    if (row.current_version !== source.event_version) throw new EventConflict('event_version_conflict','New judgments must use current event facts',{event_id:source.event_id,current_version:row.current_version});
    evidence.push(source);
  }
  const head=(await db.query('SELECT * FROM gm_adjudications WHERE game_id=$1 AND subject_type=$2 AND subject_key=$3 AND aspect_key=$4 ORDER BY sequence DESC LIMIT 1',topic)).rows[0];
  if ((head?.id || null) !== input.previous_id) throw new EventConflict('adjudication_version_conflict','Link the latest judgment in this subject and aspect',{previous_id:head?.id || null});
  if (input.correction_of) {
    const corrected=(await db.query('SELECT * FROM gm_adjudications WHERE game_id=$1 AND id=$2',[game.id,input.correction_of])).rows[0];
    if (!corrected || corrected.subject_type !== subject.type || corrected.subject_key !== subjectKey || corrected.aspect_key !== input.aspect_key) throw new EventConflict('invalid_correction','Correction must reference the same judgment chain');
  } else if (head) {
    const old=(await db.query('SELECT event_id,event_version FROM gm_adjudication_sources WHERE adjudication_id=$1',[head.id])).rows;
    if (old.some(s=>!sources.some(next=>next.event_id===s.event_id && next.event_version>=s.event_version))) throw new EventConflict('new_evidence_required','Keep previous sources or make an explicit correction');
    if (!sources.some(s=>!old.some(prev=>prev.event_id===s.event_id && prev.event_version===s.event_version))) throw new EventConflict('new_evidence_required','Additional judgment needs new facts or an explicit correction');
  }
  const after=changedCharacter(current,input);
  const id=randomUUID();
  await db.query(`INSERT INTO gm_adjudications(id,game_id,update_id,subject_type,subject_key,subject_event_id,aspect_key,basis_hash,effect_hash,previous_id,correction_of,reason,xp_delta,stats_delta)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,game.id,updateId,subject.type,subjectKey,subject.type === 'event' ? subject.event_id : null,input.aspect_key,basisHash,effectHash,input.previous_id,input.correction_of,input.reason,input.xp_delta,serialized(input.stats_delta)]);
  for (const source of evidence) await db.query('INSERT INTO gm_adjudication_sources(adjudication_id,event_id,event_version) VALUES($1,$2,$3)',[id,source.event_id,source.event_version]);
  return {outcome:'applied',adjudication_id:id,subject,aspect_key:input.aspect_key,sources,previous_id:input.previous_id,correction_of:input.correction_of,reason:input.reason,before_state:current,after_state:after,xp_delta:input.xp_delta,stats_delta:input.stats_delta,level_delta:after.level-current.level};
}
/** @param {import('./database.js').Queryable} db @param {string} owner @param {import('./growth-schema.js').ApplyGmInput} input @param {boolean} allowSynthetic */
export async function applyGmUpdate(db,owner,input,allowSynthetic) {
  await lockEventWrites(db);
  if(input.mode!=='initialize' && input.mode!=='advance') return applyInitialization(db,owner,input,allowSynthetic,(draft,chunks,id)=>finalizeBirth(db,owner,draft,chunks,id,input));
  // Legacy synthetic fixtures can be built before the additive 007 migration.
  const hasBirthSchema=!!(await db.query("SELECT to_regclass('initialization_requests') AS name")).rows[0].name;
  const reserved=hasBirthSchema && (await db.query('SELECT 1 FROM initialization_requests WHERE owner_id=$1 AND request_key=$2',[owner,input.request_key])).rows.length;
  if(reserved) throw new EventConflict('idempotency_conflict','Request key belongs to initialization');
  let game=await loadGame(db,owner,true);
  const inputHash=digest(input);
  if (game) {
    const prior=(await db.query('SELECT input_hash,result FROM gm_updates WHERE game_id=$1 AND request_key=$2',[game.id,input.request_key])).rows[0];
    if (prior) {
      if (prior.input_hash !== inputHash) throw new EventConflict('idempotency_conflict','Retry key was used with different GM input');
      return {...prior.result,outcome:'replayed'};
    }
  }
  const updateId=randomUUID();
  if (input.mode === 'initialize') {
    if (!allowSynthetic) throw new EventConflict('initialization_disabled','Only explicitly enabled synthetic test initialization is implemented');
    if (game) throw new EventConflict('already_initialized','A game already exists; initialization never resets it');
    if(hasBirthSchema && (await initializationStatus(db,owner)).status==='preparing') throw new EventConflict('initialization_in_progress','A birth draft is preparing');
    const gameId=randomUUID();
    await db.query("INSERT INTO games(id,owner_id,kind,revision,rules_version) VALUES($1,$2,'test',1,'growth-v1')",[gameId,owner]);
    const c=input.character;
    await db.query('INSERT INTO characters(game_id,label,xp_total,str,dex,vit,int,cha,luk) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[gameId,c.label,c.xp_total,...STAT_KEYS.map(k=>c.stats[k])]);
    game=await loadGame(db,owner);
    const after=state(game);
    const change={outcome:'initialized',before_state:null,after_state:after.character,xp_delta:c.xp_total,stats_delta:c.stats,level_delta:after.character.level-1};
    await appendChange(db,gameId,updateId,0,change);
    const result={outcome:'committed',update_id:updateId,request_key:input.request_key,mode:input.mode,reason:input.reason,before:null,after,changes:[change]};
    Object.assign(result,{player_result:playerGmResult(result)});
    await saveUpdate(db,gameId,updateId,input.request_key,inputHash,input.reason,result);
    return result;
  }
  if (!game) throw new EventConflict('not_initialized','No game exists for this owner');
  if (game.revision !== input.expected_revision) throw new EventConflict('revision_conflict','Read the latest game context before changing it',{current_revision:game.revision});
  if (game.rules_version !== 'growth-v1') throw new EventConflict('unsupported_rules','Game growth rule version is unsupported');
  const before=state(game);
  const affectsStats=!!input.content_changes || (input.adjudications || []).some(j=>STAT_KEYS.some(k=>j.stats_delta[k]!==0));
  const statBefore=affectsStats ? await getStatEffects(db,game.id,before.character.stats) : null;
  let character=before.character;
  const changes=[];
  const topics=new Set();
  for (const [index,judgment] of (input.adjudications || []).entries()) {
    const topic=serialized([judgment.subject,judgment.aspect_key]);
    if (topics.has(topic)) throw new EventConflict('invalid_input','Only one judgment per subject/aspect in an update');
    topics.add(topic);
    const change=await applyAdjudication(db,game,updateId,judgment,character);
    if (change.outcome === 'applied') await appendChange(db,game.id,updateId,index,change);
    character=change.after_state;
    changes.push(change);
  }
  const quests=input.quest_changes ? await applyQuestChanges(db,game,updateId,input.quest_changes) : {changes:[],refs:{},changed:false};
  const content=input.content_changes ? await applyContentChanges(db,game,updateId,input.content_changes) : {changes:[],refs:{},changed:false};
  const world=input.world_changes ? await applyWorldChanges(db,game,updateId,input.world_changes,quests.refs) : {changes:[],refs:{},private_changes:[],private_refs:{},changed:false};
  let characterChange=null;
  let privateCharacterChange=null;
  if(input.character_change) {
    const previous=(await db.query('SELECT profile FROM character_profiles WHERE game_id=$1',[game.id])).rows[0]?.profile;
    if(!previous) throw new EventConflict('character_profile_not_found','This legacy game has no formal birth profile');
    const next={...previous,...input.character_change.changes};
    characterChange={before_state:publicProfile(previous),after_state:publicProfile(next)};
    privateCharacterChange={before_state:previous,after_state:next,reason:input.character_change.reason};
    await db.query('UPDATE character_profiles SET profile=$2 WHERE game_id=$1',[game.id,serialized(next)]);
    await db.query('INSERT INTO character_profile_changes(game_id,update_id,before_state,after_state,reason) VALUES($1,$2,$3,$4,$5)',[game.id,updateId,serialized(previous),serialized(next),input.character_change.reason]);
    if(next.name!==previous.name) await db.query('UPDATE characters SET label=$2 WHERE game_id=$1',[game.id,next.name]);
  }
  const statAfter=affectsStats ? await getStatEffects(db,game.id,character.stats) : null;
  const changed=changes.some(c=>c.outcome === 'applied') || quests.changed || content.changed || world.changed || !!characterChange;
  if (changed) {
    await db.query('UPDATE characters SET xp_total=$2,str=$3,dex=$4,vit=$5,int=$6,cha=$7,luk=$8 WHERE game_id=$1',[game.id,character.xp_total,...STAT_KEYS.map(k=>character.stats[k])]);
    await db.query('UPDATE games SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',[game.id]);
  }
  const after=state(await loadGame(db,owner));
  const result={outcome:changed ? 'committed' : 'unchanged',update_id:updateId,request_key:input.request_key,mode:input.mode,reason:input.reason,before,after,changes,quest_changes:quests.changes,quest_refs:quests.refs,content_changes:content.changes,content_refs:content.refs,...(affectsStats ? {stat_effects:{before:statBefore,after:statAfter}} : {})};
  if(input.world_changes) Object.assign(result,{world_changes:world.changes,world_refs:world.refs,gm_private:{world_changes:world.private_changes,world_refs:world.private_refs}});
  if(characterChange) Object.assign(result,{character_change:characterChange,gm_private:{...(input.world_changes ? {world_changes:world.private_changes,world_refs:world.private_refs} : {}),character_change:privateCharacterChange}});
  Object.assign(result,{player_result:playerGmResult(result)});
  await saveUpdate(db,game.id,updateId,input.request_key,inputHash,input.reason,result);
  return result;
}

/** Final state is assembled with existing validators in the caller's transaction.
 * @param {import('./database.js').Queryable} db @param {string} owner @param {any} draft
 * @param {any[]} chunks @param {string} updateId @param {any} input */
async function finalizeBirth(db,owner,draft,chunks,updateId,input) {
  const gameId=randomUUID(),c=draft.character;
  await db.query("INSERT INTO games(id,owner_id,kind,revision,rules_version) VALUES($1,$2,$3,1,'growth-v1')",[gameId,owner,draft.kind]);
  await db.query('INSERT INTO characters(game_id,label,xp_total,str,dex,vit,int,cha,luk) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[gameId,c.profile.name,c.xp_total,...STAT_KEYS.map(k=>c.stats[k])]);
  const game=await loadGame(db,owner),after=state(game);
  const quests=await applyQuestChanges(db,game,updateId,chunks.flatMap(chunk=>chunk.quest_changes || []));
  const content=await applyContentChanges(db,game,updateId,chunks.flatMap(chunk=>chunk.content_changes || []));
  const world=await applyWorldChanges(db,game,updateId,chunks.flatMap(chunk=>chunk.world_changes || []),quests.refs);
  const location=draft.starting_location.startsWith('@') ? world.private_refs[draft.starting_location] : draft.starting_location;
  const start=(await db.query("SELECT 1 FROM world_entities WHERE game_id=$1 AND id=$2 AND category='place' AND active AND visibility='player'",[gameId,location || null])).rows.length;
  const root=(await db.query("SELECT 1 FROM world_entities WHERE game_id=$1 AND category='world' AND active AND visibility='player'",[gameId])).rows.length;
  const profession=(await db.query("SELECT 1 FROM character_features WHERE game_id=$1 AND kind='profession' AND status='active'",[gameId])).rows.length;
  if(!start || !root || !profession) throw new EventConflict('incomplete_initialization','Finalize needs a public active world root, starting place and current profession');
  const seen=new Set(),sourceChanges=[];
  for(const source of chunks.flatMap(chunk=>chunk.birth_sources || [])) {
    if(seen.has(source.event_id)) throw new EventConflict('invalid_input','Birth source event must appear once across all chunks');
    seen.add(source.event_id);
    // Initial XP/stats already include this past experience; reserve base without awarding twice.
    const judgment=adjudicationSchema.parse({subject:{type:'event',event_id:source.event_id},sources:[{event_id:source.event_id,event_version:source.event_version}],reason:source.reason});
    sourceChanges.push(await applyAdjudication(db,game,updateId,judgment,after.character));
  }
  const effects=await getStatEffects(db,gameId,c.stats);
  const change={outcome:'initialized',before_state:null,after_state:after.character,xp_delta:c.xp_total,stats_delta:c.stats,level_delta:after.character.level-1};
  await appendChange(db,gameId,updateId,0,change);
  await db.query('INSERT INTO character_profiles(game_id,profile) VALUES($1,$2)',[gameId,serialized(c.profile)]);
  await db.query('INSERT INTO character_profile_changes(game_id,update_id,before_state,after_state,reason) VALUES($1,$2,NULL,$3,$4)',[gameId,updateId,serialized(c.profile),input.reason]);
  await db.query('INSERT INTO character_births(game_id,initialization_id,update_id,character,starting_location_id) VALUES($1,$2,$3,$4,$5)',[gameId,draft.id,updateId,serialized(c),location]);
  const result={outcome:'committed',update_id:updateId,request_key:input.request_key,mode:input.mode,reason:input.reason,before:null,after,
    initialization:{status:'completed',initialization_id:draft.id,kind:draft.kind,revision:draft.revision+1},
    character_profile:publicProfile(c.profile),starting_location_id:location,changes:[change],birth_sources:sourceChanges,
    quest_changes:quests.changes,quest_refs:quests.refs,content_changes:content.changes,content_refs:content.refs,
    world_changes:world.changes,world_refs:world.refs,stat_effects:{after:effects},
    gm_private:{character_profile:c.profile,world_changes:world.private_changes,world_refs:world.private_refs}};
  Object.assign(result,{player_result:playerGmResult(result)});
  await saveUpdate(db,gameId,updateId,input.request_key,digest(input),input.reason,result);
  return result;
}
