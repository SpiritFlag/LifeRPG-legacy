import { randomUUID } from 'node:crypto';
import { proposal, DomainError } from './contracts.ts';
import { lockGame, loadPayload, payloadRoots, savePayload, activeEvent } from './storage.ts';
import type { Database, Queryable } from './storage.ts';
import { canReserve } from './budget.ts';
import type { PriceCard } from './openai-config.ts';
import { readRpg,applyRpg,effectiveStats } from './rpg.ts';

export type GmContext={
  operation_id:string; kind:string; input:Record<string,unknown>; initialized:boolean; xp:number;
  memories:{kind:string;body:unknown}[]; events:{id:string;version:number;body:unknown}[];
  previous_decision:unknown;target_event_id:string|null;
  reality?:{status:string;event_id:string|null};rpg?:unknown;world_tick?:number;
  clarification_history?:{input:Record<string,unknown>;question:unknown}[];
};
export type GmUsage={input_tokens:number;output_tokens:number;cost:number|null;details?:{
  cached_tokens:number;cache_write_tokens:number;reasoning_tokens:number;total_tokens:number;returned_model:string;service_tier:string;
}};
export type GmReply={proposal:unknown;usage?:GmUsage;failure?:{code:string;retryable:boolean}};
export interface GmAdapter {
  model:string; maxCost:number;provider?:'mock'|'openai';priceCard?:PriceCard;
  generate(context:GmContext,signal:AbortSignal):Promise<GmReply>;
}
export type Claim={
  jobId:string;owner:string;requestId:string;attemptId:string;fencing:number;revision:number;epoch:number;
  roots:string[];eventVersions:{id:string;version:number}[];context:GmContext;
  continuationIds:string[];previousDecisionId:string|null;
};

export class GmWorker {
  db:Database; gm:GmAdapter; leaseMs:number; timeoutMs:number;
  constructor(db:Database,gm:GmAdapter,options:{leaseMs?:number;timeoutMs?:number}={}) {
    if(!Number.isSafeInteger(gm.maxCost) || gm.maxCost<0) throw new Error('A bounded GM is required');
    this.db=db;this.gm=gm;this.leaseMs=options.leaseMs??30000;this.timeoutMs=options.timeoutMs??15000;
    if(this.leaseMs<20 || this.timeoutMs<1) throw new Error('Invalid worker timing');
  }

