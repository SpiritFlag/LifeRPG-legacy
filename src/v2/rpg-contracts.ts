import { z } from 'zod';

const text=z.string().min(1).max(1200),name=z.string().trim().min(1).max(80);
export const entityRef=z.string().regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@[a-z][a-z0-9_]{0,31})$/);
const version=z.number().int().min(0).max(1000000);
const number=z.number().int().min(-1000000).max(1000000);
const stat=z.strictObject({name,value:number});
const named={name,description:text};
export const definitionKinds=['profession','skill','trait','title','achievement','item','equipment'] as const;
export const entityBody=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('character'),...named,level:z.number().int().min(1).max(1000000),stats:z.array(stat).max(20),profession:entityRef.nullable(),location:entityRef.nullable()}),
  z.strictObject({kind:z.enum(definitionKinds),...named,effects:z.array(stat).max(12),slots:z.array(name).max(8)}),
  z.strictObject({kind:z.literal('quest'),...named,status:z.enum(['offered','active','completed','failed']),progress:z.number().int().min(0).max(1000000),target:z.number().int().min(1).max(1000000),location:entityRef.nullable()}),
  z.strictObject({kind:z.enum(['npc','place','faction']),...named,parent:entityRef.nullable()}),
  z.strictObject({kind:z.literal('relation'),...named,from:entityRef,to:entityRef,status:z.enum(['active','ended'])}),
  z.strictObject({kind:z.literal('world_event'),...named,status:z.enum(['planned','active','resolved','cancelled']),location:entityRef.nullable(),participants:z.array(entityRef).max(12)}),
]);
export const operation=z.discriminatedUnion('op',[
  z.strictObject({op:z.literal('put'),ref:entityRef,expected_version:version,body:entityBody,visibility:z.enum(['public','private']),private_notes:text.nullable()}),
  z.strictObject({op:z.literal('inventory'),ref:entityRef,expected_version:version,definition:entityRef,delta:z.number().int().min(-1000000).max(1000000)}),
  z.strictObject({op:z.literal('equip'),ref:entityRef,expected_version:version,slot:name.nullable()}),
  z.strictObject({op:z.literal('retire'),ref:entityRef,expected_version:version}),
  z.strictObject({op:z.literal('advance_time'),ticks:z.number().int().min(1).max(1000)}),
  z.strictObject({op:z.literal('resolve_reinterpretation'),decision_id:z.uuid()}),
]);
export const scene=z.strictObject({title:name,text,dialogue:z.array(z.strictObject({speaker:entityRef.nullable(),text})).max(5),choices:z.array(z.strictObject({label:name,action:z.string().min(1).max(500)})).max(5)});
export const rpgFields={
  operations:z.array(operation).max(32),
  reward_source:entityRef.nullable(),
  scene:scene.nullable(),
};
export type EntityBody=z.infer<typeof entityBody>;
export type Operation=z.infer<typeof operation>;
export type Scene=z.infer<typeof scene>;
