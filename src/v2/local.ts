import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile,mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readConfig } from '../config.js';
import { scopedDatabase } from './storage.ts';
import { createV2App } from './app.ts';
import { MockGm } from './mock-gm.ts';
import { GmWorker } from './worker.ts';
import { openDeletionJournal } from './privacy.ts';

// This runner never reads DATABASE_URL, production env files or OPENAI_API_KEY.
const config=readConfig({...process.env,PUBLIC_BASE_URL:process.env.V2_LOCAL_ORIGIN??'http://127.0.0.1:3020'});
if(!['localhost','127.0.0.1'].includes(new URL(config.base).hostname)) throw new Error('Mock runner binds loopback only');
const dir=resolve('.local/v2-mock');
await mkdir(dir,{recursive:true});
const pg=new PGlite(dir);
const isNew=!(await pg.query("SELECT 1 FROM pg_namespace WHERE nspname='liferpg_v2'")).rows.length;
if(isNew) {
  await pg.exec(await readFile(new URL('../../migrations/v2/001-foundation.sql',import.meta.url),'utf8'));
}
if(!(await pg.query("SELECT 1 FROM information_schema.tables WHERE table_schema='liferpg_v2' AND table_name='rpg_entities'")).rows.length)
  await pg.exec(await readFile(new URL('../../migrations/v2/003-rpg.sql',import.meta.url),'utf8'));
if(!(await pg.query("SELECT 1 FROM information_schema.tables WHERE table_schema='liferpg_v2' AND table_name='memory_sources'")).rows.length)
  await pg.exec(await readFile(new URL('../../migrations/v2/004-memory.sql',import.meta.url),'utf8'));
const db=scopedDatabase({query:async(sql,values)=>pg.query(sql,values),transaction:fn=>pg.transaction(tx=>fn({query:async(sql,values)=>tx.query(sql,values)}))});
// Kept outside the database directory; do not restore it from an old DB backup.
const journal=await openDeletionJournal(db,resolve('.local/v2-deletions.json'),isNew);
const app=createV2App(db,config,journal.sync);
const worker=new GmWorker(db,new MockGm());
let stopping=false;
const work=(async()=>{
  while(!stopping) {
    try {if(await worker.runOnce())continue;}
    catch {console.error(JSON.stringify({type:'mock_worker_error'}));}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
})();
const server=createServer(async(req,res)=>{
  try {
    const request=new Request(new URL(req.url??'/',config.base),{method:req.method,headers:req.headers as HeadersInit,
      ...(['GET','HEAD'].includes(req.method??'')?{}:{body:Readable.toWeb(req) as ReadableStream,duplex:'half'})});
    const response=await app(request);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  } catch {res.writeHead(500);res.end('internal_error');}
});
server.listen(Number(new URL(config.base).port||3020),'127.0.0.1',()=>console.info(`LifeRPG v2 MOCK only: ${config.resource}`));
async function shutdown() {
  if(stopping)return;stopping=true;
  const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
  await Promise.all([work,closed]);await pg.close();
  process.disconnect?.();
}
process.on('SIGINT',()=>{void shutdown();});process.on('SIGTERM',()=>{void shutdown();});
process.on('message',message=>{if(message==='shutdown')void shutdown();});
