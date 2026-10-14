import { z } from 'zod';
import { normalizeEventKey } from './event-schema.js';
import { boundedSettings } from './content-schema.js';

const uuid=z.uuid().transform(s=>s.toLowerCase()),temporary=z.string().regex(/^@[a-z][a-z0-9_-]{0,39}$/),ref=z.union([uuid,temporary]);
const key=z.string().trim().min(1).max(160).transform(normalizeEventKey).refine(s=>s.length>0 && s.length<=160);
const reason=z.string().trim().min(1).max(500),short=z.string().trim().min(1).max(80);
const visibility=z.enum(['player','gm']);
export const worldTimeSchema=z.strictObject({label:z.string().trim().min(1).max(160),order:z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable().default(null)}).nullable();
const shared={visibility,gm_notes:z.string().max(2000),gm_state:boundedSettings};
const sharedDefaults={visibility:visibility.default('player'),gm_notes:shared.gm_notes.default(''),gm_state:boundedSettings.default({})};
const entityFields={name:z.string().trim().min(1).max(160),kind:short,description:z.string().max(2000),status:z.string().max(160),state:boundedSettings,active:z.boolean(),parent:ref.nullable(),location:ref.nullable(),affiliation:ref.nullable(),...shared};
const endpoint=z.discriminatedUnion('type',[z.strictObject({type:z.literal('entity'),id:ref}),z.strictObject({type:z.literal('character')})]);
export const worldLinkSchema=z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('entity'),id:ref}),z.strictObject({type:z.literal('world_fact'),id:ref}),
  z.strictObject({type:z.literal('questline'),id:ref}),z.strictObject({type:z.literal('event'),event_id:uuid,event_version:z.number().int().min(1).max(2147483647)}),
]);
const links=z.array(worldLinkSchema).max(20);
const relationFields={kind:short,description:z.string().max(2000),state:boundedSettings,active:z.boolean(),...shared};
const factFields={title:z.string().trim().min(1).max(160),body:z.string().max(2000),kind:z.enum(['event','history','setting','foreshadowing']),truth:z.enum(['canon','claim','belief']),speaker:ref.nullable(),world_time:worldTimeSchema,links,...shared};
const memoryFields={title:factFields.title,body:factFields.body,kind:short,active:z.boolean(),links,...shared};
const journalFields={title:factFields.title,body:factFields.body,world_time:worldTimeSchema,links,...shared};
/** @template {import('zod').ZodRawShape} T @param {T} fields */
const patch=fields=>z.strictObject(fields).partial().refine(v=>Object.keys(v).length>0);
export const worldOperations=z.array(z.discriminatedUnion('operation',[
  z.strictObject({operation:z.literal('create_entity'),ref:temporary,entity_key:key,category:z.enum(['world','place','faction','npc']),reason,...entityFields,...sharedDefaults,description:entityFields.description.default(''),status:entityFields.status.default(''),state:boundedSettings.default({}),active:z.boolean().default(true),parent:ref.nullable().default(null),location:ref.nullable().default(null),affiliation:ref.nullable().default(null)}),
  z.strictObject({operation:z.literal('update_entity'),entity:ref,changes:patch(entityFields),reason}),
  z.strictObject({operation:z.literal('create_relation'),ref:temporary,relation_key:key,from:endpoint,to:endpoint,reason,...relationFields,...sharedDefaults,description:relationFields.description.default(''),state:boundedSettings.default({}),active:z.boolean().default(true)}),
  z.strictObject({operation:z.literal('update_relation'),relation:ref,changes:patch(relationFields),reason}),
  z.strictObject({operation:z.literal('create_fact'),ref:temporary,fact_key:key,reason,...factFields,...sharedDefaults,truth:factFields.truth.default('canon'),speaker:ref.nullable().default(null),world_time:worldTimeSchema.default(null),links:links.default([])}),
  z.strictObject({operation:z.literal('update_fact'),fact:ref,changes:patch(factFields),reason}),
  z.strictObject({operation:z.literal('create_memory'),ref:temporary,memory_key:key,reason,...memoryFields,...sharedDefaults,visibility:visibility.default('gm'),kind:short.default('continuity'),active:z.boolean().default(true),links:links.default([])}),
  z.strictObject({operation:z.literal('update_memory'),memory:ref,changes:patch(memoryFields),reason}),
  z.strictObject({operation:z.literal('create_journal'),ref:temporary,journal_key:key,reason,...journalFields,...sharedDefaults,world_time:worldTimeSchema.default(null),links:links.default([])}),
  z.strictObject({operation:z.literal('update_journal'),journal:ref,changes:patch(journalFields),reason}),
  z.strictObject({operation:z.literal('advance_world'),world_time:worldTimeSchema,reason}),
])).min(1).max(40);
const cursor=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);
export const worldContextFields={
  view:z.enum(['gm','player']).default('gm'),world_entity_id:uuid.optional(),world_fact_id:uuid.optional(),memory_id:uuid.optional(),journal_id:uuid.optional(),
  world_query:z.string().trim().min(1).max(100).optional(),memory_active:z.boolean().default(true),
  world_limit:z.number().int().min(1).max(50).default(20),after_world_entity_sequence:cursor,after_world_relation_sequence:cursor,after_world_fact_sequence:cursor,after_memory_sequence:cursor,after_journal_sequence:cursor,
  include_world_history:z.boolean().default(false),after_world_change_sequence:cursor,include_chronicle:z.boolean().default(false),chronicle_order:z.enum(['recorded','occurred','world']).default('recorded'),after_chronicle:z.string().max(1000).optional(),
};
/** @typedef {z.infer<typeof worldOperations>[number]} WorldOperation */
