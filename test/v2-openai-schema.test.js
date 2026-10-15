import {test} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';
import {compileStructuredSchema,assertStructuredSchema} from '../src/v2/openai-schema.ts';
import {readSafeProviderError,safeProviderError} from '../src/v2/openai-errors.ts';
import {OpenAiGm,createLiveOpenAiGm,GM_OUTPUT_SCHEMA} from '../src/v2/openai-gm.ts';
import {readOpenAiConfig} from '../src/v2/openai-config.ts';
import {operation,entityBody} from '../src/v2/rpg-contracts.ts';
import {measureSyntheticGm} from '../src/v2/synthetic-metrics.ts';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const branch=values=>object({tag:{type:'string',enum:values}});
const config=readOpenAiConfig({});
const signal=()=>new AbortController().signal;
const context={operation_id:'11111111-1111-4111-8111-111111111111',kind:'start',input:{message:'SYNTHETIC-PRIVATE'},initialized:false,xp:0,memories:[],events:[],previous_decision:null,target_event_id:null};
const requestId='req_'+'a'.repeat(32);
const safe={code:'invalid_json_schema',param:'text.format.schema',request_id:requestId};

test('actual wire schema passes strict local profile and an independent JSON Schema compiler',()=>{
  const profile=assertStructuredSchema(GM_OUTPUT_SCHEMA);
  assert.equal(profile.properties,84);assert.equal(profile.max_depth,6);
  assert.ok(!JSON.stringify(GM_OUTPUT_SCHEMA).includes('"oneOf"'));
  new Ajv2020({strict:true}).compile(GM_OUTPUT_SCHEMA);
  assert.throws(()=>{GM_OUTPUT_SCHEMA.type='array';},TypeError);
  assert.ok(Object.isFrozen(GM_OUTPUT_SCHEMA.$defs.__schema3.anyOf));
});

test('all RPG discriminators preserve structural acceptance under oneOf to anyOf conversion',()=>{
  const original=z.toJSONSchema(z.strictObject({change:operation}));
  const {$schema,...raw}=original;
  assert.throws(()=>assertStructuredSchema(raw),/unsupported_keyword/);
  const converted=compileStructuredSchema(raw);
  const ajv=new Ajv2020({strict:false,validateFormats:false});
  const before=ajv.compile(raw),after=ajv.compile(converted);
  const named={name:'합성',description:'합성 설명'},ref='11111111-1111-4111-8111-111111111111';
  const bodies=[
    {kind:'character',...named,level:1,stats:[],profession:null,location:null},
    ...['profession','skill','trait','title','achievement','item','equipment'].map(kind=>({kind,...named,effects:[],slots:[]})),
    {kind:'quest',...named,status:'offered',progress:0,target:1,location:null},
    ...['npc','place','faction'].map(kind=>({kind,...named,parent:null})),
    {kind:'relation',...named,from:'@a',to:'@b',status:'active'},
    {kind:'world_event',...named,status:'planned',location:null,participants:[]},
  ];
  const ops=bodies.map(body=>({op:'put',ref:'@a',expected_version:0,visibility:'public',private_notes:null,body}));
  ops.push({op:'inventory',ref:'@a',expected_version:0,definition:'@b',delta:1},
    {op:'equip',ref:'@a',expected_version:1,slot:null},{op:'retire',ref:'@a',expected_version:1},
    {op:'advance_time',ticks:1},{op:'resolve_reinterpretation',decision_id:ref});
  let rejected=0;
  for(const op of ops) {
    assert.ok(before({change:op}));assert.ok(after({change:op}));assert.ok(operation.safeParse(op).success);
    // Missing and mixed branch fields, unknown discriminators, and extra properties must stay rejected.
    const invalid=[{...op,op:'unknown'},{...op,unexpected:true}];
    for(const key of Object.keys(op)){const partial={...op};delete partial[key];invalid.push(partial);}
    for(const other of ops.filter(o=>o.op!==op.op))invalid.push({...op,...other,op:op.op});
    for(const candidate of invalid) {
      assert.equal(after({change:candidate}),before({change:candidate}));
      if(!before({change:candidate}))rejected++;
    }
  }
  // Exercise every body discriminator with fields from each other variant, not just op tags.
  for(const body of bodies)for(const other of bodies) {
    const candidate={...ops[0],body:{...body,...other,kind:body.kind}};
    assert.equal(after({change:candidate}),before({change:candidate}));
  }
  assert.ok(rejected>200);
  assert.equal(entityBody.safeParse({...bodies[0],level:0}).success,false);
  assert.equal(operation.safeParse({op:'advance_time',ticks:1001}).success,false);
});

