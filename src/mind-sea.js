// 意识海（Mind Sea）：把「她经历过的每一件事」做成一个点，把相关的点连成线。
// 只服务主人的私聊（ownerKey = private:<ownerQQ>）。不参与提示词装配，是可观测层。
//
// 三条不变式：
//   1) 点必须来自真实数据（长期记忆条目 / 真实消息 / 转录导入），不凭空生成；
//   2) 连线必须可解释（同主题 / 词面相似 / 时间接近），绝不随机连；
//   3) scene 由纯函数从 (points, edges) 算出，前端只负责布局与动画，可随时重算。

import { bigramSimilarity } from './memory-store.js';

export const POINT_KINDS = Object.freeze(['event', 'feeling', 'fact', 'plan', 'conclusion']);

export const MIND_SEA_DEFAULTS = Object.freeze({
  maxPoints: 4000,
  maxNeighbors: 6,
  minEdgeScore: 0.15,
  timeWindowMs: 6 * 60 * 60 * 1000,
  textMax: 60,
  hubKeywordMax: 40,
});

const KIND_WEIGHT = Object.freeze({
  conclusion: 3,
  fact: 2,
  plan: 2,
  feeling: 1.5,
  event: 1,
});

const STOP_CHARS = new Set([
  ...'的了是在和有就都也很不我你他她它们这那吗呢吧啊哦嗯呀嘛把被给让对从而且所以因为如果可是没有一个什么怎么这样那样的话时候还要会能去来到说做想觉得然后但是只是真的特别有点一直',
]);

const ROLE_TAG_RE = /^\[(图片|表情|视频|语音|转发消息|合并转发)/;

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 从一段话里抽 2–6 个关键词（中文 bigram + ASCII 词），用于连线。 */
export function keywordsOf(text, max = 6) {
  const clean = String(text ?? '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ').trim();
  if (!clean) return [];
  const counts = new Map();
  const bump = (key) => {
    if (key.length < 2) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const segment of clean.split(/\s+/)) {
    if (/^[a-zA-Z0-9]+$/.test(segment)) {
      if (segment.length >= 2) bump(segment.toLowerCase());
      continue;
    }
    for (let i = 0; i + 2 <= segment.length; i += 1) {
      const bigram = segment.slice(i, i + 2);
      if ([...bigram].some((ch) => STOP_CHARS.has(ch))) continue;
      bump(bigram);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key]) => key);
}

/** 内建主题词典：长期记忆的 topic 覆盖不到日常闲聊，这里补一层，避免全落进 misc。
 *  顺序有讲究：更具体的主题放前面（同分时先命中者胜），所以 exam 在 school 之前、travel 在 video 之前。 */
