# 接入你自己的 agent

记忆海的输入只有三段数组：`longTerm`（长期记忆）、`messages`（聊天记录）、`diaries`（日记）。任何能产出这三样东西的系统都能用。

## 方式一：换 JSON 文件

最小改动。把你的数据写成：

```json
{
  "longTerm": [{ "id": "lt-1", "text": "主人对芒果过敏", "topic": "food", "kind": "fact", "confirmed": true }],
  "messages": [{ "sender": "owner", "isOwner": true, "text": "今天好累", "at": 1761000000000 }],
  "diaries": [{ "date": "2026-10-27", "text": "今天他很晚才回来……" }]
}
```

然后：

```bash
DATA=./data/my.json npm start
```

消息时间字段认 `at` / `ts` / `time`，长期记忆认 `createdAt` / `lastMentionAt`，都是毫秒时间戳；缺了会退化成"现在"。

## 方式二：复用数据层（推荐）

```js
import { createSceneService } from 'memory-sea/src/scene-service.mjs';

const sea = createSceneService({ data: { longTerm, messages, diaries } });

app.get('/api/scene', (req, res) => res.json(sea.scene()));

// 你的记忆更新后：
sea.load({ longTerm: newEntries });   // 只换长期记忆，消息和日记保持不变
```

`scene()` 返回的结构：

```js
{
  ok: true,
  points: [{ id, t, kind, topic, text, weight, cluster, source, keywords, full? }],
  edges:  [{ a, b, score }],
  stats:  { total, edges, byKind, byTopic, byCluster, span: { from, to } }
}
```

前端只认这个结构，所以你可以用任何后端语言复刻它。

## 方式三：只抄前端

`public/index.html` 是单文件，只请求两个接口：

- `GET /api/scene` → 上面那个 JSON
- `POST /api/rebuild` → 可选，点「重建」时调用

把 `fetch('/api/scene')` 换成你的地址即可。

## 你自己写数据结构时的注意事项

**点**（`normalizePoint` 会补默认值）：

| 字段 | 说明 |
|---|---|
| `id` | 唯一；重复会被丢弃 |
| `t` | 毫秒时间戳，决定横向位置与时间窗连线 |
| `kind` | `event` / `feeling` / `fact` / `plan` / `conclusion` |
| `topic` | 小写短横线（`exam-schedule`），决定簇名 |
| `text` | 一句话；`textMax` 字以内的部分进详情卡 |
| `weight` | 越大点越大，默认按 kind 给 |
| `full` | 可选，全文（日记用） |

**长期记忆条目**（`memory-store.js`）：

```js
{
  id, text,
  kind: 'fact' | 'event' | 'promise' | 'preference',
  topic: 'food',                 // 同 topic 的新结论会作废旧结论
  confirmed: true,               // false 的不进海、不注入
  active: true,                  // 设为 false 表示"被取代"（不删除）
  supersededBy: 'lt-9',
  expiresAt: 1762000000000,      // 事件类可带过期时间
  createdAt, lastMentionAt, hits
}
```

状态由 `entryState(entry, cfg, now)` 统一判定：`pending → superseded → expired → stale → active`。

## 常见问题

**点太密？** 调小 `maxPoints`（默认 4000），或者只传最近 N 天的消息。

**线太多？** 提高 `minEdgeScore`（默认 0.15）或调小 `maxNeighbors`（默认 6）。

**簇名不认识？** 改 `src/mind-sea.js` 里的 `TOPIC_KEYWORDS`（主题 → 关键词）和 `TOPIC_LABELS`（主题 → 中文名）。

**想加新类型？** 在 `POINT_KINDS` 加一个名字，在 `public/index.html` 的 `KIND_COLOR` / `KIND_LABEL` 加对应颜色和标签。

**数据量大？** 前端是 Canvas 2D 逐点画圆，实测 4000 点流畅、8000 点开始掉帧。要上万点需要做 LOD（只画近处大权重点）。
