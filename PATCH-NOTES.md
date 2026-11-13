# 补丁清单（本机改动）

基线：`dsh-fish-soul@0.15.46`（npm 原样）+ 下列补丁。
插件本体在 `C:\Users\path\dsh-fish-soul-vendored`，以 `file:` 依赖挂进 `~/.dsh/profiles/desktop`。

> 教训：改完一个点就重启一次 DSH 验一个点 —— 这批改动是叠着做的，验证归因很费劲。

## 一、B站 能力（原版只有后台自走，模型无法按指令操作）

| 文件 | 改动 |
|---|---|
| `lib/index.js` | 新增工具 `bili_search`（搜视频）、`bili_video`（标题/简介/热评）、`bili_feed`（@我的 / 回复我的）、`bili_comment`（发评论，自动 `@主人`）、`bili_open`（BV/链接/短链/动态 id → 读视频或评论区，可选 rpid） |
| `lib/index.js` | 主人 B站 昵称缓存（`masterBiliNick`），用于评论自动 @ 与身份统一 |
| `lib/gateway.js` | `BILI_TOOLS` 白名单 + `CHAT_TOOLS`（否则聊天会话的工具护栏会拦掉） |
| `lib/channels/bilibili.js` | 新增 `replyMain()` / `replyUnder()`（任意评论区 type 1/17、楼中楼） |

## 二、B站 的五个真 bug

| 位置 | 问题 / 修法 |
|---|---|
| `lib/channels/bilibili.js` `commentOidOf()` | **动态 @ 通知里的 `subject_id` 不是评论区 oid**（实测 ...800 vs 真 ...764），照它发评论返回 code 0 但评论消失。改为优先从 `uri` / `native_uri` 取 oid |
| `lib/channels/bilibili.js` | 请求 10s 硬超时且无重试 → `READ_TIMEOUT_MS=15s` + `withRetry`（仅超时/网络错误重试一次；写操作不重试） |
| `lib/index.js` | 开局预热 WBI 签名，避免首包多一次 nav 往返 |
| `lib/routes.js` `biliState()` | 状态接口漏发 `shareAt` / `shareAtPerDay` / `replyWindowMinutes` → 设置页「点了没反应」「改完弹回去」 |
| `lib/routes.js` bili-config | 保存路由重建对象时漏字段 → `replyWindowMinutes`、`shareAt`、`shareAtPerDay` 被冲回默认 |

## 三、评论区行为

| 文件 | 改动 |
|---|---|
| `lib/social.js` | `rememberReply()`：回完评论写一条 self 记忆（评论区是一次性调用，不写就「私聊里她不知道自己说过」） |
| `lib/social.js` | `rememberInbound()`：主人在评论区说的话写进 master 记忆 |
| `lib/social.js` `recallForComment()` | 评论区回复前召回**只取 owner=self** 的记忆；且只对主人注入，陌生人一律不注入（防泄露） |
| `lib/social.js` `personaContext` | 评论回复带称呼/关系/亲近度/最近三条私聊 → 认得出主人、语气和私聊一致 |
| `lib/index.js` 提示词 | 公开场合红线（真名/私聊/账号/地址不提）+ 对熟人别端着、对陌生人别带刺 |
| `lib/browse.js` | 自主评论：`commentOn`（视频下留一句）、`commentReplyOn`（楼中楼）、`shareAtOwner`（公开 @ 主人） |
| `lib/browse.js` | `isPromoText()` 过滤推荐流里的引流/卖课/抽奖视频（只查标题+UP名，另在 `watch()` 兜底） |
| `lib/public-guard.js` | **新文件**：公开文案护栏（联系方式/链接/长数字串/骂人/医疗承诺/隐私/引战/纯标点）+ `PUBLIC_RULES` |

## 四、记忆与人格

| 文件 | 改动 |
|---|---|
| `lib/index.js` | **常驻底色**：重要度最高的 6 条（≤320 字）每轮固定注入，不再只靠 BM25 命中 |
| `lib/index.js` | **提示词微变化**（`drift`）：每 N 天用全部记忆（最近/底色/随机旧事）生成一句「我是谁 + 这几天」；设置页可调开关、周期、三档条数、字数 |
| `lib/index.js` 提示词 | `[关于主人]` 一行：把 QQ / B站 不同名字说成同一个人 |
| `lib/index.js` | `collect_image` 工具：下载公网图片（≤2MB、魔数校验）存进 `_stickers` |
| `lib/life.js` | `stateSnapshot()` 加 `driftConfig` |

