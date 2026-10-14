import { z } from 'zod';

export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0,10) === s;
}, 'Use an actual calendar date');
export const eventKey = z.string().trim().min(1).max(160);
const timestamp = z.iso.datetime({offset:true}).transform(s => new Date(s).toISOString());
const timezone = z.string().min(1).max(80).refine(s => {
  try { new Intl.DateTimeFormat('en',{timeZone:s}); return true; } catch { return false; }
}, 'Use an IANA timezone');
const factList = z.array(z.string().trim().min(1).max(300)).max(20);
const timeFields = {
  occurred_on:calendarDate.nullable(),
  occurred_start:timestamp.nullable(),
  occurred_end:timestamp.nullable(),
  time_precision:z.enum(['unknown','date','exact','range']),
  timezone:timezone.nullable(),
};
const contentFields = {
  event_key:eventKey,
  kind:z.enum(['real','test']),
  summary:z.string().trim().min(1).max(300),
  facts:factList,
  unknowns:factList,
};
const reportFields = {
  evidence:z.string().trim().min(1).max(500),
  reported_at:timestamp.nullable().default(null).describe('Actual message report time, only if supplied by the conversation. Unknown is null; never substitute event or server time.'),
  source_ref:z.string().trim().min(1).max(200).optional().describe('Optional conversation/message reference only when actually available; not event identity.'),
};
export const createEventSchema = z.strictObject({
  ...contentFields,...timeFields,...reportFields,
  facts:factList.default([]),unknowns:factList.default([]),
  occurred_start:timestamp.nullable().default(null),occurred_end:timestamp.nullable().default(null),
  time_precision:timeFields.time_precision.optional(),timezone:timezone.nullable().default('Asia/Seoul'),
}).transform(e => ({...e,time_precision:e.time_precision ?? (e.occurred_on === null ? 'unknown' : 'date')}));
export const eventPatchSchema = z.strictObject({...contentFields,...timeFields}).partial().refine(p => Object.keys(p).length > 0,'Provide changed facts');
export const updateEventsSchema = z.strictObject({
  request_key:z.string().trim().min(1).max(160).describe('Stable retry key. Reuse with identical input after response loss.'),
  operations:z.array(z.discriminatedUnion('operation',[
    z.strictObject({operation:z.literal('create'),event:createEventSchema}),
    z.strictObject({operation:z.enum(['enrich','correct']),event_id:z.uuid(),expected_version:z.number().int().min(1),reason:z.string().trim().min(1).max(300),changes:eventPatchSchema,...reportFields}),
  ])).min(1).max(10),
});
export const getEventSchema = z.strictObject({event_id:z.uuid(),after_version:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(50).default(20)});
/** @typedef {z.infer<typeof createEventSchema>} CreateEventInput */
/** @typedef {z.infer<typeof updateEventsSchema>} UpdateEventsInput */

/** @param {string} key */
export const normalizeEventKey = key => key.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();

/** @param {any} event */
export function validEventTime(event) {
  const {occurred_on:day,occurred_start:start,occurred_end:end,time_precision:precision,timezone:zone} = event;
  if (precision === 'unknown') return day === null && start === null && end === null;
  if (!day || !zone) return false;
  if (precision === 'date') return start === null && end === null;
  if (!start || (precision === 'exact' ? end !== null : !end || Date.parse(start) > Date.parse(end))) return false;
  const parts = new Intl.DateTimeFormat('en',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(start));
  const part = (/** @type {string} */ name) => parts.find(p => p.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}` === day;
}
