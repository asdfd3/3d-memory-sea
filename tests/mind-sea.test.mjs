// 意识海纯函数单测：node scripts/test-mind-sea.mjs
import assert from 'node:assert/strict';
import {
  MIND_SEA_DEFAULTS,
  buildScene,
  collectPoints,
  guessTopic,
  keywordsOf,
  linkPoints,
  normalizePoint,
  pointFromLongTerm,
  pointFromMessage,
  pointId,
  sectorOf,
  SECTOR_LABELS,
} from '../src/mind-sea.js';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('guessTopic 命中话题词典，猜不出返回空串', () => {
  assert.equal(guessTopic('今天月考数学考了 125 分'), 'exam');
  assert.equal(guessTopic('晚上好喵'), 'greeting');
  assert.equal(guessTopic('嗯'), '');
});

test('sectorOf 把日常碎话分到语用簇', () => {
  assert.equal(sectorOf('抱抱～想你'), '撒娇');
  assert.equal(sectorOf('哈哈草，绷不住了'), '玩梗');
  assert.equal(sectorOf('你冷不冷，穿厚点'), '关心');
  assert.equal(sectorOf('你几点回来呀？'), '问句');
  assert.equal(sectorOf('嗯嗯好'), '应答');
  assert.equal(sectorOf('电脑又蓝屏了'), '技术');
  assert.equal(sectorOf('那就这样吧'), '其他');
});

test('buildScene 给 misc 点补 cluster 与 byCluster 统计', () => {
  const now = 1_700_000_000_000;
  const points = [
    normalizePoint({ text: '哈哈笑死我了', t: now - 3000 }),
    normalizePoint({ text: '抱抱蹭蹭', t: now - 2000 }),
    pointFromLongTerm({ id: 'lt1', text: '他是走读生', topic: 'owner-profile', active: true, createdAt: now - 1000 }, { now }),
  ].filter(Boolean);
  const scene = buildScene({ points, now });
  const misc = scene.points.filter((p) => p.topic === 'misc');
  assert.ok(misc.length >= 2, 'misc 点丢了');
  const labels = Object.values(SECTOR_LABELS);
  for (const point of misc) {
    assert.ok(point.cluster && !point.cluster.includes('-'), `簇名还是 slug: ${point.cluster}`);
    assert.ok(labels.includes(point.cluster), `簇名不在中文表里: ${point.cluster}`);
  }
  assert.ok(scene.stats.byCluster['撒娇黏人'] >= 1, `byCluster 不对: ${JSON.stringify(scene.stats.byCluster)}`);
  assert.equal(scene.points.find((p) => p.topic === 'owner-profile').cluster, '主人是谁');
});

test('keywordsOf 抽中文 bigram 且滤掉停用字', () => {
  const keys = keywordsOf('今天月考数学考了 125 分');
  assert.ok(keys.length >= 3, `关键词太少: ${keys.join(',')}`);
  assert.ok(keys.some((k) => k.includes('月考') || k.includes('数学')), `没抓到主题词: ${keys.join(',')}`);
  for (const key of keys) {
    assert.ok(![...key].every((ch) => '的了是我你他'.includes(ch)), `停用字混进来: ${key}`);
  }
});

test('normalizePoint 拒绝过短文本', () => {
  assert.equal(normalizePoint({ text: '嗯' }), null);
  assert.equal(normalizePoint({ text: '   ' }), null);
});

test('normalizePoint 截断到 textMax 且补默认值', () => {
  const point = normalizePoint({ text: '一'.repeat(200), t: 1_700_000_000_000 });
  assert.equal(point.text.length, MIND_SEA_DEFAULTS.textMax);
  assert.equal(point.kind, 'event');
  assert.equal(point.topic, 'misc');
  assert.ok(point.weight > 0);
  assert.ok(point.id.startsWith('ms_'));
});

