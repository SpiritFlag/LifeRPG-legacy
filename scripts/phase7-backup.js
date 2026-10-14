// Explicitly approved Phase 7 backup. No production write or migration mode.
import pg from 'pg';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getCACertificates } from 'node:tls';

const directory = path.resolve('.local/backups/phase7');
const keyDirectory = 'C:/Users/singi/.codex/secrets';
const bin = path.resolve('.local/tools/pgsql/bin');
// EDB libpq/OpenSSL does not use this Windows user's Node trust store automatically.
// Export the installed Node runtime's public trusted roots; retain verify-full.
const caFile=path.resolve('.local/tools/node-trusted-roots.pem');
await writeFile(caFile,getCACertificates('default').join('\n'));
const sourceHost = 'ep-soft-sky-a1kxmx2q.ap-southeast-1.aws.neon.tech';
const restoreHost = 'ep-young-flower-a115sf9a.ap-southeast-1.aws.neon.tech';
const env = parseEnv(await readFile('.env.local','utf8'));
const keyCommands = await readFile('scripts/phase7-key.ps1','utf8');
const source = new URL(env.DATABASE_URL);
if (source.hostname === sourceHost.replace('.ap-', '-pooler.ap-')) source.hostname = sourceHost;
assert.equal(source.hostname, sourceHost); assert.equal(source.pathname, '/liferpg_experiment');
assert.equal(decodeURIComponent(source.username), 'liferpg_owner');
assert.equal(source.searchParams.get('sslmode'), 'verify-full');

