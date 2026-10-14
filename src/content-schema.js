import { z } from 'zod';
import { normalizeEventKey } from './event-schema.js';

const uuid=z.uuid().transform(s=>s.toLowerCase());
const temp=z.string().regex(/^@[a-z][a-z0-9_-]{0,39}$/);
const ref=z.union([uuid,temp]);
const key=z.string().trim().min(1).max(160).transform(normalizeEventKey).refine(s=>s.length>0 && s.length<=160);
const reason=z.string().trim().min(1).max(500);
const positive=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegative=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const delta=z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const version=z.number().int().min(1).max(2147483647);
export const definitionKind=z.enum(['profession','skill','trait','equipment','item','title','achievement']);
export const modifiersSchema=z.strictObject({STR:delta.default(0),DEX:delta.default(0),VIT:delta.default(0),INT:delta.default(0),CHA:delta.default(0),LUK:delta.default(0)});
const zero={STR:0,DEX:0,VIT:0,INT:0,CHA:0,LUK:0};
const settings=z.record(z.string().min(1).max(80),z.json()).superRefine((value,ctx)=>{
  if (Buffer.byteLength(JSON.stringify(value),'utf8')>4096) ctx.addIssue({code:'custom',message:'Settings must fit in 4096 bytes'});
  /** @param {any} item @param {number} depth @returns {boolean} */
  function bounded(item,depth) {
    if (depth>4) return false;
    if (typeof item==='string') return item.length<=1000;
    if (typeof item==='number') return Number.isFinite(item) && Math.abs(item)<=Number.MAX_SAFE_INTEGER;
    if (item && typeof item==='object') return Object.keys(item).length<=30 && Object.entries(item).every(([k,v])=>k.length<=80 && bounded(v,depth+1));
    return true;
  }
  if (!bounded(value,0)) ctx.addIssue({code:'custom',message:'Settings exceed bounded JSON depth/size'});
});
export const boundedSettings=settings;
const definitionFields={name:z.string().trim().min(1).max(160),description:z.string().max(1000),settings,stat_modifiers:modifiersSchema};
const definitionPatch=z.strictObject(definitionFields).partial().refine(v=>Object.keys(v).length>0);
const featureFields={mastery:nonnegative,grade:z.string().max(80),state:settings};
const featurePatch=z.strictObject({...featureFields,definition_version:version}).partial().refine(v=>Object.keys(v).length>0);
const inventoryFields={grade:z.string().max(80),state:settings,durability:nonnegative.nullable(),max_durability:nonnegative.nullable()};
const inventoryPatch=z.strictObject({...inventoryFields,definition_version:version}).partial().refine(v=>Object.keys(v).length>0);
const acquisition={ref:temp,acquisition_key:key,definition:ref,definition_version:version,reason};
export const contentOperations=z.array(z.discriminatedUnion('operation',[
  z.strictObject({operation:z.literal('create_definition'),ref:temp,definition_key:key,kind:definitionKind,reason,...definitionFields,description:definitionFields.description.default(''),settings:settings.default({}),stat_modifiers:modifiersSchema.default(zero)}),
  z.strictObject({operation:z.literal('revise_definition'),definition:ref,expected_version:version,changes:definitionPatch,reason}),
  z.strictObject({operation:z.enum(['grant_feature','change_profession']),...acquisition,mastery:nonnegative.default(0),grade:featureFields.grade.default(''),state:settings.default({})}),
  z.strictObject({operation:z.literal('update_feature'),feature:ref,changes:featurePatch,reason}),
  z.strictObject({operation:z.literal('lose_feature'),feature:ref,reason}),
  z.strictObject({operation:z.literal('grant_inventory'),...acquisition,mode:z.enum(['individual','stack']),quantity:positive.default(1),grade:inventoryFields.grade.default(''),state:settings.default({}),durability:nonnegative.nullable().default(null),max_durability:nonnegative.nullable().default(null)}),
  z.strictObject({operation:z.literal('adjust_quantity'),entry:ref,quantity_delta:delta,reason}),
  z.strictObject({operation:z.literal('update_inventory'),entry:ref,changes:inventoryPatch,reason}),
  z.strictObject({operation:z.literal('equip'),entry:ref,slot:z.string().trim().min(1).max(80).transform(normalizeEventKey).refine(s=>s.length>0 && s.length<=80),reason}),
  z.strictObject({operation:z.enum(['unequip','lose_inventory']),entry:ref,reason}),
])).min(1).max(40);
const cursor=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);
export const contentContextFields={
  definition_id:uuid.optional(),feature_id:uuid.optional(),inventory_id:uuid.optional(),definition_kinds:z.array(definitionKind).min(1).max(7).optional(),
  feature_statuses:z.array(z.enum(['active','lost','ended'])).min(1).max(3).optional(),inventory_statuses:z.array(z.enum(['owned','lost'])).min(1).max(2).optional(),
  content_limit:z.number().int().min(1).max(50).default(20),after_definition_sequence:cursor,after_feature_sequence:cursor,after_inventory_sequence:cursor,
  after_definition_version:cursor,include_content_history:z.boolean().default(false),after_content_change_sequence:cursor,
};
/** @typedef {z.infer<typeof contentOperations>[number]} ContentOperation */
