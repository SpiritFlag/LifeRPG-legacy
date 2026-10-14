import { createHash,randomUUID } from 'node:crypto';
import { EventConflict,serialized } from './storage.js';
import { STAT_KEYS } from './growth-schema.js';

/** @param {import('./database.js').Queryable} db @param {any} game @param {string} updateId @param {import('./content-schema.js').ContentOperation[]} operations */
export async function applyContentChanges(db,game,updateId,operations) {
  /** @type {Map<string,{id:string,type:string}>} */
  const refs=new Map();
  /** @type {any[]} */
  const results=[];
  /** @param {string} value @param {string} type */
  function resolve(value,type) {
    if (!value.startsWith('@')) return value;
    const found=refs.get(value);
    if (!found || found.type!==type) throw new EventConflict('content_reference_conflict','Missing or incorrectly typed temporary reference',{reference:value});
    return found.id;
  }
  /** @param {string} ref @param {string} id @param {string} type */
  function bind(ref,id,type) {if(refs.has(ref)) throw new EventConflict('invalid_input','Content refs must be unique');refs.set(ref,{id,type});}
  /** @param {string} table @param {string} where @param {any[]} args */
  async function find(table,where,args) {return (await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE t.game_id=$1 AND ${where}`,[game.id,...args])).rows[0]?.value;}
  /** @param {string} table @param {string} id */
  async function get(table,id) {const row=await find(table,'t.id=$2',[id]);if(!row) throw new EventConflict('content_not_found','Content does not belong to this game',{id});return row;}
  /** @param {string} id @param {number} version */
  async function definition(id,version) {
    const row=(await db.query(`SELECT to_jsonb(d)||to_jsonb(v)||jsonb_build_object('id',d.id,'sequence',d.sequence) AS value FROM game_definitions d JOIN game_definition_versions v ON v.game_id=d.game_id AND v.definition_id=d.id WHERE d.game_id=$1 AND d.id=$2 AND v.version=$3`,[game.id,id,version])).rows[0]?.value;
    if(!row) throw new EventConflict('definition_version_not_found','Definition version does not belong to this game');return row;
  }
  /** @param {string} table @param {any} data @param {any} before */
  async function save(table,data,before) {
    const columns=Object.keys(data),values=Object.values(data);
    if(before && columns.every(k=>serialized(before[k])===serialized(data[k]))) return before;
    // Identifiers are fixed by this module/strict operation schemas, never SQL input.
    const sql=before ? `UPDATE ${table} SET ${columns.map((k,i)=>`${k}=$${i+2}`).join(',')},version=version+1 WHERE id=$1 RETURNING to_jsonb(${table}) AS value`
      : `INSERT INTO ${table}(id,${columns.join(',')}) VALUES($1,${columns.map((_,i)=>`$${i+2}`).join(',')}) RETURNING to_jsonb(${table}) AS value`;
    return (await db.query(sql,[before?.id || randomUUID(),...values])).rows[0].value;
  }
  /** @param {string} type @param {any} before @param {any} after @param {string} reason */
  async function record(type,before,after,reason) {
    const changed=!before || serialized(before)!==serialized(after);
    const result={outcome:changed ? before ? 'updated' : 'created' : 'unchanged',target_type:type,target_id:after.id,reason,before_state:before || null,after_state:after};
    if(changed) await db.query(`INSERT INTO content_change_entries(game_id,update_id,ordinal,target_type,target_id,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[game.id,updateId,results.length,type,after.id,reason,before ? serialized(before) : null,serialized(after)]);
    results.push(result);
  }
  /** @param {any} data */
  const fingerprint=data=>createHash('sha256').update(serialized(data)).digest('hex');
  /** @param {any} row */
  function validInventory(row) {
    if(!Number.isSafeInteger(row.quantity) || row.quantity<0 || (row.mode==='individual' && row.quantity>1) || (row.kind==='equipment' && row.mode!=='individual')) throw new EventConflict('invalid_inventory_quantity','Individual items have quantity zero or one; equipment cannot stack');
    if(row.durability!==null && row.max_durability!==null && row.durability>row.max_durability) throw new EventConflict('invalid_durability','Durability cannot exceed its maximum');
  }
  for(const op of operations) {
    if(op.operation==='create_definition') {
      const beforeRoot=await find('game_definitions','t.definition_key=$2',[op.definition_key]);
      const content={name:op.name,description:op.description,settings:op.settings,stat_modifiers:op.stat_modifiers};
      if(beforeRoot) {
        const before=await definition(beforeRoot.id,beforeRoot.current_version);
        if(before.kind!==op.kind || Object.keys(content).some(k=>serialized(before[k])!==serialized(/** @type {any} */(content)[k]))) throw new EventConflict('definition_identity_conflict','Definition key exists with different content');
        bind(op.ref,before.id,'definition');await record('definition',before,before,op.reason);continue;
      }
      const id=randomUUID();
      await db.query('INSERT INTO game_definitions(id,game_id,definition_key,kind) VALUES($1,$2,$3,$4)',[id,game.id,op.definition_key,op.kind]);
      await db.query('INSERT INTO game_definition_versions(game_id,definition_id,version,name,description,settings,stat_modifiers) VALUES($1,$2,1,$3,$4,$5,$6)',[game.id,id,op.name,op.description,serialized(op.settings),serialized(op.stat_modifiers)]);
      bind(op.ref,id,'definition');await record('definition',null,await definition(id,1),op.reason);continue;
    }
    if(op.operation==='revise_definition') {
      const id=resolve(op.definition,'definition'),root=await get('game_definitions',id),before=await definition(id,root.current_version);
      if(root.current_version!==op.expected_version) throw new EventConflict('definition_version_conflict','Read the current definition version',{current_version:root.current_version});
      const next={...before,...op.changes};
      if(serialized(next)===serialized(before)) {await record('definition',before,before,op.reason);continue;}
      const version=root.current_version+1;
      await db.query('INSERT INTO game_definition_versions(game_id,definition_id,version,name,description,settings,stat_modifiers) VALUES($1,$2,$3,$4,$5,$6,$7)',[game.id,id,version,next.name,next.description,serialized(next.settings),serialized(next.stat_modifiers)]);
      await db.query('UPDATE game_definitions SET current_version=$2 WHERE id=$1',[id,version]);
      await record('definition',before,await definition(id,version),op.reason);continue;
    }
    if(op.operation==='grant_feature' || op.operation==='change_profession' || op.operation==='grant_inventory') {
      const def=await definition(resolve(op.definition,'definition'),op.definition_version),inventory=op.operation==='grant_inventory';
      if(inventory ? !['equipment','item'].includes(def.kind) : op.operation==='change_profession' ? def.kind!=='profession' : !['skill','trait','title','achievement'].includes(def.kind)) throw new EventConflict('content_kind_conflict','Definition kind is incompatible with this acquisition operation');
      const data=op.operation==='grant_inventory' ? {game_id:game.id,acquisition_key:op.acquisition_key,definition_id:def.id,definition_version:op.definition_version,kind:def.kind,mode:op.mode,quantity:op.quantity,status:'owned',slot:null,grade:op.grade,state:op.state,durability:op.durability,max_durability:op.max_durability}
        : {game_id:game.id,acquisition_key:op.acquisition_key,definition_id:def.id,definition_version:op.definition_version,kind:def.kind,status:'active',mastery:op.mastery,grade:op.grade,state:op.state};
      if(inventory) validInventory(data);
      const hash=fingerprint(data),table=inventory ? 'inventory_entries' : 'character_features',type=inventory ? 'inventory' : 'feature';
      const existing=await find(table,'t.acquisition_key=$2',[op.acquisition_key]);
      if(existing) {
        if(existing.acquisition_hash!==hash) throw new EventConflict('acquisition_conflict','Acquisition key already belongs to a different reward');
        bind(op.ref,existing.id,type);await record(type,existing,existing,op.reason);continue;
      }
      if(!inventory) {
        const owned=await find(table,"t.definition_id=$2 AND t.status='active'",[def.id]);
        if(owned) throw new EventConflict('feature_already_owned','Use update_feature for an already active feature',{feature_id:owned.id});
        if(op.operation==='change_profession') {
          const previous=await find(table,"t.kind='profession' AND t.status='active'",[]);
          if(previous) await record('feature',previous,await save(table,{status:'ended',ended_at:new Date().toISOString()},previous),op.reason);
        }
      }
      const after=await save(table,{...data,acquisition_hash:hash},null);bind(op.ref,after.id,type);await record(type,null,after,op.reason);continue;
    }
    if(op.operation==='update_feature' || op.operation==='lose_feature') {
      const before=await get('character_features',resolve(op.feature,'feature'));
      if(op.operation==='lose_feature') {
        const after=before.status==='active' ? await save('character_features',{status:before.kind==='profession' ? 'ended' : 'lost',ended_at:new Date().toISOString()},before) : before;
        await record('feature',before,after,op.reason);continue;
      }
      if(before.status!=='active') throw new EventConflict('feature_inactive','Historical features are retained; reacquire with a new acquisition key');
      if(op.changes.definition_version!==undefined) await definition(before.definition_id,op.changes.definition_version);
      await record('feature',before,await save('character_features',op.changes,before),op.reason);continue;
    }
    if(!('entry' in op)) throw new EventConflict('invalid_input','Unsupported content operation');
    const before=await get('inventory_entries',resolve(op.entry,'inventory'));
    let changes;
    if(op.operation==='adjust_quantity') {
      const quantity=BigInt(before.quantity)+BigInt(op.quantity_delta);
      if(quantity<0n || quantity>BigInt(Number.MAX_SAFE_INTEGER)) throw new EventConflict('invalid_inventory_quantity','Quantity must stay in nonnegative safe integers');
      changes={quantity:Number(quantity),status:quantity===0n ? 'lost' : 'owned',slot:quantity===0n ? null : before.slot};
    } else if(op.operation==='update_inventory') {
      if(before.status!=='owned') throw new EventConflict('inventory_inactive','Lost inventory cannot be upgraded');
      if(op.changes.definition_version!==undefined) await definition(before.definition_id,op.changes.definition_version);
      changes=op.changes;
    } else if(op.operation==='equip') {
      if(before.kind!=='equipment' || before.quantity!==1 || before.status!=='owned') throw new EventConflict('inventory_not_equippable','Only a currently owned individual equipment can be equipped');
      const occupant=await find('inventory_entries','t.slot=$2',[op.slot]);
      if(occupant && occupant.id!==before.id) throw new EventConflict('equipment_slot_conflict','Slot is occupied; explicitly unequip its occupant first',{entry_id:occupant.id});
      changes={slot:op.slot};
    } else changes=op.operation==='unequip' ? {slot:null} : {quantity:0,status:'lost',slot:null};
    validInventory({...before,...changes});
    await record('inventory',before,await save('inventory_entries',changes,before),op.reason);
  }
  return {changes:results,refs:Object.fromEntries([...refs].map(([key,value])=>[key,value.id])),changed:results.some(r=>r.outcome!=='unchanged')};
}

/** @param {import('./database.js').Queryable} db @param {string} gameId @param {any} baseStats */
export async function getStatEffects(db,gameId,baseStats) {
  const rows=(await db.query(`SELECT v.stat_modifiers FROM character_features f JOIN game_definition_versions v ON v.game_id=f.game_id AND v.definition_id=f.definition_id AND v.version=f.definition_version WHERE f.game_id=$1 AND f.status='active'
    UNION ALL SELECT v.stat_modifiers FROM inventory_entries i JOIN game_definition_versions v ON v.game_id=i.game_id AND v.definition_id=i.definition_id AND v.version=i.definition_version WHERE i.game_id=$1 AND i.status='owned' AND i.slot IS NOT NULL`,[gameId])).rows;
  const modifiers={},display={};
  for(const key of STAT_KEYS) {
    let sum=0n;for(const row of rows) sum+=BigInt(row.stat_modifiers[key]);
    const effective=BigInt(baseStats[key])+sum,shown=effective<0n ? 0n : effective;
    if(sum < -BigInt(Number.MAX_SAFE_INTEGER) || sum>BigInt(Number.MAX_SAFE_INTEGER) || shown>BigInt(Number.MAX_SAFE_INTEGER)) throw new EventConflict('stat_modifier_overflow','Aggregated modifiers/display stats exceed safe integers',{stat:key});
    Object.assign(modifiers,{[key]:Number(sum)});Object.assign(display,{[key]:Number(shown)});
  }
  return {base_stats:baseStats,stat_modifiers:modifiers,display_stats:display};
}

/** @param {import('./database.js').Queryable} db @param {string} gameId @param {any} input */
export async function getContentContext(db,gameId,input) {
  const limit=input.content_limit;
  /** @param {string} table @param {string} condition @param {any[]} args @param {number} cursor */
  async function page(table,condition,args,cursor) {
    const rows=(await db.query(`SELECT to_jsonb(t)-'acquisition_hash' AS value FROM ${table} t WHERE t.game_id=$1 AND t.sequence>$2 AND ${condition} ORDER BY t.sequence LIMIT $3`,[gameId,cursor,limit+1,...args])).rows.map(r=>r.value);
    return {items:rows.slice(0,limit),next_after_sequence:rows.length>limit ? rows[limit-1].sequence : null};
  }
  const definitions=await page('game_definitions','($4::uuid IS NULL OR t.id=$4) AND ($5::text[] IS NULL OR t.kind=ANY($5))',[input.definition_id || null,input.definition_kinds || null],input.after_definition_sequence);
  const features=await page('character_features','($4::uuid IS NULL OR t.id=$4) AND t.status=ANY($5::text[])',[input.feature_id || null,input.feature_statuses || (input.feature_id ? ['active','lost','ended'] : ['active'])],input.after_feature_sequence);
  const inventory=await page('inventory_entries','($4::uuid IS NULL OR t.id=$4) AND t.status=ANY($5::text[])',[input.inventory_id || null,input.inventory_statuses || (input.inventory_id ? ['owned','lost'] : ['owned'])],input.after_inventory_sequence);
  /** @param {string} id @param {number} version @param {boolean} full */
  async function definition(id,version,full) {
    const row=(await db.query(`SELECT d.kind,d.definition_key,v.* FROM game_definitions d JOIN game_definition_versions v ON v.game_id=d.game_id AND v.definition_id=d.id WHERE d.game_id=$1 AND d.id=$2 AND v.version=$3`,[gameId,id,version])).rows[0];
    if(full) return row;
    return {definition_id:id,version,kind:row.kind,definition_key:row.definition_key,name:row.name,description:row.description.slice(0,300),stat_modifiers:row.stat_modifiers,summary_truncated:row.description.length>300 || Object.keys(row.settings).length>0};
  }
  for(const d of definitions.items) d.definition=await definition(d.id,d.current_version,false);
  for(const f of features.items) {f.definition=await definition(f.definition_id,f.definition_version,!!input.feature_id);if(!input.feature_id) {f.state_omitted=Object.keys(f.state).length>0;delete f.state;}}
  for(const i of inventory.items) {i.definition=await definition(i.definition_id,i.definition_version,!!input.inventory_id);if(!input.inventory_id) {i.state_omitted=Object.keys(i.state).length>0;delete i.state;}}
  const profession=(await db.query("SELECT to_jsonb(f)-'acquisition_hash' AS value FROM character_features f WHERE game_id=$1 AND kind='profession' AND status='active'",[gameId])).rows[0]?.value || null;
  if(profession) profession.definition=await definition(profession.definition_id,profession.definition_version,false);
  const result={current_profession:profession,definitions,features,inventory};
  if(input.definition_id) {
    if(!(await db.query('SELECT 1 FROM game_definitions WHERE game_id=$1 AND id=$2',[gameId,input.definition_id])).rows.length) throw new EventConflict('content_not_found','Definition does not belong to this game');
    const rows=(await db.query('SELECT * FROM game_definition_versions WHERE game_id=$1 AND definition_id=$2 AND version>$3 ORDER BY version LIMIT $4',[gameId,input.definition_id,input.after_definition_version,limit+1])).rows;
    Object.assign(result,{definition_versions:{items:rows.slice(0,limit),next_after_version:rows.length>limit ? rows[limit-1].version : null}});
  }
  for(const [table,id] of [['character_features',input.feature_id],['inventory_entries',input.inventory_id]]) if(id && !(await db.query(`SELECT 1 FROM ${table} WHERE game_id=$1 AND id=$2`,[gameId,id])).rows.length) throw new EventConflict('content_not_found','Possession does not belong to this game');
  if(input.include_content_history) Object.assign(result,{history:await page('content_change_entries','($4::uuid IS NULL OR t.target_id=$4)',[input.feature_id || input.inventory_id || input.definition_id || null],input.after_content_change_sequence)});
  return result;
}
