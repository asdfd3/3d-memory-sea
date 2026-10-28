// 长期记忆（"海马体"档）的纯逻辑层。
//
// 为什么单独抽一层：
//  1) 这些规则（作废、过期、预算装箱）决定"她能记住什么"，必须能脱离桥接进程单测；
//  2) C（检索式记忆）要在同一份数据上做挑选，逻辑得复用，不能抄两遍。
//
// 三条不变式（改这里的任何一条都会改变她的行为，改前先想清楚）：
//  1) **只标记、不删除**：过时条目一律 active=false + supersededBy，内容永远留着，可回滚；
//  2) 只有 confirmed === true 且 active !== false 且未过期且未过时的条目才会被注入；
//  3) 预算装不下就整条跳过（不截断），优先保"最近还提到过"的。

export const LONGTERM_KINDS = ['fact', 'event', 'promise', 'preference'];

const DAY_MS = 24 * 60 * 60 * 1000;

function entryText(e) {
  return String(e?.text ?? '').trim();
}

// 归一化成"可判定状态"的条目视图（不改原对象）。
export function entryState(e, cfg = {}, now = Date.now()) {
  if (!e || typeof e !== 'object') return 'invalid';
  if (!entryText(e)) return 'invalid';
  if (e.confirmed !== true) return 'pending';
  if (e.active === false || e.supersededBy) return 'superseded';
  const exp = Number(e.expiresAt);
  if (Number.isFinite(exp) && exp > 0 && now > exp) return 'expired';
  const staleDays = Number(cfg.staleDays) || 0;
  if (staleDays > 0) {
    const at = Number(e.lastMentionAt || e.createdAt || 0);
    if (at > 0 && now - at > staleDays * DAY_MS) return 'stale';
  }
  return 'active';
}

// 中文没有天然分词，用字符 bigram 的 Jaccard 当"是不是同一件事"的近似。
export function bigramSimilarity(a, b) {
  const norm = (s) => String(s ?? '')
    .toLowerCase()
    .replace(/[\s，。、；：？！…—－·"'“”‘’（）()【】\[\]《》<>~!?.,:;]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const gx = grams(x);
  const gy = grams(y);
  if (!gx.size || !gy.size) return 0;
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  return inter / (gx.size + gy.size - inter);
}

// 能进提示词的条目（还没排序、没装箱）。
export function injectableEntries(entries, cfg = {}, now = Date.now()) {
  const list = Array.isArray(entries) ? entries : [];
  return list.filter((e) => entryState(e, cfg, now) === 'active');
}

// 按预算装箱：优先"最近还提到过"的，装不下就整条跳过，最后按时间顺序输出。
export function packByBudget(entries, maxTotalChars, maxEntries = 0) {
  const budget = Math.max(0, Number(maxTotalChars) || 0);
  const cap = Number(maxEntries) > 0 ? Number(maxEntries) : Infinity;
  const ranked = [...entries].sort(
    (a, b) => Number(b.lastMentionAt || b.createdAt || 0) - Number(a.lastMentionAt || a.createdAt || 0)
  );
  const picked = [];
  let used = 0;
  for (const e of ranked) {
    if (picked.length >= cap) break;
    const len = entryText(e).length;
    if (len <= 0) continue;
    if (used + len > budget) continue;
    used += len;
    picked.push(e);
  }
  picked.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  return picked;
}

export function selectInjectable(entries, cfg = {}, now = Date.now()) {
  return packByBudget(injectableEntries(entries, cfg, now), cfg.maxTotalChars, cfg.maxEntries);
}

// 清理：inactive 只保留最近 maxInactiveKeep 条；总量超 maxEntries 时先丢 inactive，
// 再丢未确认，最后才动最久没提过的已确认条目。
export function trimEntries(entries, cfg = {}, now = Date.now()) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && entryText(e)) : [];
  const keepInactive = Math.max(0, Number(cfg.maxInactiveKeep) || 0);
  const maxEntries = Math.max(1, Number(cfg.maxEntries) || 30);
  const inactiveAt = (e) => Number(e.supersededAt || e.expiresAt || e.createdAt || 0);
  const inactive = list.filter((e) => entryState(e, cfg, now) !== 'active');
  const active = list.filter((e) => entryState(e, cfg, now) === 'active');
  // 先把 inactive 裁剪到 maxInactiveKeep（留最近的）
  let kept = inactive;
  if (inactive.length > keepInactive) {
    const sorted = [...inactive].sort((a, b) => inactiveAt(b) - inactiveAt(a));
    kept = sorted.slice(0, keepInactive);
  }
  let out = [...active, ...kept];
  while (out.length > maxEntries) {
    const idxInactive = out.findIndex((e) => entryState(e, cfg, now) !== 'active');
    if (idxInactive >= 0) {
      let oldest = idxInactive;
      for (let i = 0; i < out.length; i++) {
        if (entryState(out[i], cfg, now) === 'active') continue;
        if (inactiveAt(out[i]) < inactiveAt(out[oldest])) oldest = i;
      }
      out.splice(oldest, 1);
      continue;
    }
    const idxPending = out.findIndex((e) => e.confirmed !== true);
    if (idxPending >= 0) { out.splice(idxPending, 1); continue; }
    let oldest = 0;
    for (let i = 1; i < out.length; i++) {
      if (Number(out[i].lastMentionAt || 0) < Number(out[oldest].lastMentionAt || 0)) oldest = i;
    }
    out.splice(oldest, 1);
  }
  return out;
}