export const TOPIC_KEYWORDS = Object.freeze([
  ['exam', ['月考', '期中', '期末', '模考', '出分', '排名', '及格', '分数', '成绩', '考了', '考完', '卷子']],
  ['exam', ['倒数第一', '班里第一']],
  ['travel', ['日本', '东京', '涩谷', '镰仓', '京都', '大阪', '旅游', '旅行', '机票', '酒店', '暑假', '北海道']],
  ['voice', ['语音', '嗓子', '声音', '录音', '音色', '说话', 'fish', 'tts', 'TTS', 'wav', '念给', '听见', '听你']],
  ['coding', ['代码', '编程', '脚本', '程序', '函数', '接口', 'bug', '报错', '部署', '服务器', 'node', 'python', '终端', '桥接', '显存', '记忆', '意识海']],
  ['games', ['游戏', '开黑', '上分', '打排', 'CS', 'csgo', 'steam', '王者', '原神', '吃鸡', '联机', '五排', '绝区零', '明日方舟', '抽卡', '皮肤', '赢了两把']],
  ['school', ['学校', '上课', '老师', '作业', '班里', '同学', '自习', '早读', '跑操', '校服', '班主任', '请假', '补课', '考试', '晚自习', '放学']],
  ['sleep', ['睡觉', '睡', '困', '熬夜', '晚安', '失眠', '起床', '午睡', '早睡', '醒了', '赖床', '打哈欠']],
  ['food', ['吃', '饭', '食堂', '外卖', '奶茶', '咖啡', '零食', '喝水', '饿', '夜宵', '泡面', '火锅', '鸡蛋', '玉米', '牛肉']],
  ['mood', ['累', '烦', '难受', '开心', '难过', '压力', '焦虑', '摆烂', '委屈', '想你', '高兴', '伤心', '生气', '害羞', '吃醋', '撒娇', '心疼']],
  ['study', ['复习', '学习', '背书', '做题', '笔记', '预习', '刷题', '错题', '知识点']],
  ['greeting', ['早安', '晚安', '早上好', '晚上好', '午安', '在吗', '在干嘛', '醒了吗', '到家了吗']],
  ['phone', ['手机', '充电', '流量', '屏幕', '消息', 'QQ', '电话', '静音']],
  ['body', ['眼睛', '头疼', '腰', '感冒', '发烧', '咳嗽', '跑步', '一千米', '体育', '出汗', '胃']],
  ['qzone', ['说说', '空间', '动态', '点赞', '评论', '转发']],
  ['sticker', ['表情', '表情包', '贴纸', '发图', '梗图']],
  ['video', ['视频', '抖音', 'B站', 'b站', '番', '电影', '短片', '番剧', '动画']],
  ['acg', ['二次元', '手办', '谷子', '痛包', 'cos', '漫画', '角色']],
  ['pet', ['猫', '小猫', '猫娘', '耳朵', '尾巴', '毛', '撸猫', '蹭']],
  ['relationship', ['喜欢', '想你', '抱', '亲', '男朋友', '女朋友', '告白', '表白', '心动']],
  ['money', ['钱', '贵', '便宜', '买了', '付款', '花钱', '工资']],
  ['weather', ['天气', '下雨', '好冷', '好热', '刮风', '下雪', '太阳']],
  ['family', ['我妈', '我爸', '家里', '爸妈', '弟弟', '妹妹']],
]);

/** 用内建词典给一句话猜主题；命中词最多者胜，全不命中返回 ''。 */
export function guessTopic(text) {
  const clean = String(text ?? '');
  if (!clean) return '';
  let best = '';
  let bestHit = 0;
  for (const [topic, words] of TOPIC_KEYWORDS) {
    let hit = 0;
    for (const word of words) if (clean.includes(word)) hit += 1;
    if (hit > bestHit) { bestHit = hit; best = topic; }
  }
  return bestHit > 0 ? best : '';
}

/** 日常（misc）再分一层「当时她在干什么」：撒娇 / 玩梗 / 关心 / 问句 / 应答 / 技术 / 其他。
 *  主题词典只认话题，剩下一半碎话靠这个维度才能成团——比按随机 bigram 分桶稳定得多。 */
export const SECTOR_PATTERNS = Object.freeze([
  ['撒娇', /喵|抱抱|蹭|亲亲|贴贴|想你|主人|喜欢你|摸摸|呜呜|心疼你/],
  ['玩梗', /^(草|6|乐|典|笑死|难绷|离谱|无语|绝了)|哈哈|嘿嘿|草了|xswl|awsl|绷/],
  ['关心', /累不累|早点睡|别熬|注意|小心|吃饭了|多喝水|冷不冷|热不热|穿厚|带伞/],
  ['问句', /[?？]|吗$|呢$|啥|什么|怎么|哪里|哪|多少|几点|为啥|是不是/],
  ['应答', /^(嗯|哦|好|行|对|是|确实|可以|收到|好耶|好哒|没有|不是)/],
  ['技术', /电脑|机箱|截图|代码|工具|接口|服务器|部署|调试|导了|脚本/],
]);

