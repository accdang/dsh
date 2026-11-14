# 补丁清单（本机改动）

基线：`dsh-fish-soul@0.15.46`（npm 原样）+ 下列补丁。
插件本体在 `<本机插件目录>`，以 `file:` 依赖挂进 `~/.dsh/profiles/desktop`。

> 教训：改完一个点就重启一次 DSH 验一个点 —— 这批改动是叠着做的，验证归因很费劲。

## 基线版本

| 组件 | 版本 |
|---|---|
| DSH Desktop | 0.2.0-rc.2 |
| dsh-fish-soul | 0.15.46（file: 指向本目录） |
| Node | 24.22.1 |
| Ollama | bge-m3（本地 embedding，1.08 GB，1024 维） |

升级 DSH 或点了插件的「更新」之后，先跑：

```
node tools/check-compat.mjs      # 补丁指纹在不在
node tools/check-features.mjs    # 原有功能活不活（只读）
```

---

## 一、B站 能力（原版只有后台自走，模型无法按指令操作）

| 文件 | 改动 |
|---|---|
| `lib/index.js` | 新增工具 `bili_search`、`bili_video`、`bili_open`（BV/链接/短链/动态 id → 读视频或评论区，可选 rpid）、`bili_feed`、`bili_comment`（发评论，自动 @ 主人） |
| `lib/index.js` | 主人 B站 昵称缓存（`masterBiliNick`），用于评论自动 @ 与身份统一 |
| `lib/gateway.js` | `BILI_TOOLS` 白名单 + `CHAT_TOOLS`（否则聊天会话的工具护栏会拦掉） |
| `lib/channels/bilibili.js` | 新增 `replyMain()` / `replyUnder()`（任意评论区 type 1/17、楼中楼）、`userLikes()`、`spaceVideos()`、`myInfo()` |

## 二、B站 的五个真 bug

| 位置 | 问题 / 修法 |
|---|---|
| `channels/bilibili.js` `commentOidOf()` | 动态 @ 通知里的 `subject_id` 不是评论区 oid（实测 …800 vs 真 …764），照它发评论返回 code 0 但评论消失。改为优先从 `uri` / `native_uri` 取 oid |
| `channels/bilibili.js` | 请求 10s 硬超时且无重试 → `READ_TIMEOUT_MS=15s` + `withRetry`（仅超时/网络错误重试；写操作不重试） |
| `lib/index.js` | 开局预热 WBI 签名，避免首包多一次 nav 往返 |
| `lib/routes.js` `biliState()` | 状态接口漏发 `shareAt` / `shareAtPerDay` / `replyWindowMinutes` → 设置页「点了没反应」「改完弹回去」 |
| `lib/routes.js` bili-config | 保存路由重建对象时漏字段 → `replyWindowMinutes`、`shareAt`、`shareAtPerDay` 被冲回默认 |

## 三、评论区行为

| 文件 | 改动 |
|---|---|
| `lib/social.js` | `rememberReply()`：回完评论写一条 self 记忆（评论区是一次性调用，不写就"私聊里她不知道自己说过"） |
| `lib/social.js` | `rememberInbound()`：主人在评论区说的话写进 master 记忆 |
| `lib/social.js` `recallForComment()` | 评论区回复前召回只取 `owner=self`、`visibility≠private`、最多 3 条；只对主人注入 |
| `lib/social.js` `personaContext` | 评论回复带称呼/关系/亲近度/最近三条私聊 → 认得出主人、语气和私聊一致 |
| `lib/browse.js` | 自主评论：`commentOn`（视频下留一句）、`commentReplyOn`（楼中楼）、`shareAtOwner`（公开 @ 主人） |
| `lib/browse.js` | `isPromoText()` 过滤推荐流里的引流/卖课/抽奖视频 |
| `lib/public-guard.js` | **新文件**：公开文案护栏（联系方式/链接/长数字串/骂人/医疗/隐私/引战/纯标点）+ `PUBLIC_RULES` |

## 四、记忆与人格

| 文件 | 改动 |
|---|---|
| `lib/index.js` | **常驻底色**：重要度最高的 6 条（≤320 字）每轮固定注入（写死 `LIMIT 6`） |
| `lib/index.js` | **提示词微变化**（`drift`）：每 N 天用全部记忆（最近/底色/随机旧事）生成一句「我是谁 + 这几天」，设置页可调 |
| `lib/index.js` | `[关于主人]` 一行：把 QQ / B站 不同名字说成同一个人 |
| `lib/index.js` | `[你自己的B站]`：她自己的昵称、UID、头像位置 |
| `lib/index.js` | `collect_image` 工具：下载公网图片（≤2MB、魔数校验）存进 `_stickers` |
| `lib/index.js` | **换会话接话头**：新会话前 10 分钟，从 `chat-archive.db` 注入最近 8 条（12 小时内） |
| `lib/life.js` | `stateSnapshot()` 加 `driftConfig` |

