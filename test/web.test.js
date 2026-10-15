import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { createFixture } from "./fixtures/web-game.js";
import { createWebApi } from "../src/web.js";
import { clerkOwnerVerifier,webConfig } from "../src/web-auth.js";
import { readConfig } from "../src/config.js";
import { playerQuerySchema, readPlayer } from "../src/web-data.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const config = {
  origin: "http://localhost:4317",
  publishableKey: `pk_test_${Buffer.from("test.clerk.accounts.dev$").toString("base64")}`,
  secretKey: "sk_test_fixture",
  jwtKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
  ownerId: "user_owner",
};
const token = (extra = {}, key = privateKey) => {
  const now = Math.floor(Date.now() / 1000);
  const parts = [
    { alg: "RS256", typ: "JWT", kid: "fixture" },
    {
      sub: "user_owner",
      sid: "sess_fixture",
      iss: "https://test.clerk.accounts.dev",
      azp: config.origin,
      iat: now,
      nbf: now - 5,
      exp: now + 60,
      v: 2,
      sts: "active",
      ...extra,
    },
  ].map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"));
  const body = parts.join(".");
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
};
const request = (q = {}, jwt = token(), options = {}) =>
  new Request(
    `${config.origin}/api/player?q=${encodeURIComponent(JSON.stringify(q))}`,
    {
      headers: { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
      ...options,
    },
  );
let fixture,
  api,
  connections = 0;
test('custom private website origin leaves the existing MCP issuer and resource unchanged',()=>{
  const env={PUBLIC_BASE_URL:'https://liferpg-mcp-experiment.vercel.app',WEB_PUBLIC_BASE_URL:'https://liferpg.spiritflag.work',OAUTH_CLIENT_SECRET:'synthetic-client-'.repeat(4),OWNER_LOGIN_KEY:'synthetic-owner-'.repeat(4),OAUTH_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'};
  assert.equal(webConfig(env).origin,env.WEB_PUBLIC_BASE_URL);
  assert.equal(readConfig(env).base,env.PUBLIC_BASE_URL);
  assert.equal(readConfig(env).resource,`${env.PUBLIC_BASE_URL}/mcp`);
  assert.equal(webConfig({PUBLIC_BASE_URL:env.PUBLIC_BASE_URL}).origin,env.PUBLIC_BASE_URL);
});
before(async () => {
  fixture = await createFixture();
  api = createWebApi(() => {
    connections++;
    return fixture.db;
  }, config);
});
after(async () => {
  await fixture?.close();
});

test("real Clerk SDK verifies signed owner JWT and denies anonymous, non-owner, expired, wrong-origin and tampered sessions before DB access", async () => {
  const count = connections;
  const foreign = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey;
  for (const [jwt, expected] of [
    [null, 401],
    [token({ sub: "user_other" }), 403],
    [token({ exp: 1 }), 401],
    [token({ azp: "https://attacker.example" }), 401],
    [token({}, foreign), 401],
    ["oauth_fake", 401],
  ])
    assert.equal((await api(request({}, jwt))).status, expected);
  assert.equal(
    (
      await api(
        request({}, token(), {
          headers: {
            Authorization: `Bearer ${token()}`,
            Origin: "https://attacker.example",
          },
        }),
      )
    ).status,
    403,
  );
  assert.equal(connections, count);
  const response = await api(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).character.label, "아렌");
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(response.headers.get("vary"), /Authorization/);
});

test("missing Clerk configuration is fail-closed and public bootstrap exposes only publishable key", async () => {
  const deny = createWebApi(
    () => {
      throw new Error("must not connect");
    },
    { ...config, ownerId: "" },
  );
  assert.equal((await deny(request())).status, 503);
  const missing = clerkOwnerVerifier({
    ...config,
    publishableKey: "",
    secretKey: "",
    jwtKey: undefined,
  });
  assert.equal((await missing(request())).status, 503);
  const body = await (
    await api(new Request(`${config.origin}/api/web-config`))
  ).json();
  assert.deepEqual(Object.keys(body), ["publishableKey"]);
});

test("API rejects writes, GM view, owner override, unknown filters, malformed JSON, oversized inputs and raw SQL", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    assert.equal((await api(request({}, token(), { method }))).status, 405);
  for (const q of [
    { view: "gm" },
    { owner_id: "other" },
    { memory_id: randomUUID() },
    { include_world_history: true },
    { world_limit: 51 },
    { world_query: "x".repeat(101) },
    { sql: "SELECT * FROM games" },
  ])
    assert.equal((await api(request(q))).status, 400);
  assert.equal(
    (
      await api(
        new Request(`${config.origin}/api/player?q=%7B`, {
          headers: { Authorization: `Bearer ${token()}` },
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await api(
        new Request(`${config.origin}/api/player?owner_id=other`, {
          headers: { Authorization: `Bearer ${token()}` },
        }),
      )
    ).status,
    400,
  );
});

test("public response removes GM-only records, secret notes, reasons, evidence and nested private content in every detail and history", async () => {
  const queries = [
    { include_chronicle: true },
    {
      inventory_id: fixture.contents["@weapon"],
      include_content_history: true,
    },
    { questline_id: fixture.q["@sea"] },
    { world_entity_id: fixture.world["@npc"] },
    { journal_id: fixture.world["@journal"] },
    { include_content_history: true },
  ];
  for (const q of queries) {
    const r = await api(request(q));
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.doesNotMatch(
      text,
      /SECRET|UNREVEALED|PRIVATE_REAL_EVIDENCE|gm_notes|gm_state|gm_private|acquisition_hash|"reason"/,
    );
  }
  const hidden = (
    await fixture.db.query(
      "SELECT id FROM world_entities WHERE visibility='gm'",
    )
  ).rows[0].id;
  for (const id of [hidden, randomUUID()])
    assert.equal((await api(request({ world_entity_id: id }))).status, 404);
  const r = await api(request({ world_query: "SECRET" }));
  const d = await r.json();
  assert.equal(d.world.entities.items.length, 0);
  assert.equal(d.world.facts.items.length, 0);
});

test("same contract renders computed growth, equipment, profession history, quest chapters, links, NPC relations and full journal", async () => {
  const d = await (
    await api(request({ feature_statuses: ["active", "ended", "lost"] }))
  ).json();
  assert.equal(d.character.level, 13);
  assert.equal(d.character.xp_total, 7860);
  assert.equal(d.character.xp_in_level, 60);
  assert.match(d.recent_adjudications[0].recorded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(d.base_stats.STR, 18);
  assert.equal(d.stat_modifiers.STR, 5);
  assert.equal(d.display_stats.STR, 23);
  assert.equal(d.equipment_modifiers.STR, 5);
  assert.equal(d.feature_modifiers.INT, 3);
  assert.equal(d.growth.items[0].kind, "initial");
  assert.equal(d.growth.items[0].xp_delta, 7200);
  assert.equal(
    d.content.features.items.filter((f) => f.kind === "profession").length,
    2,
  );
  assert.equal(d.content.current_profession.definition.name, "별의 항해사");
  const q = await (
    await api(request({ questline_id: fixture.q["@sea"] }))
  ).json();
  assert.equal(q.nodes.items.length, 4);
  assert.equal(q.line_links.items.length, 1);
  assert.equal(q.world.journals.items.length, 1);
  assert.equal(q.event_links.items.length, 1);
  const j = await (
    await api(request({ journal_id: fixture.world["@journal"] }))
  ).json();
  assert.match(j.world.journals.items[0].body, /새로운 항해/);
  const npc = await (
    await api(request({ world_entity_id: fixture.world["@npc"] }))
  ).json();
  assert.equal(npc.world.relations.items.length, 2);
});

test("dashboard summaries remain current when ordinary lists are truncated", async () => {
  const response = await api(
    request({
      dashboard: true,
      content_limit: 1,
      world_limit: 1,
      quest_limit: 1,
    }),
  );
  assert.equal(response.status, 200);
  const d = await response.json();
  assert.equal(d.content.inventory.items.length, 1);
  assert.equal(d.dashboard.equipment.length, 3);
  assert.equal(d.dashboard.skills.length, 2);
  assert.equal(d.dashboard.titles[0].definition.name, "새벽을 건너는 자");
  assert.equal(d.dashboard.rewards[0].definition.name, "별의 항해사");
  assert.equal(d.dashboard.news[0].title, "은빛 항구에 다시 켜진 불빛");
  assert.equal(d.dashboard.questlines.length, 2);
  assert.doesNotMatch(
    JSON.stringify(d.dashboard),
    /SECRET|gm_notes|acquisition_hash/,
  );
});

test("read-only queries do not alter any row or game revision; absent owner stays uninitialized", async () => {
  const tables = (
    await fixture.db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((r) => r.tablename);
  const snapshot = async () =>
    Promise.all(
      tables.map(
        async (t) =>
          (
            await fixture.db.query(
              `SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS data FROM ${t} t`,
            )
          ).rows[0].data,
      ),
    );
  const before = await snapshot();
  await api(
    request({ include_chronicle: true, include_content_history: true }),
  );
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(
    await readPlayer(fixture.db, "nobody", playerQuerySchema.parse({})),
    { initialized: false, initialization: {status:'unstarted'} },
  );
});

test("keyset pagination traverses all public records without duplicates, including hidden-only pages", async () => {
  for (const [key, path] of [
    ["after_world_entity_sequence", ["world", "entities"]],
    ["after_inventory_sequence", ["content", "inventory"]],
    ["after_feature_sequence", ["content", "features"]],
  ]) {
    let cursor = 0,
      ids = [];
    do {
      const d = await (
        await api(request({ [key]: cursor, world_limit: 1, content_limit: 1 }))
      ).json();
      const p = path.reduce((v, k) => v[k], d);
      ids.push(...p.items.map((i) => i.id));
      cursor = p.next_after_sequence;
    } while (cursor != null);
    assert.ok(ids.length > 2);
    assert.equal(ids.length, new Set(ids).size);
  }
  for (const order of ["recorded", "occurred", "world"]) {
    let cursor,
      ids = [];
    do {
      const d = await (
        await api(
          request({
            include_chronicle: true,
            chronicle_order: order,
            world_limit: 1,
            ...(cursor ? { after_chronicle: cursor } : {}),
          }),
        )
      ).json();
      ids.push(...d.world.chronicle.items.map((i) => i.id));
      cursor = d.world.chronicle.next_cursor;
    } while (cursor);
    assert.equal(ids.length, 5);
    assert.equal(ids.length, new Set(ids).size);
  }
});

test("refresh observes committed GM changes; stale version is not cached", async () => {
  const old = await (await api(request())).json();
  await fixture.apply({
    mode: "advance",
    quest_changes: [
      {
        operation: "update_line",
        questline: fixture.q["@sea"],
        changes: { progress: "새로 도착한 항해 기록" },
        reason: "SECRET_REFRESH_REASON",
      },
    ],
  });
  const updated = await (await api(request())).json();
  assert.equal(updated.revision, old.revision + 1);
  assert.equal(
    updated.questlines.find((q) => q.id === fixture.q["@sea"]).progress,
    "새로 도착한 항해 기록",
  );
});

test("storage failures disclose no database diagnostics or secret connection information", async () => {
  const broken = createWebApi(() => {
    throw new Error("postgres://private:password@host");
  }, config);
  const response = await broken(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "game_unavailable" });
});


test('real task metadata reaches cards, dashboard, node details and public history',async()=>{
  const result=await fixture.apply({mode:'advance',quest_changes:[
    {operation:'create_line',ref:'@task',line_key:'web-task',title:'길드 기록의 복원',description:'잃어버린 기록을 정리하자.',real_task:'서류 정리 <img src=x onerror=alert(1)>',user_consent:true,status:'active',reason:'SECRET_TASK_REASON'},
    {operation:'create_node',ref:'@repeat',questline:'@task',node_key:'repeat',kind:'quest',title:'숲의 순찰',real_task:'20분 산책',recurrence:'매일',user_consent:true,status:'active',reason:'SECRET_TASK_REASON'}
  ]});
  const id=result.quest_refs['@task'];
  const detail=await (await api(request({questline_id:id}))).json();
  assert.equal(detail.questline.real_task,'서류 정리 <img src=x onerror=alert(1)>');assert.equal(detail.questline.recurrence,null);
  assert.equal(detail.nodes.items[0].recurrence,'매일');
  assert.equal(detail.history.items.find(h=>h.target_type==='line').after_state.real_task,detail.questline.real_task);
  assert.ok(!JSON.stringify(detail).includes('SECRET_TASK_REASON'));
  const overview=await (await api(request({dashboard:true}))).json();
  assert.equal(overview.questlines.find(q=>q.id===id).real_task,detail.questline.real_task);
  assert.equal(overview.dashboard.questlines.find(q=>q.id===id).real_task,detail.questline.real_task);
});