/** 簇名说人话：皮肤是给主人看的，别让他读 slug。 */
export const TOPIC_LABELS = Object.freeze({
  diary: '日记',
  'owner-profile': '主人是谁',
  profile: '主人是谁',
  'exam-schedule': '考试安排',
  'exam-day': '考试那天',
  'exam-score': '考试成绩',
  school: '学校的事',
  'school-phone': '上学带手机',
  'evening-study': '晚自习',
  sleep: '睡觉和作息',
  food: '吃什么',
  mood: '心情',
  study: '学习',
  greeting: '打招呼',
  phone: '手机',
  body: '身体',
  qzone: 'QQ空间',
  sticker: '表情包',
  video: '视频',
  acg: '二次元',
  pet: '猫',
  relationship: '我俩的事',
  money: '钱',
  weather: '天气',
  family: '家里',
  games: '打游戏',
  voice: '发语音',
  'voice-mode': '语音模式',
  coding: '搞代码',
  tech: '搞技术',
  travel: '出门玩',
  'sports-test': '体育考试',
  plan: '计划',
  promise: '答应过的事',
  composition: '作文',
  work: '工作',
  music: '音乐',
  preference: '偏好',
  schedule: '作息',
  health: '身体状态',
  'tts-outage': '嗓子坏了',
  'sunday-rest': '周日休息',
  misc: '日常琐事',
});

export const SECTOR_LABELS = Object.freeze({
  撒娇: '撒娇黏人',
  玩梗: '玩梗吐槽',
  关心: '关心你',
  问句: '问来问去',
  应答: '嗯嗯哦哦',
  技术: '弄电脑',
  凌晨: '熬夜瞎聊',
  上午: '上午闲聊',
  下午: '下午闲聊',
  晚上: '晚上闲聊',
});

/** topic → 中文簇名；没登记的保持原样（宁可露出 slug，也不要瞎编一个名字）。 */
export function topicLabel(topic) {
  const key = String(topic ?? '').trim();
  return TOPIC_LABELS[key] ?? key;
}

/** 给一个日常点分簇；命中不了返回 '其他'。 */
export function sectorOf(text) {
  const clean = String(text ?? '');
  if (!clean) return '其他';
  for (const [name, re] of SECTOR_PATTERNS) if (re.test(clean)) return name;
  return '其他';
}

/** 「其他」日常点按时段再分：凌晨 / 上午 / 下午 / 深夜。比堆成一坨"其他"有信息量。 */
export function dayPartOf(t) {
  const d = new Date(Number(t) || 0);
  const hour = d.getHours();
  if (hour >= 0 && hour < 6) return '凌晨';
  if (hour < 12) return '上午';
  if (hour < 18) return '下午';
  return '晚上';
}

/** 点的稳定 id：同一时刻同一条文本永远得到同一个 id，重复导入不会翻倍。 */
export function pointId(text, t) {
  const time = Math.floor(Number(t) || 0);
  return `ms_${time.toString(36)}${fnv1a(`${time}:${text}`).toString(36)}`;
}

/** 把任意来源的原始点规整成统一结构；文本太短返回 null。 */
export function normalizePoint(raw, cfg = MIND_SEA_DEFAULTS) {
  const text = String(raw?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, cfg.textMax);
  if (text.length < 2) return null;
  const t = Number(raw?.t) > 0 ? Number(raw.t) : Date.now();
  const kind = POINT_KINDS.includes(raw?.kind) ? raw.kind : 'event';
  const keywords = Array.isArray(raw?.keywords) && raw.keywords.length
    ? raw.keywords.map((k) => String(k)).slice(0, 8)
    : keywordsOf(text);
  const weight = Number(raw?.weight) > 0 ? Number(raw.weight) : KIND_WEIGHT[kind];
  const source = raw?.source && typeof raw.source === 'object'
    ? { type: String(raw.source.type ?? 'unknown'), id: String(raw.source.id ?? '') }
    : { type: 'unknown', id: '' };
  return {
    id: raw?.id ? String(raw.id) : pointId(text, t),
    t,
    kind,
    topic: typeof raw?.topic === 'string' && raw.topic ? raw.topic : 'misc',
    text,
    weight: Math.round(weight * 100) / 100,
    keywords,
    source,
  };
}

const LT_KIND_MAP = Object.freeze({ fact: 'fact', event: 'event', promise: 'plan', preference: 'feeling' });

