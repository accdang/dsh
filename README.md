# dsh-fish-soul（个人修改版）

[`dsh-fish-soul`](https://github.com/Britneycode/dsh-fish-soul) 的个人修改版，基准版本 **0.15.46**。
原插件是一个 DSH 人格插件：按人记忆、日程自走、主动开口，能收 QQ / B站 / 抖音 的私信与通知。

这个仓库只做三件事：把原版缺的能力补上、修掉几个真 bug、把写死的参数挪到设置页。

> 改动清单见 [PATCH-NOTES.md](PATCH-NOTES.md)：四十来处，每处都写了「哪个文件 / 改了什么 / 为什么」。

## 与原版的差异（摘要）

**新增能力**

- B站 的工具化操作：`bili_search`、`bili_video`、`bili_open`、`bili_feed`、`bili_comment`，模型可以按指令去搜、去看、去发；`bili_open` 支持 BV 号 / 视频链接 / `b23.tv` 短链 / 动态链接，可带 `rpid` 读某一条评论
- `collect_image`：把网络图片收进表情包库（≤2MB、魔数校验、去重）
- 会话认领：本地 DSH 窗口发 `/鱼 认领 <口令>` 即接上人格与记忆
- 会话轮换：自动（按天数）+ 手动「重开」，记忆不受影响

**修的 bug**

- 动态 @ 通知里 `subject_id` 不是评论区 oid（照它发评论会「成功但消失」）
- 请求 10s 硬超时且无重试 → 15s + 仅读操作重试一次
- 设置页「点了没反应 / 改完弹回去」：状态接口漏字段、保存路由重建对象时丢字段

**可调参数**（原来写死）

- 私信分条：条数 / 每条字数 / 跟随内容模式
- 提示词微变化：开关、周期、三档取样条数、字数上限
- 常驻记忆条数与字数

## 安装

```bash
# 放进你的 DSH profile
cd ~/.dsh/profiles/desktop
npm i "file:C:\\path\\to\\this\\repo"
# 或者把 package.json 里改成 file: 依赖
```

需要 DSH `0.2.x`。Node ≥ 22.5。

## 许可

MIT。原版权归 **Britneycode**（见 [LICENSE](LICENSE)），本仓库的修改同样以 MIT 提供。
这不是原作者发布的版本；问题请提到这个仓库，不要麻烦上游作者。
