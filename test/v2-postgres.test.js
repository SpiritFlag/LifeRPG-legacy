import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {connectDatabase} from '../src/database.js';
import {scopedDatabase} from '../src/v2/storage.ts';
import {LifeRpgService} from '../src/v2/service.ts';
import {GmWorker} from '../src/v2/worker.ts';
import {MockGm} from '../src/v2/mock-gm.ts';
import {V2_SCOPES} from '../src/v2/contracts.ts';
import {OpenAiGm} from '../src/v2/openai-gm.ts';
import {readOpenAiConfig} from '../src/v2/openai-config.ts';
import {configureBudget,budgetUsage} from '../src/v2/budget.ts';

async function command(file,args) {
  return new Promise((accept,reject)=>{
    const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    child.on('error',reject);child.on('exit',code=>{
      // pg_ctl's server child can inherit pipe handles on Windows; wait for exit, not pipe EOF.
      child.stdout.destroy();child.stderr.destroy();
      code===0?accept(output):reject(new Error(`Local PostgreSQL command failed (${code}): ${output}`));
    });
  });
}
async function unusedPort() {
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;
}

test('real local PostgreSQL: independent connections, locks, lease recovery and deletion races',async t=>{
  // Explicit local test binaries only. No env file, DATABASE_URL, production endpoint or external DB.
  const getBinaries=(await import(pathToFileURL(resolve('.local/pg-runtime/node_modules/embedded-postgres/dist/binary.js')).href)).default;
  const binaries=await getBinaries();
  const root=resolve('.local/pg-verification');await mkdir(root,{recursive:true});
  const run=await mkdtemp(join(root,'run-'));
  const data=join(run,'data'),password=randomBytes(24).toString('hex'),passwordFile=join(run,'password');
  const port=await unusedPort();
  let started=false,rawA,rawB;
  try {
    await writeFile(passwordFile,password,{mode:0o600});
    await command(binaries.initdb,['-D',data,'-U','v2test','--pwfile',passwordFile,'--auth=scram-sha-256','--encoding=UTF8','--locale=C']);
    await rm(passwordFile);
    await command(binaries.pg_ctl,['-D',data,'-l',join(run,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);started=true;
    const admin=new pg.Client({host:'127.0.0.1',port,user:'v2test',password,database:'postgres'});
    await admin.connect();
    try {await admin.query('CREATE DATABASE liferpg_v2_test');} finally {await admin.end();}
    const url=`postgresql://v2test:${password}@127.0.0.1:${port}/liferpg_v2_test`;
    const migration=new pg.Client({connectionString:url});await migration.connect();
    try {for(const file of ['001-foundation.sql','002-openai-accounting.sql','003-rpg.sql'])await migration.query(await readFile(new URL(`../migrations/v2/${file}`,import.meta.url),'utf8'));}
    finally {await migration.end();}
    rawA=connectDatabase(url);rawB=connectDatabase(url);
    const a=scopedDatabase(rawA),b=scopedDatabase(rawB);
    const serviceA=new LifeRpgService(a),serviceB=new LifeRpgService(b),identity={subject:randomUUID(),scopes:V2_SCOPES};
    const workerA=new GmWorker(a,new MockGm()),workerB=new GmWorker(b,new MockGm());
    const call=(name,input)=>serviceA.execute(name,input,identity);
    await call('interact_with_gm',{request_id:randomUUID(),kind:'start',message:'Synthetic local PostgreSQL'});await workerA.runOnce();
    let event;
    await t.test('twenty concurrent deliveries share one request and one event',async()=>{
      const input={request_id:randomUUID(),summary:'synthetic concurrent observation'};
      const replies=await Promise.all(Array.from({length:20},(_,i)=>(i%2?serviceA:serviceB).execute('submit_observation',input,identity)));
      assert.equal(new Set(replies.map(r=>r.operation_id)).size,1);event=replies[0];
      assert.equal((await a.query('SELECT count(*)::integer AS n FROM events')).rows[0].n,1);
    });
    await t.test('only one worker owns the game; expired owner cannot commit',async()=>{
      const claims=await Promise.all([workerA.claim(),workerB.claim()]);assert.equal(claims.filter(Boolean).length,1);
      const old=claims.find(Boolean);
      await a.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[old.jobId]);
      const fresh=await workerB.claim();assert.ok(fresh.fencing>old.fencing);
      const gm=new MockGm(),signal=new AbortController().signal;
      const result=await Promise.all([workerA.complete(old,await gm.generate(old.context,signal)),workerB.complete(fresh,await gm.generate(fresh.context,signal))]);
      assert.equal(result[0].status,'discarded');
      assert.equal((await call('read_liferpg',{view:'game'})).xp,5);
    });
    await t.test('deletion racing an in-flight world job never leaves identifiable payloads',async()=>{
      const action=await call('interact_with_gm',{request_id:randomUUID(),kind:'action',message:'synthetic action'});
      const claim=await workerA.claim();assert.ok(claim.roots.includes(event.event_ids[0]));
      await Promise.all([
        serviceB.execute('delete_real_record',{request_id:randomUUID(),event_ids:event.event_ids},identity),
        workerA.complete(claim,{proposal:{outcome:'commit',summary:'synthetic concurrent observation',xp_delta:0,memories:[{kind:'reflection',text:'synthetic concurrent observation'}]},usage:{cost:0,input_tokens:0,output_tokens:0}}),
      ]);
      assert.equal((await call('read_liferpg',{view:'request',operation_id:action.operation_id})).status,'deleted');
      assert.equal((await a.query("SELECT 1 FROM payloads WHERE body::text LIKE '%synthetic concurrent observation%'" )).rows.length,0);
      assert.equal((await a.query('SELECT 1 FROM events WHERE deleted_at IS NULL')).rows.length,0);
    });
    await t.test('owner-scoped foreign keys reject cross-owner payload references',async()=>{
      const other=randomUUID();await a.query('INSERT INTO games(owner_id) VALUES($1)',[other]);
      const payload=(await a.query('SELECT id FROM payloads WHERE owner_id=$1 LIMIT 1',[identity.subject])).rows[0].id;
      await assert.rejects(()=>a.query("INSERT INTO memories(id,owner_id,kind,payload_id) VALUES($1,$2,'summary',$3)",[randomUUID(),other,payload]),e=>e.code==='23503');
    });
    await t.test('RPG world rewards commit once across connections and duplicate source rejects the whole second turn',async()=>{
      const player={subject:randomUUID(),scopes:V2_SCOPES};
      const call=(name,input)=>serviceA.execute(name,input,player);
      await call('interact_with_gm',{request_id:randomUUID(),kind:'start',message:'synthetic RPG race'});
      const birth=await workerA.claim(),gm=new MockGm(),initial=await gm.generate(birth.context,new AbortController().signal);
      initial.proposal.operations.push({op:'put',ref:'@event',expected_version:0,visibility:'public',private_notes:null,
        body:{kind:'world_event',name:'합성 구조 사건',description:'SYNTHETIC',status:'resolved',location:null,participants:[]}});
      await workerA.complete(birth,initial);
      const source=(await call('read_liferpg',{view:'game'})).entities.find(e=>e.kind==='world_event').id;
      await Promise.all([serviceA,serviceB].map(s=>s.execute('interact_with_gm',{request_id:randomUUID(),kind:'action',message:'synthetic source reward'},player)));
      const claims=await Promise.all([workerA.claim(),workerB.claim()]);assert.equal(claims.filter(Boolean).length,1);
      const winner=claims.find(Boolean),reply={proposal:{outcome:'commit',summary:'synthetic',xp_delta:9,memories:[],reward_source:source,scene:null,operations:[{op:'advance_time',ticks:1}]},usage:{cost:0,input_tokens:0,output_tokens:0}};
      const commits=await Promise.all([workerA.complete(winner,reply),workerB.complete(winner,reply)]);
      assert.equal(commits.filter(r=>r.status==='completed').length,1);
      const next=await workerB.claim();await workerB.complete(next,reply);
      assert.equal((await call('read_liferpg',{view:'request',operation_id:next.requestId})).error_code,'rpg_reward_already_claimed');
      const game=await call('read_liferpg',{view:'game'});assert.equal(game.xp,9);assert.equal(game.world_tick,1);
      assert.equal((await a.query('SELECT count(*)::int AS n FROM rpg_reward_claims WHERE owner_id=$1',[player.subject])).rows[0].n,1);
      await a.query("UPDATE jobs SET state='cancelled' WHERE owner_id=$1 AND state='queued'",[player.subject]);
    });
    await t.test('two independent workers cannot overspend one shared OpenAI budget across owners',async()=>{
      const config=readOpenAiConfig({});
      const gm=new OpenAiGm(config,async()=>({status:200,body:{model:config.model,status:'completed',service_tier:'default',
        usage:{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens_details:{reasoning_tokens:10}},
        output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({outcome:'commit',summary:'합성 시작',xp_delta:0,question:null,memories:[],reward_source:null,scene:null,
          operations:[{op:'put',ref:'@hero',expected_version:0,visibility:'public',private_notes:null,body:{kind:'character',name:'합성 영웅',description:'synthetic',level:1,stats:[],profession:null,location:null}}]})}]}]}}));
      await configureBudget(a,{lifetime:gm.maxCost,daily:gm.maxCost,monthly:gm.maxCost});
      for(const service of [serviceA,serviceB])await service.execute('interact_with_gm',{request_id:randomUUID(),kind:'start',message:'synthetic budget race'},{subject:randomUUID(),scopes:V2_SCOPES});
      const workers=[new GmWorker(a,gm),new GmWorker(b,gm)];
      const claims=await Promise.all(workers.map(w=>w.claim()));
      assert.equal(claims.filter(Boolean).length,1);
      assert.equal((await a.transaction(budgetUsage)).lifetime,String(gm.maxCost));
      const winner=claims.findIndex(Boolean),claim=claims[winner];
      await workers[winner].complete(claim,await gm.generate(claim.context,new AbortController().signal));
      assert.equal((await a.transaction(budgetUsage)).lifetime,'400');
      assert.equal((await a.query("SELECT count(*)::int AS n FROM requests WHERE status='blocked_budget'")).rows[0].n,1);
    });
  } finally {
    await rawA?.close();await rawB?.close();
    if(started) await command(binaries.pg_ctl,['-D',data,'-m','fast','-w','stop']);
    const target=resolve(run);
    if(!target.startsWith(root+sep)) throw new Error('Unsafe PostgreSQL test cleanup');
    await rm(target,{recursive:true,force:true});
  }
});
