import { z } from "zod";
import { contextSchema } from "./growth-schema.js";
import { getGameContext } from "./growth-storage.js";
import { publicWorldState } from "./world-storage.js";

// No client-selectable owner, GM view, GM memories, receipts, or mutation path.
export const playerQuerySchema = contextSchema
  .omit({
    view: true,
    memory_id: true,
    memory_active: true,
    after_memory_sequence: true,
    include_world_history: true,
    after_world_change_sequence: true,
  })
  .extend({
    dashboard: z.boolean().default(false),
    after_growth_sequence: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
  });

/** @param {any} row @param {string} fields */
const pick = (row, fields) =>
  row
    ? Object.fromEntries(
        fields
          .split(" ")
          .filter((k) => k in row)
          .map((k) => [k, row[k]]),
      )
    : null;
/** Defense in depth for reserved private fields inside free-form public settings.
 * @param {any} value @returns {any} */
function publicJson(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(publicJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !key.startsWith("gm_") &&
            !["reason", "acquisition_hash", "request_hash"].includes(key),
        )
        .map(([k, v]) => [k, publicJson(v)]),
    );
  return value;
}
/** @param {any} value */
const definition = (value) =>
  pick(
    value,
    "definition_id version kind name description settings stat_modifiers summary_truncated",
  );
/** @param {any} row */
const possession = (row) =>
  row
    ? {
        ...pick(
          row,
          "id sequence kind status mastery grade state quantity slot durability max_durability acquired_at ended_at definition_version state_omitted",
        ),
        ...(row.definition ? { definition: definition(row.definition) } : {}),
      }
    : null;
/** @param {any} row */
const quest = (row) =>
  pick(
    row,
    "id sequence title description goal progress ending status kind parent_id questline_id real_task recurrence summary_truncated",
  );
/** @param {any} page @param {(row:any)=>any} map */
const page = (page, map) => ({
  items: (page?.items || []).map(map),
  next_after_sequence: page?.next_after_sequence ?? null,
});
/** @param {any} row @param {(row:any)=>any} snapshot */
const history = (row, snapshot) => ({
  ...pick(row, "sequence target_type target_id recorded_at"),
  before_state: snapshot(row.before_state),
  after_state: snapshot(row.after_state),
});

/** Explicit public response. The world has already passed Phase 3C visibility/reference checks.
 * @param {any} raw */
export function projectPlayer(raw) {
  if (!raw.initialized) return { initialized: false, initialization: pick(raw.initialization,'status kind') };
  const c = raw.content,
    w = raw.world;
  return publicJson({
    ...pick(
      raw,
      "initialized revision kind rules_version character character_profile character_history birth initialization base_stats stat_modifiers display_stats equipment_modifiers feature_modifiers",
    ),
    ...(raw.dashboard
      ? {
          dashboard: {
            equipment: raw.dashboard.equipment.map(possession),
            skills: raw.dashboard.skills.map(possession),
            titles: raw.dashboard.titles.map(possession),
            rewards: raw.dashboard.rewards.map(possession),
            news: raw.dashboard.news,
            questlines: raw.dashboard.questlines.map(quest),
          },
        }
      : {}),
    recent_adjudications: raw.recent_adjudications.map((/** @type {any} */ r) =>
      pick(r, "id sequence xp_delta stats_delta recorded_at"),
    ),
    growth: raw.growth,
    questlines: raw.questlines.map(quest),
    next_after_quest_sequence: raw.next_after_quest_sequence,
    ...(raw.questline
      ? {
          questline: quest(raw.questline),
          nodes: page(raw.nodes, quest),
          node_links: page(raw.node_links, (r) =>
            pick(r, "id from_id to_id kind label active"),
          ),
          line_links: page(raw.line_links, (r) =>
            pick(r, "id from_id to_id label active"),
          ),
          event_links: page(raw.event_links, (r) =>
            pick(r, "id event_id event_version node_id label active"),
          ),
          history: page(raw.history, (r) =>
            history(
              r,
              r.target_type.endsWith("link")
                ? (value) => pick(value, "label active")
                : quest,
            ),
          ),
        }
      : {}),
    content: {
      current_profession: possession(c.current_profession),
      features: page(c.features, possession),
      inventory: page(c.inventory, possession),
      ...(c.history
        ? {
            history: page(c.history, (r) =>
              history(
                r,
                r.target_type === "definition" ? definition : possession,
              ),
            ),
          }
        : {}),
    },
    world: {
      entities: w.entities,
      relations: w.relations,
      facts: w.facts,
      journals: w.journals,
      clock: pick(w.clock, "world_time last_world_advanced_at"),
      ...(w.chronicle
        ? {
            chronicle: {
              ...w.chronicle,
              items: w.chronicle.items.map((/** @type {any} */ r) =>
                r.type === "life_event"
                  ? {
                      ...r,
                      value: pick(
                        r.value,
                        "id summary occurred_on occurred_start occurred_end time_precision timezone",
                      ),
                    }
                  : r,
              ),
            },
          }
        : {}),
    },
  });
}

