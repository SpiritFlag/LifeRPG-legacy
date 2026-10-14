import { z } from 'zod';
import { boundedSettings } from './content-schema.js';

// Fantasy biography is authored by the GM, never copied into life_events.
const profileFields={
  name:z.string().trim().min(1).max(100),
  species:z.string().trim().min(1).max(160),
  birth:z.string().trim().min(1).max(2000),
  background:z.string().trim().min(1).max(2000),
  destiny:z.string().trim().min(1).max(2000),
  narrative:boundedSettings,
  gm_notes:z.string().max(2000),
  gm_state:boundedSettings,
};
export const profileSchema=z.strictObject({...profileFields,narrative:boundedSettings.default({}),gm_notes:profileFields.gm_notes.default(''),gm_state:boundedSettings.default({})});
export const profileChangeSchema=z.strictObject({
  // Birth defaults must not clear omitted fields in subsequent partial edits.
  changes:z.strictObject(profileFields).partial().refine(v=>Object.keys(v).length>0),
  reason:z.string().trim().min(1).max(500),
});
export const initializationFields={
  initialization_id:z.uuid().transform(s=>s.toLowerCase()),
  expected_initialization_revision:z.number().int().min(1).max(2147483647),
};
export const startingLocationSchema=z.union([z.uuid().transform(s=>s.toLowerCase()),z.string().regex(/^@[a-z][a-z0-9_-]{0,39}$/)]);
