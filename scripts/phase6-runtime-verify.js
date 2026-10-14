import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { connectDatabase } from '../src/database.js';
import { lockEventWrites,recordEvent } from '../src/storage.js';
import { getGameContext,applyGmUpdate } from '../src/growth-storage.js';
import { contextSchema,applyGmSchema } from '../src/growth-schema.js';
import { testEvent } from './client.js';
import { login,mcpClient } from './client.js';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

const target=JSON.parse(await readFile('.local/phase6/connection.json','utf8')),source=new URL(target.url);
if(target.branch_id!=='br-soft-art-a1xx9a51' || source.hostname!=='ep-young-flower-a115sf9a.ap-southeast-1.aws.neon.tech') throw new Error('Refusing unexpected branch');
source.pathname='/liferpg_phase6_synthetic';source.hostname='ep-young-flower-a115sf9a-pooler.ap-southeast-1.aws.neon.tech';
const first=connectDatabase(source.href),second=connectDatabase(source.href),report={target:{branch:target.branch_id,host:source.hostname,database:source.pathname},checks:[]};
const direct=new URL(source);direct.hostname=direct.hostname.replace('-pooler.','.');
const observer=new pg.Client({connectionString:direct.href,statement_timeout:10000});await observer.connect();
const check=async(name,fn)=>{const start=performance.now();try{await fn();report.checks.push({name,outcome:'passed',elapsed_ms:Math.round(performance.now()-start)});console.log(JSON.stringify(report.checks.at(-1)));}catch(e){report.checks.push({name,outcome:'failed',code:e.code || e.outcome,message:e.message});throw e;}finally{await writeFile('.local/phase6/runtime-report.json',JSON.stringify(report,null,2));}};
try {
  await check('production pg pool configuration works on Neon pooled endpoint',async()=>{
    const result=await first.query("SELECT current_database() AS database,current_setting('statement_timeout') AS statement_timeout");assert.equal(result.rows[0].database,'liferpg_phase6_synthetic');assert.equal(result.rows[0].statement_timeout,'10s');
  });
  await check('two application pools contend on transaction advisory lock on distinct actual backends',async()=>{
    let held,release,waiting;
    const started=new Promise(r=>{held=r;}),gate=new Promise(r=>{release=r;}),waiterStarted=new Promise(r=>{waiting=r;});
    let holderPid,waiterPid;
    const a=first.transaction(async tx=>{holderPid=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await lockEventWrites(tx);held();await gate;});await started;
    const b=second.transaction(async tx=>{waiterPid=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;waiting();await lockEventWrites(tx);});await waiterStarted;
    try{assert.notEqual(holderPid,waiterPid);let observed=false;for(let i=0;i<20;i++){if((await observer.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[waiterPid])).rows.length){observed=true;break;}await new Promise(r=>setTimeout(r,25));}assert.ok(observed);}finally{release();await Promise.all([a,b]);}
  });
  await check('application pooled READ ONLY REPEATABLE READ context and GM writes preserve isolation',async()=>{
    const r=JSON.parse(await readFile('.local/phase6/neon-report.json','utf8')),owner=`phase6-main-${r.run}`;
    const context=await first.transaction(tx=>getGameContext(tx,owner,contextSchema.parse({view:'player'})));assert.equal(context.initialized,true);assert.equal(context.gm_private,undefined);
    const input=applyGmSchema.parse({mode:'advance',request_key:`pooled-${randomUUID()}`,expected_revision:context.revision,reason:'Isolated pooled verification',character_change:{changes:{destiny:'Synthetic pooled destiny'},reason:'Synthetic'}});
    assert.equal((await second.transaction(tx=>applyGmUpdate(tx,owner,input,true))).outcome,'committed');assert.equal((await first.transaction(tx=>applyGmUpdate(tx,owner,input,true))).outcome,'replayed');
  });
  await check('patched production database wrapper completes OAuth PKCE and MCP discovery/context on pooler',async()=>{
    const config=readConfig({PUBLIC_BASE_URL:'https://phase6-pooler.example',OAUTH_CLIENT_SECRET:'synthetic-client-'.repeat(4),OWNER_LOGIN_KEY:'synthetic-owner-'.repeat(4),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'});
    const app=createApp(first,config),fetcher=(input,init)=>app(input instanceof Request ? input : new Request(input,init));
    const {tokens}=await login(config.base,config,fetcher),client=await mcpClient(config.base,tokens.access_token,fetcher);
    try{assert.equal((await client.listTools()).tools.length,9);assert.equal((await client.callTool({name:'get_game_context',arguments:{}})).structuredContent.initialized,true);}finally{await client.close();}
  });
  await check('application default 10-second statement timeout rolls back and pool remains reusable',async()=>{
    await assert.rejects(first.transaction(tx=>tx.query('SELECT pg_sleep(11)')),e=>e.code==='57014');assert.equal((await first.query('SELECT 1 AS n')).rows[0].n,1);
  });
  await check('application lock wait hits 10-second statement timeout and identical event can retry',async()=>{
    const input={...testEvent,event_key:`pooled-timeout-${randomUUID()}`};await observer.query('BEGIN');await lockEventWrites(observer);
    try{await assert.rejects(second.transaction(tx=>recordEvent(tx,input)),e=>e.code==='57014');}finally{await observer.query('ROLLBACK');}
    assert.equal((await second.transaction(tx=>recordEvent(tx,input))).outcome,'recorded');assert.equal((await first.transaction(tx=>recordEvent(tx,input))).outcome,'duplicate');
  });
  report.outcome='passed';
}catch(e){report.outcome='failed';console.error(JSON.stringify({outcome:'failed',code:e.code || e.outcome,message:e.message}));process.exitCode=1;}finally{await first.close();await second.close();await observer.end();await writeFile('.local/phase6/runtime-report.json',JSON.stringify(report,null,2));}
