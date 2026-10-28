// C 阶段：检索式记忆。
//
// B 解决「旧结论顶掉新结论」，D 解决「不用人提醒就能记」，C 解决「记得多了怎么挑」：
// 长期记忆从 30 条上限的小池子，扩到 500–2000 条的库；每次唤醒**按当前对话**挑 6–10 条注入，
// 而不是把"最近提过的"一股脑塞进去（那样老结论会被最近闲聊挤掉，库越大越糟）。
//
// 全部是纯函数，bridge.js 只负责取数据、组装查询串、注入与调试视图。

import { entryState } from './memory-store.js';

const CJK = /[\u4e00-\u9fff]/;
// 只用来砍掉「的/了/是」这类高频虚词组成的 bigram，避免"我的""他的"占满重叠分。
const STOP_CHARS = new Set('的了是在我他她你您我们这就都很也还又和与及而但所以因为如果这个那个一些什么怎么可以不是没有一自己现在时候这样那样东西事情吗呢吧啊哦呀嘛啦么'.split(''));
const ASCII_STOP = new Set(['the', 'and', 'for', 'you', 'are', 'was', 'his', 'her', 'that', 'this', 'with', 'have', 'has']);

export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const run of s.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      if (!STOP_CHARS.has(run)) out.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const bg = run.slice(i, i + 2);
      if (STOP_CHARS.has(bg[0]) && STOP_CHARS.has(bg[1])) continue;
      out.add(bg);
    }
  }
  for (const w of s.match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []) {
    if (!ASCII_STOP.has(w)) out.add(w);
  }
  return out;
}

function daysBetween(a, b) {
  const d = (Number(b) - Number(a)) / 86400000;
  return Number.isFinite(d) ? Math.max(0, d) : 0;
}

// 时段/场景联想：一句「晚上好」没有查询词，但它在问"这个点你在干嘛"。
// 命中这些模式时，给对应主题的条目加一点分，让作息/上学这类底账能进候选。
export const CUE_RULES = Object.freeze([
  [/晚上好|晚安|睡了|困了|熬夜|睡觉|这个点/, ['sleep', 'evening-study']],
  [/早上好|早安|起床|上学|出门|到校/, ['school', 'exam-schedule']],
  [/放学|回家|到家|晚自习|几点回/, ['evening-study', 'school']],
  [/考完|月考|考试|分数|成绩|排名/, ['exam-schedule', 'exam-score', 'exam-day']],
]);

function cueTopicsFor(text) {
  const set = new Set();
  const q = String(text ?? '');
  if (!q) return set;
  for (const [re, topics] of CUE_RULES) {
    if (re.test(q)) for (const t of topics) set.add(t);
  }
  return set;
}

// 单条打分：词汇重叠（按逆文档频率加权）为主，其次是 topic 直接命中与"最近提过"。
export function scoreEntry(entry, queryTokens, { now = Date.now(), df = new Map(), total = 1, queryText = '' } = {}) {
  const text = String(entry?.text ?? '');
  const tokens = tokenize(`${text} ${entry?.topic ?? ''}`);
  let overlap = 0;
  const hits = [];
  for (const t of tokens) {
    if (!queryTokens.has(t)) continue;
    const n = df.get(t) ?? 1;
    overlap += Math.log(1 + total / Math.max(1, n));
    if (hits.length < 4 && t.length >= 2) hits.push(t);
  }
  const norm = overlap / (1 + overlap);
  const topic = String(entry?.topic ?? '').trim();
  const topicHit = topic && queryText && (queryText.includes(topic) || topic.split('-').some((p) => p.length >= 3 && queryText.includes(p))) ? 1 : 0;
  const recency = Math.exp(-daysBetween(entry?.lastMentionAt || entry?.createdAt || 0, now) / 45);
  const kindWeight = entry?.kind === 'fact' ? 0.3 : entry?.kind === 'promise' ? 0.25 : 0.15;
  const score = 2.2 * norm + 1.2 * topicHit + 1.0 * recency + kindWeight;
  const reasons = [];
  if (hits.length) reasons.push(`重叠:${hits.join('/')}`);
  if (topicHit) reasons.push(`主题:${topic}`);
  reasons.push(`召回:${Math.round(recency * 100)}%`);
  if (entry?.kind === 'fact') reasons.push('事实');
  return { score: Math.round(score * 1000) / 1000, reasons, overlap: norm, topicHit, recency };
}

