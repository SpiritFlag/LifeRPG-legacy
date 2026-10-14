import { z } from 'zod';
import { normalizeEventKey } from './event-schema.js';
import { questContextSchema,questOperations } from './quest-schema.js';
import { contentContextFields,contentOperations } from './content-schema.js';
import { worldContextFields,worldOperations } from './world-schema.js';
import { profileSchema,profileChangeSchema,initializationFields,startingLocationSchema } from './initialization-schema.js';

export const STAT_KEYS = /** @type {const} */ (['STR','DEX','VIT','INT','CHA','LUK']);
const nonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const delta = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const statsFields = {STR:nonnegative,DEX:nonnegative,VIT:nonnegative,INT:nonnegative,CHA:nonnegative,LUK:nonnegative};
const deltaFields = {STR:delta.default(0),DEX:delta.default(0),VIT:delta.default(0),INT:delta.default(0),CHA:delta.default(0),LUK:delta.default(0)};
export const statsSchema = z.strictObject(statsFields);
export const statsDeltaSchema = z.strictObject(deltaFields);
const stableKey = z.string().trim().min(1).max(160).transform(normalizeEventKey).refine(s => s.length > 0 && s.length <= 160);
const reason = z.string().trim().min(1).max(500);
const uuid = z.uuid().transform(s => s.toLowerCase());
export const subjectSchema = z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('event'),event_id:uuid}),
  z.strictObject({type:z.literal('event_group'),key:stableKey}),
]);
export const adjudicationSchema = z.strictObject({
  subject:subjectSchema,
  aspect_key:stableKey.default('base'),
  sources:z.array(z.strictObject({event_id:uuid,event_version:z.number().int().min(1).max(2147483647)})).min(1).max(20),
  previous_id:uuid.nullable().default(null),
  correction_of:uuid.nullable().default(null),
  reason,
  xp_delta:delta.default(0),
  stats_delta:statsDeltaSchema.default({STR:0,DEX:0,VIT:0,INT:0,CHA:0,LUK:0}),
});
const requestFields={request_key:z.string().trim().min(1).max(160),reason};
export const birthSourceSchema=z.strictObject({event_id:uuid,event_version:z.number().int().min(1).max(2147483647),reason});
const preparationFields={quest_changes:questOperations.optional(),content_changes:contentOperations.optional(),world_changes:worldOperations.optional(),birth_sources:z.array(birthSourceSchema).min(1).max(20).optional()};
/** @param {any} value */
const boundedPreparation=value=>(value.quest_changes?.length || 0)+(value.content_changes?.length || 0)+(value.world_changes?.length || 0)+(value.birth_sources?.length || 0)<=100;
export const applyGmSchema = z.discriminatedUnion('mode',[
  z.strictObject({mode:z.literal('initialize'),request_key:z.string().trim().min(1).max(160),expected_revision:z.literal(0),reason,synthetic:z.literal(true),character:z.strictObject({label:z.string().trim().min(1).max(100),xp_total:nonnegative,stats:statsSchema})}),
  z.strictObject({mode:z.literal('begin_initialization'),...requestFields,expected_revision:z.literal(0),synthetic:z.boolean().default(false),character:z.strictObject({profile:profileSchema,xp_total:nonnegative,stats:statsSchema}),starting_location:startingLocationSchema,...preparationFields}).refine(boundedPreparation,'Provide at most 100 operations per chunk'),
  z.strictObject({mode:z.literal('prepare_initialization'),...requestFields,...initializationFields,...preparationFields}).refine(v=>!!(v.quest_changes || v.content_changes || v.world_changes || v.birth_sources),'Provide authored data').refine(boundedPreparation,'Provide at most 100 operations per chunk'),
  z.strictObject({mode:z.literal('finalize_initialization'),...requestFields,...initializationFields}),
  z.strictObject({mode:z.literal('cancel_initialization'),...requestFields,...initializationFields}),
  z.strictObject({mode:z.literal('advance'),request_key:z.string().trim().min(1).max(160),expected_revision:z.number().int().min(1).max(2147483647),reason,adjudications:z.array(adjudicationSchema).max(10).optional(),quest_changes:questOperations.optional(),content_changes:contentOperations.optional(),world_changes:worldOperations.optional(),character_change:profileChangeSchema.optional()}).refine(v=>{const n=(v.adjudications?.length || 0)+(v.quest_changes?.length || 0)+(v.content_changes?.length || 0)+(v.world_changes?.length || 0)+(v.character_change ? 1 : 0);return n>0 && n<=100;},'Provide 1 to 100 total operations'),
]);
export const contextSchema = questContextSchema.extend(contentContextFields).extend(worldContextFields).extend({include_birth:z.boolean().default(false),include_character_history:z.boolean().default(false),after_character_change_sequence:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)});
export const listAdjudicationsSchema = z.strictObject({event_id:uuid.optional(),subject:subjectSchema.optional(),aspect_key:stableKey.optional(),after_sequence:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),limit:z.number().int().min(1).max(50).default(20)});
export const getGmUpdateSchema = z.strictObject({update_id:uuid.optional(),request_key:z.string().trim().min(1).max(160).optional(),view:z.enum(['gm','player']).default('gm')}).refine(v => Number(!!v.update_id)+Number(!!v.request_key) === 1,'Choose update_id or request_key');
/** @typedef {z.infer<typeof applyGmSchema>} ApplyGmInput */
/** @typedef {z.infer<typeof adjudicationSchema>} AdjudicationInput */
/** @typedef {z.infer<typeof listAdjudicationsSchema>} ListAdjudicationsInput */
/** @typedef {z.infer<typeof statsSchema>} Stats */

/** Exact integer thresholds, including near the JSON safe-integer boundary.
 * @param {number} xp */
export function growthFromXp(xp) {
  if (!Number.isSafeInteger(xp) || xp < 0) throw new RangeError('XP must be a nonnegative safe integer');
  const total = BigInt(xp);
  const threshold = (/** @type {bigint} */ level) => 50n*level*(level-1n);
  let low=1n,high=2n;
  while (threshold(high) <= total) high*=2n;
  while (high-low > 1n) {const middle=(low+high)/2n;if (threshold(middle) <= total) low=middle;else high=middle;}
  return {level:Number(low),xp_in_level:Number(total-threshold(low)),xp_for_next_level:Number(100n*low),xp_to_next_level:Number(threshold(low+1n)-total)};
}