test('ambiguous/missing/optional discriminator unions are rejected; enum groups and references are proven disjoint',()=>{
  for(const variants of [
    [branch(['same']),branch(['same'])],
    [branch(['a','b']),branch(['b','c'])],
    [branch(['a']),object({other:{type:'string'}})],
    [branch(['a']),{...branch(['b']),required:[]}],
    [{type:'string'},{type:'number'}],
  ])assert.throws(()=>compileStructuredSchema(object({value:{oneOf:variants}})),/gm_schema_ambiguous_union/);
  assert.doesNotThrow(()=>compileStructuredSchema({...object({value:{oneOf:[{$ref:'#/$defs/a'},{$ref:'#/$defs/b'}]}}),$defs:{a:branch(['a','b']),b:branch(['c'])}}));
  // A property named oneOf is data, not a JSON Schema keyword.
  const named=compileStructuredSchema(object({oneOf:{type:'string'}}));
  assert.ok(named.properties.oneOf);assert.deepEqual(named.required,['oneOf']);
});

test('preflight rejects unsupported constructs, open/optional objects, unresolved refs and size/depth violations',()=>{
  for(const keyword of ['oneOf','allOf','not','if','then','else','dependentSchemas','patternProperties','default','unknown']) {
    assert.throws(()=>assertStructuredSchema(object({nested:{type:'string',[keyword]:[]}})),/gm_schema_/);
  }
  for(const bad of [
    {anyOf:[object({}),object({})]},
    {...object({}),additionalProperties:true},
    {...object({a:{type:'string'}}),required:[]},
    object({ref:{$ref:'#/$defs/missing'}}),
    object({ref:{$ref:'https://example.invalid/schema'}}),
    object({a:{type:'array',items:false}}),
    object({a:{type:'string',enum:[1]}}),
    object({a:{type:'string',enum:Array.from({length:1001},(_,i)=>String(i))}}),
    object({a:{type:'string',enum:Array.from({length:251},(_,i)=>'x'.repeat(70)+i)}}),
    object(Object.fromEntries(Array.from({length:5001},(_,i)=>['p'+i,{type:'string'}]))),
    object({['x'.repeat(120001)]:{type:'string'}}),
    {...object({a:{$ref:'#/$defs/a'}}),$defs:{a:object({loop:{$ref:'#/$defs/a'}})}},
  ])assert.throws(()=>assertStructuredSchema(bad),/gm_schema_/);
  let deep={type:'string'};for(let i=0;i<11;i++)deep=object({a:deep});
  assert.throws(()=>assertStructuredSchema(deep),/depth_limit/);
});

test('an invalid outgoing schema stops before injected transport and before live fetch',async t=>{
  let calls=0;const gm=new OpenAiGm(config,async()=>{calls++;throw new Error('Must not send');});
  const request=gm.requestBody(context);
  gm.requestBody=()=>({...request,text:{format:{...request.text.format,schema:object({bad:{oneOf:[branch(['a']),branch(['b'])]}})}}});
  const reply=await gm.generate(context,signal());
  assert.equal(calls,0);assert.equal(reply.failure.code,'gm_schema_invalid');assert.equal(reply.usage.cost,0);
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('No network allowed');});
  const live=createLiveOpenAiGm(config,{OPENAI_API_KEY:'synthetic',LIFERPG_ALLOW_PAID_SYNTHETIC:'I_APPROVE_PAID_SYNTHETIC'});
  await assert.rejects(()=>live.transport(gm.requestBody(),signal()),/gm_schema_/);
});

