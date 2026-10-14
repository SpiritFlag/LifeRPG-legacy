import { createHash, randomUUID } from 'node:crypto';
import { normalizeEventKey, validEventTime } from './event-schema.js';

/** @param {import('./database.js').Queryable} db @param {string} kind @param {string} hash @param {object} payload @param {number} seconds */
export async function putGrant(db, kind, hash, payload, seconds) {
  await db.query('INSERT INTO oauth_grants(hash, kind, payload, expires_at) VALUES ($1,$2,$3,now() + $4 * interval \'1 second\')', [hash, kind, JSON.stringify(payload), seconds]);
}
/** @param {import('./database.js').Queryable} db @param {string} kind @param {string} hash @param {boolean} consume */
export async function getGrant(db, kind, hash, consume = false) {
  const sql = consume ? 'DELETE FROM oauth_grants WHERE hash=$1 AND kind=$2 AND expires_at>now() RETURNING payload' : 'SELECT payload FROM oauth_grants WHERE hash=$1 AND kind=$2 AND expires_at>now()';
  return (await db.query(sql, [hash, kind])).rows[0]?.payload;
}
/** @param {import('./database.js').Queryable} db @param {{id: string, calledAt: string, tool: string, args: object, outcome: string, result: object, eventId?: string}} call */
export async function audit(db, call) {
  await db.query('INSERT INTO tool_calls(id,called_at,tool,arguments,outcome,event_id,result) VALUES ($1,$2,$3,$4,$5,$6,$7)', [call.id, call.calledAt, call.tool, JSON.stringify(call.args), call.outcome, call.eventId || null, JSON.stringify(call.result)]);
}
/** @param {import('./database.js').Queryable} db @param {import('./tools.js').EventInput} event */
export async function recordEvent(db, event) {
  await lockEventWrites(db);
  return createEvent(db,{...event,kind:/** @type {'real'|'test'} */(event.kind),occurred_start:null,occurred_end:null,time_precision:'date',timezone:'Asia/Seoul',reported_at:null,facts:[],unknowns:[]},undefined,true);
}
/** @param {any} row */
export function formatEvent(row) {
  return { ...row, occurred_on: row.occurred_on == null ? null : typeof row.occurred_on === 'string' ? row.occurred_on : row.occurred_on.toISOString().slice(0,10) };
}
/** @param {import('./database.js').Queryable} db @param {number} limit @param {string | undefined} date @param {number} offset @param {string | undefined} key */
export async function listEvents(db, limit, date, offset = 0, key) {
  const rows = await db.query(`SELECT e.*,e.occurred_on::text AS occurred_on FROM life_events e WHERE
    ($1::date IS NULL OR e.occurred_on=$1 OR EXISTS (SELECT 1 FROM life_event_aliases a WHERE a.event_id=e.id AND a.occurred_on=$1 AND ($4::text IS NULL OR a.event_key=$4)))
    AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM life_event_aliases a WHERE a.event_id=e.id AND a.event_key=$4 AND ($1::date IS NULL OR a.occurred_on=$1)))
    ORDER BY e.recorded_at DESC,e.id DESC LIMIT $2 OFFSET $3`, [date || null, limit + 1, offset, key ? normalizeEventKey(key) : null]);
  return { events: rows.rows.slice(0,limit).map(formatEvent), next_offset: rows.rows.length > limit ? offset + limit : null };
}

export class EventConflict extends Error {
  /** @param {string} outcome @param {string} message @param {object} details */
  constructor(outcome,message,details = {}) { super(message); this.outcome=outcome; this.details=details; }
}

// One private owner, short write transactions. Transaction-scoped DB lock also
// serializes legacy and GM writes without process/session state.
/** @param {import('./database.js').Queryable} db */
export async function lockEventWrites(db) { await db.query('SELECT pg_advisory_xact_lock(1819436645)'); }

/** @param {any} value @returns {any} */
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k,canonical(value[k])]));
  return value;
}
/** @param {any} value */
export const serialized = value => JSON.stringify(canonical(value));