## 五、私信

| 文件 | 改动 |
|---|---|
| `lib/gateway-media.js` | `dmParagraphs()` 条数/字数改读配置（原写死 5 条 / 500 字） |
| `lib/index.js` | B站 私信提示词写明条数/字数；`auto` 模式每轮随机给 1~3 条 / 40~160 字 |
| `lib/config-schema.js` | 新增 `dm: { mode: 'auto'|'fixed', maxParts, maxChars }` |
| `lib/routes.js` | 新增 `POST /dm/config`，`/channels/state` 带 `dm` |

## 六、主动开口（B站 私信）

| 文件 | 改动 |
|---|---|
| `lib/life.js` `masterChannel()` | QQ 没落点时退回 `bili:<masterUid>`（原来只看 QQ，QQ 没接就永远不主动） |
| `lib/life.js` `idleReason()` | 六种由头轮换（分享/闲聊/撒娇/吐槽…），替掉固定「好久没说话了」 |
| `lib/routes.js` | 落点校验接受 `bili:<uid>`，并容忍尖括号/空格/全角括号 |

## 七、会话与设置

| 文件 | 改动 |
|---|---|
| `lib/routes.js` + `lib/index.js` | **会话认领**：本地 DSH 窗口发 `/鱼 认领 <口令>` 即接上人格与记忆；`claim/code`、`claim/sessions` 存 kv；`GET /claim/state`、`POST /claim/reset`、`/claim/release`、`/claim/release-one` |
| `lib/client.js` | 「日常 → 主动开口」新增：分享上限、提示词微变化、会话认领（含逐个解除） |
| `lib/client.js` | 「平台 → B站 → 私信」新增：回复窗口、分条（模式 + 两个数字） |
| `lib/client.js` | `commentReplyPerDay` 初始化读错路径（读 bili 根，实际在 browse 下）→ 已修 |
| `lib/config-schema.js` | 新增 `drift` 一节 |

## 八、profile 层（不在本目录）

| 位置 | 改动 |
|---|---|
| `~/.dsh/profiles/desktop/cordis.patch.yml` | 末尾 `id: recall` 覆盖 `baseExcludes`（默认 26 项 + `.pnpm-store/` `.npm-cache/` `*.jar` `*.log`），解决工作区 1.27GB 超 256MB 导致快照停用 |
| `~/.dsh/profiles/desktop/package.json` | `dsh-fish-soul` 改为 `file:C:\Users\path\dsh-fish-soul-vendored` |
| `~/.dsh/fish-soul/persona.json` | 追加外貌（雾蓝长发 / 鲸鱼鳍不像耳朵 / 女仆装）与「小笨蛋是亲昵叫法」 |

## 已知未做

- **embedding 没配** → 只有 BM25，语义召回缺失（常驻底色是止血）；配了之后要重算全部向量
- `collect_image` 没有图片搜索能力，只能收已看到的直链
- 抖音通路仍未启用

## 九、会话轮换（2026-11-13 补）

| 文件 | 改动 |
|---|---|
| `lib/config-schema.js` | `sessions.rotateDays`（0 = 不轮换） |
| `lib/gateway.js` `ensureSession()` | 会话存在天数超过 `rotateDays` → 标 retired + 新建（记忆不动，最近 4 句仍会带过去） |
| `lib/gateway.js` `retireSession()` | 手动重开：按 channelId 把该聊天的会话归档，下一条消息开新的 |
| `lib/routes.js` | `POST /sessions/rotate`（`{channelId}`）、`POST /sessions/rotate-days`（`{rotateDays}`）；state 带 `rotateDays` |
| `lib/client.js` | 「平台 → 会话」：自动轮换天数 + 每个聊天一个「重开」按钮 |
## 基线版本（升级前对照）

| 组件 | 版本 |
|---|---|
| DSH Desktop | 0.2.0-rc.2 |
| dsh-fish-soul | 0.15.46（file: 依赖指向本目录） |
| Node | 24.22.1 |
| dsh-recall-plugin | 2.6.5 |
| dsh-boot-suite | 2.16.13 |

升级 DSH 或点了插件的「更新」之后，先跑：

`
node tools/check-compat.mjs
`

全部 ✓ 才继续用；有 ✗ 就 git diff 看被覆盖了什么。插件自身的 update.autoCheck 已关，避免误点更新把补丁覆盖掉。