import { loadClerk } from "./auth.js";
const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const num = (v) => Number(v || 0).toLocaleString("ko-KR");
const signed = (v) => `${Number(v) > 0 ? "+" : ""}${num(v)}`;
const date = (v) =>
  v
    ? new Date(v).toLocaleDateString("ko-KR", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "시각 미상";
const status = {
  active: "진행 중",
  available: "발견됨",
  paused: "잠시 멈춤",
  completed: "완료",
  failed: "실패",
  abandoned: "중단",
  owned: "보유",
  lost: "상실",
  ended: "종료",
};
const kinds = {
  profession: "직업",
  skill: "스킬",
  trait: "특성",
  title: "칭호",
  achievement: "업적",
  equipment: "장비",
  item: "아이템",
  world: "세계",
  place: "장소",
  faction: "세력",
  npc: "인물",
};
const statNames = {
  STR: "힘",
  DEX: "민첩",
  VIT: "체력",
  INT: "지능",
  CHA: "매력",
  LUK: "행운",
};
const nav = [
  ["home", "✧", "모험가의 서재", "SANCTUARY"],
  ["character", "♜", "캐릭터", "CHARACTER"],
  ["inventory", "⚔", "소지품", "INVENTORY"],
  ["quests", "◇", "퀘스트라인", "QUESTLINES"],
  ["world", "◎", "세계 도감", "WORLD ATLAS"],
  ["journal", "▤", "모험 일지", "CHRONICLE"],
];
let config,
  clerk,
  data,
  current = "home",
  generation = 0,
  detailGeneration = 0,
  dialogState,
  questFilter = "all",
  worldFilter = "all",
  journalOrder = "recorded";
const allStatuses = Object.keys(status).slice(0, 6);
const defaults = {
  quest_statuses: allStatuses,
  feature_statuses: ["active", "ended", "lost"],
  inventory_statuses: ["owned", "lost"],
};
const previewEmpty = () =>
  (config.preview || config.synthetic) &&
  new URLSearchParams(location.search).get("preview") === "empty";
const api = async (query) => {
  const headers = {};
  if (clerk) {
    const token = await clerk.session?.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (previewEmpty()) headers["X-Preview-State"] = "empty";
  const r = await fetch(
    `/api/player?q=${encodeURIComponent(JSON.stringify({ ...defaults, ...query }))}`,
    { headers, cache: "no-store" },
  );
  const result = await r.json();
  if (!r.ok) {
    const e = new Error(result.error);
    e.status = r.status;
    throw e;
  }
  return result;
};
const badge = (s) =>
  `<span class="badge ${esc(s)}">${esc(status[s] || s)}</span>`;
const empty = (text = "아직 남겨진 기록이 없습니다.") =>
  `<div class="quiet">✧<p>${esc(text)}</p></div>`;
const section = (title, subtitle, body, link = "") =>
  `<section class="panel"><header class="section-head"><div><p class="eyebrow">${subtitle}</p><h2>${title}</h2></div>${link}</header>${body}</section>`;
const more = (key, cursor, scope = "main") =>
  cursor != null
    ? `<button class="more" data-more="${key}" data-scope="${scope}" data-cursor="${esc(cursor)}">다음 기록 펼치기 <span>↓</span></button>`
    : "";
const detailButton = (type, id, body, cls = "record") =>
  `<button class="${cls}" data-detail="${type}" data-id="${esc(id)}">${body}</button>`;
const link = (id, text) =>
  `<a class="text-link" href="#${id}">${text} <span>↗</span></a>`;
const label = (entry) =>
  entry.definition?.name || entry.name || entry.title || "이름 없는 기록";
const rarity = (entry) =>
  /전설|legend/i.test(entry.grade)
    ? "legendary"
    : /영웅|epic/i.test(entry.grade)
      ? "epic"
      : /희귀|rare/i.test(entry.grade)
        ? "rare"
        : "common";
const itemIcon = (entry) =>
  entry.kind === "equipment"
    ? entry.slot === "몸통"
      ? "♜"
      : entry.slot === "장신구"
        ? "✦"
        : "⚔"
    : entry.kind === "item"
      ? "♧"
      : entry.kind === "achievement"
        ? "✺"
        : entry.kind === "title"
          ? "♛"
          : entry.kind === "trait"
            ? "❈"
            : "✧";
const itemCard = (entry) =>
  detailButton(
    entry.kind === "equipment" || entry.kind === "item"
      ? "inventory"
      : "feature",
    entry.id,
    `<span class="item-icon ${rarity(entry)}">${itemIcon(entry)}</span><span class="record-copy"><small>${esc(entry.grade || kinds[entry.kind])}${entry.slot ? ` · ${esc(entry.slot)}` : ""}</small><strong>${esc(label(entry))}</strong><span>${esc(entry.definition?.description || "")}</span></span><span class="record-tail">${entry.quantity ? `×${num(entry.quantity)}` : entry.mastery ? `숙련 ${num(entry.mastery)}` : "↗"}</span>`,
  );
function crest() {
  return `<svg class="crest" viewBox="0 0 260 320" aria-hidden="true"><defs><linearGradient id="metal" x2="1" y2="1"><stop stop-color="#f3dfaa"/><stop offset="1" stop-color="#7f6542"/></linearGradient></defs><circle cx="130" cy="135" r="100" fill="none" stroke="#9c8757" stroke-opacity=".25"/><circle cx="130" cy="135" r="82" fill="none" stroke="#9c8757" stroke-dasharray="1 11"/><path d="M130 26 220 78 208 201 130 277 52 201 40 78Z" fill="#13282c" stroke="url(#metal)" stroke-width="2"/><path d="M130 44 204 87 193 193 130 256 67 193 56 87Z" fill="none" stroke="#8d7953" stroke-opacity=".5"/><path d="m130 66 13 66 51 17-51 17-13 67-13-67-51-17 51-17Z" fill="url(#metal)"/><circle cx="130" cy="149" r="13" fill="#123039" stroke="#ecd39b"/><path d="m130 2 4 12 12 4-12 4-4 12-4-12-12-4 12-4Z" fill="#d6bb80"/><path d="M75 283q55 28 110 0M89 297q41 19 82 0" fill="none" stroke="#957c50"/></svg>`;
}
function scene() {
  return `<div class="scene" aria-hidden="true"><div class="moon"></div><svg viewBox="0 0 900 370" preserveAspectRatio="xMidYMax slice"><path d="m0 280 90-110 85 65 80-140 130 175 130-152 120 110 110-120 155 175v87H0" fill="#304747"/><path d="m0 310 160-112 140 80 130-60 140 100 180-150 150 110v92H0" fill="#1b3639"/><path d="m0 340 130-40 160 38 180-30 160 20 160-65 110 70v37H0" fill="#10262c"/><path d="M664 292v-99h35v99m-40-99 22-39 22 39m-29 16h15v17h-15m-3 42h20v24h-20" fill="#0c1d23" stroke="#b69b64" stroke-opacity=".35"/><path d="m400 370 160-35 90-8-100 43" fill="#c2aa71" opacity=".13"/></svg></div>`;
}
function shell() {
  $("#app").innerHTML =
    `<div class="layout"><aside class="sidebar"><a href="#home" class="brand"><span>✧</span><div>LIFE RPG<small>모험의 서</small></div></a><p class="nav-label">나의 이야기</p><nav aria-label="주요 탐색">${nav.map(([id, icon, title]) => `<a href="#${id}" ${current === id ? 'aria-current="page"' : ""}><span>${icon}</span>${title}</a>`).join("")}</nav><div class="sidebar-footer"><span class="seal">✦</span><p>평범한 하루가<br>하나의 전설이 되도록.</p><small>THE STORY CONTINUES</small></div></aside><div class="main-wrap"><header class="topbar"><span class="breadcrumb">모험의 서 <span>/</span> ${nav.find((n) => n[0] === current)?.[2]}</span><div class="top-actions"><span class="connection">${config.preview || config.synthetic ? "합성 세계 미리보기" : "개인 전용 서재"}</span><button id="refresh" class="icon-button" aria-label="최신 기록 새로고침">↻</button>${clerk ? '<button id="signout" class="subtle">로그아웃</button>' : ""}</div></header>${config.preview || config.synthetic ? `<div class="preview-note">✧ 합성 데이터로 펼쳐본 이야기 <span>실제 캐릭터·세계는 생성되지 않았습니다.</span><a href="${previewEmpty() ? "/" : "/?preview=empty"}">${previewEmpty() ? "합성 세계 보기" : "미시작 화면 보기"} ↗</a></div>` : ""}<main id="main" tabindex="-1"><div role="status" class="loading">기록을 펼치고 있습니다…</div></main><footer class="page-footer"><span>✧ LIFE RPG</span><span id="freshness">당신의 이야기는 계속됩니다.</span></footer></div></div>`;
}
const pageHeading = (title, english, desc) =>
  `<header class="page-heading"><p class="eyebrow">${english}</p><h1>${title}</h1><p>${desc}</p></header>`;
function stats() {
  return `<div class="stat-table"><div class="stat-row stat-labels"><span>능력치</span><span>기본</span><span>장비</span><span>기타 활성</span><span>최종</span></div>${Object.entries(
    statNames,
  )
    .map(
      ([key, name]) =>
        `<div class="stat-row"><span><b>${key}</b> ${name}</span><span>${num(data.base_stats[key])}</span><span class="modifier">${signed(data.equipment_modifiers[key])}</span><span class="modifier">${signed(data.feature_modifiers[key])}</span><strong>${num(data.display_stats[key])}</strong></div>`,
    )
    .join(
      "",
    )}</div><p class="footnote">활성 보정 = 장착 장비 + 활성 직업·스킬·특성 등. 최종값은 서버 계산값입니다.</p>`;
}
function xp() {
  const c = data.character;
  return `<div class="xp-meta"><span>LEVEL ${c.level} <span>→ ${c.level + 1}</span></span><span>${num(c.xp_in_level)} <span>/ ${num(c.xp_for_next_level)} XP</span></span></div><progress class="xp" value="${c.xp_in_level}" max="${c.xp_for_next_level}" aria-label="다음 레벨까지 경험치"></progress><p class="footnote">다음 레벨까지 ${num(c.xp_to_next_level)} XP · 누적 ${num(c.xp_total)} XP</p>`;
}
function questCards(lines) {
  return lines
    .map((q, i) =>
      detailButton(
        "quest",
        q.id,
        `<div class="quest-card-top"><span class="quest-number">${String(i + 1).padStart(2, "0")}</span>${badge(q.status)}</div><h3>${esc(q.title)}</h3><p>${esc(q.progress || q.goal || q.description || "다음 장면을 기다리고 있습니다.")}</p><div class="quest-card-bottom"><span>이야기 펼치기</span><span>↗</span></div>`,
        "quest-card",
      ),
    )
    .join("");
}
function home() {
  const c = data.character,
    title = data.dashboard.titles[0];
  const active = data.dashboard.questlines;
  return `<section class="hero">${scene()}<div class="hero-copy"><p class="eyebrow">YOUR ADVENTURE, STILL UNFOLDING</p><p class="hero-kicker">${esc(title ? label(title) : "아직 쓰이지 않은 전설")}</p><h1>${esc(c.label)}<span>의 모험</span></h1><p>오늘의 발자취가 내일의 전설이 되는 곳.<br>당신이 지나온 길과, 아직 펼쳐지지 않은 이야기를 만나세요.</p><a href="#character" class="primary">캐릭터 살펴보기 <span>↗</span></a></div><div class="hero-world"><span>✦</span> ${esc(data.world.clock.world_time?.label || "아직 이름 없는 시간")}</div></section><div class="dashboard-grid"><section class="panel character-summary"><div class="character-heading"><div class="mini-crest">✧</div><div><p class="eyebrow">${esc(data.content.current_profession ? label(data.content.current_profession) : "직업 미정")}</p><h2>${esc(c.label)}</h2></div><div class="level"><small>LV.</small>${c.level}</div></div>${xp()}<div class="quick-stats">${Object.entries(
    statNames,
  )
    .map(
      ([k, v]) =>
        `<div><small>${v}</small><strong>${num(data.display_stats[k])}</strong><span>${k}</span></div>`,
    )
    .join("")}</div>${link("character", "성장의 기록")}</section>${section(
    "이어지는 이야기",
    "ACTIVE QUESTLINES",
    active.length
      ? `<div class="compact-quests">${active
          .slice(0, 3)
          .map((q) =>
            detailButton(
              "quest",
              q.id,
              `<span class="quest-diamond">◇</span><span class="record-copy"><strong>${esc(q.title)}</strong><span>${esc(q.progress || q.goal)}</span></span><span>↗</span>`,
            ),
          )
          .join("")}</div>`
      : empty("진행 중인 이야기가 없습니다."),
    link("quests", "모두 보기"),
  )}</div><div class="three-columns">${section("함께하는 장비", "EQUIPMENT", data.dashboard.equipment.slice(0, 3).map(itemCard).join("") || empty("장착한 장비가 없습니다."), link("inventory", "소지품"))}${section("새겨진 기술", "SKILLS", data.dashboard.skills.map(itemCard).join("") || empty("아직 배운 기술이 없습니다."), link("character", "상세"))}${section("세계의 소식", "WORLD WHISPERS", data.dashboard.news.map((f) => detailButton("fact", f.id, `<span class="record-copy"><small>${esc(f.world_time?.label || date(f.recorded_at))}</small><strong>${esc(f.title)}</strong><span>${esc(f.body)}</span></span>`)).join("") || empty("아직 들려온 소식이 없습니다."), link("world", "도감"))}</div>${section(
    "최근 여정의 선물",
    "RECENT REWARDS",
    `<div class="reward-strip">${data.dashboard.rewards.map(itemCard).join("") || empty()}${data.recent_adjudications
      .slice(0, 1)
      .map(
        (a) =>
          `<div class="xp-reward"><span>✦</span><div><strong>${signed(a.xp_delta)} XP</strong><small>${date(a.recorded_at)} · 성장 기록</small></div></div>`,
      )
      .join("")}</div>`,
  )}`;
}
function character() {
  const features = data.content.features.items;
  return (
    pageHeading(
      "한 사람의 전설",
      "CHARACTER",
      "몸에 남은 힘, 마음에 새긴 기술, 그리고 지나온 이름들.",
    ) +
    (data.character_profile ? section('탄생과 운명','ORIGIN',`<p>${esc(data.character_profile.species)}</p><p>${esc(data.character_profile.birth)}</p><p>${esc(data.character_profile.background)}</p><p>${esc(data.character_profile.destiny)}</p>`) : '') +
    `<div class="character-layout"><section class="portrait-panel">${crest()}<p class="eyebrow">LEVEL ${data.character.level}</p><h2>${esc(data.character.label)}</h2><p>${esc(data.content.current_profession ? label(data.content.current_profession) : "직업 미정")}</p>${features
      .filter((f) => f.kind === "title" && f.status === "active")
      .map((f) =>
        detailButton("feature", f.id, `♛ ${esc(label(f))}`, "title-chip"),
      )
      .join(
        "",
      )}${xp()}</section><div>${section("여섯 가지 힘", "ATTRIBUTES", stats())}${section(
      "직업과 전직",
      "CALLING",
      features
        .filter((f) => f.kind === "profession")
        .map(
          (f) =>
            `<div class="history-job">${itemCard(f)}${badge(f.status)}<small>${date(f.acquired_at)}${f.ended_at ? " → " + date(f.ended_at) : "부터"}</small></div>`,
        )
        .join("") || empty(),
    )}</div></div><div class="two-columns">${section(
      "스킬과 특성",
      "ABILITIES",
      features
        .filter((f) => ["skill", "trait"].includes(f.kind))
        .map(
          (f) =>
            `<div>${itemCard(f)}${f.status !== "active" ? badge(f.status) : ""}</div>`,
        )
        .join("") || empty(),
    )}${section(
      "칭호와 업적",
      "HONORS",
      features
        .filter((f) => ["title", "achievement"].includes(f.kind))
        .map(itemCard)
        .join("") || empty(),
    )}</div>${more("features", data.content.features.next_after_sequence)}${section("성장의 발자취", "GROWTH HISTORY", growthRows(data.growth.items) + more("growth", data.growth.next_after_sequence))}`
  );
}
function growthRows(rows) {
  return rows.length
    ? `<div class="timeline">${rows
        .map(
          (r) =>
            `<article><small>${date(r.recorded_at)}${r.kind === "initial" ? " · 최초 성장" : ""}</small><h3>${signed(r.xp_delta)} XP</h3><p>${
              Object.entries(r.stats_delta)
                .filter(([, v]) => v)
                .map(([k, v]) => `${esc(statNames[k] || k)} ${signed(v)}`)
                .join(" · ") || "경험이 새로운 발자취로 남았습니다."
            }</p></article>`,
        )
        .join("")}</div>`
    : empty("초기 성장 이후의 변화가 아직 없습니다.");
}
function inventory() {
  const items = data.content.inventory.items;
  return (
    pageHeading(
      "여정에 함께하는 것들",
      "INVENTORY",
      "하나의 검에도, 작은 돌 하나에도 이야기가 깃들어 있다.",
    ) +
    section(
      "장착 장비",
      "EQUIPPED",
      `<div class="equipment-grid">${
        items
          .filter((i) => i.slot)
          .map(
            (i) =>
              `<article class="equipment-card ${rarity(i)}"><p class="eyebrow">${esc(i.slot)}</p><div class="large-item">${itemIcon(i)}</div>${itemCard(i)}${i.durability != null && i.max_durability ? `<progress value="${i.durability}" max="${i.max_durability}" aria-label="${esc(label(i))} 내구도"></progress><small>내구도 ${num(i.durability)} / ${num(i.max_durability)}</small>` : ""}</article>`,
          )
          .join("") || empty("아직 장착한 장비가 없습니다.")
      }</div>`,
    ) +
    section(
      "가방 속 이야기",
      "COLLECTION",
      `<div class="two-columns item-collection">${items.map((i) => `<div>${itemCard(i)}${i.status === "lost" ? badge(i.status) : ""}</div>`).join("") || empty()}</div>${more("inventory", data.content.inventory.next_after_sequence)}`,
    )
  );
}
function quests() {
  const lines =
    questFilter === "all"
      ? data.questlines
      : data.questlines.filter((q) => q.status === questFilter);
  return (
    pageHeading(
      "아직 끝나지 않은 이야기",
      "QUESTLINES",
      "여러 갈래의 여정, 서로를 비추는 하나의 세계.",
    ) +
    `<div class="filters" aria-label="퀘스트 상태 필터">${["all", ...allStatuses].map((s) => `<button data-quest-filter="${s}" aria-pressed="${questFilter === s}">${s === "all" ? "모든 이야기" : status[s]}</button>`).join("")}</div><div class="quest-grid">${questCards(lines) || empty("이 상태에 해당하는 이야기가 없습니다.")}</div>${more("quests", data.next_after_quest_sequence)}`
  );
}
function world() {
  const entities = data.world.entities.items.filter(
    (e) => worldFilter === "all" || e.category === worldFilter,
  );
  return (
    pageHeading(
      "별빛 아래의 세계",
      "WORLD ATLAS",
      "발견한 장소와 만난 사람들. 공개된 이야기만 이 도감에 새겨집니다.",
    ) +
    `<div class="world-banner">${scene()}<div><p class="eyebrow">THE KNOWN WORLD</p><h2>${esc(data.world.entities.items.find((e) => e.category === "world")?.name || "미지의 세계")}</h2><p>${esc(data.world.clock.world_time?.label || "세계의 시각 미정")}</p></div><span class="compass">✥</span></div><div class="filters" aria-label="세계 도감 분류">${["all", "place", "faction", "npc", "world"].map((s) => `<button data-world-filter="${s}" aria-pressed="${worldFilter === s}">${s === "all" ? "도감 전체" : kinds[s]}</button>`).join("")}</div><div class="world-grid">${entities.map((e) => detailButton("entity", e.id, `<span class="entity-mark">${e.category === "npc" ? "♙" : e.category === "faction" ? "⚑" : "⌖"}</span><small>${esc(e.kind)}</small><h3>${esc(e.name)}</h3><p>${esc(e.description)}</p><span class="text-link">기록 열기 ↗</span>`, "world-card")).join("") || empty()}</div>${more("entities", data.world.entities.next_after_sequence)}${section("세계의 역사와 전언", "LORE & HISTORY", data.world.facts.items.map((f) => detailButton("fact", f.id, `<span class="record-copy"><small>${esc(f.world_time?.label || "세계 시각 미상")} · ${f.truth === "canon" ? "확정된 기록" : f.truth === "claim" ? "인물의 주장" : "인물의 믿음"}</small><strong>${esc(f.title)}</strong><span>${esc(f.body)}</span></span><span>↗</span>`)).join("") + more("facts", data.world.facts.next_after_sequence))}`
  );
}
function journal() {
  const rows = data.world.chronicle?.items || [];
  return (
    pageHeading(
      "시간이 남긴 문장들",
      "ADVENTURE JOURNAL",
      "GM이 기록한 모험과, 그 이야기가 시작된 순간들.",
    ) +
    `<div class="journal-grid">${data.world.journals.items.map((j, i) => detailButton("journal", j.id, `<p class="eyebrow">ADVENTURE LOG · ${String(i + 1).padStart(2, "0")}</p><small>${esc(j.world_time?.label || date(j.recorded_at))}</small><h2>${esc(j.title)}</h2><p class="journal-excerpt">${esc(j.body)}</p><span class="text-link">기록 펼쳐 읽기 ↗</span>`, "journal-card")).join("") || empty("첫 모험의 이야기를 기다리고 있습니다.")}</div>${more("journals", data.world.journals.next_after_sequence)}${section("모든 길의 연대기", "CHRONICLE", `<label class="order-label">시간의 기준 <select id="chronicle-order"><option value="recorded" ${journalOrder === "recorded" ? "selected" : ""}>기록순</option><option value="occurred" ${journalOrder === "occurred" ? "selected" : ""}>현실 발생순</option><option value="world" ${journalOrder === "world" ? "selected" : ""}>세계 시각순</option></select></label><p class="footnote">오래된 기록부터 이어집니다. 날짜만 있는 사건은 하루 단위이며, 세계 시각은 현실 시각으로 환산하지 않습니다.</p><div class="timeline">${rows.map((r) => `<article><small>${esc(journalOrder === "world" ? r.world_time?.label || "세계 시각 미상" : journalOrder === "occurred" ? r.value.occurred_on || "현실 발생 시각 미상" : date(r.recorded_at))} · ${r.type === "life_event" ? "현실의 발자취" : r.type === "journal" ? "모험 일지" : "세계의 기록"}</small>${r.type === "life_event" ? `<h3>${esc(r.value.summary)}</h3><p>${r.occurrence_basis === "date_helper" ? "날짜만 알려진 사건 · 하루 안의 순서는 알 수 없습니다." : ""}</p>` : detailButton(r.type === "journal" ? "journal" : "fact", r.id, `<span class="record-copy"><strong>${esc(r.value.title)}</strong><span>${esc(r.value.body)}</span></span><span>↗</span>`)}</article>`).join("") || empty()}</div>${more("chronicle", data.world.chronicle?.next_cursor)}`)}`
  );
}
function unstarted() {
  if(data.initialization?.status==='preparing') return `<section class="unstarted">${scene()}${crest()}<p class="eyebrow">A WORLD TAKING SHAPE</p><h1>당신의 첫 이야기를<br>준비하고 있습니다</h1><p>GM이 캐릭터와 세계의 첫 장을 엮고 있어요.<br>모든 준비가 확정되면 모험의 서가 열립니다.</p><span class="title-chip">초기 생성 준비 중</span></section>`;
  return `<section class="unstarted">${scene()}${crest()}<p class="eyebrow">A STORY YET TO BEGIN</p><h1>아직 펼쳐지지 않은<br>당신의 이야기</h1><p>캐릭터와 세계가 태어나면 이곳에 첫 장이 열립니다.<br>그날의 이름과 첫 여정을 기다리고 있어요.</p><span class="title-chip">첫 번째 페이지를 기다리는 중</span></section>`;
}
const render = () => {
  $("#main").innerHTML = data.initialized
    ? { home, character, inventory, quests, world, journal }[current]()
    : unstarted();
  $("#freshness").textContent =
    `방금 읽은 기록${data.revision ? ` · 판본 ${data.revision}` : ""}`;
};
function gate(title, body, extra = "") {
  $("#app").innerHTML =
    `<main id="main" class="gate"><div class="sigil">✧</div><p class="eyebrow">LIFE RPG · PRIVATE SANCTUARY</p><h1>${title}</h1><p>${body}</p>${extra}</main>`;
}
function failure(error, target) {
  if (error.status === 401 || error.status === 403) {
    data = null;
    detailGeneration++;
    $("#detail").close();
    if (error.status === 401) showSignIn();
    else
      gate(
        "주인을 기다리는 서재",
        "이 계정은 모험의 서를 열 수 없습니다.",
        clerk
          ? '<button id="signout" class="primary">다른 계정으로 로그인</button>'
          : "",
      );
    return;
  }
  target.innerHTML = `<div class="quiet error" role="alert"><h2>기록을 불러오지 못했어요.</h2><p>${error.message === "auth_not_configured" ? "서재의 인증 연결이 아직 준비되지 않았습니다." : "잠시 후 다시 펼쳐 주세요. 저장된 이야기는 그대로 남아 있습니다."}</p><button class="primary" id="refresh">다시 시도</button></div>`;
}
async function route() {
  const own = ++generation;
  detailGeneration++;
  $("#detail").close();
  current = location.hash.slice(1).split("/")[0] || "home";
  if (!nav.some((n) => n[0] === current)) current = "home";
  shell();
  try {
    const result = await api({
      dashboard: current === "home",
      include_chronicle: current === "journal",
      chronicle_order: journalOrder,
      ...(current === "quests" && questFilter !== "all"
        ? { quest_statuses: [questFilter] }
        : {}),
    });
    if (own !== generation) return;
    data = result;
    render();
  } catch (e) {
    if (own === generation) failure(e, $("#main"));
  }
}
const pagePaths = {
  features: ["content", "features"],
  inventory: ["content", "inventory"],
  growth: ["growth"],
  entities: ["world", "entities"],
  facts: ["world", "facts"],
  journals: ["world", "journals"],
  nodes: ["nodes"],
  node_links: ["node_links"],
  line_links: ["line_links"],
  event_links: ["event_links"],
  quest_history: ["history"],
  content_history: ["content", "history"],
  relations: ["world", "relations"],
};
const cursors = {
  features: "after_feature_sequence",
  inventory: "after_inventory_sequence",
  growth: "after_growth_sequence",
  entities: "after_world_entity_sequence",
  facts: "after_world_fact_sequence",
  journals: "after_journal_sequence",
  nodes: "after_node_sequence",
  node_links: "after_node_link_sequence",
  line_links: "after_line_link_sequence",
  event_links: "after_event_link_sequence",
  quest_history: "after_quest_change_sequence",
  content_history: "after_content_change_sequence",
  relations: "after_world_relation_sequence",
  quests: "after_quest_sequence",
  chronicle: "after_chronicle",
};
async function loadMore(button) {
  const { more: key, cursor, scope } = button.dataset;
  const query =
    scope === "detail"
      ? dialogState.query
      : {
          include_chronicle: current === "journal",
          chronicle_order: journalOrder,
          ...(current === "quests" && questFilter !== "all"
            ? { quest_statuses: [questFilter] }
            : {}),
        };
  const ticket = scope === "detail" ? detailGeneration : generation;
  button.disabled = true;
  button.textContent = "기록을 읽고 있어요…";
  try {
    const next = await api({
      ...query,
      [cursors[key]]: key === "chronicle" ? cursor : Number(cursor),
    });
    if (ticket !== (scope === "detail" ? detailGeneration : generation)) return;
    const target = scope === "detail" ? dialogState.data : data;
    if (key === "quests") {
      target.questlines.push(...next.questlines);
      target.next_after_quest_sequence = next.next_after_quest_sequence;
    } else if (key === "chronicle") {
      target.world.chronicle.items.push(...next.world.chronicle.items);
      target.world.chronicle.next_cursor = next.world.chronicle.next_cursor;
    } else {
      const path = pagePaths[key],
        a = path.reduce((v, k) => v[k], target),
        b = path.reduce((v, k) => v[k], next);
      a.items.push(
        ...b.items.filter(
          (item) => !item.id || !a.items.some((old) => old.id === item.id),
        ),
      );
      a.next_after_sequence = b.next_after_sequence;
    }
    if (scope === "detail") renderDetail();
    else render();
  } catch (e) {
    if (ticket !== (scope === "detail" ? detailGeneration : generation)) return;
    if (e.status === 401 || e.status === 403) failure(e, $("#main"));
    else {
      button.disabled = false;
      button.textContent = "불러오기 실패 · 다시 시도";
    }
  }
}
const settings = (value) =>
  value && Object.keys(value).length
    ? `<dl class="settings">${Object.entries(value)
        .map(
          ([k, v]) =>
            `<div><dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd></div>`,
        )
        .join("")}</dl>`
    : "";
const effects = (mods) =>
  `<div class="effect-chips">${
    Object.entries(mods || {})
      .filter(([, v]) => v)
      .map(([k, v]) => `<span>${esc(statNames[k] || k)} ${signed(v)}</span>`)
      .join("") || "<span>수치 보정 없음</span>"
  }</div>`;
function historyRows(rows) {
  return `<div class="timeline">${rows
    .map((r) => {
      const linked = r.target_type.endsWith("link");
      const name =
        r.after_state?.title ||
        r.after_state?.name ||
        (linked
          ? "이야기의 연결"
          : r.target_type === "inventory"
            ? "아이템 기록"
            : "성장의 기록");
      const change = linked
        ? r.after_state?.active
          ? "연결됨"
          : "연결 해제"
        : `${r.before_state ? `${status[r.before_state.status] || "이전 기록"} → ` : "첫 기록 · "}${status[r.after_state?.status] || "갱신"}`;
      return `<article><small>${date(r.recorded_at)}</small><h3>${esc(name)}</h3><p>${esc(change)}${r.before_state?.quantity !== r.after_state?.quantity && r.after_state?.quantity != null ? ` · 수량 ${num(r.after_state.quantity)}` : ""}</p><p>${esc(r.after_state?.ending || r.after_state?.progress || r.after_state?.label || "")}</p></article>`;
    })
    .join("")}</div>`;
}
const references = (links) =>
  `<div class="reference-links">${(links || [])
    .filter((l) => l.type !== "event")
    .map((l) =>
      detailButton(
        { entity: "entity", world_fact: "fact", questline: "quest" }[l.type],
        l.id,
        `${{ entity: "관련 인물·장소", world_fact: "관련 세계 기록", questline: "이어지는 퀘스트라인" }[l.type]} ↗`,
        "reference-link",
      ),
    )
    .join("")}</div>`;
function renderDetail() {
  const { type, id, data: d } = dialogState;
  let title = "",
    body = "",
    overline = "";
  if (type === "inventory" || type === "feature") {
    const entry = (
      type === "inventory" ? d.content.inventory : d.content.features
    ).items.find((e) => e.id === id);
    if (!entry) {
      body = empty("기록을 찾을 수 없습니다.");
      title = "사라진 기록";
    } else {
      title = label(entry);
      overline = `${kinds[entry.kind]} · ${entry.grade || "등급 미정"} · ${status[entry.status]}`;
      body = `<div class="detail-item-icon ${rarity(entry)}">${itemIcon(entry)}</div><p class="prose">${esc(entry.definition.description)}</p>${effects(entry.definition.stat_modifiers)}<p class="footnote">${entry.slot ? `${esc(entry.slot)} 장착 · ` : ""}정의 v${num(entry.definition_version)} · ${date(entry.acquired_at)} 취득${entry.mastery != null ? " · 숙련 " + num(entry.mastery) : ""}</p>${settings(entry.definition.settings)}${settings(entry.state)}<h3>취득과 변화의 기록</h3>${historyRows(d.content.history?.items || [])}${more("content_history", d.content.history?.next_after_sequence, "detail")}`;
    }
  }
  if (type === "quest") {
    const q = d.questline;
    title = q.title;
    overline = "QUESTLINE · 이어지는 이야기";
    body = `${badge(q.status)}<p class="prose">${esc(q.description)}</p><div class="quest-goal"><small>현재의 목표</small><p>${esc(q.goal || "아직 기록되지 않았습니다.")}</p>${q.progress ? `<small>지나온 장면</small><p>${esc(q.progress)}</p>` : ""}${q.ending ? `<small>남겨진 결말</small><p>${esc(q.ending)}</p>` : ""}</div><h3>장과 여정</h3><div class="chapter-list">${d.nodes.items.map((n) => `<article class="${n.kind === "chapter" ? "chapter" : "quest-node"}" id="node-${esc(n.id)}"><div>${badge(n.status)}<h4>${esc(n.title)}</h4></div>${n.parent_id ? `<small>↳ ${esc(d.nodes.items.find((p) => p.id === n.parent_id)?.title || "앞선 장에 속한 퀘스트")}</small>` : ""}<p>${esc(n.description || n.goal)}</p><p>${esc(n.ending || n.progress)}</p></article>`).join("") || empty()}</div>${more("nodes", d.nodes.next_after_sequence, "detail")}<h3>갈림길과 이어지는 이야기</h3>${d.node_links.items
      .filter((l) => l.active)
      .map(
        (l) =>
          `<p class="branch">${esc(d.nodes.items.find((n) => n.id === l.from_id)?.title || "앞선 장면")} → ${esc(d.nodes.items.find((n) => n.id === l.to_id)?.title || "다음 장면")}<small>${esc(l.label)}</small></p>`,
      )
      .join(
        "",
      )}${more("node_links", d.node_links.next_after_sequence, "detail")}${d.line_links.items
      .filter((l) => l.active)
      .map((l) =>
        detailButton(
          "quest",
          l.from_id === id ? l.to_id : l.from_id,
          `${esc(l.label || "연결된 이야기")} ↗`,
          "reference-link",
        ),
      )
      .join(
        "",
      )}${more("line_links", d.line_links.next_after_sequence, "detail")}<h3>현실에서 시작된 발자취</h3>${
      d.event_links.items
        .filter((l) => l.active)
        .map(
          (l) =>
            `<p>${esc(l.label || "연결된 사건")} · 근거 v${num(l.event_version)}</p>`,
        )
        .join("") || empty()
    }${more("event_links", d.event_links.next_after_sequence, "detail")}<h3>이 이야기의 모험 일지</h3>${d.world.journals.items.map((j) => detailButton("journal", j.id, `${esc(j.title)} ↗`, "reference-link")).join("") || empty()}${more("journals", d.world.journals.next_after_sequence, "detail")}<h3>멈춤과 재개, 그리고 결말</h3>${historyRows(d.history.items)}${more("quest_history", d.history.next_after_sequence, "detail")}`;
  }
  if (type === "entity") {
    const e = d.world.entities.items.find((e) => e.id === id);
    title = e.name;
    overline = `WORLD ATLAS · ${e.kind}`;
    const lookup = (ref) =>
      d.world.entities.items.find((v) => v.id === ref)?.name ||
      data.world.entities.items.find((v) => v.id === ref)?.name;
    body = `<p class="prose">${esc(e.description)}</p>${e.status ? `<p class="title-chip">${esc(e.status)}</p>` : ""}${settings(e.state)}<div class="reference-links">${[
      "parent_id",
      "location_id",
      "affiliation_id",
    ]
      .filter((k) => e[k])
      .map((k) =>
        detailButton(
          "entity",
          e[k],
          `${{ parent_id: "속한 세계·지역", location_id: "위치", affiliation_id: "소속" }[k]} · ${esc(lookup(e[k]) || "기록 열기")} ↗`,
          "reference-link",
        ),
      )
      .join("")}</div><h3>연결된 장소와 사람들</h3>${
      d.world.entities.items
        .filter((v) => v.id !== id)
        .map((v) =>
          detailButton(
            "entity",
            v.id,
            `${esc(v.name)} · ${esc(v.kind)} ↗`,
            "reference-link",
          ),
        )
        .join("") || empty()
    }${more("entities", d.world.entities.next_after_sequence, "detail")}<h3>관계의 실타래</h3>${d.world.relations.items.map((r) => `<article class="relationship"><small>${r.active ? "현재 관계" : "끝난 관계"} · ${esc(r.from_character ? data.character.label : lookup(r.from_entity_id) || "관련 인물")} ↔ ${esc(r.to_character ? data.character.label : lookup(r.to_entity_id) || "관련 인물")}</small><h4>${esc(r.kind)}</h4><p>${esc(r.description)}</p>${references([r.from_entity_id, r.to_entity_id].filter((ref) => ref && ref !== id).map((ref) => ({ type: "entity", id: ref })))}</article>`).join("") || empty()}${more("relations", d.world.relations.next_after_sequence, "detail")}<h3>이곳에 남겨진 기록</h3>${d.world.facts.items.map((f) => detailButton("fact", f.id, `${esc(f.title)} ↗`, "reference-link")).join("") || empty()}${more("facts", d.world.facts.next_after_sequence, "detail")}`;
  }
  if (type === "journal" || type === "fact") {
    const e = (
      type === "journal" ? d.world.journals : d.world.facts
    ).items.find((e) => e.id === id);
    title = e.title;
    overline =
      type === "journal"
        ? "ADVENTURE JOURNAL · GM의 모험 기록"
        : "WORLD LORE · " +
          { canon: "확정된 기록", claim: "인물의 주장", belief: "인물의 믿음" }[
            e.truth
          ];
    body = `<p class="journal-date">${esc(e.world_time?.label || "세계 시각 미상")}</p><div class="book-prose">${esc(
      e.body,
    )
      .split("\n")
      .filter(Boolean)
      .map((p) => `<p>${p}</p>`)
      .join(
        "",
      )}</div><p class="footnote">${date(e.recorded_at)} 기록${e.revealed_at ? " · " + date(e.revealed_at) + " 공개" : ""}</p>${e.speaker_id ? references([{ type: "entity", id: e.speaker_id }]) : ""}${references(e.links)}`;
  }
  $("#detail").innerHTML =
    `<div class="dialog-top"><span class="eyebrow">${esc(overline)}</span><button class="icon-button" data-close aria-label="상세 닫기">×</button></div><div class="dialog-content"><h2 id="detail-title">${esc(title)}</h2>${body}</div>`;
}
async function openDetail(type, id) {
  const ticket = ++detailGeneration;
  const query = {
    ...{
      quest: { questline_id: id },
      inventory: { inventory_id: id, include_content_history: true },
      feature: { feature_id: id, include_content_history: true },
      entity: { world_entity_id: id },
      fact: { world_fact_id: id },
      journal: { journal_id: id },
    }[type],
  };
  $("#detail").innerHTML =
    '<div class="dialog-content"><button class="icon-button" data-close aria-label="상세 닫기">×</button><h2 id="detail-title">기록을 펼치는 중…</h2></div>';
  if (!$("#detail").open) $("#detail").showModal();
  try {
    const result = await api(query);
    if (ticket !== detailGeneration) return;
    dialogState = { type, id, query, data: result };
    renderDetail();
    $("#detail").scrollTop = 0;
    $("#detail-title").tabIndex = -1;
    $("#detail-title").focus({ preventScroll: true });
  } catch (e) {
    if (ticket !== detailGeneration) return;
    if (e.status === 401 || e.status === 403) failure(e, $("#main"));
    else
      $("#detail").innerHTML =
        '<div class="dialog-content"><button class="icon-button" data-close aria-label="상세 닫기">×</button><h2 id="detail-title">기록을 열 수 없습니다.</h2><p>공개된 기록인지 확인하거나 잠시 후 다시 시도해 주세요.</p></div>';
  }
}
async function showSignIn() {
  gate(
    "당신만의 모험의 서",
    "이곳의 기록은 단 한 명의 모험가에게만 열립니다.",
    '<div id="clerk-sign-in"></div>',
  );
  if (clerk)
    clerk.mountSignIn($("#clerk-sign-in"), {
      forceRedirectUrl: location.origin,
      signUpUrl: undefined,
    });
}
document.addEventListener("click", async (event) => {
  if (event.target.closest(".skip-link")) {
    event.preventDefault();
    $("#main").focus();
    return;
  }
  const b = event.target.closest("button");
  if (!b) return;
  if (b.dataset.close != null) {
    detailGeneration++;
    $("#detail").close();
  } else if (b.id === "refresh") await route();
  else if (b.id === "signout") {
    generation++;
    detailGeneration++;
    data = null;
    $("#detail").close();
    await clerk.signOut();
    await showSignIn();
  } else if (b.dataset.detail) await openDetail(b.dataset.detail, b.dataset.id);
  else if (b.dataset.more) await loadMore(b);
  else if (b.dataset.questFilter) {
    questFilter = b.dataset.questFilter;
    await route();
  } else if (b.dataset.worldFilter) {
    worldFilter = b.dataset.worldFilter;
    render();
  }
});
$("#detail").addEventListener("cancel", () => {
  detailGeneration++;
});
document.addEventListener("change", async (event) => {
  if (event.target.id === "chronicle-order") {
    journalOrder = event.target.value;
    await route();
  }
});
window.addEventListener("hashchange", () => {
  if (config && (config.preview || clerk?.user)) void route();
});
async function boot() {
  try {
    config = await (
      await fetch("/api/web-config", { cache: "no-store" })
    ).json();
    if (config.preview) {
      await route();
      return;
    }
    if (!config.publishableKey) {
      gate(
        "봉인된 모험의 서",
        "서재의 인증 연결을 준비하고 있습니다. 연결이 완료되면 주인의 기록을 펼칠 수 있어요.",
      );
      return;
    }
    clerk = await loadClerk(config.publishableKey);
    let previousUser = clerk.user?.id;
    clerk.addListener(({ user }) => {
      if (previousUser && !user) {
        generation++;
        detailGeneration++;
        data = null;
        $("#detail").close();
        void showSignIn();
      }
      previousUser = user?.id;
    });
    if (clerk.user) await route();
    else await showSignIn();
  } catch {
    gate(
      "잠시 닫힌 서재",
      "인증 연결을 불러오지 못했습니다. 잠시 후 다시 방문해 주세요.",
      '<a class="primary" href="/">다시 열기 ↻</a>',
    );
  }
}
void boot();