function newId(now) {
  return `lt${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// 写入一条（含去重 / 同 topic 作废 / 近似合并）。
// input: { text, topic, kind, expiresAt, confirmed, now, cfg }
// 返回 { entries, action, entry, superseded: [id] }
//   action: 'deduped' 逐字重复被刷新 | 'reactivated' 旧的作废条目被重新提及而复活
//           | 'merged' 高度相似被合并进旧条目 | 'created' 新增
export function applyAppend(entries, input = {}) {
  const cfg = input.cfg || {};
  const now = Number(input.now) || Date.now();
  const text = String(input.text ?? '').trim();
  const list = Array.isArray(entries) ? entries.slice() : [];
  if (!text) return { entries: list, action: 'noop', entry: null, superseded: [] };

  // 1) 逐字相同：刷新时钟；如果它之前被作废，这次"又被提起"说明还成立 → 复活。
  const exact = list.find((e) => e && entryText(e) === text);
  if (exact) {
    exact.lastMentionAt = now;
    exact.hits = (Number(exact.hits) || 0) + 1;
    if (input.confirmed === true) exact.confirmed = true;
    let action = 'deduped';
    if (exact.active === false || exact.supersededBy) {
      exact.active = true;
      exact.supersededBy = null;
      exact.supersededAt = null;
      action = 'reactivated';
    }
    return { entries: list, action, entry: exact, superseded: [] };
  }

  const kind = LONGTERM_KINDS.includes(String(input.kind || '')) ? String(input.kind) : 'fact';
  const topic = String(input.topic ?? '').trim() || null;
  let expiresAt = Number(input.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    const ttlDays = Number(cfg.eventTtlDays);
    expiresAt = kind === 'event' && ttlDays > 0 ? now + ttlDays * DAY_MS : 0;
  }

  // 2) 没给 topic 时用相似度兜底：≥ mergeSimilarity（默认 0.85）视为同一句的不同说法，
  //    合并进旧条目（用更新的措辞），不再新增一条。低于阈值的宁可并存，也不猜。
  const mergeSim = Number(cfg.mergeSimilarity) > 0 ? Number(cfg.mergeSimilarity) : 0.85;
  if (!topic) {
    let best = null;
    let bestSim = 0;
    for (const e of list) {
      if (!e || entryState(e, cfg, now) !== 'active') continue;
      const sim = bigramSimilarity(entryText(e), text);
      if (sim > bestSim) { bestSim = sim; best = e; }
    }
    if (best && bestSim >= mergeSim) {
      if (text.length > entryText(best).length) best.text = text;
      best.lastMentionAt = now;
      best.hits = (Number(best.hits) || 0) + 1;
      if (input.confirmed === true) best.confirmed = true;
      return { entries: list, action: 'merged', entry: best, superseded: [] };
    }
  }

  // 3) 新增
  const entry = {
    id: newId(now),
    text,
    createdAt: now,
    lastMentionAt: now,
    confirmed: input.confirmed === true,
    hits: 1,
    active: true,
    kind,
    topic,
    expiresAt: expiresAt > 0 ? expiresAt : 0,
    supersededBy: null,
    supersededAt: null
  };

  // 4) 同 topic 的活跃条目一律标记作废（内容保留，可回滚）。
  const superseded = [];
  if (topic && cfg.supersedeEnabled !== false) {
    for (const e of list) {
      if (!e || e.id === entry.id) continue;
      if (entryState(e, cfg, now) !== 'active') continue;
      const t = String(e.topic || '').trim();
      if (t !== topic) continue;
      e.active = false;
      e.supersededBy = entry.id;
      e.supersededAt = now;
      superseded.push(e.id);
    }
  }

  list.push(entry);
  return { entries: list, action: 'created', entry, superseded };
}
