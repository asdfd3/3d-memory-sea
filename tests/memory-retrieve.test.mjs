// C 阶段单测：检索式记忆（纯函数，不需要桥接/模型）
// 运行：node scripts/test-memory-retrieve.mjs

import assert from 'node:assert/strict';
import { tokenize, scoreEntry, selectRelevant, describeSelection } from '../src/memory-retrieve.js';
import { entryState } from '../src/memory-store.js';

const NOW = Date.parse('2026-10-18T12:00:00+08:00');
const CFG = { maxTotalChars: 1500, maxCharsPerEntry: 80, maxEntries: 2000, staleDays: 90, eventTtlDays: 14 };
let pass = 0;
let total = 0;
const ok = (name, fn) => {
  total += 1;
  try { fn(); pass += 1; console.log(`  ok ${name}`); } catch (e) { console.error(`  FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
};
const mk = (id, text, extra = {}) => ({
  id, text, confirmed: true, active: true, topic: 'misc', kind: 'fact',
  createdAt: NOW - 86400000, lastMentionAt: NOW - 86400000, ...extra
});

ok('tokenize: 中文 bigram + ASCII + 去虚词 bigram', () => {
  const t = tokenize('数学考了一百二十五分 math 125');
  assert.ok(t.has('数学') && t.has('一百') && t.has('math'));
  assert.ok(!t.has('的了') && !t.has('一的'));
});

ok('tokenize: 空串安全', () => {
  assert.equal(tokenize('').size, 0);
  assert.equal(tokenize(null).size, 0);
});

ok('scoreEntry: 相关条目 > 不相关条目', () => {
  const q = tokenize('明天月考数学考得怎么样');
  const df = new Map(); // 空 df，命中都按 1 算
  const a = scoreEntry(mk('a', '月考 10/20 开始，数学是重点'), q, { now: NOW, total: 10, queryText: '明天月考数学考得怎么样' });
  const b = scoreEntry(mk('b', '他喜欢喝冰美式'), q, { now: NOW, total: 10, queryText: '明天月考数学考得怎么样' });
  assert.ok(a.score > b.score, `a=${a.score} b=${b.score}`);
  assert.ok(a.reasons.some((r) => r.startsWith('重叠:')));
});

ok('scoreEntry: 刚提过的比三个月前的分高（recency）', () => {
  const q = tokenize('喜欢什么');
  const fresh = scoreEntry(mk('f', '喜欢冰美式', { lastMentionAt: NOW - 3600000 }), q, { now: NOW, total: 2 });
  const old = scoreEntry(mk('o', '喜欢冰美式', { lastMentionAt: NOW - 80 * 86400000 }), q, { now: NOW, total: 2 });
  assert.ok(fresh.score > old.score);
});

ok('selectRelevant: 按查询选出相关条目', () => {
  const entries = [
    mk('a', '月考 10/13-14 已经考完了'),
    mk('b', '他喜欢我给他讲错题'),
    mk('c', '学校不让带手机，白天联系不上', { topic: 'school-phone' }),
    mk('d', '他数学 125 分，不想聊分数', { topic: 'exam-score' })
  ];
  const r = selectRelevant(entries, { queryText: '月考分数出来了吗，数学怎么样', now: NOW, cfg: CFG });
  const ids = r.selected.map((s) => s.id);
  assert.ok(ids.includes('d'), `应选 exam-score，实际 ${ids}`);
});

ok('selectRelevant: 核心主题保底注入（查询无关）', () => {
  const entries = [mk('a', '完全不相干的一句话'), mk('p', '他是一名走读生，每周日放假', { topic: 'owner-profile' })];
  const r = selectRelevant(entries, { queryText: '今天天气不错', now: NOW, cfg: CFG });
  const core = r.selected.find((s) => s.id === 'p');
  assert.ok(core && core.core === true, JSON.stringify(r.selected));
  assert.ok(core.reasons.length >= 2);
});

ok('selectRelevant: 作废/过期/未确认不进注入', () => {
  const entries = [
    mk('a', '活的', { topic: 'live' }),
    mk('b', '作废的', { topic: 'dead', active: false, supersededBy: 'a' }),
    mk('c', '过期的', { topic: 'exp', kind: 'event', expiresAt: NOW - 1000 }),
    mk('d', '没确认的', { topic: 'pending', confirmed: false })
  ];
  const r = selectRelevant(entries, { queryText: '活的 作废的 过期的 没确认的', now: NOW, cfg: CFG });
  assert.deepEqual(r.selected.map((s) => s.id), ['a']);
  assert.equal(r.eligible, 1);
});

ok('selectRelevant: 预算装箱（不超长、短条目可补位）', () => {
  const entries = [];
  for (let i = 0; i < 12; i += 1) entries.push(mk(`long${i}`, `月考相关很长的条目第${i}条`.repeat(6), { lastMentionAt: NOW - i * 1000 }));
  const r = selectRelevant(entries, { queryText: '月考', now: NOW, cfg: CFG, maxInject: 12, budgetChars: 200 });
  assert.ok(r.chars <= 200, `chars=${r.chars}`);
  assert.ok(r.selected.length >= 1);
  assert.ok(r.dropped.some((d) => d.reason === '预算不足'));
});

ok('selectRelevant: 无查询串时退化为最近提过', () => {
  const entries = [mk('old', '以前说的', { lastMentionAt: NOW - 30 * 86400000 }), mk('new', '刚说的', { lastMentionAt: NOW - 60000 })];
  const r = selectRelevant(entries, { queryText: '', now: NOW, cfg: CFG });
  assert.equal(r.selected[0].id, 'new');
});

ok('selectRelevant: 2000 条库性能 < 60ms', () => {
  const entries = [];
  for (let i = 0; i < 2000; i += 1) entries.push(mk(`e${i}`, `第${i}条记忆，关于月考、分数、晚自习、语音、表情包`, { topic: `t${i % 40}` }));
  const t0 = Date.now();
  const r = selectRelevant(entries, { queryText: '月考分数怎么样', now: NOW, cfg: CFG });
  const ms = Date.now() - t0;
  assert.ok(r.selected.length > 0 && r.selected.length <= 8);
  assert.ok(ms < 60, `耗时 ${ms}ms`);
});

ok('describeSelection 输出含入选与否决原因', () => {
  const r = selectRelevant([mk('a', '月考考完了', { topic: 'exam' }), mk('b', '别的')], { queryText: '月考', now: NOW, cfg: CFG });
  const text = describeSelection(r);
  assert.match(text, /入选 [1-9] 条/);
  assert.match(text, /✓|★/);
});

ok('与 memory-store 的 entryState 口径一致（stale 被排除）', () => {
  const stale = mk('s', '很久没提的', { lastMentionAt: NOW - 200 * 86400000 });
  assert.equal(entryState(stale, CFG, NOW), 'stale');
  const r = selectRelevant([stale], { queryText: '很久', now: NOW, cfg: CFG });
  assert.equal(r.selected.length, 0);
});

ok('selectRelevant: 短问候无查询词时兜底补齐到 fillMax', () => {
  const entries = [
    mk('p', '他是一名走读生，每周只有周日放假', { topic: 'owner-profile', lastMentionAt: NOW - 3 * 86400000 }),
    mk('es', '10/17 晚跟老师吵赢，晚自习不上了、照常放学', { topic: 'evening-study', lastMentionAt: NOW - 2 * 86400000 }),
    mk('ph', '学校不让带手机，白天联系不上', { topic: 'school-phone', lastMentionAt: NOW - 5 * 86400000 }),
    mk('ex', '10/13 月考第一天，考的科目他都擅长', { topic: 'exam-day', lastMentionAt: NOW - 6 * 86400000 }),
    mk('com', '他把作文正文拍给我看，写苏轼与东坡肉', { topic: 'composition', lastMentionAt: NOW - 8 * 86400000 }),
    mk('jp', '他说明年想去日本旅游', { topic: 'japan-trip', lastMentionAt: NOW - 9 * 86400000 })
  ];
  const r = selectRelevant(entries, { queryText: '晚上好', now: NOW, cfg: CFG, maxInject: 8, budgetChars: 1200 });
  assert.ok(r.selected.length >= 4, `只选了 ${r.selected.length} 条`);
  assert.ok(r.filled > 0, 'filled 应大于 0');
  assert.ok(r.selected.some((s) => s.id === 'es'), '晚自习那条应被兜底带进来');
  assert.ok(r.selected.every((s) => s.reasons.includes('兜底补齐') || s.score >= 0));
});

ok('selectRelevant: 查询词充足时不触发兜底', () => {
  const entries = [];
  for (let i = 0; i < 6; i += 1) entries.push(mk(`m${i}`, `月考分数数学${125 + i}分的记录，他不想聊分数`, { topic: 'exam-score', lastMentionAt: NOW - i * 3600000 }));
  const r = selectRelevant(entries, { queryText: '月考分数出来了吗数学怎么样', now: NOW, cfg: CFG, maxInject: 8, budgetChars: 1200 });
  assert.equal(r.filled, 0, `不应兜底，实际补了 ${r.filled} 条`);
  assert.ok(r.selected.length >= 4);
});

ok('selectRelevant: 兜底也不超预算', () => {
  const entries = [];
  for (let i = 0; i < 8; i += 1) entries.push(mk(`b${i}`, `这是一条比较长的记忆用来测试预算上限${i}`.repeat(3), { lastMentionAt: NOW - i * 1000 }));
  const r = selectRelevant(entries, { queryText: '晚上好', now: NOW, cfg: CFG, maxInject: 8, budgetChars: 200 });
  assert.ok(r.chars <= 200, `chars=${r.chars}`);
});

ok('selectRelevant: 时段联想把作息条目带进来（晚上好 → evening-study）', () => {
  const entries = [
    mk('core', '他是一名走读生', { topic: 'owner-profile' }),
    mk('late', '周四晚跟老师谈好了，晚自习不上了、照常放学', { topic: 'evening-study' }),
    mk('game', '他在玩《绝区零》', { topic: 'games', lastMentionAt: NOW }),
    mk('food', '他爱吃牛肉面', { topic: 'food', lastMentionAt: NOW - 1000 })
  ];
  const r = selectRelevant(entries, { queryText: '晚上好', now: NOW, cfg: CFG, maxInject: 6, budgetChars: 1200 });
  const topics = r.selected.map((s) => s.topic);
  assert.ok(topics.includes('evening-study'), `没带进作息条目: ${topics.join(',')}`);
  const hit = r.selected.find((s) => s.topic === 'evening-study');
  assert.ok(hit.reasons.includes('时段联想'), `缺时段联想理由: ${hit.reasons.join(',')}`);
});

console.log(`\n${pass}/${total} 通过`);
