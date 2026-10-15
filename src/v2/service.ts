import { randomUUID } from 'node:crypto';
import { observation, interaction, revision, deletion, read, DomainError } from './contracts.ts';
import type { Identity } from './contracts.ts';
import { digest, lockGame, activeEvent, savePayload, loadPayload, payloadRoots, purgeSources } from './storage.ts';
import type { Database, Queryable } from './storage.ts';
import { readRpg,publicRpg,effectiveStats } from './rpg.ts';

const schemas={submit_observation:observation,interact_with_gm:interaction,revise_real_record:revision,delete_real_record:deletion,read_liferpg:read};
export type ToolName=keyof typeof schemas;
const writeScopes:Record<string,string[]>={submit_observation:['life.write','game.play'],interact_with_gm:['game.play'],revise_real_record:['life.write'],delete_real_record:['life.delete']};
export function scopesFor(tool:ToolName,input:{view?:string}):string[] {
  if(tool!=='read_liferpg') return writeScopes[tool];
  return [input.view==='records'?'life.read':input.view==='usage'?'usage.read':'game.read'];
}
export async function requestResult(tx:Queryable,owner:string,id:string) {
  const row=(await tx.query('SELECT * FROM requests WHERE owner_id=$1 AND id=$2',[owner,id])).rows[0];
  if(!row) throw new DomainError('not_found');
  const result=await loadPayload(tx,owner,row.result_payload);
  const deletion=(await tx.query('SELECT live_status,backup_status,payload_count,privacy_epoch FROM deletions WHERE owner_id=$1 AND request_id=$2',[owner,id])).rows[0];
  const live=row.event_ids.length?(await tx.query('SELECT id FROM events WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL',[owner,row.event_ids])).rows.map(e=>e.id):[];
  return {operation_id:row.id,status:row.status,event_ids:row.status==='deleted'?[]:row.event_ids,
    ...(result?result:{}),...(deletion?{deletion}:{}),...(row.error_code?{error_code:row.error_code}:{}),
    reality:{status:row.kind==='delete'||(row.event_ids.length&&!live.length)?'deleted':row.kind==='revise'?'corrected':live.length?'recorded':'not_applicable',event_ids:live},
    ...(['queued','running','retryable_error'].includes(row.status)?{retry_after_ms:1000}:{})};
}
export async function enqueue(tx:Queryable,owner:string,requestId:string) {
  await tx.query('INSERT INTO jobs(id,owner_id,request_id) VALUES($1,$2,$3)',[randomUUID(),owner,requestId]);
}

