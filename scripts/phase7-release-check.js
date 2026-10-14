// Local release inventory and read-only Vercel inspection; no deploy/push mode.
import { execFileSync } from 'node:child_process';
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';
const cli='C:/Users/singi/AppData/Local/npm-cache/_npx/67eb4586ca667318/node_modules/vercel/dist/index.js';
const team='team_wDLsRTkkRjvKKqQKnE8B9jEJ',project='prj_v5gMi1veBor2Oa2DPmzHi9uJjHvk';
const get=route=>JSON.parse(execFileSync(process.execPath,[cli,'api',`${route}${route.includes('?')?'&':'?'}teamId=${team}`,'--method','GET'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}));
const p=get(`/v9/projects/${project}`),deployments=get(`/v6/deployments?projectId=${project}&target=production&limit=3`);
const current=deployments.deployments.find(d=>d.readyState==='READY'),deployment=get(`/v13/deployments/${current.uid}`),domains=get(`/v9/projects/${project}/domains`);
const overview=JSON.parse(execFileSync(process.execPath,[cli,'firewall','overview','--scope',team,'--json'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}));
assert.equal(p.id,project);assert.equal(p.link.repo,'LifeRPG');assert.equal(p.link.productionBranch,'main');
const infrastructure={checked_at:new Date().toISOString(),team,project,name:p.name,git:{type:p.link.type,org:p.link.org,repo:p.link.repo,production_branch:p.link.productionBranch},deployment:{id:current.uid,url:current.url,state:current.readyState,commit:current.meta?.githubCommitSha,target:deployment.target,source:deployment.source},environment_names:p.env.map(v=>({name:v.key,targets:v.target})),domains:domains.domains.map(d=>({name:d.name,verified:d.verified})),resource_config:p.resourceConfig,firewall:{active:overview.active,draft:overview.draft,bypass:overview.bypass,attack_mode:overview.attackMode}};
await writeFile('.local/phase7/vercel-inventory.json',JSON.stringify(infrastructure,null,2));
const dry=JSON.parse(execFileSync(process.execPath,[cli,'deploy','--dry','--json','--scope',team],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}));
await writeFile('.local/phase7/vercel-dry.json',JSON.stringify(dry,null,2));
const uploaded=dry.files.filter(f=>f.sha);
for(const f of uploaded) assert.ok(!/^(?:\.env|\.local\/|\.vercel\/|docs\/|test\/|migrations\/|scripts\/(?:phase[67]-|client\.js|smoke\.js|setup-db\.js|preview-web\.js|serve-web\.js))/.test(f.path),`Excluded file in deployment: ${f.path}`);
assert.ok(!uploaded.some(f=>['DESIGN.md','SPEC.md'].includes(f.path)));
const secrets=[];
for(const file of ['.env.local','.env.clerk.local','.env.clerk.production.local']) {
  const values=parseEnv(await readFile(file,'utf8'));
  for(const [name,value] of Object.entries(values)) {
    if(/SECRET|LOGIN_KEY/.test(name)&&value.length>=16) secrets.push(value);
    if(/DATABASE.*URL/.test(name)) secrets.push(value,new URL(value).password,decodeURIComponent(new URL(value).password));
  }
}
const deploymentFiles=[];
for(const f of uploaded) {
  const content=await readFile(f.path);for(const secret of secrets) assert.equal(content.includes(Buffer.from(secret)),false,'Credential detected; content omitted');
  deploymentFiles.push({path:f.path,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')});
}
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean).sort();
const releaseFiles=[];for(const file of files) {const data=await readFile(file);for(const secret of secrets) assert.equal(data.includes(Buffer.from(secret)),false,'Credential detected in release source; content omitted');releaseFiles.push({path:file.replaceAll('\\','/'),bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});}
const manifest={created_at:new Date().toISOString(),git_head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),git_branch:execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),state:'local uncommitted release candidate; no push/deploy',source_files:releaseFiles,deployment_files:deploymentFiles,deployment_file_count:deploymentFiles.length,deployment_total_bytes:deploymentFiles.reduce((n,f)=>n+f.bytes,0),credentials_detected:0,excluded:dry.ignored};
manifest.source_manifest_sha256=createHash('sha256').update(JSON.stringify(releaseFiles)).digest('hex');
manifest.deployment_manifest_sha256=createHash('sha256').update(JSON.stringify(deploymentFiles)).digest('hex');
await writeFile('.local/phase7/release-manifest.json',JSON.stringify(manifest,null,2));
console.log(JSON.stringify({source_file_count:releaseFiles.length,deployment_file_count:deploymentFiles.length,credentials_detected:0,source_manifest_sha256:manifest.source_manifest_sha256,deployment_manifest_sha256:manifest.deployment_manifest_sha256,production:infrastructure.deployment,git:infrastructure.git,environment_names:infrastructure.environment_names.map(v=>v.name),firewall:infrastructure.firewall}));
