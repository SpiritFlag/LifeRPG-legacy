import pg from 'pg';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';

// This script has no mutation mode. Production connections default to READ ONLY.
const env=parseEnv(await readFile('.env.local','utf8'));
const url=new URL(env.DATABASE_DIRECT_URL || env.DATABASE_URL);
// Older local configuration mislabeled the pooled URL as direct; derive the
// already verified endpoint without changing the source env file.
if(url.hostname==='ep-soft-sky-a1kxmx2q-pooler.ap-southeast-1.aws.neon.tech') url.hostname='ep-soft-sky-a1kxmx2q.ap-southeast-1.aws.neon.tech';
if(url.hostname!=='ep-soft-sky-a1kxmx2q.ap-southeast-1.aws.neon.tech' || url.pathname!=='/liferpg_experiment') throw new Error('Unexpected production endpoint/database');
const client=new pg.Client({connectionString:url.href,options:'-c default_transaction_read_only=on',statement_timeout:10000,application_name:'liferpg-phase6-readonly-inventory'});
try {
  await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const identity=(await client.query(`SELECT current_database() AS database,current_user AS role,current_setting('server_version') AS version,current_setting('transaction_read_only') AS read_only,pg_backend_pid() AS pid`)).rows[0];
  const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename);
  const columns=(await client.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const constraints=(await client.query("SELECT conrelid::regclass::text AS table_name,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conrelid::regclass::text,conname")).rows;
  const fingerprints={};
  for(const table of tables) {
    if(!/^[a-z_]+$/.test(table)) throw new Error('Unexpected identifier');
    fingerprints[table]=(await client.query(`SELECT count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM public.${table} t`)).rows[0];
  }
  const socket=client.connection.stream;
  const ssl={client_tls:{encrypted:socket.encrypted,authorized:socket.authorized,protocol:socket.getProtocol()},backend:(await client.query('SELECT ssl,version,cipher FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]};
  const snapshot={observed_at:new Date().toISOString(),endpoint:url.hostname,identity,ssl,tables,columns,constraints,fingerprints};
  await client.query('COMMIT');await mkdir('.local/phase6',{recursive:true});
  const output=process.argv.includes('--final') ? '.local/phase6/production-inventory-final.json' : '.local/phase6/production-inventory.json';
  await writeFile(output,JSON.stringify(snapshot,null,2));
  console.log(JSON.stringify({identity,endpoint:url.hostname,ssl,tables,fingerprints}));
} catch(error) {console.error(JSON.stringify({outcome:'inventory_error',code:error.code,message:String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted]')}));process.exitCode=1;} finally {await client.end();}
