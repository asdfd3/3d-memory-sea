// memory-store 的单测（纯逻辑，不需要起桥接）。
// 跑法：node scripts/test-memory-store.mjs
import assert from 'node:assert/strict';
import {
  applyAppend,
  bigramSimilarity,
  entryState,
  packByBudget,
  selectInjectable,
  trimEntries
} from '../src/memory-store.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;
const cfg = {
  maxEntries: 30,
  maxCharsPerEntry: 80,
  maxTotalChars: 1500,
  staleDays: 90,
  eventTtlDays: 14,
  supersedeEnabled: true,
  mergeSimilarity: 0.85,
  maxInactiveKeep: 200
};

const mk = (id, text, extra = {}) => ({
  id,
  text,
  createdAt: NOW - 10 * DAY,
  lastMentionAt: NOW - 10 * DAY,
  confirmed: true,
  hits: 1,
  active: true,
  kind: 'fact',
  topic: null,
  expiresAt: 0,
  supersededBy: null,
  supersededAt: null,
  ...extra
});

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

check('entryState 区分 pending/superseded/expired/stale', () => {
  assert.equal(entryState(mk('a', 'x'), cfg, NOW), 'active');
  assert.equal(entryState(mk('a', 'x', { confirmed: false }), cfg, NOW), 'pending');
  assert.equal(entryState(mk('a', 'x', { active: false }), cfg, NOW), 'superseded');
  assert.equal(entryState(mk('a', 'x', { supersededBy: 'b' }), cfg, NOW), 'superseded');
  assert.equal(entryState(mk('a', 'x', { expiresAt: NOW - 1 }), cfg, NOW), 'expired');
  assert.equal(entryState(mk('a', 'x', { lastMentionAt: NOW - 91 * DAY }), cfg, NOW), 'stale');
});

check('bigramSimilarity：同义改写高、无关低', () => {
  const hi = bigramSimilarity('他的考试在 13-14 两天', '他的考试在 13 到 14 两天');
  const lo = bigramSimilarity('他的考试在 13-14 两天', '他喜欢我用语音讲知识点');
  assert.ok(hi > 0.6, `hi=${hi}`);
  assert.ok(lo < 0.2, `lo=${lo}`);
});

check('同 topic 新条目 → 旧条目标记作废（内容保留）', () => {
  const entries = [mk('old', '学校要求上晚自习到 21:30', { topic: 'evening-study', kind: 'event' })];
  const res = applyAppend(entries, { text: '10/17 晚吵赢了，晚自习不上了', topic: 'evening-study', kind: 'fact', confirmed: true, cfg, now: NOW });
  assert.equal(res.action, 'created');
  assert.deepEqual(res.superseded, ['old']);
  const old = res.entries.find((e) => e.id === 'old');
  assert.equal(old.active, false);
  assert.equal(old.supersededBy, res.entry.id);
  assert.equal(old.text, '学校要求上晚自习到 21:30', '内容必须原样保留');
  assert.equal(selectInjectable(res.entries, cfg, NOW).length, 1);
});

check('逐字重复 → 刷新；被作废的再被提到 → 复活', () => {
  const entries = [mk('old', '他喜欢我用语音讲知识点', { topic: 'voice-pref' })];
  const first = applyAppend(entries, { text: '他喜欢我用语音讲知识点', confirmed: true, cfg, now: NOW });
  assert.equal(first.action, 'deduped');
  assert.equal(first.entries[0].lastMentionAt, NOW);

  const dead = [mk('dead', '语音挂了', { active: false, supersededBy: 'x', supersededAt: NOW - DAY })];
  const revived = applyAppend(dead, { text: '语音挂了', confirmed: true, cfg, now: NOW });
  assert.equal(revived.action, 'reactivated');
  assert.equal(revived.entries[0].active, true);
  assert.equal(revived.entries[0].supersededBy, null);
});

check('高相似但无 topic → 合并进旧条目，不新增', () => {
  const entries = [mk('a', '他的考试在 13-14 两天')];
  const res = applyAppend(entries, { text: '他的考试在 13-14 两天了', confirmed: true, cfg, now: NOW });
  assert.equal(res.action, 'merged');
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].id, 'a');
  assert.equal(res.entries[0].text, '他的考试在 13-14 两天了', '合并时保留更新的措辞');
});

check('中等相似（0.6~0.85）不合并：阈值保守，宁可并存', () => {
  const entries = [mk('a', '他的考试在 13-14 两天')];
  const sim = bigramSimilarity('他的考试在 13-14 两天', '考试在 13-14 两天');
  assert.ok(sim > 0.5 && sim < 0.85, `sim=${sim}`);
  const res = applyAppend(entries, { text: '考试在 13-14 两天', confirmed: true, cfg, now: NOW });
  assert.equal(res.action, 'created');
  assert.equal(res.entries.length, 2);
});

check('低相似不合并（宁可并存，不乱猜）', () => {
  const entries = [mk('a', '他的考试在 13-14 两天')];
  const res = applyAppend(entries, { text: '学校不让带手机，白天联系不上', confirmed: true, cfg, now: NOW });
  assert.equal(res.action, 'created');
  assert.equal(res.entries.length, 2);
});

check('event 自动带 14 天有效期，fact 不过期', () => {
  const events = applyAppend([], { text: '今天语音挂了', kind: 'event', confirmed: true, cfg, now: NOW });
  assert.equal(events.entry.expiresAt, NOW + 14 * DAY);
  const facts = applyAppend([], { text: '他走读', kind: 'fact', confirmed: true, cfg, now: NOW });
  assert.equal(facts.entry.expiresAt, 0);
});

check('预算装箱：装不下整条跳过，优先最近提到的', () => {
  const entries = [
    mk('long', 'x'.repeat(60), { lastMentionAt: NOW - 20 * DAY }),
    mk('recent', 'y'.repeat(60), { lastMentionAt: NOW - 1 * DAY }),
    mk('older', 'z'.repeat(20), { lastMentionAt: NOW - 40 * DAY })
  ];
  const picked = packByBudget(entries, 80);
  assert.deepEqual(picked.map((e) => e.id).sort(), ['older', 'recent'].sort(), '最近的两条优先，长的被跳过');
  assert.ok(picked.reduce((n, e) => n + e.text.length, 0) <= 80);
});

check('作废条目不进注入，但超量时先被裁', () => {
  const entries = [
    mk('a1', '活1'),
    mk('a2', '活2'),
    mk('d1', '死1', { active: false, supersededAt: NOW - 5 * DAY }),
    mk('d2', '死2', { active: false, supersededAt: NOW - 1 * DAY })
  ];
  assert.equal(selectInjectable(entries, cfg, NOW).length, 2);
  const trimmed = trimEntries(entries, { ...cfg, maxEntries: 3 }, NOW);
  assert.equal(trimmed.length, 3);
  assert.equal(trimmed.some((e) => e.id === 'd1'), false, '应裁掉最老的作废条目');
});

console.log(`\n${passed} passed, exitCode=${process.exitCode || 0}`);
