import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { login, mcpClient, testEvent } from './client.js';

const config = readConfig();
const base = process.env.SMOKE_BASE_URL || config.base;
if (new URL(base).origin !== config.base) throw new Error('Smoke target must match PUBLIC_BASE_URL');
const anonymous = await fetch(`${base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'record_life_event',arguments:testEvent}})});
assert.equal(anonymous.status,401);
const {tokens} = await login(base,config);
const client = await mcpClient(base,tokens.access_token);
try {
  const tools = await client.listTools();
  for (const name of ['get_gm_status','record_life_event','list_life_events']) assert.ok(tools.tools.some(t => t.name === name));
  const before = (await client.callTool({name:'get_gm_status',arguments:{}})).structuredContent;
  const event = {...testEvent,event_key:`synthetic-smoke-${randomUUID()}`};
  const results = await Promise.all([client.callTool({name:'record_life_event',arguments:event}),client.callTool({name:'record_life_event',arguments:event})]);
  assert.deepEqual(results.map(r => r.structuredContent.outcome).sort(),['duplicate','recorded']);
  assert.equal(results[0].structuredContent.event.id,results[1].structuredContent.event.id);
  const skipped = await client.callTool({name:'record_life_event',arguments:{...event,event_key:`${event.event_key}-joke`,kind:'joke'}});
  assert.equal(skipped.structuredContent.outcome,'skipped');
  const after = (await client.callTool({name:'get_gm_status',arguments:{}})).structuredContent;
  assert.equal(after.event_count,before.event_count+1);
  assert.ok(after.recent_calls.some(c => c.outcome === 'duplicate'));
  const list = (await client.callTool({name:'list_life_events',arguments:{occurred_on:event.occurred_on}})).structuredContent;
  assert.ok(list.events.some(e => e.id === results[0].structuredContent.event.id));
  console.info(JSON.stringify({target:base,transport:'Streamable HTTP',result:'passed',anonymous_write:'blocked',oauth:'authorization-code + PKCE',concurrent_duplicate:'one event',joke:'skipped',event_id:results[0].structuredContent.event.id,chatgpt_autonomous_call:'NOT VERIFIED'},null,2));
} finally {
  await client.close();
  for (const token of [tokens.access_token,tokens.refresh_token].filter(Boolean)) {
    await fetch(`${base}/oauth/revoke`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,token})});
  }
}