test('HTTP error diagnostics allow only known categorical values and a provider request ID',async()=>{
  const response=new Response(JSON.stringify({error:{code:safe.code,param:safe.param,message:'sk-SYNTHETIC-KEY PRIVATE PROMPT 개인정보',extra:'private'},key:'secret'}),
    {status:400,headers:{'content-type':'application/json','x-request-id':requestId,'authorization':'secret'}});
  assert.deepEqual(await readSafeProviderError(response),safe);
  for(const bad of ['sk-secret','private@example.com','SYNTHETIC-PRIVATE','req_private_person','text.format.schema.PRIVATE'])
    assert.deepEqual(safeProviderError({code:bad,param:bad,request_id:bad}),{code:null,param:null,request_id:null});
  assert.deepEqual(safeProviderError({code:'brand_new_provider_code',param:'input[0].content',request_id:requestId}),{code:null,param:null,request_id:requestId});
  const reply=await new OpenAiGm(config,async()=>({status:400,body:{error:'PRIVATE'},diagnostic:{code:'PRIVATE',param:'SECRET',request_id:'sk-secret',message:'private'}})).generate(context,signal());
  assert.deepEqual(reply.failure.provider_error,{code:null,param:null,request_id:null});
  assert.ok(!JSON.stringify(reply).includes('PRIVATE'));
});

test('oversized, malformed, non-JSON, and broken error streams retain only safe header metadata',async()=>{
  const header={code:null,param:null,request_id:requestId};
  for(const [body,type] of [['not json','application/json'],['<html>SECRET</html>','text/html'],[JSON.stringify({error:{code:'invalid_json_schema',message:'x'.repeat(33000)}}),'application/json']]) {
    assert.deepEqual(await readSafeProviderError(new Response(body,{status:400,headers:{'content-type':type,'x-request-id':requestId}})),header);
  }
  let cancelled=false;
  const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(32769));},cancel(){cancelled=true;}});
  assert.deepEqual(await readSafeProviderError(new Response(stream,{status:400,headers:{'content-type':'application/json','x-request-id':requestId}})),header);
  assert.equal(cancelled,true);
  const broken=new ReadableStream({start(c){c.error(new Error('PRIVATE'));}});
  assert.deepEqual(await readSafeProviderError(new Response(broken,{status:400,headers:{'content-type':'application/json','x-request-id':requestId}})),header);
});

test('real transport with mocked fetch logs only safe diagnostics, preserves error classification and does not retry',async t=>{
  const logs=[],samples=[];let calls=0;
  t.mock.method(console,'warn',line=>logs.push(line));
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    calls++;assert.equal(init.headers.Authorization,'Bearer synthetic-secret-key');
    return new Response(JSON.stringify({error:{code:safe.code,param:safe.param,message:'synthetic-secret-key SYNTHETIC-PRIVATE'}}),{status:400,headers:{'content-type':'application/json','x-request-id':requestId}});
  });
  const gm=createLiveOpenAiGm(config,{OPENAI_API_KEY:'synthetic-secret-key',LIFERPG_ALLOW_PAID_SYNTHETIC:'I_APPROVE_PAID_SYNTHETIC'});
  const reply=await measureSyntheticGm(gm,s=>samples.push(s)).generate(context,signal());
  assert.equal(calls,1);assert.equal(reply.usage,undefined);assert.equal(reply.failure.retryable,false);
  assert.deepEqual(reply.failure.provider_error,safe);assert.deepEqual(samples[0].provider_error,safe);
  assert.deepEqual(JSON.parse(logs[0]),{type:'gm_provider_error',http_status:400,...safe});
  for(const secret of ['synthetic-secret-key','SYNTHETIC-PRIVATE'])assert.ok(!JSON.stringify({logs,samples,reply}).includes(secret));
  t.mock.method(console,'warn',()=>{throw new Error('logging unavailable');});
  assert.equal((await gm.generate(context,signal())).failure.code,'gm_provider_rejected');assert.equal(calls,2);
});