  async claim():Promise<Claim|null> {
    return this.db.transaction(async tx=>{
      // Lock game first everywhere. SKIP LOCKED lets another worker handle another owner.
      const game=(await tx.query(`SELECT g.* FROM games g WHERE EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=g.owner_id
        AND ((j.state='queued' AND j.available_at<=clock_timestamp()) OR (j.state='running' AND j.lease_until<=clock_timestamp())))
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=g.owner_id AND j.state='running' AND j.lease_until>clock_timestamp())
        ORDER BY g.owner_id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if(!game) return null;
      const owner=game.owner_id;
      const expired=(await tx.query(`UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
        fencing=fencing+1,lease_until=NULL WHERE owner_id=$1 AND state='running' AND lease_until<=clock_timestamp() RETURNING id,request_id,state`,[owner])).rows;
      for(const j of expired) {
        await tx.query("UPDATE attempts SET state='unknown' WHERE job_id=$1 AND state='reserved'",[j.id]);
        await tx.query('UPDATE requests SET status=$2,error_code=$3 WHERE id=$1',[j.request_id,j.state==='failed'?'failed':'retryable_error','worker_lease_expired']);
      }
      const job=(await tx.query(`SELECT j.*,r.kind,r.input_payload,r.event_ids,r.reference_id,r.can_play FROM jobs j JOIN requests r ON r.id=j.request_id
        WHERE j.owner_id=$1 AND j.state='queued' AND j.attempts<3 AND j.available_at<=clock_timestamp() ORDER BY j.available_at,j.id LIMIT 1 FOR UPDATE OF j`,[owner])).rows[0];
      if(!job) return null;
      const input=await loadPayload(tx,owner,job.input_payload);
      if(!input || !job.can_play) {
        await tx.query("UPDATE jobs SET state='cancelled' WHERE id=$1",[job.id]);
        await tx.query("UPDATE requests SET status='invalidated' WHERE id=$1",[job.request_id]);
        return null;
      }
      const ancestors=[];let origin=job;
      while(origin.kind==='answer'&&ancestors.length<8) {
        const parent=(await tx.query(`SELECT r.*,q.payload_id AS question_payload FROM questions q JOIN requests r ON r.id=q.request_id
          WHERE q.owner_id=$1 AND q.id=$2`,[owner,origin.reference_id])).rows[0];
        if(!parent)break;
        ancestors.unshift(parent);origin=parent;
      }
      if(origin.kind==='answer') {
        await tx.query("UPDATE jobs SET state='failed' WHERE id=$1",[job.id]);
        await tx.query("UPDATE requests SET status='failed',error_code='clarification_limit' WHERE id=$1",[job.request_id]);return null;
      }
      const gameKind=origin.kind;
      const cleanInput=(kind:string,v:Record<string,unknown>)=>kind==='observation'?
        {summary:v.summary,occurred_on:v.occurred_on??null,timezone:v.timezone,unknowns:v.unknowns}:{message:v.message??''};
      const clarificationHistory=[];
      for(const ancestor of ancestors)clarificationHistory.push({input:cleanInput(ancestor.kind,await loadPayload(tx,owner,ancestor.input_payload)??{}),question:await loadPayload(tx,owner,ancestor.question_payload)});
      if(!game.initialized && gameKind!=='start') {
        await tx.query("UPDATE jobs SET state='blocked' WHERE id=$1",[job.id]);
        await tx.query("UPDATE requests SET status='needs_input',error_code='start_required' WHERE id=$1",[job.request_id]);
        return null;
      }
      if(game.initialized && gameKind==='start') {
        await tx.query("UPDATE jobs SET state='completed' WHERE id=$1",[job.id]);
        await tx.query("UPDATE requests SET status='no_change' WHERE id=$1",[job.request_id]);
        return null;
      }
      const budget=(await tx.query(`SELECT COALESCE(sum(CASE WHEN state='completed' THEN actual_cost ELSE reserved_cost END),0)::text AS used FROM attempts WHERE owner_id=$1`,[owner])).rows[0];
      if(BigInt(budget.used)+BigInt(this.gm.maxCost)>BigInt(game.budget_limit) ||
        (this.gm.provider==='openai' && !await canReserve(tx,this.gm.maxCost))) {
        await tx.query("UPDATE jobs SET state='blocked' WHERE id=$1",[job.id]);
        await tx.query("UPDATE requests SET status='blocked_budget',error_code='budget_exhausted' WHERE id=$1",[job.request_id]);
        return null;
      }
      const memories=(await tx.query(`SELECT m.kind,m.payload_id,p.body FROM memories m JOIN payloads p ON p.id=m.payload_id
        WHERE m.owner_id=$1 AND m.active ORDER BY (m.kind='identity') DESC,m.created_at DESC,m.id LIMIT 20`,[owner])).rows;
      let previous=null;
      let previousPayload:string|null=null;
      if(gameKind==='appeal') {
        const d=(await tx.query('SELECT * FROM decisions WHERE owner_id=$1 AND id=$2',[owner,origin.reference_id])).rows[0];
        if(!d?.payload_id || d.needs_reinterpretation || (await tx.query('SELECT 1 FROM decisions WHERE owner_id=$1 AND previous_id=$2',[owner,d?.id])).rows.length) {
          await tx.query("UPDATE jobs SET state='cancelled' WHERE id=$1",[job.id]);
          await tx.query("UPDATE requests SET status='invalidated',error_code='decision_unavailable' WHERE id=$1",[job.request_id]);return null;
        }
        previousPayload=d.payload_id;previous=await loadPayload(tx,owner,previousPayload);
      }
      const rpg=await readRpg(tx,owner);
      const pending=(await tx.query('SELECT id,xp_delta FROM decisions WHERE owner_id=$1 AND needs_reinterpretation',[owner])).rows;
      const rpgPayloads=rpg.filter(e=>!e.retired&&!e.needs_reinterpretation).flatMap(e=>[e.public_payload,e.private_payload].filter((id):id is string=>!!id));
      const payloadIds=[job.input_payload,...ancestors.flatMap(a=>[a.input_payload,a.question_payload]).filter(Boolean),...memories.map(m=>m.payload_id),...(previousPayload?[previousPayload]:[]),...rpgPayloads];
      const roots=[...new Set([...job.event_ids,...await payloadRoots(tx,owner,payloadIds)])] as string[];
      const events=[];
      for(const id of roots) {
        const e=await activeEvent(tx,owner,id);
        const v=(await tx.query('SELECT payload_id FROM event_versions WHERE owner_id=$1 AND event_id=$2 AND version=$3',[owner,id,e.version])).rows[0];
        events.push({id,version:e.version,body:await loadPayload(tx,owner,v?.payload_id)});
      }
      if(roots.length>50 || JSON.stringify({input,clarificationHistory,memories,events,previous,rpg}).length>48000) {
        await tx.query("UPDATE jobs SET state='failed' WHERE id=$1",[job.id]);
        await tx.query("UPDATE requests SET status='failed',error_code='context_limit' WHERE id=$1",[job.request_id]);
        return null;
      }
      // Taint the request too: deletion cancels in-flight results and their retry receipts.
      for(const root of roots) await tx.query('INSERT INTO payload_sources(owner_id,payload_id,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[owner,job.input_payload,root]);
      const fencing=job.fencing+1;
      await tx.query("UPDATE jobs SET state='running',attempts=attempts+1,fencing=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1",[job.id,fencing,this.leaseMs]);
      await tx.query("UPDATE requests SET status='running',error_code=NULL WHERE id=$1",[job.request_id]);
      const attemptId=randomUUID();
      const eventVersions=events.map(({id,version})=>({id,version}));
      await tx.query(`INSERT INTO attempts(id,owner_id,job_id,fencing,state,reserved_cost,model,context_manifest)
        VALUES($1,$2,$3,$4,'reserved',$5,$6,$7)`,[attemptId,owner,job.id,fencing,this.gm.maxCost,this.gm.model,JSON.stringify({game_revision:game.revision,privacy_epoch:game.privacy_epoch,event_versions:eventVersions,payload_ids:payloadIds})]);
      if(this.gm.provider==='openai')await tx.query("UPDATE attempts SET provider='openai',price_card=$2 WHERE id=$1",[attemptId,JSON.stringify(this.gm.priceCard)]);
      const target=job.event_ids[0]??null;
      // Only factual fields / player message cross into GM context. Retry/capture flags are transport policy.
      const gmInput=cleanInput(job.kind,input);
      return {jobId:job.id,owner,requestId:job.request_id,attemptId,fencing,revision:game.revision,epoch:game.privacy_epoch,roots,eventVersions,
        continuationIds:ancestors.map(a=>a.id),previousDecisionId:gameKind==='appeal'?origin.reference_id:null,
        context:{operation_id:job.request_id,kind:gameKind,input:gmInput,initialized:game.initialized,xp:Number(game.xp),memories:memories.map(({kind,body})=>({kind,body})),events,previous_decision:previous,target_event_id:target,
          ...(clarificationHistory.length?{clarification_history:clarificationHistory}:{}),
          reality:{status:target?'recorded':'not_applicable',event_id:target},world_tick:Number(game.world_tick),
          rpg:{entities:rpg.filter(e=>!e.retired).map(e=>({id:e.id,kind:e.kind,version:e.version,visibility:e.visibility,needs_reinterpretation:e.needs_reinterpretation,body:e.needs_reinterpretation?null:e.body,private_notes:e.needs_reinterpretation?null:e.private_notes})),pending_reinterpretations:pending}}};
    });
  }

  async heartbeat(c:Claim):Promise<boolean> {
    return this.db.transaction(async tx=>{
      const game=await lockGame(tx,c.owner);
      if(game.privacy_epoch!==c.epoch) return false;
      return !!(await tx.query(`UPDATE jobs SET lease_until=clock_timestamp()+$4*interval '1 millisecond'
        WHERE id=$1 AND owner_id=$2 AND fencing=$3 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,[c.jobId,c.owner,c.fencing,this.leaseMs])).rows.length;
    });
  }
  private async retry(tx:Queryable,c:Claim,code:string) {
    const row=(await tx.query(`UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,lease_until=NULL,
      available_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1 AND fencing=$2 AND state='running' RETURNING state`,[c.jobId,c.fencing])).rows[0];
    if(row) await tx.query('UPDATE requests SET status=$2,error_code=$3 WHERE id=$1',[c.requestId,row.state==='failed'?'failed':'retryable_error',code]);
  }
  async fail(c:Claim,code='gm_failed') {
    // Never store exception messages, prompts or arbitrary provider output.
    await this.db.transaction(async tx=>{
      await lockGame(tx,c.owner);
      await tx.query("UPDATE attempts SET state='unknown' WHERE id=$1 AND state='reserved'",[c.attemptId]);
      await this.retry(tx,c,['gm_timeout','gm_failed'].includes(code)?code:'gm_failed');
    });
  }

