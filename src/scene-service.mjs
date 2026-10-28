// 把「长期记忆 + 聊天记录 + 日记」拼成一片海。
// 纯内存实现：给你一个 JSON，它返回可以直接喂给前端的场景。
import { collectPoints, pointFromDiary, buildScene, MIND_SEA_DEFAULTS } from './mind-sea.js';

/**
 * @param {object} opts
 * @param {object} opts.data        { longTerm: [], messages: [], diaries: [] }
 * @param {object} [opts.cfg]       覆盖 MIND_SEA_DEFAULTS 里的字段
 */
export function createSceneService({ data = {}, cfg = {} } = {}) {
  // textMax 默认放宽到 160：详情卡里能看完整一句话（标签本来也只显示 14 字）
  const seaCfg = { ...MIND_SEA_DEFAULTS, textMax: 160, ...cfg };
  const state = {
    name: data.name || 'memory-sea',
    longTerm: Array.isArray(data.longTerm) ? data.longTerm : [],
    messages: Array.isArray(data.messages) ? data.messages : [],
    diaries: Array.isArray(data.diaries) ? data.diaries : [],
  };

  let points = [];
  let builtAt = 0;

  function rebuild() {
    const base = collectPoints({
      longTerm: state.longTerm,
      messages: state.messages,
      cfg: seaCfg,
    });
    // 日记单独成点：黄色、标「日记」，点开能看全文
    const diaryPoints = state.diaries
      .filter((d) => d && d.text)
      .map((d) => pointFromDiary(d, { cfg: seaCfg, fullText: true, time: seaCfg.diaryTime }));
    points = [...base, ...diaryPoints]
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);
    builtAt = Date.now();
    return { ok: true, points: points.length, builtAt };
  }

  function scene({ focusIds = [], limit = 0 } = {}) {
    const source = limit > 0 ? points.slice(-limit) : points;
    const built = buildScene({ points: source, focusIds, cfg: seaCfg });
    return { ok: true, name: state.name, builtAt, ...built };
  }

  /** 换数据（比如你的 agent 每次更新记忆后调用） */
  function load(next = {}) {
    if (Array.isArray(next.longTerm)) state.longTerm = next.longTerm;
    if (Array.isArray(next.messages)) state.messages = next.messages;
    if (Array.isArray(next.diaries)) state.diaries = next.diaries;
    return rebuild();
  }

  rebuild();
  return {
    rebuild,
    scene,
    load,
    get points() {
      return points;
    },
  };
}
