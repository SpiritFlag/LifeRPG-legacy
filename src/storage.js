import { randomUUID } from 'node:crypto';

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
  const key = event.event_key.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  const inserted = await db.query('INSERT INTO life_events(id,occurred_on,event_key,kind,summary,evidence) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (kind,occurred_on,event_key) DO NOTHING RETURNING *', [randomUUID(), event.occurred_on, key, event.kind, event.summary, event.evidence]);
  const row = inserted.rows[0] || (await db.query('SELECT * FROM life_events WHERE kind=$1 AND occurred_on=$2 AND event_key=$3', [event.kind, event.occurred_on, key])).rows[0];
  return { outcome: inserted.rows.length ? 'recorded' : 'duplicate', event: formatEvent(row) };
}
/** @param {any} row */
export function formatEvent(row) {
  return { ...row, occurred_on: typeof row.occurred_on === 'string' ? row.occurred_on : row.occurred_on.toISOString().slice(0,10) };
}
/** @param {import('./database.js').Queryable} db @param {number} limit @param {string | undefined} date @param {number} offset */
export async function listEvents(db, limit, date, offset = 0) {
  const rows = await db.query('SELECT * FROM life_events WHERE ($1::date IS NULL OR occurred_on=$1::date) ORDER BY recorded_at DESC,id DESC LIMIT $2 OFFSET $3', [date || null, limit + 1, offset]);
  return { events: rows.rows.slice(0,limit).map(formatEvent), next_offset: rows.rows.length > limit ? offset + limit : null };
}