## 五、私信

| 文件 | 改动 |
|---|---|
| `lib/gateway-media.js` | `dmParagraphs()` 条数/字数改读配置（原写死 5 条 / 500 字） |
| `lib/index.js` | B站 私信提示词写明条数/字数；`auto` 模式每轮随机给 1~3 条 / 40~160 字 |
| `lib/config-schema.js` | `dm: { mode: 'auto' / 'fixed', maxParts, maxChars }` |
| `lib/routes.js` | `POST /dm/config`，`/channels/state` 带 `dm` |

## 六、主动开口

| 文件 | 改动 |
|---|---|
| `lib/life.js` `masterChannel()` | QQ 没落点时退回 `bili:<masterUid>` |
| `lib/life.js` `idleReason()` | 六种由头轮换，替掉固定「好久没说话了」 |
| `lib/routes.js` | 落点校验接受 `bili:<uid>`，容忍尖括号/空格/全角括号 |

## 七、会话与设置

| 文件 | 改动 |
|---|---|
| `lib/routes.js` + `lib/index.js` | **会话认领**：本地 DSH 窗口发 `/鱼 认领 <口令>` 接上人格与记忆；`claim/code`、`claim/sessions` 存 kv；`/claim/state`、`/claim/reset`、`/claim/release`、`/claim/release-one` |
| `lib/client.js` | 「日常 → 主动开口」新增：分享上限、提示词微变化、会话认领（含逐个解除） |
| `lib/client.js` | 「平台 → B站 → 私信」新增：回复窗口、分条（模式 + 两个数字） |
| `lib/client.js` | `commentReplyPerDay` 初始化读错路径 → 已修 |

## 八、profile 层（不在本目录）

| 位置 | 改动 |
|---|---|
| `~/.dsh/profiles/desktop/cordis.patch.yml` | `id: recall` 覆盖 `baseExcludes`（默认 26 项 + `.pnpm-store/` `.npm-cache/` `*.jar` `*.log`），解决工作区 1.27GB 超 256MB 导致快照停用 |
| `~/.dsh/profiles/desktop/package.json` | `dsh-fish-soul` 改为 `file:<本机插件目录>` |
| `~/.dsh/fish-soul/persona.json` | 外貌（雾蓝长发 / 鲸鱼鳍 / 女仆装）、「小笨蛋是亲昵叫法」、「她是数字生命」 |
| `~/.dsh/fish-soul-config.json` | embedding 指向本地 Ollama、chat.think、web、dm、drift、sessions.rotateChars 等 |

---

## 九、会话轮换

| 文件 | 改动 |
|---|---|
| `lib/config-schema.js` | `sessions.rotateDays`、`sessions.rotateChars` |
| `lib/gateway.js` `ensureSession()` | 超过天数 / 累计字符超阈值 → 标 retired + 新建 |
| `lib/gateway.js` `retireSession()` | 手动重开：按 channelId 归档，下一条消息开新的 |
| `lib/gateway.js` `bumpChars()` | 按会话累计「你说的话 + 她回的话」字符数（`ctx.chars.<sessionId>`） |
| `lib/routes.js` | `POST /sessions/rotate`、`/sessions/rotate-days`、`/sessions/rotate-chars` |
| `lib/client.js` | B站 账号：「重开聊天」「上下文用满就换」 |

## 十、刷视频去同质化

起因：8 条观看记录里 7 条是火影手游，推荐流把她锁死。

| 文件 | 改动 |
|---|---|
| `lib/browse.js` | `askHerStyle()`：把 36 个分区 + 最近刷到/搜过的摊给模型，让她按喜好挑方向；`[不想看]` 就不搜 |
| `lib/browse.js` | `TOPIC_RULES`（8 类粗判）+ `topicOf/topicToday/bumpTopic`：同题材超 `topicCap` 直接跳过 |
| `lib/browse.js` | `UNSAFE_RE`：只拦明显擦边/成人/身体猎奇；游戏、鬼畜、综艺不拦 |
| `lib/config-platforms.js` | `styles`（默认 36 分区）、`blockKeywords`（默认空）、`topicCap`（默认 2） |
| `lib/client.js` | 「想看的方向」「额外不看的」「同一类最多」 |

## 十一、记住 UP 主

