import { readFile } from 'node:fs/promises';
import pg from 'pg';

const url = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== '/liferpg_experiment') throw new Error('Refusing setup outside dedicated liferpg_experiment database');
if (new URL(url).hostname.includes('-pooler.')) throw new Error('Migrations require the verified direct endpoint, not a pooled connection');
const migration = process.argv[2] || '001-experiment.sql';
if (!['001-experiment.sql','002-life-event-history.sql','003-gm-growth.sql','004-questlines.sql','005-character-content.sql','006-world-memory.sql','007-game-initialization.sql','008-real-task-quests.sql'].includes(migration)) throw new Error('Choose an explicit known migration file');
// Migration files manage their own BEGIN/COMMIT; do not nest the app wrapper.
const db = new pg.Client({connectionString:url,connectionTimeoutMillis:10000,statement_timeout:10000});
try {
  await db.connect();
  await db.query(await readFile(new URL(`../migrations/${migration}`,import.meta.url),'utf8'));
  console.info(`Applied ${migration}.`);
} catch(error) {await db.query('ROLLBACK').catch(()=>{});throw error;} finally { await db.end(); }