/** @param {import('./database.js').Queryable} db @param {any} event */
async function findIdentity(db,event) {
  return (await db.query(`SELECT e.*,e.occurred_on::text AS occurred_on FROM life_event_aliases a JOIN life_events e ON e.id=a.event_id
    WHERE a.kind=$1 AND a.occurred_on IS NOT DISTINCT FROM $2::date AND a.event_key=$3`,[event.kind,event.occurred_on,event.event_key])).rows[0];
}
/** @param {import('./database.js').Queryable} db @param {any} event */
async function reserveIdentity(db,event) {
  const existing = await findIdentity(db,event);
  if (existing && existing.id !== event.id) throw new EventConflict('identity_conflict','Identity is already reserved by another event',{event_id:existing.id});
  if (!existing) await db.query('INSERT INTO life_event_aliases(kind,occurred_on,event_key,event_id) VALUES ($1,$2,$3,$4)',[event.kind,event.occurred_on,event.event_key,event.id]);
}
/** @param {import('./database.js').Queryable} db @param {any} after @param {any} before @param {string} operation @param {any} report @param {string | undefined} requestKey */
async function appendRevision(db,after,before,operation,report,requestKey) {
  await db.query(`INSERT INTO life_event_revisions(event_id,version,operation,reason,evidence,reported_at,report_time_source,source_ref,before_state,after_state,request_key,recorded_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[after.id,after.version,operation,report.reason || 'First confirmed report',report.evidence,report.reported_at || null,report.reported_at ? 'message' : 'unknown',report.source_ref || null,before ? serialized(before) : null,serialized(formatEvent(after)),requestKey || null,after.updated_at]);
}
/** @param {import('./database.js').Queryable} db @param {import('./event-schema.js').CreateEventInput} input @param {string | undefined} requestKey @param {boolean} legacy */
async function createEvent(db,input,requestKey,legacy = false) {
  const event = {...input,event_key:normalizeEventKey(input.event_key)};
  if (!validEventTime(event)) throw new EventConflict('invalid_input','Event date, timezone and precision must agree');
  const existing = await findIdentity(db,event);
  if (existing) {
    // Legacy contract ignores changed wording. New writes require explicit enrichment.
    const compare = ['summary','facts','unknowns','occurred_start','occurred_end','time_precision','timezone'];
    if (!legacy && compare.some(k => serialized(canonical(existing[k])) !== serialized(canonical(/** @type {any} */(event)[k])))) {
      throw new EventConflict('identity_conflict','Existing event requires enrichment or correction',{event_id:existing.id,current_version:existing.version});
    }
    return {outcome:'duplicate',event:formatEvent(existing)};
  }
  const row = (await db.query(`INSERT INTO life_events(id,occurred_on,event_key,kind,summary,evidence,occurred_start,occurred_end,time_precision,timezone,reported_at,facts,unknowns,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()) RETURNING *,occurred_on::text AS occurred_on`,[randomUUID(),event.occurred_on,event.event_key,event.kind,event.summary,event.evidence,event.occurred_start,event.occurred_end,event.time_precision,event.timezone,event.reported_at,JSON.stringify(event.facts),JSON.stringify(event.unknowns)])).rows[0];
  await reserveIdentity(db,row);
  await appendRevision(db,row,null,'create',event,requestKey);
  return {outcome:'recorded',event:formatEvent(row)};
}

/** @param {import('./database.js').Queryable} db @param {import('./event-schema.js').UpdateEventsInput} input */
export async function updateEvents(db,input) {
  await lockEventWrites(db);
  const inputHash = createHash('sha256').update(serialized(input)).digest('hex');
  const prior = (await db.query('SELECT input_hash,result FROM life_event_requests WHERE request_key=$1',[input.request_key])).rows[0];
  if (prior) {
    if (prior.input_hash !== inputHash) throw new EventConflict('idempotency_conflict','Retry key was used with different input');
    return {...prior.result,outcome:'replayed'};
  }
  const results = [];
  const touched = new Set();
  for (const operation of input.operations) {
    if (operation.operation === 'create') {
      const result = await createEvent(db,operation.event,input.request_key);
      if (touched.has(result.event.id)) throw new EventConflict('invalid_input','Only one operation per event in a batch');
      touched.add(result.event.id);
      results.push(result);
      continue;
    }
    if (touched.has(operation.event_id)) throw new EventConflict('invalid_input','Only one operation per event in a batch');
    touched.add(operation.event_id);
    const row = (await db.query('SELECT *,occurred_on::text AS occurred_on FROM life_events WHERE id=$1 FOR UPDATE',[operation.event_id])).rows[0];
    if (!row) throw new EventConflict('not_found','Event does not exist',{event_id:operation.event_id});
    if (row.version !== operation.expected_version) throw new EventConflict('version_conflict','Read the latest event before changing it',{event_id:row.id,current_version:row.version});
    const before = canonical(formatEvent(row));
    const changes = {...operation.changes};
    if (changes.event_key) changes.event_key = normalizeEventKey(changes.event_key);
    if (operation.operation === 'enrich') {
      for (const key of ['kind','event_key','occurred_on','occurred_start','occurred_end','timezone']) {
        if (key in changes && before[key] != null && serialized(before[key]) !== serialized(/** @type {any} */(changes)[key])) {
          throw new EventConflict('correction_required','Use correct to replace a known identity or time',{field:key});
        }
      }
      if (changes.facts) changes.facts = [...new Set([...before.facts,...changes.facts])];
    }
    const next = {...before,...changes};
    if (next.facts.length > 20) throw new EventConflict('invalid_input','At most 20 current facts; consolidate with a correction');
    if (!validEventTime(next)) throw new EventConflict('invalid_input','Event date, timezone and precision must agree');
    if (serialized(next) === serialized(before)) { results.push({outcome:'unchanged',event:formatEvent(row)}); continue; }
    await reserveIdentity(db,next);
    const after = (await db.query(`UPDATE life_events SET occurred_on=$2,event_key=$3,kind=$4,summary=$5,evidence=$6,occurred_start=$7,occurred_end=$8,time_precision=$9,timezone=$10,facts=$11,unknowns=$12,version=version+1,updated_at=clock_timestamp()
      WHERE id=$1 RETURNING *,occurred_on::text AS occurred_on`,[row.id,next.occurred_on,next.event_key,next.kind,next.summary,operation.evidence,next.occurred_start,next.occurred_end,next.time_precision,next.timezone,JSON.stringify(next.facts),JSON.stringify(next.unknowns)])).rows[0];
    await appendRevision(db,after,before,operation.operation,operation,input.request_key);
    results.push({outcome:operation.operation === 'enrich' ? 'enriched' : 'corrected',event:formatEvent(after)});
  }
  const result = {outcome:'committed',request_key:input.request_key,results};
  await db.query('INSERT INTO life_event_requests(request_key,input_hash,result) VALUES ($1,$2,$3)',[input.request_key,inputHash,serialized(result)]);
  return result;
}

/** @param {import('./database.js').Queryable} db @param {zGetEventInput} input */
export async function getEvent(db,input) {
  // One statement provides a consistent snapshot of the event and its history.
  const row = (await db.query(`SELECT to_jsonb(e) AS event,
    (SELECT COALESCE(jsonb_agg(r ORDER BY r.version),'[]'::jsonb) FROM
      (SELECT * FROM life_event_revisions WHERE event_id=e.id AND version>$2 ORDER BY version LIMIT $3) r) AS revisions,
    (SELECT COALESCE(jsonb_agg(a ORDER BY a.occurred_on NULLS LAST,a.event_key),'[]'::jsonb) FROM life_event_aliases a WHERE a.event_id=e.id) AS aliases
    FROM life_events e WHERE id=$1`,[input.event_id,input.after_version,input.limit+1])).rows[0];
  if (!row) throw new EventConflict('not_found','Event does not exist',{event_id:input.event_id});
  const revisions = row.revisions.slice(0,input.limit);
  return {outcome:'ok',event:row.event,aliases:row.aliases,revisions,as_of_version:row.event.version,next_after_version:row.revisions.length > input.limit ? revisions.at(-1).version : null};
}
/** @typedef {import('zod').infer<typeof import('./event-schema.js').getEventSchema>} zGetEventInput */
