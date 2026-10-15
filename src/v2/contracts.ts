import { z } from 'zod';
import { rpgFields } from './rpg-contracts.ts';

const uuid = z.uuid();
const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const summary = z.string().trim().min(1).max(1000);
const date = z.iso.date().nullable().optional();
const timezone = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}).default('Asia/Seoul');
const unknowns = z.array(z.string().trim().min(1).max(200)).max(5).default([]);
export const observation = z.strictObject({
  request_id: requestId, summary, occurred_on: date, timezone, unknowns, event_id: uuid.optional(), confirmed_new_report:z.boolean().default(false),
});
export const interaction = z.strictObject({
  request_id: requestId, kind: z.enum(['start','action','answer','appeal']),
  message: z.string().trim().min(1).max(2000), question_id: uuid.optional(), decision_id: uuid.optional(),
}).superRefine((v,ctx) => {
  if ((v.kind === 'answer') !== !!v.question_id || (v.kind === 'appeal') !== !!v.decision_id)
    ctx.addIssue({code:'custom',message:'Answer requires question_id; appeal requires decision_id; other kinds accept neither.'});
});
export const revision = z.strictObject({request_id:requestId,event_id:uuid,expected_version:z.number().int().positive(),summary,occurred_on:date,timezone,unknowns});
export const deletion = z.strictObject({request_id:requestId,event_ids:z.array(uuid).min(1).max(20).refine(ids=>new Set(ids).size===ids.length)});
export const read = z.strictObject({
  view:z.enum(['status','request','records','game','usage']), operation_id:uuid.optional(),
  query:z.string().max(200).optional(), cursor:uuid.optional(), limit:z.number().int().min(1).max(50).default(20),
}).refine(v=>(v.view==='request')===!!v.operation_id,'request view requires operation_id');

export const proposal = z.strictObject({
  outcome:z.enum(['commit','clarify','no_change']), summary:z.string().min(1).max(2000),
  xp_delta:z.number().int().min(-1000).max(1000).default(0),
  question:z.string().min(1).max(500).optional(),
  memories:z.array(z.strictObject({kind:z.enum(['identity','episode','reflection','summary','world']),text:z.string().min(1).max(2000)})).max(5).default([]),
  operations:rpgFields.operations.default([]),reward_source:rpgFields.reward_source.default(null),scene:rpgFields.scene.default(null),
}).refine(v=>v.outcome==='clarify' ? !!v.question && v.xp_delta===0 && !v.memories.length : !v.question)
  .refine(v=>v.outcome!=='no_change' || (v.xp_delta===0 && !v.memories.length))
  .refine(v=>v.outcome==='commit'||(!v.operations.length&&!v.reward_source&&!v.scene));

export const V2_SCOPES = ['life.read','life.write','life.delete','game.read','game.play','usage.read','offline_access'];
export type Identity = {subject:string;scopes:string[]};
export type Proposal = z.infer<typeof proposal>;
export class DomainError extends Error {
  code: string;
  constructor(code:string) { super(code); this.code=code; }
}
