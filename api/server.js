import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { connectDatabase } from '../src/database.js';
import { maintenanceResponse } from '../src/maintenance.js';

/** @type {ReturnType<typeof createApp> | undefined} */
let app;
/** @param {Request} request */
async function handle(request) {
  try {
    const maintenance = maintenanceResponse(request, process.env.MAINTENANCE_WRITES === 'true');
    if (maintenance) return maintenance;
    app ||= createApp(connectDatabase(process.env.DATABASE_URL || ''),readConfig());
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