  private async settle(c:Claim,reply:GmReply) {
    return this.db.transaction(async tx=>{
      await lockGame(tx,c.owner);
      const usage=reply.usage;
      const usageValid=usage && usage.cost!==null && [usage.cost,usage.input_tokens,usage.output_tokens].every(n=>Number.isSafeInteger(n)&&n>=0);
      // Keep true usage even if a provider exceeds the reservation or the content is rejected/deleted.
      if(this.gm.provider==='openai') {
        await tx.query('SELECT id FROM gm_budget WHERE id=true FOR UPDATE');
        if(usage)await tx.query("UPDATE attempts SET input_tokens=$2,output_tokens=$3,usage_details=$4 WHERE id=$1 AND state<>'completed'",
          [c.attemptId,usage.input_tokens,usage.output_tokens,JSON.stringify(usage.details??null)]);
        if(usageValid)await tx.query("UPDATE attempts SET settled_at=clock_timestamp() WHERE id=$1 AND state<>'completed'",[c.attemptId]);
      }
      if(usageValid) await tx.query("UPDATE attempts SET state='completed',actual_cost=$2,input_tokens=$3,output_tokens=$4 WHERE id=$1 AND state<>'completed'",[c.attemptId,usage.cost,usage.input_tokens,usage.output_tokens]);
      else await tx.query("UPDATE attempts SET state='unknown' WHERE id=$1 AND state='reserved'",[c.attemptId]);
      return !!usageValid;
    });
  }

