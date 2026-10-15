import { createApp } from '../app.js';
import { createV2McpServer } from './tools.ts';
import { V2_SCOPES } from './contracts.ts';
import type { Database } from './storage.ts';
import type { Config } from '../config.js';

/** db must be scopedDatabase(rawDb). There is no v1 writer in this app. */
export function createV2App(db:Database,config:Config,afterDeletion?:()=>Promise<void>) {
  return createApp(db,{...config,scopes:V2_SCOPES,serverName:'liferpg-v2-mock'},(database,settings,identity)=>createV2McpServer(database,settings,identity,afterDeletion));
}