// 从库里挑这次要注入的条目。
// 规则：只挑 entryState==='active'（已确认/未作废/未过期/未过时）→ 打分 →
// 核心主题保底（最多 2 条，保证"主人是谁"这类永远在场）→ 其余按分数取满 maxInject
// → 最后按 budgetChars 装箱（装不下就跳过，继续试后面分数低的短条目）。
export function selectRelevant(entries, {
  queryText = '',
  now = Date.now(),
  cfg = {},
  maxInject = 8,
  budgetChars = 1600,
  coreTopics = ['profile', 'owner-profile'],
  fillMin = 4,
  fillMax = 6
} = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const eligible = [];
  for (const e of list) {
    if (entryState(e, cfg, now) !== 'active') continue;
    eligible.push(e);
  }
  if (!eligible.length) return { selected: [], dropped: [], considered: 0, eligible: 0, pool: list.length, queryTokens: 0, chars: 0 };

  const qText = String(queryText ?? '').trim();
  const queryTokens = tokenize(qText);
  const cueTopics = cueTopicsFor(qText);
  // 逆文档频率：在全库里数每个 token 出现在多少条里，常见词权重低。
  const df = new Map();
  const perEntry = [];
  for (const e of eligible) {
    const toks = tokenize(`${e.text ?? ''} ${e.topic ?? ''}`);
    perEntry.push(toks);
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const scored = eligible.map((e, i) => {
    const s = scoreEntry(e, queryTokens, { now, df, total: eligible.length, queryText: qText });
    const isCore = coreTopics.includes(String(e.topic ?? ''));
    const cue = cueTopics.has(String(e.topic ?? ''));
    if (cue) {
      s.score = Math.round((s.score + 0.9) * 1000) / 1000;
      s.reasons = [...s.reasons, '时段联想'];
    }
    return { entry: e, ...s, core: isCore, cue, tokens: perEntry[i] };
  });

  const max = Math.max(1, Math.min(20, Number(maxInject) || 8));
  const byScore = [...scored].sort((a, b) => b.score - a.score || Number(b.entry.lastMentionAt || 0) - Number(a.entry.lastMentionAt || 0));

  const picked = [];
  const pickedIds = new Set();
  const take = (item) => {
    const id = String(item.entry.id ?? item.entry.text);
    if (pickedIds.has(id)) return;
    pickedIds.add(id);
    picked.push(item);
  };
  const pickedChars = () => picked.reduce((sum, item) => sum + String(item.entry.text ?? '').trim().length, 0);
  if (qText) {
    // 有查询串：核心主题保底最多 2 条，然后只补"确实沾边"的（重叠/topic 命中/核心）。
    // 不沾边的不许拿来凑数——库越大，凑数越像噪音。
    for (const item of byScore.filter((x) => x.core).slice(0, 2)) take(item);
    for (const item of byScore) {
      if (picked.length >= max) break;
      if (item.overlap > 0 || item.topicHit || item.core || item.cue) take(item);
    }
  } else {
    // 没有查询串（比如只有一张图）：退化为"最近提过优先"，等价于 C 之前的行为。
    const recent = [...scored].sort((a, b) => Number(b.entry.lastMentionAt || 0) - Number(a.entry.lastMentionAt || 0));
    for (const item of recent) {
      if (picked.length >= max) break;
      take(item);
    }
  }

  // 兜底：短问候（"晚上好""在干嘛"）几乎没有查询词，只挑到 2–3 条的话，
  // 她的"作息/上学/手机"这类底账就不在场，只能拿模型常识补
  // 所以：入选不足 4 条，或占用预算不到 40% 时，按"最近提过"补齐到 6 条（仍然不许超预算）。
  const budget = Math.max(120, Number(budgetChars) || 1600);
  const minEntries = Math.min(fillMin, max);
  const fillTarget = Math.min(fillMax, max);
  let filledCount = 0;
  if (picked.length < minEntries || (pickedChars() < budget * 0.4 && picked.length < fillTarget)) {
    const byRecent = [...scored].sort((a, b) => (
      Number(b.entry.lastMentionAt || b.entry.createdAt || 0) - Number(a.entry.lastMentionAt || a.entry.createdAt || 0)
    ));
    for (const item of byRecent) {
      if (picked.length >= fillTarget) break;
      const id = String(item.entry.id ?? item.entry.text);
      if (pickedIds.has(id)) continue;
      const len = String(item.entry.text ?? '').trim().length;
      if (pickedChars() + len > budget) continue;
      item.reasons = [...(item.reasons ?? []), '兜底补齐'];
      item.filled = true;
      take(item);
      filledCount += 1;
    }
  }

  const selected = [];
  const dropped = [];
  let used = 0;
  for (const item of picked) {
    const len = String(item.entry.text ?? '').trim().length;
    if (used + len > budget && selected.length > 0) {
      dropped.push({ id: item.entry.id, text: String(item.entry.text ?? '').slice(0, 40), score: item.score, reason: '预算不足' });
      continue;
    }
    used += len;
    selected.push({
      id: item.entry.id,
      text: String(item.entry.text ?? '').trim(),
      topic: item.entry.topic ?? null,
      kind: item.entry.kind ?? null,
      score: item.score,
      core: item.core,
      reasons: item.reasons
    });
  }
  const selectedIds = new Set(selected.map((s) => s.id));
  const droppedAll = [
    ...dropped,
    ...byScore.filter((x) => !selectedIds.has(x.entry.id)).slice(0, 20).map((x) => ({
      id: x.entry.id, text: String(x.entry.text ?? '').slice(0, 40), score: x.score, reason: '未入选（分数低）'
    }))
  ];
  return {
    selected,
    dropped: droppedAll,
    considered: scored.length,
    eligible: eligible.length,
    pool: list.length,
    queryTokens: queryTokens.size,
    chars: used,
    filled: filledCount
  };
}

// 调试视图用：把结果压成一段可读文本（控制台直接显示）。
export function describeSelection(result, { limit = 30 } = {}) {
  const lines = [];
  lines.push(`库 ${result.pool ?? 0} 条 / 可用 ${result.eligible ?? 0} 条 / 查询词 ${result.queryTokens ?? 0} 个`);
  lines.push(`入选 ${result.selected?.length ?? 0} 条，共 ${result.chars ?? 0} 字`);
  for (const s of result.selected ?? []) {
    lines.push(`  ✓ [${s.score}] ${s.core ? '★' : ' '}${s.topic ?? '-'} | ${s.text}  ← ${s.reasons.join('，')}`);
  }
  const rest = (result.dropped ?? []).slice(0, limit);
  if (rest.length) {
    lines.push(`未入选 ${result.dropped.length} 条（前 ${rest.length}）：`);
    for (const d of rest) lines.push(`  · [${d.score}] ${d.id} | ${d.text}  ← ${d.reason}`);
  }
  return lines.join('\n');
}
