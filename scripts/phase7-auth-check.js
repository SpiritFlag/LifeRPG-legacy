// Read-only Clerk/TLS inventory. Never logs keys, email addresses or session tokens.
import { readFile,writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';
import https from 'node:https';
const production=parseEnv(await readFile('.env.clerk.production.local','utf8'));
const development=parseEnv(await readFile('.env.clerk.local','utf8'));
assert.ok(production.CLERK_SECRET_KEY.startsWith('sk_live_'));
assert.ok(production.CLERK_PUBLISHABLE_KEY.startsWith('pk_live_'));
assert.notEqual(production.CLERK_SECRET_KEY,development.CLERK_SECRET_KEY);
assert.notEqual(production.CLERK_OWNER_USER_ID,development.CLERK_OWNER_USER_ID);
const userResponse=await fetch(`https://api.clerk.com/v1/users/${production.CLERK_OWNER_USER_ID}`,{headers:{Authorization:`Bearer ${production.CLERK_SECRET_KEY}`}});
assert.equal(userResponse.status,200);
const user=await userResponse.json();assert.equal(user.id,'user_3KgIDVcWqpwsHxVotXgNxOv15mF');
assert.ok(user.last_sign_in_at);assert.ok(user.email_addresses.some(e=>e.verification?.status==='verified'));
const tls=await Promise.all(['liferpg.spiritflag.work','clerk.liferpg.spiritflag.work','accounts.liferpg.spiritflag.work'].map(host=>new Promise((resolve,reject)=>{
  const request=https.get(`https://${host}/`,response=>{
    const socket=response.socket,certificate=socket.getPeerCertificate();
    resolve({host,http_status:response.statusCode,authorized:socket.authorized,protocol:socket.getProtocol(),valid_to:certificate.valid_to});response.resume();
  });request.setTimeout(10000,()=>request.destroy(new Error('TLS check timed out')));request.on('error',reject);
})));
const environmentResponse=await fetch('https://clerk.liferpg.spiritflag.work/v1/environment');assert.equal(environmentResponse.status,200);
const environment=await environmentResponse.json();
assert.equal(environment.user_settings.social.oauth_google.enabled,false);
const safe={checked_at:new Date().toISOString(),instance:'ins_3KgHQpUdWBwxfzGUrj4QjQpr2zs',owner_id:user.id,owner_email_verified:true,last_sign_in_at:new Date(user.last_sign_in_at).toISOString(),external_account_providers:user.external_accounts.map(a=>a.provider),key_environment:'live',development_keys_distinct:true,tls,frontend_environment_keys:Object.keys(environment),google_enabled:false,display_config:environment.display_config,user_settings:environment.user_settings ? {sign_in:environment.user_settings.sign_in,sign_up:environment.user_settings.sign_up,social:environment.user_settings.social,attributes:environment.user_settings.attributes} : undefined};
// No personal identity fields from the Backend API are written to the report.
await writeFile('.local/phase7/clerk-verification.json',JSON.stringify(safe,null,2));
console.log(JSON.stringify({owner_id:safe.owner_id,email_verified:true,last_sign_in_at:safe.last_sign_in_at,external_account_providers:safe.external_account_providers,key_environment:'live',development_keys_distinct:true,tls,frontend_environment_keys:safe.frontend_environment_keys}));