test('pointId 对同一时刻同一文本稳定', () => {
  const a = pointId('他说今天好累', 1_700_000_000_000);
  const b = pointId('他说今天好累', 1_700_000_000_000);
  const c = pointId('他说今天好累', 1_700_000_000_001);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('pointFromLongTerm 映射 kind/权重/来源', () => {
  const active = pointFromLongTerm({ id: 'ltm1', text: '他是走读生，每周日放假', kind: 'promise', topic: 'profile', active: true, createdAt: 1_700_000_000_000 });
  assert.equal(active.kind, 'plan');
  assert.equal(active.topic, 'profile');
  assert.equal(active.weight, 3);
  assert.deepEqual(active.source, { type: 'longterm', id: 'ltm1' });
  const superseded = pointFromLongTerm({ id: 'ltm2', text: '他要去月考了', kind: 'event', topic: 'exam', active: false, createdAt: 1_700_000_000_000 });
  assert.equal(superseded.weight, 1.5);
});

test('pointFromMessage 跳过媒体占位、过短消息与她的碎句', () => {
  assert.equal(pointFromMessage({ text: '[图片]' }), null);
  assert.equal(pointFromMessage({ text: '在吗' }), null);
  assert.equal(pointFromMessage({ text: '哦', isSelf: true }), null, '她自己的碎句不该进意识海');
  const point = pointFromMessage({ text: '明早八点起不来，闹钟又没响', time: 1_700_000_000_000, isOwner: true, isSelf: false });
  assert.ok(point);
  assert.equal(point.weight, 1.3);
  assert.equal(point.source.type, 'message');
  const mine = pointFromMessage({ text: '那你把闹钟放远一点，起来关掉就不困了', isSelf: true, time: 1_700_000_100_000 });
  assert.ok(mine, '成句的回应应该保留');
  assert.equal(mine.weight, 1);
});

test('pointFromMessage 支持外部主题归类器', () => {
  const point = pointFromMessage(
    { text: '月考数学考了 125 分', isOwner: true, isSelf: false, time: 1_700_000_000_000 },
    { topicOf: () => 'exam-score' }
  );
  assert.equal(point.topic, 'exam-score');
});

test('collectPoints 去重并按时间升序', () => {
  const now = 1_700_000_000_000;
  const points = collectPoints({
    longTerm: [{ id: 'a', text: '他喜欢我用语音讲知识点', kind: 'preference', topic: 'voice', createdAt: now + 5000 }],
    messages: [
      { text: '今天月考数学考了 125 分', at: now },
      { text: '今天月考数学考了 125 分', at: now },
    ],
    now,
  });
  assert.equal(points.length, 2);
  assert.ok(points[0].t <= points[1].t);
});

test('linkPoints 把同主题的两条连起来', () => {
  const points = [
    normalizePoint({ text: '月考数学 125 分，班一 132', t: 1_700_000_000_000, topic: 'exam' }),
    normalizePoint({ text: '月考 10 月 13 到 14 号考完', t: 1_700_000_100_000, topic: 'exam' }),
  ];
  const edges = linkPoints(points);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, 'topic');
  assert.ok(edges[0].score >= MIND_SEA_DEFAULTS.minEdgeScore);
});

test('linkPoints 靠共享关键词也能连线（主题不同）', () => {
  const points = [
    normalizePoint({ text: '晚自习上到九点半，他跟老师吵起来了', t: 1_700_000_000_000, topic: 'school' }),
    normalizePoint({ text: '晚自习取消了，他吵赢了', t: 1_700_000_050_000, topic: 'misc' }),
  ];
  const edges = linkPoints(points);
  assert.ok(edges.length >= 1, '共享关键词的点没连上');
});

test('linkPoints 每个点最多 maxNeighbors 条边', () => {
  const points = [];
  for (let i = 0; i < 30; i += 1) {
    points.push(normalizePoint({ text: `今天又聊到月考的事情第${i}次`, t: 1_700_000_000_000 + i * 1000, topic: 'exam' }));
  }
  const edges = linkPoints(points, { ...MIND_SEA_DEFAULTS, maxNeighbors: 3 });
  const degree = new Map();
  for (const edge of edges) {
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
  }
  for (const [id, count] of degree) {
    assert.ok(count <= 3, `点 ${id} 度数 ${count} 超过上限`);
  }
  assert.ok(edges.length > 0);
});

test('buildScene 统计 byKind/byTopic/focus 与跨度', () => {
  const points = [
    normalizePoint({ text: '他说今天好累，加班到十点', t: 1_700_000_000_000, topic: 'work' }),
    normalizePoint({ text: '他夸我声音好听', t: 1_700_000_900_000, topic: 'voice', kind: 'feeling' }),
  ];
  const scene = buildScene({ points, focusIds: [points[1].id], now: 1_700_001_000_000 });
  assert.equal(scene.stats.total, 2);
  assert.equal(scene.stats.focusCount, 1);
  assert.equal(scene.stats.byTopic.voice, 1);
  assert.equal(scene.stats.byKind.feeling, 1);
  assert.equal(scene.stats.span.from, 1_700_000_000_000);
  assert.equal(scene.stats.generatedAt, 1_700_001_000_000);
});

test('buildScene 只保留最后 maxPoints 个点', () => {
  const points = [];
  for (let i = 0; i < 20; i += 1) points.push(normalizePoint({ text: `第${i}件事发生了`, t: 1_700_000_000_000 + i }));
  const scene = buildScene({ points, cfg: { ...MIND_SEA_DEFAULTS, maxPoints: 5 } });
  assert.equal(scene.points.length, 5);
  assert.equal(scene.stats.total, 5);
});

for (const [name, fn] of cases) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${cases.length} passed`);
