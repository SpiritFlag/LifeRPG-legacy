import { readFile } from 'node:fs/promises';
import { connectDatabase } from '../src/database.js';

const url = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== '/liferpg_experiment') throw new Error('Refusing setup outside dedicated liferpg_experiment database');
const db = connectDatabase(url);
try {
  await db.query(await readFile(new URL('../migrations/001-experiment.sql',import.meta.url),'utf8'));
  console.info('Experiment schema ready.');
} finally { await db.close(); }