/** 长期记忆条目 → 点（结论类，权重高；被作废的条目变暗）。 */
export function pointFromLongTerm(entry, opts = {}) {
  if (!entry || !entry.text) return null;
  const cfg = opts.cfg ?? MIND_SEA_DEFAULTS;
  const t = Number(entry.createdAt) || Number(entry.lastMentionAt) || Number(opts.now) || Date.now();
  return normalizePoint({
    t,
    kind: LT_KIND_MAP[entry.kind] ?? 'conclusion',
    topic: entry.topic,
    text: entry.text,
    weight: entry.active === false ? 1.5 : 3,
    source: { type: 'longterm', id: entry.id ?? '' },
  }, cfg);
}

/** 一条真实消息 → 点（经历类）。跳过太短、纯媒体占位、以及她自己的碎句。 */
export function pointFromMessage(msg, opts = {}) {
  const cfg = opts.cfg ?? MIND_SEA_DEFAULTS;
  const text = String(msg?.text ?? msg?.content ?? '').trim();
  if (text.length < 4) return null;
  if (ROLE_TAG_RE.test(text)) return null;
  const isSelf = msg?.isSelf === true;
  const fromOwner = msg?.isOwner === true && isSelf === false;
  // 她自己的「哦 / 嗯 / 先坐着喘会儿」不进意识海：只留成句的回应
  if (isSelf && text.length < 12) return null;
  // 语音条自动补的「翻译：…」是机械产物，不是她真说过的话
  if (/^(翻译|译文)[：:]/.test(text)) return null;
  const t = Number(msg?.at ?? msg?.ts ?? msg?.time) || Number(opts.now) || Date.now();
  const topic = typeof opts.topicOf === 'function'
    ? opts.topicOf(text)
    : (opts.topic ?? msg?.topic ?? 'misc');
  return normalizePoint({
    t,
    kind: fromOwner ? 'event' : 'event',
    topic,
    text,
    weight: fromOwner ? 1.3 : 1,
    source: { type: 'message', id: String(msg?.id ?? msg?.messageId ?? msg?.seq ?? '') },
  }, cfg);
}

/** 一篇日记 → 点（回忆类：她那天自己写下的整段经历）。 */
export function pointFromDiary(entry, opts = {}) {
  const cfg = opts.cfg ?? MIND_SEA_DEFAULTS;
  const date = String(entry?.date ?? '').trim();
  const body = String(entry?.text ?? entry?.summary ?? '').replace(/\s+/g, ' ').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || body.length < 4) return null;
  const hhmm = /^\d{2}:\d{2}$/.test(String(opts.time ?? '')) ? String(opts.time) : '23:30';
  const t = Date.parse(`${date}T${hhmm}:00`) || Number(entry?.at) || Number(opts.now) || Date.now();
  const point = normalizePoint({
    id: `diary_${date}`,
    t,
    kind: 'conclusion',
    topic: 'diary',
    text: body,
    weight: 2.6,
    source: { type: 'diary', id: date },
  }, cfg);
  if (!point) return null;
  point.diary = { date, chars: body.length };
  if (opts.fullText) point.full = String(entry?.text ?? body).trim().slice(0, cfg.diaryMaxChars ?? 1400);
  return point;
}

