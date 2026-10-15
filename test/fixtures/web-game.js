import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { applyGmUpdate } from "../../src/growth-storage.js";
import { applyGmSchema } from "../../src/growth-schema.js";
import { recordEvent } from "../../src/storage.js";

// Memory-only fixture shared by browser and API tests. Never imported by deployed code.
export async function createFixture() {
  const pg = new PGlite();
  for (const name of [
    "001-experiment",
    "002-life-event-history",
    "003-gm-growth",
    "004-questlines",
    "005-character-content",
    "006-world-memory",
    "007-game-initialization",
    "008-real-task-quests",
  ])
    await pg.exec(
      await readFile(
        new URL(`../../migrations/${name}.sql`, import.meta.url),
        "utf8",
      ),
    );
  const db = {
    query: (s, v) => pg.query(s, v),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (s, v) => tx.query(s, v) })),
  };
  let revision = 0,
    serial = 0;
  const apply = async (body) => {
    const result = await db.transaction((tx) =>
      applyGmUpdate(
        tx,
        "experiment-owner",
        applyGmSchema.parse({
          request_key: `web-fixture-${serial++}`,
          expected_revision: revision,
          reason: "GM_SECRET_REASON",
          ...body,
        }),
        true,
      ),
    );
    revision = result.after.revision;
    return result;
  };
  await apply({
    mode: "initialize",
    synthetic: true,
    character: {
      label: "아렌",
      xp_total: 7200,
      stats: { STR: 18, DEX: 24, VIT: 20, INT: 29, CHA: 16, LUK: 13 },
    },
  });
  const event = (
    await db.transaction((tx) =>
      recordEvent(tx, {
        kind: "test",
        event_key: "synthetic-expedition",
        occurred_on: "2026-10-13",
        category: "탐험",
        summary: "합성 기록: 세 번의 바다 탐험",
        evidence: "PRIVATE_REAL_EVIDENCE",
      }),
    )
  ).event;
  revision = Number(
    (await db.query("SELECT revision FROM games")).rows[0].revision,
  );
  const op = (operation, fields) => ({
    operation,
    reason: "GM_SECRET_REASON",
    ...fields,
  });
  const define = (ref, kind, name, description, stat_modifiers = {}) =>
    op("create_definition", {
      ref,
      definition_key: ref,
      kind,
      name,
      description,
      stat_modifiers,
    });
  const grant = (ref, definition, extra = {}) =>
    op("grant_feature", {
      ref,
      definition,
      definition_version: 1,
      acquisition_key: ref,
      ...extra,
    });
  const item = (ref, definition, grade, extra = {}) => ({
    ...grant(ref, definition),
    operation: "grant_inventory",
    mode: "individual",
    grade,
    ...extra,
  });
  const content = await apply({
    mode: "advance",
    content_changes: [
      define(
        "@wanderer",
        "profession",
        "길 위의 이방인",
        "이름 없는 길을 따라 첫 발걸음을 내디딘 여행자.",
      ),
      define(
        "@navigator",
        "profession",
        "별의 항해사",
        "흩어진 별의 기억을 읽고, 아직 이름 없는 바다에 길을 낸다.",
      ),
      define(
        "@tide",
        "skill",
        "조류 읽기",
        "물결 아래 숨은 흐름을 감지한다. 낯선 바다에서 다음 길을 찾는 항해술.",
        { INT: 3 },
      ),
      define(
        "@step",
        "skill",
        "안개 걸음",
        "발소리마저 안개에 감춰, 짧은 순간 적의 시선에서 벗어난다.",
        { DEX: 2 },
      ),
      define(
        "@trait",
        "trait",
        "깊은 바다의 숨",
        "긴 침묵 속에서도 흔들리지 않는 집중력.",
        { VIT: 2 },
      ),
      define(
        "@title",
        "title",
        "새벽을 건너는 자",
        "길이 사라진 밤에도 끝내 새벽의 항구에 닿은 자.",
      ),
      define(
        "@achievement",
        "achievement",
        "세 번의 파도",
        "서로 다른 세 바다의 흔적을 하나의 항해에 남겼다.",
      ),
      define(
        "@sword",
        "equipment",
        "월광의 나침검",
        "달빛이 닿으면 검 끝이 잊힌 항로를 가리킨다. 은빛 항구의 대장장이가 남긴 유일한 작품.",
        { STR: 5, DEX: 2 },
      ),
      define(
        "@cloak",
        "equipment",
        "안개 순례자의 망토",
        "푸른 안개를 실처럼 엮어 만든 망토. 옷자락에는 오래된 항로가 수놓아져 있다.",
        { VIT: 3, LUK: 1 },
      ),
      define(
        "@charm",
        "equipment",
        "별을 담은 호박석",
        "작은 돌 안에서 아직 이름 붙이지 못한 별이 느리게 회전한다.",
        { INT: 4, LUK: 2 },
      ),
      define(
        "@potion",
        "item",
        "은빛 이슬",
        "달이 가장 높이 뜬 밤에 모은 이슬. 사용 효과는 GM의 판정을 따른다.",
      ),
      { ...grant("@oldjob", "@wanderer"), operation: "change_profession" },
      grant("@skill1", "@tide", { mastery: 3, grade: "숙련" }),
      grant("@skill2", "@step", { mastery: 2, grade: "단련" }),
      grant("@trait1", "@trait"),
      grant("@title1", "@title"),
      grant("@achievement1", "@achievement", { grade: "희귀" }),
      item("@weapon", "@sword", "영웅", {
        durability: 83,
        max_durability: 100,
        state: {
          "획득 경위": "은빛 항구의 등대를 되살린 보답",
          효과: "달빛 아래 항로를 감지한다.",
          gm_notes: "NESTED_CONTENT_SECRET",
        },
      }),
      item("@armor", "@cloak", "희귀", {
        state: { "획득 경위": "안개 숲의 순례자에게 받은 선물" },
      }),
      item("@accessory", "@charm", "전설", {
        state: { "획득 경위": "첫 번째 별의 파편을 발견했다." },
      }),
      item("@supplies", "@potion", "일반", { mode: "stack", quantity: 5 }),
      op("equip", { entry: "@weapon", slot: "주무기" }),
      op("equip", { entry: "@armor", slot: "몸통" }),
      op("equip", { entry: "@accessory", slot: "장신구" }),
    ],
  });
  const contents = content.content_refs;
  await apply({
    mode: "advance",
    content_changes: [
      {
        ...grant("@newjob", contents["@navigator"]),
        operation: "change_profession",
        state: {
          "전직 기록": "잊힌 별의 항로를 해독하고 별의 항해사로 전직했다.",
        },
      },
    ],
  });
  const line = (ref, title, description) =>
    op("create_line", {
      ref,
      line_key: ref,
      title,
      description,
      goal: "잊힌 기록을 따라 다음 장면에 도달한다.",
      status: "active",
    });
  const node = (ref, questline, title, kind = "quest", parent) =>
    op("create_node", {
      ref,
      questline,
      node_key: ref,
      title,
      kind,
      status: "active",
      ...(parent ? { parent } : {}),
      goal: "기록에 남겨진 단서를 찾아낸다.",
    });
  const quests = await apply({
    mode: "advance",
    quest_changes: [
      line(
        "@sea",
        "잊힌 별의 항로",
        "별이 사라진 바다. 마지막 등대지기의 편지 한 통이 오랫동안 닫힌 항로를 다시 열었다.",
      ),
      line(
        "@forest",
        "안개 숲의 약속",
        "숲은 한 번 맺은 약속을 잊지 않는다. 사라진 순례자의 발자취를 따라가자.",
      ),
      line(
        "@tower",
        "잠든 탑의 노래",
        "바람이 멎은 날에도 오래된 탑에서는 노랫소리가 들린다.",
      ),
      line(
        "@past",
        "첫 번째 등불",
        "어둠 속에서 발견한 작은 등불이 모든 여행의 시작이었다.",
      ),
      line(
        "@failed",
        "유리 사막의 전령",
        "모래바람 속에서 놓친 편지는 또 다른 이야기의 씨앗이 되었다.",
      ),
      node("@chapter", "@sea", "제1장 · 등대가 기억하는 것", "chapter"),
      node("@light", "@sea", "꺼진 등대를 깨우다", "quest", "@chapter"),
      node("@map", "@sea", "조각난 별지도를 읽다", "quest", "@chapter"),
      node("@second", "@sea", "제2장 · 이름 없는 바다", "chapter"),
      op("link_nodes", {
        from: "@light",
        to: "@map",
        kind: "branch",
        label: "등대에서 발견한 별지도",
      }),
      op("link_lines", {
        from: "@sea",
        to: "@forest",
        label: "안개 숲에도 같은 별의 문장이 새겨져 있다.",
      }),
      op("link_event", {
        questline: "@sea",
        node: "@light",
        event_id: event.id,
        event_version: event.version,
        label: "세 번의 탐험이 항해의 실마리가 되었다.",
      }),
    ],
  });
  const q = quests.quest_refs;
  await apply({
    mode: "advance",
    quest_changes: [
      op("update_node", {
        node: q["@light"],
        changes: {
          status: "completed",
          ending: "등대가 다시 은빛으로 물들었다.",
        },
      }),
      op("update_line", {
        questline: q["@past"],
        changes: { status: "completed", ending: "첫 등불이 밝혀졌다." },
      }),
      op("update_line", {
        questline: q["@failed"],
        changes: {
          status: "failed",
          ending: "전령은 떠났지만 모래 속에 인장이 남았다.",
        },
      }),
      op("update_line", {
        questline: q["@tower"],
        changes: {
          status: "paused",
          progress: "탑의 문이 열리는 계절을 기다리는 중.",
        },
      }),
      op("update_line", {
        questline: q["@forest"],
        changes: { status: "paused" },
      }),
    ],
  });
  await apply({
    mode: "advance",
    quest_changes: [
      op("update_line", {
        questline: q["@forest"],
        changes: {
          status: "active",
          progress: "순례자의 흔적을 다시 발견했다.",
        },
      }),
    ],
  });
  const entity = (ref, category, name, kind, description, fields = {}) =>
    op("create_entity", {
      ref,
      entity_key: ref,
      category,
      name,
      kind,
      description,
      ...fields,
    });
  const worlds = await apply({
    mode: "advance",
    world_changes: [
      entity(
        "@world",
        "world",
        "에테리아",
        "별의 바다",
        "별의 기억과 오래된 약속이 살아 숨 쉬는 세계.",
      ),
      entity(
        "@country",
        "place",
        "루멘 왕국",
        "국가",
        "은빛 바다를 마주한 오래된 왕국.",
        { parent: "@world" },
      ),
      entity(
        "@port",
        "place",
        "은빛 항구",
        "도시",
        "바다에서 돌아온 이야기는 모두 이곳에 닻을 내린다.",
        { parent: "@country", status: "새벽 등대 재점등" },
      ),
      entity(
        "@wood",
        "place",
        "안개 숲",
        "지역",
        "말하지 못한 약속이 희고 낮은 안개로 내려앉는 숲.",
        { parent: "@world" },
      ),
      entity(
        "@guild",
        "faction",
        "별읽는 자들의 길드",
        "길드",
        "잊힌 항로를 복원하는 항해사와 기록자들의 모임.",
        { parent: "@world", location: "@port" },
      ),
      entity(
        "@npc",
        "npc",
        "세렌",
        "등대지기",
        "오래된 지도를 고치며 돌아오지 않는 배를 기다린다.",
        {
          parent: "@world",
          location: "@port",
          affiliation: "@guild",
          state: {
            성격: "조용하지만 단호하다.",
            "현재 상황": "새로운 항해를 준비하고 있다.",
          },
          gm_notes: "SECRET_LIGHTHOUSE_TWIST",
        },
      ),
      entity(
        "@scholar",
        "npc",
        "이안",
        "기록학자",
        "세상의 모든 별에 이름을 붙이려는 젊은 학자.",
        { parent: "@world", location: "@port" },
      ),
      entity(
        "@hidden",
        "npc",
        "UNREVEALED_NPC",
        "그림자",
        "SECRET_HIDDEN_DESCRIPTION",
        { parent: "@world", visibility: "gm" },
      ),
      op("create_relation", {
        ref: "@bond",
        relation_key: "bond",
        from: { type: "entity", id: "@npc" },
        to: { type: "character" },
        kind: "신뢰",
        description: "등대를 함께 되살린 뒤, 새로운 항로를 맡길 만큼 신뢰한다.",
      }),
      op("create_relation", {
        ref: "@friend",
        relation_key: "friend",
        from: { type: "entity", id: "@npc" },
        to: { type: "entity", id: "@scholar" },
        kind: "동료",
        description: "오래된 지도를 함께 해독하고 있다.",
      }),
      op("create_fact", {
        ref: "@history",
        fact_key: "history",
        kind: "history",
        title: "별이 바다로 내려온 밤",
        body: "아주 오래전, 하늘의 별 하나가 서쪽 바다로 떨어졌다. 사람들은 그 빛을 따라 첫 항구를 세웠고, 길을 잃지 않기 위해 등대를 지었다.",
        world_time: { label: "별의 시대 1년", order: 1 },
        links: [{ type: "entity", id: "@port" }],
      }),
      op("create_fact", {
        ref: "@news",
        fact_key: "news",
        kind: "event",
        title: "은빛 항구에 다시 켜진 불빛",
        body: "수십 년 동안 잠들어 있던 등대가 새벽 바다를 비췄다. 항구에는 오래전 끊긴 항로가 다시 열릴 것이라는 이야기가 번지고 있다.",
        world_time: { label: "별력 327년 · 안개의 달 14일", order: 32714 },
        links: [
          { type: "entity", id: "@port" },
          { type: "questline", id: q["@sea"] },
        ],
      }),
      op("create_fact", {
        ref: "@secret",
        fact_key: "secret",
        kind: "foreshadowing",
        title: "UNREVEALED_FACT",
        body: "SECRET_FUTURE_PLOT",
        visibility: "gm",
      }),
      op("create_journal", {
        ref: "@journal",
        journal_key: "journal",
        title: "파도 너머, 첫 번째 별",
        body: "새벽이 오기 전의 바다는 유난히 고요했다.\n\n아렌은 젖은 장갑을 벗고 등대의 마지막 렌즈를 맞췄다. 오랫동안 닫혀 있던 빛이 수평선을 향해 천천히 뻗어 나갔다. 세렌은 아무 말 없이, 오래된 별지도를 그의 손에 쥐여 주었다.\n\n“이제 길이 보이나요?”\n\n지도 위에는 이름 없는 바다가 있었다. 그리고 그 너머, 아직 아무도 읽지 못한 별 하나.\n\n새로운 항해는 그렇게 시작되었다.",
        world_time: { label: "별력 327년 · 안개의 달 14일", order: 32714 },
        links: [
          { type: "questline", id: q["@sea"] },
          { type: "entity", id: "@npc" },
          { type: "world_fact", id: "@news" },
          { type: "event", event_id: event.id, event_version: event.version },
        ],
        gm_notes: "SECRET_JOURNAL_NOTES",
      }),
      op("create_journal", {
        ref: "@journal2",
        journal_key: "journal2",
        title: "숲이 기억하는 이름",
        body: "안개 속에서도 약속은 길을 잃지 않았다. 돌에 새겨진 문장은 항구에서 보았던 별의 모양과 같았다.\n\n두 이야기가 같은 곳을 향하고 있었다.",
        world_time: { label: "별력 327년 · 안개의 달 15일", order: 32715 },
        links: [{ type: "questline", id: q["@forest"] }],
      }),
      op("create_memory", {
        ref: "@memory",
        memory_key: "memory",
        title: "SECRET_GM_MEMORY",
        body: "SECRET_CONTINUITY",
      }),
      op("advance_world", {
        world_time: { label: "별력 327년 · 안개의 달", order: 32715 },
      }),
    ],
    adjudications: [
      {
        subject: { type: "event", event_id: event.id },
        sources: [{ event_id: event.id, event_version: event.version }],
        reason: "SECRET_JUDGMENT",
        xp_delta: 660,
        stats_delta: { INT: 1 },
      },
    ],
  });
  return {
    pg,
    db,
    q,
    contents,
    world: worlds.world_refs,
    event,
    apply,
    close: () => pg.close(),
  };
}
