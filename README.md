# 记忆海 · Memory Sea

把「长期记忆 + 聊天记录 + 日记」画成一片可以旋转的三维星海。

每个点是她经历的一件事，每根线是两件事之间的相似，颜色是类型（经历 / 心情 / 事实 / 约定 / 结论 / 日记）。左键拖动旋转，滚轮推拉，点一颗星看原文。

- 纯前端 Canvas 2D，无 WebGL、无第三方运行时依赖
- 数据层是三个纯函数模块，能单独拿走接进任何 Node / 浏览器项目
- 自带演示数据，`npm start` 就能看

## 30 秒跑起来

```bash
git clone https://github.com/asdfd3/memory-sea.git
cd memory-sea
npm start          # 默认 http://127.0.0.1:4173
```

不需要 `npm install` —— 没有任何依赖。Node 20 以上。

改端口 / 换数据：

```bash
PORT=8080 DATA=./data/my.json npm start
```

## 它会显示什么

| 元素 | 含义 |
|---|---|
| 点 | 一条长期记忆、一条聊天消息，或一篇日记 |
| 颜色 | 经历（蓝）· 心情（粉）· 事实（青）· 约定（橙）· 结论（紫）· 日记（金） |
| 大小 | 权重：结论/事实 > 心情 > 经历；日记更亮一些 |
| 线 | 两点共享关键词或同主题，按分数排序，每点最多 6 条 |
| 簇名 | 主题标签（`exam-schedule` → 「考试安排」）或时段/语气分类 |
| 远近 | 真三维投影：远的更小更淡，按深度排序遮挡 |

## 数据格式

`data/demo.json` 就是全部输入，三段数组：

```json
{
  "longTerm": [
    { "id": "lt-1", "text": "主人对芒果过敏", "topic": "food",
      "kind": "fact", "confirmed": true,
      "createdAt": 1760000000000, "lastMentionAt": 1761000000000 }
  ],
  "messages": [
    { "sender": "owner", "isOwner": true, "text": "今天好累", "at": 1761000000000 },
    { "sender": "her",   "isSelf": true,  "text": "辛苦啦，先坐下", "at": 1761000060000 }
  ],
  "diaries": [
    { "date": "2026-10-27", "text": "今天他很晚才回来……", "createdAt": 1761577200000 }
  ]
}
```

字段都是宽松的：`topic` / `kind` 缺省会自动归类，`confirmed: false` 的长期记忆不会进海。

- 消息时间字段认 `at` / `ts` / `time`（毫秒时间戳），三个任选一个；都缺就当成"现在"。
- `isOwner: true` 的是对方说的（权重更高），`isSelf: true` 的是她说的（太短的碎句会被跳过）。
- 长期记忆时间认 `createdAt` / `lastMentionAt`；日记认 `date`（`YYYY-MM-DD`）+ `text`。

## 三个核心模块

| 文件 | 职责 |
|---|---|
| `src/memory-store.js` | 长期记忆的状态机：`active / pending / superseded / expired / stale`，同主题作废、相近合并、按预算装箱 |
| `src/memory-retrieve.js` | 检索：中文 bigram + IDF 打分、时段联想（「晚上好」→ 睡觉/作息）、核心主题保底、按字数装箱 |
| `src/mind-sea.js` | 把上面两者的数据变成点、边、簇和场景 |

`src/scene-service.mjs` 是薄胶水，`src/server.mjs` 是零依赖 HTTP 服务。

## 接进你自己的 agent

三种深度，任选：

1. **只换数据** —— 让程序把 `data/demo.json` 换成你的 `longTerm` / `messages` / `diaries`，其余不动。
2. **只抄前端** —— `public/index.html` 只依赖 `GET /api/scene` 返回的 JSON，你可以用任何后端实现这个接口。
3. **复用数据层** —— `import { createSceneService } from './src/scene-service.mjs'`，直接拿 `rebuild()` / `scene()`。

```js
import { createSceneService } from './src/scene-service.mjs';

const sea = createSceneService({
  data: {
    longTerm: myLongTermEntries,
    messages: myRecentMessages,
    diaries: myDiaries,
  },
});

const payload = sea.scene();          // 直接 JSON 化给前端
sea.load({ longTerm: updatedEntries }); // 记忆变了就重建
```

详细说明见 [`docs/how-to-plug-in.md`](docs/how-to-plug-in.md)。

## 可调参数

`createSceneService({ cfg })` 里可以覆盖 `MIND_SEA_DEFAULTS`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxPoints` | 4000 | 海里最多保留多少个点（超出丢最老的） |
| `maxNeighbors` | 6 | 每个点最多连几条线 |
| `minEdgeScore` | 0.15 | 连线的最低相似度 |
| `timeWindowMs` | 6h | 相邻时间窗内的点更容易连上 |
| `textMax` | 160 | 点文本保留多少字（详情卡显示） |
| `hubKeywordMax` | 40 | 关键词出现在多少个点里就不当连线依据（避免「今天」这种词连成一片） |

前端参数在 `public/index.html` 顶部：`FOCAL`（焦距，越大越平）、`CAM_DEFAULT`（初始旋转角/距离）、`DIARY_COLOR`。

## 测试

```bash
npm test
```

三个纯函数模块各有一套 `node:assert` 单测，覆盖：状态机四态、相似度合并、预算装箱、检索兜底与时段联想、点的归一化、连线去重、场景统计。

## 目录

```
memory-sea/
├─ src/
│  ├─ memory-store.js      长期记忆状态机
│  ├─ memory-retrieve.js   检索打分
│  ├─ mind-sea.js          点 / 边 / 簇 / 场景
│  ├─ scene-service.mjs    胶水层
│  └─ server.mjs           零依赖静态服务 + 两个接口
├─ public/index.html       三维渲染器（单文件）
├─ data/demo.json          合成演示数据（不含任何真实对话）
├─ docs/how-to-plug-in.md  接入指南
└─ tests/                  单测
```

## 设计取舍

- **不用 WebGL**：几千个点用 Canvas 2D 够快，省掉一个渲染库和一层调试成本。真正的瓶颈是投影、深度排序和逐点画圆，不是光影。
- **连线不是全连接**：只在共享关键词或同主题的候选里找，点数上万也不会炸。
- **簇不是聚出来的**：主题标签来自关键词表（可改），日常碎片按时段和语气兜底，比 k-means 稳定，也不随数据漂移。
- **不会动你的数据**：`createSceneService` 只读不写，删点重建都由调用方决定。

## License

MIT