/** 批量转换 + 去重（按 id），返回按时间升序的点。 */
export function collectPoints({ longTerm = [], messages = [], now = Date.now(), cfg = MIND_SEA_DEFAULTS, topicOf = null } = {}) {
  const seen = new Set();
  const out = [];
  const push = (point) => {
    if (!point || seen.has(point.id)) return;
    seen.add(point.id);
    out.push(point);
  };
  for (const entry of longTerm) push(pointFromLongTerm(entry, { now, cfg }));
  for (const msg of messages) push(pointFromMessage(msg, { now, cfg, topicOf }));
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * 连线：只在「共享关键词 / 同主题」里找候选，避免 O(n²)。
 * 每个点最多保留 maxNeighbors 条边，边按分数降序。
 */
export function linkPoints(points, cfg = MIND_SEA_DEFAULTS) {
  const list = (points || []).filter(Boolean);
  if (list.length < 2) return [];
  const byKeyword = new Map();
  list.forEach((point, index) => {
    for (const keyword of point.keywords) {
      const bucket = byKeyword.get(keyword) ?? [];
      bucket.push(index);
      byKeyword.set(keyword, bucket);
    }
  });

  const pairScores = new Map();
  const consider = (i, j) => {
    if (i === j) return;
    const key = i < j ? `${i}|${j}` : `${j}|${i}`;
    if (pairScores.has(key)) return;
    const a = list[i];
    const b = list[j];
    const wordScore = bigramSimilarity(a.text, b.text);
    const shared = a.keywords.filter((k) => b.keywords.includes(k)).length;
    const keywordScore = shared ? shared / Math.max(1, Math.min(a.keywords.length, b.keywords.length)) : 0;
    const topicScore = a.topic !== 'misc' && a.topic === b.topic ? 1 : 0;
    const dt = Math.abs(a.t - b.t);
    const timeScore = dt <= cfg.timeWindowMs ? 1 - dt / cfg.timeWindowMs : 0;
    const score = 0.4 * keywordScore + 0.35 * wordScore + 0.25 * topicScore + 0.05 * timeScore;
    if (score < cfg.minEdgeScore) return;
    const kind = topicScore >= wordScore && topicScore > 0
      ? 'topic'
      : (keywordScore >= 0.3 ? 'word' : 'time');
    pairScores.set(key, { i: Math.min(i, j), j: Math.max(i, j), score, kind });
  };

  for (const [, bucket] of byKeyword) {
    if (bucket.length < 2 || bucket.length > cfg.hubKeywordMax) continue;
    for (let a = 0; a < bucket.length; a += 1) {
      for (let b = a + 1; b < bucket.length; b += 1) consider(bucket[a], bucket[b]);
    }
  }
  // 时间邻居：每点与前后各 2 条相连，保证孤立点也有线
  for (let i = 1; i < list.length; i += 1) {
    consider(i - 1, i);
    if (i >= 2) consider(i - 2, i);
  }

  const perNode = new Map();
  const edges = [];
  for (const edge of [...pairScores.values()].sort((x, y) => y.score - x.score)) {
    const ca = perNode.get(edge.i) ?? 0;
    const cb = perNode.get(edge.j) ?? 0;
    if (ca >= cfg.maxNeighbors || cb >= cfg.maxNeighbors) continue;
    perNode.set(edge.i, ca + 1);
    perNode.set(edge.j, cb + 1);
    edges.push({
      a: list[edge.i].id,
      b: list[edge.j].id,
      score: Math.round(edge.score * 1000) / 1000,
      kind: edge.kind,
    });
  }
  return edges;
}

/** 场景 = 点 + 边 + 统计（前端据此渲染；focusIds 是本轮检索命中的点）。 */
export function buildScene({ points = [], focusIds = [], cfg = MIND_SEA_DEFAULTS, now = Date.now() } = {}) {
  const clean = (points || []).filter(Boolean).slice(-cfg.maxPoints);
  // 日常（misc）点补一个 cluster 字段：前端按它成团，而不是按随机 bigram。
  for (const point of clean) {
    if (point.topic === 'misc') {
      const sector = sectorOf(point.text);
      point.cluster = SECTOR_LABELS[sector === '其他' ? dayPartOf(point.t) : sector] ?? '日常琐事';
    } else if (!point.cluster) point.cluster = topicLabel(point.topic);
  }
  const edges = linkPoints(clean, cfg);
  const byKind = {};
  const byTopic = {};
  const byCluster = {};
  for (const point of clean) {
    byKind[point.kind] = (byKind[point.kind] ?? 0) + 1;
    byTopic[point.topic] = (byTopic[point.topic] ?? 0) + 1;
    byCluster[point.cluster] = (byCluster[point.cluster] ?? 0) + 1;
  }
  const focus = new Set(Array.isArray(focusIds) ? focusIds : []);
  return {
    points: clean,
    edges,
    stats: {
      total: clean.length,
      edges: edges.length,
      byKind,
      byTopic,
      byCluster,
      focusCount: clean.filter((p) => focus.has(p.id)).length,
      span: clean.length ? { from: clean[0].t, to: clean[clean.length - 1].t } : null,
      generatedAt: now,
    },
  };
}