export class LifeRpgService {
  db:Database;
  afterDeletion:()=>Promise<void>;
  mode:'mock'|'openai';
  constructor(db:Database,afterDeletion:()=>Promise<void>=async()=>{},mode:'mock'|'openai'='mock') { this.db=db;this.afterDeletion=afterDeletion;this.mode=mode; }
  async execute(tool:ToolName,raw:unknown,identity:Identity) {
    const parsed=schemas[tool]?.safeParse(raw);
    if(!parsed?.success) throw new DomainError('invalid_input');
    const input=parsed.data;
    if(scopesFor(tool,input as {view?:string}).some(s=>!identity.scopes.includes(s))) throw new DomainError('forbidden');
    if(tool==='read_liferpg') return this.read(read.parse(input),identity);
    const outcome=await this.db.transaction(async tx=>{
      const owner=identity.subject;
      const game=await lockGame(tx,owner);
      const key=digest((input as {request_id:string}).request_id);
      const prior=(await tx.query('SELECT id,input_hash,status,kind FROM requests WHERE owner_id=$1 AND request_key=$2',[owner,key])).rows[0];
      const hash=digest({tool,input});
      if(prior) {
        if(prior.kind==='delete' && tool==='delete_real_record') {
          const old=(await tx.query('SELECT event_ids FROM deletions WHERE request_id=$1',[prior.id])).rows[0];
          if(digest([...old.event_ids].sort())!==digest([...deletion.parse(input).event_ids].sort())) throw new DomainError('idempotency_conflict');
          return requestResult(tx,owner,prior.id);
        }
        if(!['deleted','invalidated'].includes(prior.status) && prior.input_hash!==hash) throw new DomainError('idempotency_conflict');
        return requestResult(tx,owner,prior.id);
      }
      const id=randomUUID();
      let kind:string, status='queued', roots:string[]=[], reference:string|null=null;
      let eventIds:string[]|undefined;
      let content:unknown=input;
      let result:Record<string,unknown>|null=null;
      let deletionCount:number|undefined;
      if(tool==='submit_observation') {
        const v=observation.parse(input);
        if(game.auto_capture_paused && !v.confirmed_new_report) throw new DomainError('automatic_capture_paused');
        const facts={summary:v.summary,occurred_on:v.occurred_on??null,timezone:v.timezone,unknowns:v.unknowns};
        const fingerprint=digest(facts);
        kind='observation';
        let event;
        if(v.event_id) {
          event=await activeEvent(tx,owner,v.event_id);
          if(event.fingerprint!==fingerprint) throw new DomainError('use_revision_for_changed_facts');
        } else event=(await tx.query('SELECT * FROM events WHERE owner_id=$1 AND fingerprint=$2 AND deleted_at IS NULL',[owner,fingerprint])).rows[0];
        if(event) {
          roots=[event.id]; status='no_change';
          result={reason:'exact_observation_already_recorded'};
        } else {
          const eventId=randomUUID(); roots=[eventId];
          await tx.query('INSERT INTO events(id,owner_id,fingerprint) VALUES($1,$2,$3)',[eventId,owner,fingerprint]);
          const payload=await savePayload(tx,owner,'real_event',facts,roots);
          await tx.query('INSERT INTO event_versions(owner_id,event_id,version,payload_id) VALUES($1,$2,1,$3)',[owner,eventId,payload]);
        }
      } else if(tool==='interact_with_gm') {
        const v=interaction.parse(input); kind=v.kind;
        if(v.kind==='start' && game.initialized) {status='no_change';result={reason:'already_started'};}
        if(v.kind==='answer') {
          const q=(await tx.query('SELECT q.*,r.event_ids FROM questions q JOIN requests r ON r.id=q.request_id WHERE q.owner_id=$1 AND q.id=$2',[owner,v.question_id])).rows[0];
          if(!q) throw new DomainError('not_found');
          if(q.state!=='open') throw new DomainError('question_not_open');
          roots=await payloadRoots(tx,owner,[q.payload_id]); eventIds=q.event_ids; reference=q.id;
        }
        if(v.kind==='appeal') {
          const d=(await tx.query('SELECT * FROM decisions WHERE owner_id=$1 AND id=$2',[owner,v.decision_id])).rows[0];
          if(!d) throw new DomainError('not_found');
          if(!d.payload_id || d.needs_reinterpretation) throw new DomainError('decision_unavailable');
          if((await tx.query('SELECT 1 FROM decisions WHERE owner_id=$1 AND previous_id=$2',[owner,d.id])).rows.length) throw new DomainError('decision_superseded');
          roots=await payloadRoots(tx,owner,[d.payload_id]); eventIds=d.event_id?[d.event_id]:[]; reference=d.id;
        }
      } else if(tool==='revise_real_record') {
        const v=revision.parse(input); kind='revise';
        const e=await activeEvent(tx,owner,v.event_id);
        if(e.version!==v.expected_version) throw new DomainError('event_version_conflict');
        roots=[e.id];
        await tx.query('UPDATE games SET privacy_epoch=privacy_epoch+1,revision=revision+1 WHERE owner_id=$1',[owner]);
        await purgeSources(tx,owner,roots,false);
        const facts={summary:v.summary,occurred_on:v.occurred_on??null,timezone:v.timezone,unknowns:v.unknowns};
        const fingerprint=digest(facts);
        if((await tx.query('SELECT 1 FROM events WHERE owner_id=$1 AND fingerprint=$2 AND id<>$3 AND deleted_at IS NULL',[owner,fingerprint,e.id])).rows.length) throw new DomainError('event_identity_conflict');
        await tx.query('UPDATE events SET version=version+1,fingerprint=$3 WHERE owner_id=$1 AND id=$2',[owner,e.id,fingerprint]);
        const payload=await savePayload(tx,owner,'real_event',facts,roots);
        await tx.query('INSERT INTO event_versions(owner_id,event_id,version,payload_id) VALUES($1,$2,$3,$4)',[owner,e.id,e.version+1,payload]);
        status='committed'; result={event_version:e.version+1,reinterpretation:'pending'};
      } else {
        const v=deletion.parse(input); kind='delete';
        for(const eventId of v.event_ids) {
          if(!(await tx.query('SELECT 1 FROM events WHERE owner_id=$1 AND id=$2',[owner,eventId])).rows.length) throw new DomainError('not_found');
        }
        await tx.query('UPDATE games SET privacy_epoch=privacy_epoch+1,revision=revision+1,auto_capture_paused=true WHERE owner_id=$1',[owner]);
        deletionCount=await purgeSources(tx,owner,v.event_ids,true);
        await tx.query('UPDATE events SET deleted_at=COALESCE(deleted_at,clock_timestamp()),fingerprint=NULL WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,v.event_ids]);
        status='committed'; content={};
      }
      // Do not persist client retry keys in text; request_key is a digest of an opaque ID.
      const {request_id:ignored,...withoutKey}=content as Record<string,unknown>;
      void ignored;
      const inputPayload=kind==='delete'?null:await savePayload(tx,owner,'request',withoutKey,roots);
      const resultPayload=result?await savePayload(tx,owner,'result',result,roots):null;
      await tx.query(`INSERT INTO requests(id,owner_id,request_key,input_hash,kind,status,input_payload,result_payload,event_ids,reference_id,can_play)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,owner,key,kind==='delete'?null:hash,kind,status,inputPayload,resultPayload,eventIds??roots,reference,identity.scopes.includes('game.play')]);
      if(kind==='delete') {
        const epoch=(await tx.query('SELECT privacy_epoch FROM games WHERE owner_id=$1',[owner])).rows[0].privacy_epoch;
        await tx.query("INSERT INTO deletions(request_id,owner_id,privacy_epoch,event_ids,payload_count,live_status) VALUES($1,$2,$3,$4,$5,'live_purged')",[id,owner,epoch,deletion.parse(input).event_ids,deletionCount]);
      }
      if(kind==='answer') await tx.query("UPDATE questions SET state='answered',answered_by=$3 WHERE owner_id=$1 AND id=$2",[owner,reference,id]);
      if(status==='queued') await enqueue(tx,owner,id);
      return requestResult(tx,owner,id);
    });
    if(tool==='delete_real_record') await this.afterDeletion();
    return outcome;
  }

  private async read(input:ReturnType<typeof read.parse>,identity:Identity) {
    return this.db.transaction(async tx=>{
      const owner=identity.subject;
      // Serialize projections against deletion without creating data on read-only calls.
      const game=(await tx.query('SELECT * FROM games WHERE owner_id=$1 FOR SHARE',[owner])).rows[0];
      if(input.view==='request') {
        const r=(await tx.query('SELECT kind FROM requests WHERE owner_id=$1 AND id=$2',[owner,input.operation_id])).rows[0];
        if(r && ['observation','revise','delete'].includes(r.kind) && !identity.scopes.includes('life.read')) throw new DomainError('forbidden');
        return requestResult(tx,owner,input.operation_id!);
      }
      if(input.view==='usage') {
        const rows=(await tx.query(`SELECT model,count(*)::integer AS calls,
          COALESCE(sum(actual_cost),0)::text AS settled,
          COALESCE(sum(CASE WHEN state<>'completed' THEN reserved_cost ELSE 0 END),0)::text AS outstanding
          FROM attempts WHERE owner_id=$1 GROUP BY model`,[owner])).rows;
        if(this.mode==='openai') {
          const usage=(await tx.query(`SELECT model,price_card,count(*)::integer AS calls,
            COALESCE(sum(input_tokens),0)::text AS input_tokens,COALESCE(sum(output_tokens),0)::text AS output_tokens,
            COALESCE(sum((usage_details->>'cached_tokens')::bigint),0)::text AS cached_tokens,
            COALESCE(sum((usage_details->>'cache_write_tokens')::bigint),0)::text AS cache_write_tokens,
            COALESCE(sum((usage_details->>'reasoning_tokens')::bigint),0)::text AS reasoning_tokens,
            COALESCE(sum(actual_cost),0)::text AS settled,
            COALESCE(sum(CASE WHEN state<>'completed' THEN reserved_cost ELSE 0 END),0)::text AS outstanding
            FROM attempts WHERE owner_id=$1 AND provider='openai' GROUP BY model,price_card`,[owner])).rows;
          return {status:'ok',mode:this.mode,unit:'micro_usd',cost_basis:'provider_usage_times_versioned_rates_estimate',budget_limit:game?.budget_limit??0,models:usage};
        }
        return {status:'ok',mode:this.mode,unit:'synthetic_micro_usd',budget_limit:game?.budget_limit??0,models:rows};
      }
      if(input.view==='records') {
        const rows=(await tx.query(`SELECT e.id,e.version,p.body FROM events e JOIN event_versions v ON v.event_id=e.id AND v.version=e.version
          JOIN payloads p ON p.id=v.payload_id WHERE e.owner_id=$1 AND e.deleted_at IS NULL
          AND ($2::uuid IS NULL OR e.id>$2) AND ($3::text IS NULL OR position(lower($3) in lower(p.body->>'summary'))>0)
          ORDER BY e.id LIMIT $4`,[owner,input.cursor??null,input.query??null,input.limit+1])).rows;
        return {status:'ok',records:rows.slice(0,input.limit),next_cursor:rows.length>input.limit?rows[input.limit-1].id:null};
      }
      if(input.view==='game') {
        const entities=await readRpg(tx,owner);
        return {status:'ok',mode:this.mode,initialized:game?.initialized??false,revision:game?.revision??0,xp:Number(game?.xp??0),world_tick:Number(game?.world_tick??0),
          entities:publicRpg(entities),effective_stats:effectiveStats(entities),entities_pending_reinterpretation:entities.filter(e=>!e.retired&&e.needs_reinterpretation).length,
          reinterpretation_pending:(await tx.query('SELECT count(*)::integer AS n FROM decisions WHERE owner_id=$1 AND needs_reinterpretation',[owner])).rows[0].n};
      }
      return {status:'ok',mode:this.mode,initialized:game?.initialized??false,automatic_capture_paused:game?.auto_capture_paused??false,
        jobs:(await tx.query('SELECT state,count(*)::integer AS count FROM jobs WHERE owner_id=$1 GROUP BY state',[owner])).rows};
    });
  }
}