  async complete(c:Claim,reply:GmReply) {
    // Provider usage is independent of gameplay. A failing game commit must not erase a known bill.
    const usageValid=await this.settle(c,reply);
    return this.db.transaction(async tx=>{
      const game=await lockGame(tx,c.owner);
      const job=(await tx.query("SELECT *,lease_until>clock_timestamp() AS live FROM jobs WHERE id=$1 AND owner_id=$2",[c.jobId,c.owner])).rows[0];
      if(!job || job.state!=='running' || job.fencing!==c.fencing || !job.live) return {status:'discarded'};
      if(reply.failure) {
        if(reply.failure.retryable)await this.retry(tx,c,reply.failure.code);
        else {
          await tx.query("UPDATE jobs SET state='failed',lease_until=NULL WHERE id=$1",[c.jobId]);
          await tx.query("UPDATE requests SET status='failed',error_code=$2 WHERE id=$1",[c.requestId,reply.failure.code]);
        }
        return {status:'failed'};
      }
      if(game.privacy_epoch!==c.epoch || game.revision!==c.revision) {
        await this.retry(tx,c,'context_changed');return {status:'retryable_error'};
      }
      for(const e of c.eventVersions) {
        const current=await activeEvent(tx,c.owner,e.id);
        if(current.version!==e.version) {await this.retry(tx,c,'context_changed');return {status:'retryable_error'};}
      }
      const parsed=proposal.safeParse(reply.proposal);
      if(!parsed.success || !usageValid) {await this.retry(tx,c,'invalid_gm_output');return {status:'retryable_error'};}
      const p=parsed.data;
      const req=(await tx.query('SELECT * FROM requests WHERE id=$1 AND owner_id=$2',[c.requestId,c.owner])).rows[0];
      const eventId=req.event_ids[0]??null;
      if(c.context.kind==='start'&&p.xp_delta!==0) {await this.retry(tx,c,'invalid_reward_source');return {status:'retryable_error'};}
      if(p.outcome==='clarify') {
        const questionId=randomUUID();
        const body={question:{question_id:questionId,text:p.question}};
        const payload=await savePayload(tx,c.owner,'question',body,c.roots);
        await tx.query("INSERT INTO questions(id,owner_id,request_id,payload_id,state) VALUES($1,$2,$3,$4,'open')",[questionId,c.owner,c.requestId,payload]);
        await tx.query("UPDATE requests SET status='needs_input',result_payload=$2 WHERE id=$1",[c.requestId,payload]);
      } else {
        const duplicate=eventId && c.context.kind!=='appeal' && (await tx.query('SELECT 1 FROM reward_entitlements WHERE owner_id=$1 AND event_id=$2',[c.owner,eventId])).rows.length;
        const delta=duplicate?0:p.xp_delta;
        const nextXp=BigInt(game.xp)+BigInt(delta);
        if(nextXp<0n || nextXp>BigInt(Number.MAX_SAFE_INTEGER)) {await this.retry(tx,c,'invalid_balance');return {status:'retryable_error'};}
        const decisionId=randomUUID();
        const currentVersion=eventId?c.eventVersions.find(e=>e.id===eventId)?.version:null;
        if(c.previousDecisionId && (await tx.query('SELECT 1 FROM decisions WHERE owner_id=$1 AND previous_id=$2',[c.owner,c.previousDecisionId])).rows.length) {
          await this.retry(tx,c,'decision_superseded');return {status:'retryable_error'};
        }
        let rpgResult;
        try {
          rpgResult=duplicate?null:await applyRpg(tx,c.owner,p,{kind:c.context.kind,requestId:c.requestId,roots:c.roots,eventId,xpDelta:delta,worldTick:Number(game.world_tick)});
        } catch(error) {
          if(!(error instanceof DomainError))throw error;
          await this.retry(tx,c,error.code);return {status:'retryable_error'};
        }
        const publicResult={decision_id:decisionId,game_revision:game.revision+1,player_result:{
          summary:duplicate?'이 사건의 기본 판정은 이미 반영되었습니다.':p.outcome==='no_change'?'게임 상태 변경이 없습니다.':'게임 판정이 확정되었습니다.',
          changes:[...(delta?[{kind:'xp',delta,balance:Number(nextXp)}]:[]),...(rpgResult?.changes??[])],
          fiction:rpgResult?.scene??null,world_tick:rpgResult?.world_tick??Number(game.world_tick),effective_stats:rpgResult?.effective_stats??effectiveStats(await readRpg(tx,c.owner))}};
        const payload=await savePayload(tx,c.owner,'decision',publicResult,c.roots);
        await tx.query(`INSERT INTO decisions(id,owner_id,request_id,previous_id,event_id,event_version,xp_delta,payload_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[decisionId,c.owner,c.requestId,c.previousDecisionId,eventId,currentVersion,delta,payload]);
        if(eventId && !duplicate && c.context.kind!=='appeal') await tx.query('INSERT INTO reward_entitlements(owner_id,event_id,decision_id) VALUES($1,$2,$3)',[c.owner,eventId,decisionId]);
        if(!duplicate) for(const memory of p.memories) {
          const content=await savePayload(tx,c.owner,memory.kind,{text:memory.text},c.roots);
          const version=Number((await tx.query('SELECT COALESCE(max(version),0)+1 AS version FROM memories WHERE owner_id=$1 AND kind=$2',[c.owner,memory.kind])).rows[0].version);
          if(memory.kind==='identity') await tx.query("UPDATE memories SET active=false WHERE owner_id=$1 AND kind='identity'",[c.owner]);
          await tx.query('INSERT INTO memories(id,owner_id,kind,version,payload_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),c.owner,memory.kind,version,content]);
        }
        await tx.query('UPDATE games SET revision=revision+1,xp=$2,initialized=initialized OR $3 WHERE owner_id=$1',[c.owner,nextXp.toString(),c.context.kind==='start']);
        await tx.query('UPDATE requests SET status=$2,result_payload=$3 WHERE id=$1',[c.requestId,duplicate||p.outcome==='no_change'?'no_change':'committed',payload]);
        if(c.context.kind==='start') {
          await tx.query("UPDATE jobs SET state='queued' WHERE owner_id=$1 AND state='blocked' AND request_id IN (SELECT id FROM requests WHERE owner_id=$1 AND error_code='start_required')",[c.owner]);
          await tx.query("UPDATE requests SET status='queued',error_code=NULL WHERE owner_id=$1 AND error_code='start_required'",[c.owner]);
        }
      }
      // Polling any earlier question follows the latest question or final canonical receipt.
      if(c.continuationIds.length)await tx.query(`UPDATE requests SET status=r.status,result_payload=r.result_payload FROM requests r
        WHERE requests.owner_id=$1 AND requests.id=ANY($2::uuid[]) AND r.id=$3`,[c.owner,c.continuationIds,c.requestId]);
      await tx.query("UPDATE jobs SET state='completed',lease_until=NULL WHERE id=$1 AND fencing=$2",[c.jobId,c.fencing]);
      return {status:'completed'};
    });
  }

  async runOnce():Promise<boolean> {
    const claim=await this.claim();
    if(!claim) return false;
    const abort=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const heartbeat=setInterval(()=>{void this.heartbeat(claim).then(ok=>{if(!ok)abort.abort();}).catch(()=>abort.abort());},Math.max(10,Math.floor(this.leaseMs/3)));
    try {
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new DomainError('gm_timeout'));},this.timeoutMs);});
      const reply=await Promise.race([this.gm.generate(claim.context,abort.signal),timeout]);
      await this.complete(claim,reply);
    } catch(error) {await this.fail(claim,error instanceof DomainError?error.code:'gm_failed');}
    finally {clearInterval(heartbeat);clearTimeout(timer);}
    return true;
  }
}
