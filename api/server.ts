import { createV2App } from '../src/v2/app.ts';
import { scopedDatabase } from '../src/v2/storage.ts';
import { inlineGm } from '../src/v2/inline.ts';
import { createLiveOpenAiGm } from '../src/v2/openai-gm.ts';
import { readOpenAiConfig } from '../src/v2/openai-config.ts';
import { waitUntil } from '@vercel/functions';
import { readConfig } from '../src/config.js';
import { connectDatabase } from '../src/database.js';
import { maintenanceResponse } from '../src/maintenance.js';

/** @type {ReturnType<typeof createV2App> | undefined} */
let app:ReturnType<typeof createV2App>|undefined;
/** @param {Request} request */
async function handle(request:Request) {
  try {
    const maintenance = maintenanceResponse(request, process.env.MAINTENANCE_WRITES === 'true');
    if (maintenance) return maintenance;
    if(!app) {
      const db=scopedDatabase(connectDatabase(process.env.DATABASE_URL || ''));
      const gm=createLiveOpenAiGm(readOpenAiConfig(process.env),process.env,true);
      app=createV2App(db,readConfig(),undefined,'openai',inlineGm(db,gm,waitUntil));
    }
    return await app(request);
  } catch {
    console.error(JSON.stringify({type:'configuration_error'}));
    return Response.json({error:'server_not_configured'},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
export const DELETE = handle;
