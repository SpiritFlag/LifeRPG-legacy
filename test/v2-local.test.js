import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,sep} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readConfig} from '../src/config.js';
import {login,mcpClient} from '../scripts/client.js';
import {V2_SCOPES} from '../src/v2/contracts.ts';

test('local runner serves OAuth/MCP over HTTP, runs queued work, and resumes persistent state after restart',async()=>{
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const dir=await mkdtemp(join(tmpdir(),'liferpg-v2-http-'));
  const origin=`http://127.0.0.1:${port}`;
  const env={...process.env,V2_LOCAL_ORIGIN:origin,PUBLIC_BASE_URL:origin,OAUTH_CLIENT_SECRET:randomBytes(32).toString('hex'),OWNER_LOGIN_KEY:randomBytes(32).toString('hex'),OAUTH_REDIRECT_URIS:'http://localhost:3021/callback'};
  delete env.DATABASE_URL;delete env.OPENAI_API_KEY;
  const config=readConfig(env);let child,client;
  const start=async()=>{
    child=spawn(process.execPath,[fileURLToPath(new URL('../src/v2/local.ts',import.meta.url))],{cwd:dir,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    await new Promise((accept,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Mock server startup timeout')),15000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Mock server exited before ready (${code})`));});
      child.stdout.on('data',chunk=>{if(String(chunk).includes('MOCK only')){clearTimeout(timer);accept();}});
      // Synthetic only, but suppress arbitrary process errors from normal output.
      child.stderr.resume();
    });
    const tokens=(await login(origin,config,fetch,V2_SCOPES.join(' '))).tokens;
    client=await mcpClient(origin,tokens.access_token);
  };
  const stop=async()=>{
    await client?.close();client=null;
    if(child && child.exitCode===null) {
      const exited=new Promise(resolve=>child.once('exit',resolve));
      child.send('shutdown');await exited;
    }
  };
  const call=async(name,args)=>(await client.callTool({name,arguments:args})).structuredContent;
  const waitFor=async(id)=>{
    for(let i=0;i<30;i++) {
      const value=await call('read_liferpg',{view:'request',operation_id:id});
      if(value.status==='committed')return value;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('Mock job did not complete');
  };
  try {
    await start();
    const init=await call('interact_with_gm',{request_id:randomUUID(),kind:'start',message:'Synthetic HTTP start'});await waitFor(init.operation_id);
    const observation=await call('submit_observation',{request_id:randomUUID(),summary:'Synthetic HTTP event'});await waitFor(observation.operation_id);
    assert.equal((await call('read_liferpg',{view:'game'})).xp,5);
    const deleted=await call('delete_real_record',{request_id:randomUUID(),event_ids:observation.event_ids});assert.equal(deleted.deletion.live_status,'live_purged');
    await stop();await start();
    assert.equal((await call('read_liferpg',{view:'request',operation_id:observation.operation_id})).status,'deleted');
    assert.equal((await call('read_liferpg',{view:'records'})).records.length,0);
  } finally {
    await stop();
    const target=resolve(dir),parent=resolve(tmpdir());
    if(!target.startsWith(parent+sep))throw new Error('Unsafe local test cleanup');
    await rm(target,{recursive:true,force:true});
  }
});
