import { z } from 'zod';
import { normalizeEventKey } from './event-schema.js';

export const questStatus = z.enum(['available','active','paused','completed','failed','abandoned']);
const uuid=z.uuid().transform(s=>s.toLowerCase());
const temporary=z.string().regex(/^@[a-z][a-z0-9_-]{0,39}$/);
const reference=z.union([uuid,temporary]);
const key=z.string().trim().min(1).max(160).transform(normalizeEventKey).refine(s=>s.length>0 && s.length<=160);
const reason=z.string().trim().min(1).max(500);
// Optional without defaults: preserve hashes of previously saved retry inputs.
const taskFields={real_task:z.string().trim().max(500).optional().describe('Actual task in the user’s words; preserve separately from fantasy prose.'),recurrence:z.string().trim().min(1).max(500).nullable().optional().describe('Only the user’s explicitly requested repeat condition. null/omitted means one-time.')};
const consent={user_consent:z.literal(true).optional().describe('Set only after the user agrees to register this task or change its task/repeat condition.')};
const fields={title:z.string().trim().min(1).max(160),description:z.string().max(1000),goal:z.string().max(500),progress:z.string().max(1000),ending:z.string().max(1000),status:questStatus,...taskFields};
const createFields={...fields,description:fields.description.default(''),goal:fields.goal.default(''),progress:fields.progress.default(''),ending:fields.ending.default(''),status:z.enum(['available','active']).default('available')};
const patch=z.strictObject(fields).partial().refine(v=>Object.keys(v).length>0);
const updateFields={reason,...consent,reopen:z.boolean().default(false),retain_children:z.array(reference).max(100).default([]),changes:patch};
export const questOperationSchema=z.discriminatedUnion('operation',[
  z.strictObject({operation:z.literal('create_line'),ref:temporary,line_key:key,reason,...consent,...createFields}),
  z.strictObject({operation:z.literal('create_node'),ref:temporary,questline:reference,parent:reference.optional(),node_key:key,kind:z.enum(['chapter','quest']),reason,...consent,...createFields}),
  z.strictObject({operation:z.literal('update_line'),questline:reference,...updateFields}),
  z.strictObject({operation:z.literal('update_node'),node:reference,...updateFields}),
  z.strictObject({operation:z.literal('link_nodes'),from:reference,to:reference,kind:z.enum(['prerequisite','branch']),label:z.string().max(500).default(''),active:z.boolean().default(true),reason}),
  z.strictObject({operation:z.literal('link_lines'),from:reference,to:reference,label:z.string().max(500).default(''),active:z.boolean().default(true),reason}),
  z.strictObject({operation:z.literal('link_event'),questline:reference,node:reference.optional(),event_id:uuid,event_version:z.number().int().min(1).max(2147483647),label:z.string().max(500).default(''),active:z.boolean().default(true),reason}),
]);
export const questOperations=z.array(questOperationSchema).min(1).max(40);
const cursor=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);
export const questContextSchema=z.strictObject({
  questline_id:uuid.optional(),event_id:uuid.optional(),
  quest_statuses:z.array(questStatus).min(1).max(6).optional(),quest_limit:z.number().int().min(1).max(50).default(20),after_quest_sequence:cursor,
  node_limit:z.number().int().min(1).max(50).default(20),after_node_sequence:cursor,
  link_limit:z.number().int().min(1).max(50).default(20),after_node_link_sequence:cursor,after_line_link_sequence:cursor,after_event_link_sequence:cursor,
  history_limit:z.number().int().min(1).max(50).default(20),after_quest_change_sequence:cursor,
});
/** @typedef {z.infer<typeof questOperationSchema>} QuestOperation */
/** @typedef {z.infer<typeof questContextSchema>} QuestContextInput */