function keyOperation(action, keyFile, input) {
  // Use normal console commands; do not change the machine's script execution policy.
  const result = spawnSync('powershell.exe', ['-NoProfile','-Command',`& {${keyCommands}} -Action $env:LIFERPG_KEY_ACTION -KeyFile $env:LIFERPG_KEY_FILE`], {input, encoding:'utf8', windowsHide:true,env:{...process.env,LIFERPG_KEY_ACTION:action,LIFERPG_KEY_FILE:keyFile}});
  if (result.status !== 0) throw new Error('DPAPI operation failed; credentials omitted');
  return action === 'unprotect' ? Buffer.from(result.stdout.trim(),'base64') : undefined;
}
function client(url, readonly=true) {
  return new pg.Client({connectionString:url.href,options:readonly ? '-c default_transaction_read_only=on' : undefined,statement_timeout:30000,application_name:'liferpg-phase7-backup-restore'});
}
function toolEnvironment(url, readonly) {
  // No URL/password in arguments, console, or persistent service files.
  return {...process.env, PGHOST:url.hostname, PGPORT:'5432', PGDATABASE:url.pathname.slice(1), PGUSER:decodeURIComponent(url.username), PGPASSWORD:decodeURIComponent(url.password), PGSSLMODE:'verify-full', PGSSLROOTCERT:caFile, PGAPPNAME:'liferpg-phase7-pg-tool', PGOPTIONS:readonly ? '-c default_transaction_read_only=on -c statement_timeout=60000' : '-c statement_timeout=60000'};
}
function runTool(name,args,url,readonly) {
  const child=spawn(path.join(bin,`${name}.exe`),args,{env:toolEnvironment(url,readonly),windowsHide:true,stdio:['pipe','pipe','pipe']});
  // pg_restore errors can contain actual data. Never log raw stderr.
  let stderrBytes=0;child.stderr.on('data',b=>{stderrBytes+=b.length;});
  const done=new Promise((resolve,reject)=>{child.on('error',()=>reject(new Error(`${name} failed to start`)));child.on('close',code=>code===0 ? resolve() : reject(new Error(`${name} exit ${code}; diagnostic bytes ${stderrBytes}, contents omitted`)));});
  // Attach immediately so pipeline errors do not create an unhandled rejection.
  done.catch(()=>{});
  return {child,done};
}
async function inventory(db) {
  const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename);
  const columns=(await db.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const constraints=(await db.query("SELECT conrelid::regclass::text AS table_name,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conrelid::regclass::text,conname")).rows;
  const indexes=(await db.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows;
  const functions=(await db.query("SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.proname,p.oid::regprocedure::text")).rows;
  const fingerprints={};
  for(const table of tables) {
    assert.match(table,/^[a-z_]+$/);
    fingerprints[table]=(await db.query(`SELECT count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM public.${table} t`)).rows[0];
  }
  return {tables,columns,constraints,indexes,functions,fingerprints};
}
async function readInventory(url) {
  const db=client(url);await db.connect();
  try {await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await inventory(db);await db.query('COMMIT');return result;}
  finally {await db.end();}
}

await mkdir(directory,{recursive:true});
const mode=process.argv[2];
// Phase 8-A reuses the approved crypto/location contract with a separate empty
// restore DB and reports. No arbitrary host/branch/database override is accepted.
const phase8a=process.argv.includes('--phase8a');
const restoreDatabase=phase8a ? 'liferpg_phase8a_restore' : 'liferpg_phase7_restore';
const reportPrefix=phase8a ? 'phase8a-' : '';
if(mode==='inventory') {
  const latest=JSON.parse(await readFile(path.join(directory,'latest.json'),'utf8'));
  assert.match(latest.manifest,/^[\w-]+\.json$/);
  const manifest=JSON.parse(await readFile(path.join(directory,latest.manifest),'utf8'));
  const final=await readInventory(source);assert.deepEqual(final,manifest.inventory);
  await writeFile(path.join(directory,`${reportPrefix}production-final.json`),JSON.stringify({verified_at:new Date().toISOString(),production_unchanged:true,inventory:final},null,2));
  console.log(JSON.stringify({production_unchanged:true,fingerprints:final.fingerprints}));
} else if(mode==='backup') {
  const id=new Date().toISOString().replace(/[:.]/g,'-');
  const keyFile=path.join(keyDirectory,`liferpg-phase7-${id}.key.dpapi`);
  const key=randomBytes(32),iv=randomBytes(12);
  keyOperation('protect',keyFile,key.toString('base64'));
  const db=client(source);await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot=(await db.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const original=await inventory(db);
    const header={format:'liferpg-backup-v1',algorithm:'AES-256-GCM',created_at:new Date().toISOString(),project:'cool-waterfall-23850161',branch:'br-spring-night-a1jbloxd',endpoint:sourceHost,database:'liferpg_experiment',snapshot,pg_dump:'18.6',iv:iv.toString('base64')};
    const aad=JSON.stringify(header),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));
    const file=path.join(directory,`${id}.pgdump.aesgcm`);
    const {child,done}=runTool('pg_dump',['--format=custom','--no-owner','--no-acl',`--snapshot=${snapshot}`],source,true);
    child.stdin.end();
    await pipeline(child.stdout,cipher,createWriteStream(file,{flags:'wx'}));await done;
    await db.query('COMMIT');
    const encrypted=await readFile(file);
    const manifest={header,aad,tag:cipher.getAuthTag().toString('base64'),key_file:keyFile,file:path.basename(file),encrypted_sha256:createHash('sha256').update(encrypted).digest('hex'),encrypted_bytes:encrypted.length,retention:'Phase 8 completion + 7 days; human confirmation before deletion',inventory:original};
    await writeFile(path.join(directory,`${id}.json`),JSON.stringify(manifest,null,2),{flag:'wx'});
    await writeFile(path.join(directory,'latest.json'),JSON.stringify({manifest:`${id}.json`},null,2));
    const after=await readInventory(source);assert.deepEqual(after,original);
    await writeFile(path.join(directory,`${id}.production-after.json`),JSON.stringify(after,null,2));
    console.log(JSON.stringify({outcome:'encrypted_backup_verified',file:path.basename(file),bytes:encrypted.length,pg_dump:'18.6',source_read_only:true,production_unchanged:true,fingerprints:original.fingerprints}));
  } finally {await db.end();key.fill(0);}
} else if(mode==='restore' || mode==='verify') {
  const latest=JSON.parse(await readFile(path.join(directory,'latest.json'),'utf8'));
  assert.match(latest.manifest,/^[\w-]+\.json$/);
  const manifest=JSON.parse(await readFile(path.join(directory,latest.manifest),'utf8'));
  assert.equal(manifest.aad,JSON.stringify(manifest.header));assert.equal(manifest.header.branch,'br-spring-night-a1jbloxd');
  assert.match(manifest.file,/^[\w-]+\.pgdump\.aesgcm$/);
  const size=(await stat(path.join(directory,manifest.file))).size;assert.ok(size<512*1024*1024,'This restore helper authenticates backups in memory; maximum 512 MiB');
  const encrypted=await readFile(path.join(directory,manifest.file));
  assert.equal(createHash('sha256').update(encrypted).digest('hex'),manifest.encrypted_sha256);
  const key=keyOperation('unprotect',manifest.key_file);
  let plaintext;
  try {
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(manifest.header.iv,'base64'));
    decipher.setAAD(Buffer.from(manifest.aad));decipher.setAuthTag(Buffer.from(manifest.tag,'base64'));
    plaintext=Buffer.concat([decipher.update(encrypted),decipher.final()]);
    assert.equal(plaintext.subarray(0,5).toString(),'PGDMP');
    if(mode==='verify') {
      const tampered=Buffer.from(encrypted);tampered[0]^=1;
      const invalid=createDecipheriv('aes-256-gcm',key,Buffer.from(manifest.header.iv,'base64'));
      invalid.setAAD(Buffer.from(manifest.aad));invalid.setAuthTag(Buffer.from(manifest.tag,'base64'));
      assert.throws(()=>{invalid.update(tampered);invalid.final();});
      const {child,done}=runTool('pg_restore',['--list'],source,true);
      let entries=0;child.stdout.on('data',b=>{entries+=b.toString().split('\n').filter(line=>/^\d+;/.test(line)).length;});
      child.stdin.end(plaintext);await done;assert.ok(entries>0);
      const report={verified_at:new Date().toISOString(),authenticated_archive:true,custom_format:true,pg_restore_list_entries:entries,tampered_ciphertext_rejected:true,database_connections:0};
      await writeFile(path.join(directory,`${reportPrefix}archive-verification.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    } else {
    // Authentication is complete BEFORE any DB write. Tampered archives cannot cause partial restore.
    const target=new URL(source);target.hostname=restoreHost;target.pathname=`/${restoreDatabase}`;
    assert.notEqual(target.hostname,sourceHost);assert.ok(['liferpg_phase7_restore','liferpg_phase8a_restore'].includes(target.pathname.slice(1)));
    const initial=await readInventory(target);assert.deepEqual(initial.tables,[],'Refusing nonempty restore target');
    const {child,done}=runTool('pg_restore',['--no-owner','--no-acl','--exit-on-error','--single-transaction',`--dbname=${restoreDatabase}`],target,false);
    child.stdout.resume();child.stdin.end(plaintext);await done;
    const restored=await readInventory(target);assert.deepEqual(restored,manifest.inventory);
    const productionAfter=await readInventory(source);assert.deepEqual(productionAfter,manifest.inventory);
    const report={outcome:'restore_verified',project:'cool-waterfall-23850161',branch:'br-soft-art-a1xx9a51',endpoint:restoreHost,database:restoreDatabase,pg_restore:'18.6',authenticated_before_restore:true,single_transaction:true,inventory_equal:true,production_unchanged:true,fingerprints:restored.fingerprints,verified_at:new Date().toISOString()};
    await writeFile(path.join(directory,`${reportPrefix}restore-verification.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    }
  } finally {key.fill(0);plaintext?.fill(0);}
} else throw new Error('Explicit backup, restore, verify or inventory mode required');
