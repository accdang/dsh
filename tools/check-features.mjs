#!/usr/bin/env node
/**
 * 功能自检（只读）：把插件原有能力挨个摸一遍，能摸的通不通报一声。
 *
 *   node tools/check-features.mjs
 *
 * 不写库、不发消息、不点赞，纯读 + 一次 B站 只读接口。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const soul = join(home, '.dsh', 'fish-soul', 'soul.db');
const ws = join(home, '.dsh', 'fish-soul', 'workspace');
const cfgPath = join(home, '.dsh', 'fish-soul-config.json');

const rows = [];
const ok = (name, detail = '') => rows.push(['✓', name, detail]);
const bad = (name, detail = '') => rows.push(['✗', name, detail]);
const skip = (name, detail = '') => rows.push(['–', name, detail]);

// ── 数据库：原有表是否都在 ──
let db;
try {
	db = new DatabaseSync(soul, { readOnly: true });
	ok('soul.db 可读');
} catch (error) {
	bad('soul.db 打不开', String(error.message ?? error));
}

if (db) {
	const want = ['memory', 'person', 'chat_session', 'bili_seen', 'social_reply', 'pending', 'kv'];
	const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
	for (const t of want) {
		if (!have.has(t)) { bad(`表 ${t}`, '不见了'); continue; }
		const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
		ok(`表 ${t}`, `${n} 行`);
	}
	// 关键字段（原有功能依赖它们）
	const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
	const memCols = cols('memory');
	for (const c of ['owner_id', 'kind', 'importance', 'visibility', 'status']) {
		memCols.has(c) ? ok(`memory.${c}`) : bad(`memory.${c}`, '字段没了');
	}
}

// ── 配置：原有配置段是否还在 ──
try {
	const { readFileSync } = await import('node:fs');
	const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
	for (const k of ['bili', 'qq', 'douyin', 'voice', 'stickers', 'browse', 'life', 'embedding', 'retrieval', 'sessions']) {
		cfg[k] === undefined ? skip(`配置 ${k}`, '未设置（用默认值）') : ok(`配置 ${k}`);
	}
} catch (error) {
	bad('配置文件', String(error.message ?? error));
}

// ── 今天的实际使用（证明这些功能真的跑过） ──
if (db) {
	const day = new Date().toISOString().slice(0, 10);
	const kv = (k, d = '0') => {
		try { return String(db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value ?? d); } catch { return d; }
	};
	const num = (k) => Number(kv(k, '0')) || 0;
	const used = [
		['刷视频', num(`bili.browse.day`) || kv(`bili.browse.day`).includes('"count"') ? '有记录' : '今天没跑'],
		['站内搜索', `${num(`bili.search.${day}`)} 次`],
		['发动态', `${num(`bili.post.day`) > 0 ? kv('bili.post.day') : '0'}（原始值）`],
		['视频下评论', `${num(`bili.comment.${day}`)} 条`],
		['楼中楼回复', `${num(`bili.reply.${day}`)} 条`],
		['公开 @ 主人', `${num(`bili.shareat.${day}`)} 次`],
		['抽帧看画面', `${num(`bili.frames.${day}`)} 次`]
	];
	for (const [name, detail] of used) ok(name, detail);
}

// ── 表情包库 ──
try {
	const dir = join(ws, '_stickers');
	if (!existsSync(dir)) skip('表情包库', '目录不存在');
	else {
		const files = readdirSync(dir);
		files.length > 0 ? ok('表情包库', `${files.length} 张`) : skip('表情包库', '还是空的');
	}
} catch { /* 忽略 */ }

// ── 会话记录 ──
if (db) {
	const n = db.prepare("SELECT COUNT(*) c FROM chat_session WHERE status = 'active'").get().c;
	n > 0 ? ok('聊天会话', `${n} 个活跃`) : skip('聊天会话', '还没有');
}

// ── HTTP 接口（进程活着吗） ──
try {
	const r = await fetch('http://127.0.0.1:19387/api/plugins/fish-soul/diagnose', { signal: AbortSignal.timeout(6000) });
	const j = await r.json();
	ok('诊断接口', `${(j.items ?? []).length} 项`);
	const st = await (await fetch('http://127.0.0.1:19387/api/plugins/fish-soul/channels/state', { signal: AbortSignal.timeout(6000) })).json();
	ok('平台状态接口', `B站 ${st.bili?.loggedIn ? '已登录' : '未登录'} / QQ ${st.qq?.connected ? '已连' : '未连'}`);
} catch (error) {
	skip('HTTP 接口', `进程没在跑（${String(error.message ?? error).slice(0, 40)}）`);
}

// ── B站 只读接口 ──
try {
	// 插件目录：默认按本脚本所在仓库，可用环境变量覆盖（别在源码里写死本机路径）
	const vendored = process.env.FISH_SOUL_VENDORED ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
	const { pathToFileURL } = await import('node:url');
	const { BiliClient } = await import(pathToFileURL(join(vendored, 'lib', 'channels', 'bilibili.js')).href);
	const c = new BiliClient({ log: () => {} });
	if (c.loggedIn !== true) skip('B站 接口', '没登录');
	else {
		const v = await c.view('BV1g7Wh6vEk7');
		ok('B站 看视频', `《${String(v.title).slice(0, 16)}》`);
		// 主人的 UID 从配置读，源码里不写死
		let masterUid = '';
		try {
			masterUid = String(JSON.parse(readFileSync(cfgPath, 'utf8')).bili?.masterUid ?? '');
		} catch { masterUid = ''; }
		if (masterUid === '') skip('B站 读点赞', '没配 masterUid');
		else {
			const likes = await c.userLikes(masterUid, 3);
			ok('B站 读点赞', `${likes.length} 条`);
		}
	}
} catch (error) {
	bad('B站 接口', String(error.message ?? error).slice(0, 50));
}

// ── 输出 ──
const w = Math.max(...rows.map((r) => r[1].length)) + 2;
console.log('');
for (const [mark, name, detail] of rows) console.log(`${mark} ${name.padEnd(w)}${detail}`);
const fails = rows.filter((r) => r[0] === '✗').length;
console.log(`\n${fails === 0 ? '没有硬失败。' : `${fails} 项失败，见上。`}\n`);