/** @param {import('./database.js').Database} db @param {string} owner @param {z.infer<typeof playerQuerySchema>} input */
export async function readPlayer(db, owner, input) {
  return db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION READ ONLY");
    const { after_growth_sequence, dashboard, ...query } = input;
    const raw = await getGameContext(
      tx,
      owner,
      contextSchema.parse({ ...query, view: "player" }),
    );
    if (!raw.initialized || !("game_id" in raw)) return projectPlayer(raw);
    if (
      input.world_entity_id &&
      !raw.world.entities.items.some((e) => e.id === input.world_entity_id)
    ) {
      const focus = (
        await tx.query(
          "SELECT to_jsonb(e) AS item FROM world_entities e WHERE game_id=$1 AND id=$2",
          [raw.game_id, input.world_entity_id],
        )
      ).rows[0]?.item;
      const visible = await publicWorldState(tx, raw.game_id, "entity", focus);
      if (visible) raw.world.entities.items.unshift(visible);
    }
    const effectRows = (
      await tx.query(
        `SELECT 'equipment' AS source,v.stat_modifiers FROM inventory_entries i JOIN game_definition_versions v ON v.game_id=i.game_id AND v.definition_id=i.definition_id AND v.version=i.definition_version WHERE i.game_id=$1 AND i.slot IS NOT NULL AND i.status='owned'
      UNION ALL SELECT 'feature',v.stat_modifiers FROM character_features f JOIN game_definition_versions v ON v.game_id=f.game_id AND v.definition_id=f.definition_id AND v.version=f.definition_version WHERE f.game_id=$1 AND f.status='active'`,
        [raw.game_id],
      )
    ).rows;
    const components = {};
    for (const source of ["equipment", "feature"])
      Object.assign(components, {
        [`${source}_modifiers`]: Object.fromEntries(
          Object.keys(raw.base_stats).map((key) => {
            const total = effectRows
              .filter((r) => r.source === source)
              .reduce((sum, r) => sum + BigInt(r.stat_modifiers[key]), 0n);
            if (
              total > BigInt(Number.MAX_SAFE_INTEGER) ||
              total < -BigInt(Number.MAX_SAFE_INTEGER)
            )
              throw new Error("Modifier subtotal exceeds safe range");
            return [key, Number(total)];
          }),
        ),
      });
    let summary;
    if (dashboard) {
      /** @param {string} table @param {string} where @param {number} limit */
      const held = async (table, where, limit) =>
        (
          await tx.query(
            `SELECT to_jsonb(t) || jsonb_build_object('definition',jsonb_build_object('name',v.name,'description',v.description,'stat_modifiers',v.stat_modifiers)) AS item FROM ${table} t JOIN game_definition_versions v ON v.game_id=t.game_id AND v.definition_id=t.definition_id AND v.version=t.definition_version WHERE t.game_id=$1 AND ${where} ORDER BY t.sequence DESC LIMIT $2`,
            [raw.game_id, limit],
          )
        ).rows.map((r) => r.item);
      const news = [];
      for (const row of (
        await tx.query(
          "SELECT to_jsonb(f) AS item FROM world_facts f WHERE game_id=$1 AND visibility='player' AND kind='event' ORDER BY sequence DESC LIMIT 6",
          [raw.game_id],
        )
      ).rows) {
        const visible = await publicWorldState(
          tx,
          raw.game_id,
          "fact",
          row.item,
        );
        if (visible) news.push(visible);
      }
      const recentItems = await held("inventory_entries", "status='owned'", 3),
        recentFeatures = await held("character_features", "status='active'", 3);
      summary = {
        equipment: await held(
          "inventory_entries",
          "status='owned' AND slot IS NOT NULL",
          6,
        ),
        skills: await held(
          "character_features",
          "status='active' AND kind='skill'",
          3,
        ),
        titles: await held(
          "character_features",
          "status='active' AND kind='title'",
          1,
        ),
        rewards: [...recentItems, ...recentFeatures]
          .sort(
            (a, b) =>
              new Date(b.acquired_at).getTime() -
              new Date(a.acquired_at).getTime(),
          )
          .slice(0, 3),
        news: news.slice(0, 2),
        questlines: (
          await tx.query(
            "SELECT * FROM questlines WHERE game_id=$1 AND status='active' ORDER BY sequence DESC LIMIT 3",
            [raw.game_id],
          )
        ).rows,
      };
    }
    const rows = (
      await tx.query(
        `SELECT j.sequence,j.xp_delta,j.stats_delta,j.recorded_at FROM gm_adjudications j JOIN games g ON g.id=j.game_id WHERE g.owner_id=$1 AND j.sequence>$2 ORDER BY j.sequence LIMIT 21`,
        [owner, after_growth_sequence],
      )
    ).rows;
    const initial =
      after_growth_sequence === 0
        ? (
            await tx.query(
              `SELECT 0 AS sequence,'initial' AS kind,c.xp_delta,c.stats_delta,u.recorded_at FROM gm_change_entries c JOIN gm_updates u ON u.id=c.update_id WHERE c.game_id=$1 AND c.before_state IS NULL ORDER BY u.recorded_at LIMIT 1`,
              [raw.game_id],
            )
          ).rows
        : [];
    return projectPlayer({
      ...raw,
      ...components,
      dashboard: summary,
      growth: {
        items: [...initial, ...rows.slice(0, 20)].map((r) => ({
          ...r,
          sequence: Number(r.sequence),
          xp_delta: Number(r.xp_delta),
        })),
        next_after_sequence:
          rows.length > 20 ? Number(rows[19].sequence) : null,
      },
    });
  });
}