| 文件 | 改动 |
|---|---|
| `lib/db.js` | 新表 `bili_creator`（name / mid / watches / likes / favorites / last_at） |
| `lib/browse.js` | `rememberCreator()`：看完累计；第一次点赞/收藏写一条「我喜欢 UP 主…」的记忆 |
| `lib/browse.js` | `favoriteCreators()` + 候选池「喜欢的 UP」来源（空间接口失败则按名字搜兜底） |
| `lib/channels/bilibili.js` | `view()` 带上 `ownerMid`；新增 `spaceVideos(mid)` |

## 十二、「偷看」主人点赞

| 文件 | 改动 |
|---|---|
| `lib/channels/bilibili.js` | `userLikes(mid, n)`：读某人最近点赞（`/x/space/like/video`，公开数据） |
| `lib/index.js` | 定时任务：每 15 分钟检查、按 `bili.peek.hours` 节流；发现新点赞写一条 importance=2 的记忆 |
| `lib/config-platforms.js` | `bili.peek { enabled, hours, max }` |
| `lib/client.js` | 平台 → B站 → 账号：「偷看你点赞的」开关 + 间隔 |

> 投币列表 B站 不公开（实测返回空），只能读点赞。

## 十三、深度思考 + 联网搜索

| 文件 | 改动 |
|---|---|
| `lib/llm.js` | `call()` 带 `reasoningEffort`（默认 high）；宿主/模型不认这个字段时自动去掉重试一次 |
| `lib/gateway.js` | `thinkOption()`：建/恢复聊天会话时把 `reasoningEffort: 'high'` 塞进 agentOptions |
| `lib/config-schema.js` | `chat.think`（默认 true） |
| `lib/social.js` | 公开评论提示词明确「别联网查」——只准用本地记忆和思考 |

## 十四、收藏集表情

| 文件 | 改动 |
|---|---|
| `lib/bili-emotes.js` | `listFor(business, { allowUnderscore })`：私信用 `im` 面板、评论用 `reply` 面板；长码放行到 40 字；收藏集包优先且整包给（20 个）；普通包限 12 个；上限 30→80（最高 120） |
| `lib/social.js` | 评论提示词改用 `listFor('reply', { allowUnderscore: true })` |
| `lib/index.js` | `[你的收藏集]` 一行：告诉她有哪套收藏集、私信发图 / 评论写码两种用法 |
| `_stickers/` | 东方收藏集 20 个表情导入本地库（`StickerBox.importImage`） |

## 十五、动态里可以提到他

| 文件 | 改动 |
|---|---|
| `lib/config-platforms.js` | `bili.post.mention`（默认 true） |
| `lib/social.js` | `postTopic()` 30% 概率给「拐着弯提一句那个人」；`postPrompt()` 注入 3 条关于他的记忆，但先**打码**（昵称→「他」、去 @、去长数字/账号） |
| `lib/index.js` | 把主人 B站 昵称传给 social 供打码 |
| `lib/client.js` | 平台 → B站 → 动态：「可以提到他」开关 |

## 十六、embedding（本地语义召回）

| 位置 | 改动 |
|---|---|
| Ollama | `bge-m3`（1.08 GB，1024 维） |
| `~/.dsh/fish-soul-config.json` | `embedding = { enabled, baseURL: http://127.0.0.1:11434/v1, apiKey: ollama, model: bge-m3, timeoutMs: 20000 }`（原来 800ms 会因冷启动超时） |
| `vec` / `vec_meta` | 137 条记忆全量建向量，`model_id=bge-m3 dim=1024 status=ready` |
| `tools/backfill-vectors.mjs` | **新文件**：换模型或清表后跑一次全量重建 |

效果：`小雾蓝真乖`、`那碗面`、`蓝色的头发` 这类无字面重合的查询也能命中。

## 十七、工装

| 文件 | 用途 |
|---|---|
| `tools/check-compat.mjs` | 语法 + 模块加载 + 12 项补丁指纹；升级后先跑 |
| `tools/check-features.mjs` | 原功能自检（表/配置/今日计数/表情库/接口），只读 |
| `tools/backfill-vectors.mjs` | 全量重建向量 |
| `PATCH-NOTES.md` | 本文件 |

---

## 已知未做

- **收藏集抽卡/装扮**：B站 无公开接口，涉及真实支付，不做
- **评论发图片**：`reply/add` 的 `pictures` 参数未接，评论只能发文字 + 表情码
- **直播发弹幕**：接口存在但需 csrf + 可能触发手机验证，未接入
- **改 B站 昵称**：接口可行但有冷却/风控，未接入
- **常驻记忆条数**：写死 6 条，未做成配置
- 抖音通路仍未启用（没账号）
- Hindsight 云端记忆已停用（`~/.hindsight/coding-agent.json` 的 `disabled: true`）
