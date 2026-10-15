import { z } from 'zod';
import { entityRef } from './rpg-contracts.ts';

export const memoryFields={
  kind:z.enum(['identity','episode','reflection','summary','world']),text:z.string().min(1).max(2000),
  claim_type:z.enum(['interpretation','canon','npc_claim','mixed']),
  importance:z.number().int().min(0).max(3),unresolved:z.boolean(),
  entity_ids:z.array(entityRef).max(8),source_memory_ids:z.array(z.uuid()).max(8),
  replaces_memory_id:z.uuid().nullable(),
  reason:z.string().min(1).max(400).nullable(),
};
export const wireMemory=z.strictObject(memoryFields);
// Old internal adapters remain readable; the provider wire requires explicit epistemic labels.
export const memoryProposal=z.strictObject({...memoryFields,claim_type:memoryFields.claim_type.default('interpretation'),
  importance:memoryFields.importance.default(1),unresolved:memoryFields.unresolved.default(false),
  entity_ids:memoryFields.entity_ids.default([]),source_memory_ids:memoryFields.source_memory_ids.default([]),reason:memoryFields.reason.default(null),replaces_memory_id:memoryFields.replaces_memory_id.default(null)});
export type MemoryProposal=z.infer<typeof memoryProposal>;
