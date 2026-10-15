import { readFile,writeFile,rename } from 'node:fs/promises';
import { z } from 'zod';
import { lockGame,purgeSources } from './storage.ts';
import type { Database } from './storage.ts';

const manifestSchema=z.strictObject({version:z.literal(1),owners:z.array(z.strictObject({owner_id:z.string().min(1),event_ids:z.array(z.uuid())}))});
export async function deletionManifest(db:Database) {
  const rows=(await db.query('SELECT owner_id,array_agg(id ORDER BY id) AS event_ids FROM events WHERE deleted_at IS NOT NULL GROUP BY owner_id ORDER BY owner_id')).rows;
  return manifestSchema.parse({version:1,owners:rows});
}

/** Run before opening API/worker on a restored DB. The manifest must live outside its backups. */
export async function applyDeletionManifest(db:Database,raw:unknown) {
  const manifest=manifestSchema.parse(raw);
  for(const entry of manifest.owners) await db.transaction(async tx=>{
    await lockGame(tx,entry.owner_id);
    await tx.query('UPDATE games SET privacy_epoch=privacy_epoch+1,revision=revision+1,auto_capture_paused=true WHERE owner_id=$1',[entry.owner_id]);
    await purgeSources(tx,entry.owner_id,entry.event_ids,true);
    for(const id of entry.event_ids) {
      // An event created after the restored snapshot must still retain its tombstone.
      await tx.query(`INSERT INTO events(id,owner_id,deleted_at) VALUES($1,$2,clock_timestamp())
        ON CONFLICT(id) DO UPDATE SET deleted_at=COALESCE(events.deleted_at,clock_timestamp()),fingerprint=NULL
        WHERE events.owner_id=EXCLUDED.owner_id`,[id,entry.owner_id]);
    }
  });
}

/** Local-only journal. Missing/corrupt journal on an existing DB blocks startup. */
export async function openDeletionJournal(db:Database,file:string,isNewDatabase:boolean) {
  let manifest:unknown;
  try {manifest=JSON.parse(await readFile(file,'utf8'));}
  catch(error) {
    if(!isNewDatabase || (error as NodeJS.ErrnoException).code!=='ENOENT') throw new Error('Deletion journal missing or invalid; keep API and worker stopped');
    manifest={version:1,owners:[]};
  }
  await applyDeletionManifest(db,manifest);
  let queue=Promise.resolve();
  const sync=()=>{
    const run=queue.catch(()=>{}).then(async()=>{
      const current=await deletionManifest(db);
      await writeFile(`${file}.pending`,JSON.stringify(current),{mode:0o600,flush:true});
      await rename(`${file}.pending`,file);
    });
    queue=run;return run;
  };
  await sync(); // also recovers DB-committed deletions whose acknowledgement was interrupted
  return {sync};
}
