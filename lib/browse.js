/**
 * browse.js —— 鱼自己刷 B站：空闲时从关注 / 首页推荐里挑几条没看过的视频，
 * 读标题、简介、字幕节选和热评，用她自己的口吻写一两句感受，记进"自己的记忆"（owner_id='self'），
 * 聊天时就能自然说出"我今天刷到……"。默认不点赞、不投币、不评论（点赞可在设置页打开）。
 */

import { getKv, setKv } from './db.js';
import { sleep } from './time-util.js';
import { guardPublicText, PUBLIC_RULES, isPromoText } from './public-guard.js';
import { tokenizeForBm25 } from './segment.js';

const BV_RE = /BV[0-9A-Za-z]{10}/g;
const SHORT_RE = /https?:\/\/(?:b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/g;
const DESCRIBE_TTL_MS = 3600_000;
const DAY_MS = 86_400_000;

// 只有明显不健康的内容才拦：擦边、成人、身体猎奇。
// 其余题材（游戏、鬼畜、综艺、时尚美妆…）一律不拦 —— 让她自己按喜好挑。
const UNSAFE_RE = /(擦边|露点|走光|裸|色情|成人视频|成人网红|成人网站|成人内容|onlyfans|福利姬|福利视频|约炮|一夜情|成人用品|无码|三级片|私房写真|ASMR.*(娇喘|呻吟)|娇喘|呻吟|身体改造)/i;

// 粗粒度题材：只用来做"一天别老看同一类"的配额，不追求分得准。
const TOPIC_RULES = [
	['游戏', /(火影|忍者|手游|游戏|王者|原神|崩坏|卡牌|抽卡|上分|排位|上段|段位|对局|连招|残局|boss|副本|皮肤|策划|版本|加强|削弱|强度|打法|阵容)/i],
	['美食', /(美食|做饭|做菜|菜谱|吃|烤|火锅|米其林|探店|零食|饮品)/],
	['风景', /(风景|旅行|徒步|海边|日落|雪山|露营|夜景|航拍|治愈系)/],
	['音乐', /(音乐|翻唱|钢琴|吉他|歌|旋律|乐器|演奏|编曲|摇滚|纯音乐)/],
	['运动', /(健身|跑步|篮球|足球|羽毛球|游泳|运动|训练|减脂)/],
	['知识', /(科普|知识|物理|数学|历史|哲学|心理|经济|读书|为什么)/],
	['动画', /(番剧|动画|动漫|二次元|剧场版|OVA|新番)/],
	['生活', /(vlog|日常|装修|家装|宠物|猫|狗|手工|种花)/]
];

const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').replace(/【/g, '〔').replace(/】/g, '〕').trim().slice(0, n);

/** 文本里的 BV 号与 b23 短链。 */
export function findVideoRefs(text) {
	const s = String(text ?? '');
	return { bvids: [...new Set(s.match(BV_RE) ?? [])], shorts: [...new Set(s.match(SHORT_RE) ?? [])] };
}

/**
 * 一轮刷完：记一条动态；挑一条她标了 [分享] 的交给自走层（一轮最多一条）。B站 / 抖音共用。
 * @param {{note?: Function|null, share?: Function|null, log: Function}} self
 */
export function afterRound(self, label, watched, pick) {
	const seen = watched.filter((w) => !w.skipped);
	try {
		self.note?.('browse', {
			title: label,
			reason: watched.length === 0 ? `刷${label}：这轮没刷到新视频` : `刷${label}：看了 ${watched.length} 条${seen.length < watched.length ? `，划走 ${watched.length - seen.length} 条` : ''}`,
			text: seen.map((w) => `《${String(pick(w).title ?? '').slice(0, 20)}》`).join(' ')
		});
	} catch { /* 动态可缺 */ }
	const s = watched.find((w) => w.share);
	if (!s || typeof self.share !== 'function') return;
	try {
		const r = self.share({ platform: label, ...pick(s), url: s.url, impression: s.impression });
		self.note?.(r?.ok ? 'share' : 'browse', { title: label, reason: r?.ok ? `想把《${String(pick(s).title ?? '').slice(0, 20)}》分享给你` : `想分享但没排上：${r?.error ?? '不知道为什么'}`, text: s.url });
	} catch (error) {
		self.log('warn', `[fish-soul] 排分享失败：${String(error instanceof Error ? error.message : error)}`);
	}
}

export class BiliBrowser {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {import('./clock.js').VirtualClock} deps.clock
	 * @param {import('./channels/bilibili.js').BiliClient} deps.client
	 * @param {() => object} deps.getConfig 返回 config.bili
	 * @param {(prompt: string) => Promise<string|null>} deps.callLlm
	 * @param {() => {name: string, brief: string}} deps.persona
	 * @param {{enqueueRealtime(id: number, text: string): void}} [deps.worker]
	 * @param {(level: string, msg: string) => void} [deps.log]
	 * @param {[number, number]} [deps.watchDelayMs] 两条视频之间"看"多久（真实毫秒）
	 */
	constructor({ db, clock, client, getConfig, callLlm, persona, worker, log, watchDelayMs = [8000, 20000], share, note, frames }) {
		this.share = share ?? null; // 刷到特别想分享的：交给自走层排一条主动消息（带链接）
		this.note = note ?? null; // 记一条动态
		this.db = db;
		this.clock = clock;
		this.client = client;
		this.getConfig = getConfig;
		this.callLlm = callLlm;
		this.persona = persona;
		this.worker = worker;
		this.log = log ?? (() => {});
		this.watchDelayMs = watchDelayMs;
		this.running = false;
		this.described = new Map();
		this.framesOf = frames ?? null; // 抽九宫格看画面（可缺：没有就只读文字）
	}

	cfg() {
		const b = this.getConfig() ?? {};
		const br = b.browse ?? {};
		const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : d);
		return {
			enabled: b.enabled === true && br.enabled !== false,
			perDay: num(br.perDay, 3, 0, 12),
			videosPerSession: num(br.videosPerSession, 3, 1, 6),
			like: br.like === true,
			share: br.share !== false,
			favorite: br.favorite === true,
			favoritePerDay: num(br.favoritePerDay, 2, 0, 30),
			commentReply: br.commentReply === true,
			commentReplyPerDay: num(br.commentReplyPerDay, 1, 0, 20),
			hotComments: num(br.hotComments, 6, 0, 30),
			danmaku: br.danmaku !== false,
			comment: br.comment === true,
			commentPerDay: num(br.commentPerDay, 1, 0, 20),
			// 刷到特别想分享的，可以在那条视频下面公开发一句 @主人（她自己的号，公开可见）
			shareAt: br.shareAt === true,
			shareAtPerDay: num(br.shareAtPerDay, 2, 0, 5),
			frames: br.frames === true,
			framesPerDay: num(br.framesPerDay, 1, 0, 15),
			framesPerDayChat: num(br.framesPerDayChat, 10, 0, 30),
			search: br.search === true,
			searchKeywords: (Array.isArray(br.searchKeywords) ? br.searchKeywords : [])
				.map((w) => String(w ?? '').trim()).filter((w) => w !== '').slice(0, 20),
			// 风格轮换 / 屏蔽词：都按字符串数组收，空数组 = 不启用
			styles: (Array.isArray(br.styles) ? br.styles : [])
				.map((w) => String(w ?? '').trim()).filter((w) => w !== '').slice(0, 30),
			blockKeywords: (Array.isArray(br.blockKeywords) ? br.blockKeywords : [])
				.map((w) => String(w ?? '').trim()).filter((w) => w !== '').slice(0, 50),
			searchPerDay: num(br.searchPerDay, 2, 0, 12),
			topicCap: num(br.topicCap, 2, 0, 10),
			maxLinks: num(br.maxLinks, 3, 1, 5),
			subtitleChars: num(br.subtitleChars, 1200, 0, 3000),
			descChars: num(br.descChars, 300, 0, 1000),
			hotCommentChars: num(br.hotCommentChars, 80, 0, 500)
		};
	}

	seen(bvid) {
		return this.db.prepare('SELECT 1 FROM bili_seen WHERE bvid = ?').get(bvid) !== undefined;
	}

	/** 屏蔽词命中（标题或 UP 名）→ 这条不看，也不算"世界里的事"。 */
	blocked(it) {
		const words = this.cfg().blockKeywords ?? [];
		const hay = `${it?.title ?? ''} ${it?.owner ?? ''}`;
		// 内置的"不健康"表：只有明显擦边/成人/身体猎奇的才拦，正常题材一律不拦
		if (UNSAFE_RE.test(hay)) return true;
		if (words.length === 0) return false;
		const low = hay.toLowerCase();
		return words.some((w) => w !== '' && low.includes(String(w).toLowerCase()));
	}

	/** 粗判这条视频属于哪一类（判不出来返回空串）。 */
	topicOf(title) {
		const t = String(title ?? '');
		if (t === '') return '';
		for (const [name, re] of TOPIC_RULES) if (re.test(t)) return name;
		return '';
	}

	topicDayKey() {
		return `bili.topic.${this.clock.getRoleDateParts().dateStr}`;
	}

	/** 今天这一类看了几条。 */
	topicToday(topic) {
		if (topic === '') return 0;
		try {
			const map = JSON.parse(getKv(this.db, this.topicDayKey(), '{}') ?? '{}');
			return Number(map?.[topic] ?? 0) || 0;
		} catch {
			return 0;
		}
	}

	/** 记一条：今天这一类 +1。 */
	bumpTopic(topic) {
		if (topic === '') return;
		try {
			const map = JSON.parse(getKv(this.db, this.topicDayKey(), '{}') ?? '{}') ?? {};
			map[topic] = (Number(map[topic] ?? 0) || 0) + 1;
			setKv(this.db, this.topicDayKey(), JSON.stringify(map));
		} catch { /* 记不上不影响看 */ }
	}

	/**
	 * 这一轮搜什么：先让她按自己的喜好挑，挑不出来再从分区里加权随机。
	 * 没开搜索 / 今天搜够了 → 空串。
	 */
	async nextStyleKeyword() {
		const c = this.cfg();
		if (c.search !== true) return '';
		if (this.searchedToday() >= Number(c.searchPerDay ?? 2)) return '';
		const styles = Array.isArray(c.styles) ? c.styles : [];
		const own = await this.askHerStyle(styles);
		if (own !== '') {
			setKv(this.db, 'browse.styleIdx', String((Math.max(0, Number(getKv(this.db, 'browse.styleIdx', '0') ?? 0) || 0) + 1) % Math.max(1, styles.length)));
			this.noteKeyword(own);
			return own;
		}
		if (styles.length === 0) return '';
		// 兜底：分区里随机，优先挑最近没搜过、最近也没看过的方向
		const recent = new Set(this.recentKeywords().map((w) => String(w)));
		const pool = styles.filter((s) => !recent.has(s));
		const list = pool.length > 0 ? pool : styles;
		const word = list[Math.floor(Math.random() * list.length)];
		setKv(this.db, 'browse.styleIdx', String((Math.max(0, Number(getKv(this.db, 'browse.styleIdx', '0') ?? 0) || 0) + 1) % Math.max(1, styles.length)));
		this.noteKeyword(word);
		return word;
	}

	/**
	 * 让她自己挑：把 B站 的分区摊在面前 + 最近刷到/搜过的东西，让她按喜好和当下心情选一个方向。
	 * 没有模型 / 调用失败 → 空串（走加权兜底）。
	 */
	async askHerStyle(styles) {
		const p = this.persona?.() ?? { name: '鱼' };
		const titles = this.recentTitles(6);
		const recent = this.recentKeywords();
		const prompt = [
			`你是「${p.name}」。你在 B站 想找点新视频看。`,
			...(styles.length > 0 ? [`B站 的分区有：${styles.join('、')}。`] : []),
			...(titles.length > 0 ? ['', '你最近刷到过：', ...titles.map((t) => `- ${t}`)] : []),
			...(recent.length > 0 ? ['', `你最近搜过：${recent.join('、')}，别重复。`] : []),
			'',
			'按你自己的喜好和此刻的心情，挑一个你真正想看的方向（可以是上面的分区，也可以是更具体的东西，比如「做饭」「海边日落」「钢琴」）。',
			'只输出一个 2-8 字的词，不要解释、不要引号、不要标点。',
			'如果你此刻什么都不想看，只输出 [不想看]。'
		].join('\n');
		try {
			const raw = String((await this.callLlm(prompt)) ?? '').trim();
			const first = raw.split(/\n/)[0] ?? '';
			if (first.includes('[不想看]')) return '';
			return oneLine(first.replace(/[「」“”"'`]/g, ''), 12);
		} catch { return ''; }
	}

	async candidates(count) {
		const pool = [];
		// 引流 / 广告 / 卖课：推荐流里这类占比不低，进来就先扔掉，别让她当成"世界里的事"
		let filtered = 0;
		let blockedCount = 0;
		const add = (list) => {
			for (const it of list) {
				if (this.seen(it.bvid) || pool.some((p) => p.bvid === it.bvid)) continue;
				if (isPromoText(it.title) || isPromoText(it.owner)) {
					filtered += 1;
					continue;
				}
				// 屏蔽词：比如首页一直推同一个手游，就别让她反复看同一个题材
				if (this.blocked(it)) {
					blockedCount += 1;
					continue;
				}
				// 题材配额：同一类今天看够了就跳过（推荐流会一直推同类，这是最后一道闸）
				const cap = Number(this.cfg().topicCap ?? 0);
				const topic = this.topicOf(it.title);
				if (cap > 0 && topic !== '' && this.topicToday(topic) >= cap) {
					blockedCount += 1;
					continue;
				}
				pool.push(it);
			}
		};
		try { add((await this.client.followingVideos()).slice(0, 8)); } catch (error) {
			this.log('warn', `[fish-soul] 取关注动态失败：${String(error instanceof Error ? error.message : error)}`);
		}
		const following = pool.splice(0, pool.length);
		const picked = following.length > 0 ? [following[Math.floor(Math.random() * Math.min(3, following.length))]] : [];
		// 她印象最好的 UP：偶尔去他主页看看有没有新的（这就是"有自己的优质创作者"）
		try {
			const favs = this.favoriteCreators(5);
			if (favs.length > 0) {
				const one = favs[Math.floor(Math.random() * favs.length)];
				let list = await this.client.spaceVideos(one.mid, 6);
				// 空间接口容易超时/被限流：拿不到就按 UP 名字搜一下兜底
				if (list.length === 0) {
					try { list = await this.client.search(one.name, 6); } catch { list = []; }
				}
				if (list.length > 0) add(list.slice(0, 2).map((x) => ({ ...x, source: 'creator' })));
			}
		} catch (error) {
			this.log('warn', `[fish-soul] 看喜欢的 UP 失败：${String(error instanceof Error ? error.message : error).slice(0, 60)}`);
		}
		// 站内搜索是"又一个来源"，不是替代：先只取一半名额放进 pool 头部，剩下的等关注 / 推荐选完还有空位再补。
		// 不这么分会把推荐全挤掉（搜索 8 条 > 一轮 3~6 条），审 #38 发现。
		let searchRest = [];
		// 先试"风格轮换"词（美食/风景/音乐…），没有配置风格时才用她自己的引导词
		const keyword = (await this.nextStyleKeyword()) || (await this.nextSearchKeyword());
		if (keyword !== '') {
			try {
				const found = await this.client.search(keyword, 8);
				if (found.length > 0) setKv(this.db, this.searchDayKey(), this.searchedToday() + 1);
				this.log('info', `[fish-soul] 站内搜「${keyword}」拿到 ${found.length} 条`);
				// 名额只有 1 个时让位给关注 / 推荐：搜索是"又一个来源"，不该独占唯一的一眼（审 #38）
				const half = count <= 1 ? 0 : Math.max(1, count - Math.floor(count / 2));
				if (half > 0) add(found.slice(0, half));
				searchRest = found.slice(half);
			} catch (error) {
				this.log('warn', `[fish-soul] 站内搜「${keyword}」失败：${String(error instanceof Error ? error.message : error)}`);
			}
		}
		try { add(await this.client.recommend(12)); } catch (error) {
			this.log('warn', `[fish-soul] 取首页推荐失败，改看热门：${String(error instanceof Error ? error.message : error)}`);
			try { add(await this.client.popular(12)); } catch { /* 都失败就算了 */ }
		}
		for (const it of pool) {
			if (picked.length >= count) break;
			if (!picked.some((p) => p.bvid === it.bvid)) picked.push(it);
		}
		// 关注 / 推荐不够（都失败、或都看过了）→ 才用搜索剩下的补，别让这一轮空跑
		for (const it of searchRest) {
			if (picked.length >= count) break;
			if (!this.seen(it.bvid) && !picked.some((p) => p.bvid === it.bvid)) picked.push(it);
		}
		if (filtered > 0) this.log('info', `[fish-soul] 推荐流里过滤了 ${filtered} 条引流视频`);
		if (blockedCount > 0) this.log('info', `[fish-soul] 按屏蔽词跳过 ${blockedCount} 条（不想让她看的那类）`);
		return picked.slice(0, count);
	}

	/** 记下这个 UP 主：看得多、赞过、收藏过都会累计；第一次喜欢他时写一条记忆。 */
	rememberCreator(v, { liked = false, favorited = false } = {}) {
		const name = String(v?.owner ?? '').trim();
		if (name === '') return;
		const mid = String(v?.ownerMid ?? '').trim();
		const now = this.clock.now();
		try {
			const row = this.db.prepare('SELECT watches, likes, favorites FROM bili_creator WHERE name = ?').get(name);
			if (row) {
				this.db.prepare(`UPDATE bili_creator SET watches = watches + 1, likes = likes + ?, favorites = favorites + ?,
					last_at = ?, mid = CASE WHEN ? <> '' THEN ? ELSE mid END WHERE name = ?`)
					.run(liked ? 1 : 0, favorited ? 1 : 0, now, mid, mid, name);
			} else {
				this.db.prepare('INSERT INTO bili_creator (name, mid, watches, likes, favorites, last_at) VALUES (?, ?, 1, ?, ?, ?)')
					.run(name, mid, liked ? 1 : 0, favorited ? 1 : 0, now);
			}
			// 第一次喜欢 / 收藏这个 UP → 记一条，让她以后能想起"我喜欢他"
			const firstLove = (liked || favorited) && (!row || (Number(row.likes ?? 0) + Number(row.favorites ?? 0)) === 0);
			if (firstLove) {
				const how = favorited ? '收藏了他的视频' : '给他点过赞';
				this.writeMemory(`我喜欢 UP 主「${name}」的内容——我已经${how}。以后可以多看看他发的东西。`, '');
			}
		} catch { /* 记不上不影响看视频 */ }
	}

	/** 她印象最好的几个 UP（点赞 > 收藏 > 看过的次数）。 */
	favoriteCreators(n = 5) {
		try {
			return this.db.prepare(`SELECT name, mid FROM bili_creator
				WHERE likes + favorites > 0 AND mid <> ''
				ORDER BY (likes * 3 + favorites * 2 + watches) DESC, last_at DESC LIMIT ?`).all(n);
		} catch {
			return [];
		}
	}

	/** 视频的"看到的内容"：详情 + 字幕节选 + 热评（字幕要登录，取不到就只看简介和评论）。 */
	async gather(bvid, { subtitleChars = 1200, danmaku = this.cfg().danmaku } = {}) {
		const info = await this.client.view(bvid);
		let subtitle = '';
		if (subtitleChars > 0) {
			try { subtitle = await this.client.subtitleText(info.bvid, info.cid, subtitleChars); } catch { /* 没字幕 */ }
		}
		let comments = [];
		try { comments = await this.client.hotComments(info.aid, this.cfg().hotComments); } catch { /* 没评论 */ }
		let danmakuLines = [];
		if (danmaku && typeof this.client.danmaku === 'function') {
			try { danmakuLines = await this.client.danmaku(info.cid, 12); } catch { /* 没弹幕 / 解不开 */ }
		}
		return { ...info, subtitle, comments, danmaku: danmakuLines };
	}

	framesDayKey() {
		return `bili.frames.${this.clock.getRoleDateParts().dateStr}`;
	}

	framedToday() {
		return Number(getKv(this.db, this.framesDayKey(), 0)) || 0;
	}

	/** 你发链接给她时抽的帧，另记一本账，不占她自己刷视频的次数。 */
	framesChatDayKey() {
		return `bili.frames.chat.${this.clock.getRoleDateParts().dateStr}`;
	}

	framedTodayChat() {
		return Number(getKv(this.db, this.framesChatDayKey(), 0)) || 0;
	}

	favDayKey() {
		return `bili.fav.${this.clock.getRoleDateParts().dateStr}`;
	}

	replyDayKey() {
		return `bili.reply.${this.clock.getRoleDateParts().dateStr}`;
	}

	repliedToday() {
		return Number(getKv(this.db, this.replyDayKey(), 0)) || 0;
	}

	/** 最近一次回过的评论（设置页显示用），没回过返回 null。 */
	recentReply() {
		return getKv(this.db, 'bili.reply.last', null) ?? null;
	}

	favoritedToday() {
		return Number(getKv(this.db, this.favDayKey(), 0)) || 0;
	}

	searchDayKey() {
		return `bili.search.${this.clock.getRoleDateParts().dateStr}`;
	}

	searchedToday() {
		return Number(getKv(this.db, this.searchDayKey(), 0)) || 0;
	}

	commentDayKey() {
		return `bili.comment.${this.clock.getRoleDateParts().dateStr}`;
	}

	commentedToday() {
		return Number(getKv(this.db, this.commentDayKey(), 0)) || 0;
	}

	shareAtDayKey() {
		return `bili.shareat.${this.clock.getRoleDateParts().dateStr}`;
	}

	shareAtToday() {
		return Number(getKv(this.db, this.shareAtDayKey(), 0)) || 0;
	}

	/**
	 * 刷到特别想分享的视频：在那条视频下面公开留一句 `@主人 我的感受`。
	 * 和「发私信分享」是两条路：私信只有他看得到，这条是公开的（也会真 @ 到他）。
	 * 文案照样过护栏，只 @ 主人一个人。
	 */
	async shareAtOwner(v, impression) {
		const c = this.cfg();
		const uid = String(this.getConfig?.()?.masterUid ?? '').trim();
		if (uid === '') return '';
		let nick = '';
		try {
			nick = String((await this.client.userName(uid)) ?? '').trim();
		} catch { /* 取不到昵称就不 @，宁可不发 */ }
		if (nick === '') return '';
		const body = guardPublicText(oneLine(impression, 60), { maxChars: 50 });
		if (!body.ok) {
			this.log('warn', `[fish-soul] 分享评论被护栏拦下（${body.reason}）：${impression}`);
			return '';
		}
		const text = `@${nick} ${body.text}`;
		try {
			await this.client.replyComment({ type: 1, oid: v.aid, root: 0, parent: 0, message: text });
			setKv(this.db, this.shareAtDayKey(), this.shareAtToday() + 1);
			this.log('info', `[fish-soul] 在《${oneLine(v.title, 30)}》下 @ 了主人：${text}`);
			return text;
		} catch (error) {
			this.log('warn', `[fish-soul] 分享评论没发出去：${String(error instanceof Error ? error.message : error)}`);
			return '';
		}
	}

	/** 她最近看过的几条标题（给她自己提搜索词当原料）。 */
	recentTitles(n = 5) {
		try {
			return this.db.prepare('SELECT title, owner_name FROM bili_seen ORDER BY seen_real_at DESC LIMIT ?').all(n)
				.map((r) => oneLine(r.title, 40)).filter(Boolean);
		} catch { return []; }
	}

	/** 最近搜过的词（最新的在前，最多 5 个），给提词当"别重复"的参考。 */
	recentKeywords() {
		try {
			const raw = JSON.parse(getKv(this.db, 'bili.search.recent', '[]'));
			return Array.isArray(raw) ? raw.map((x) => String(x ?? '')).filter((x) => x !== '').slice(0, 5) : [];
		} catch { return []; }
	}

	/** 记下这次搜的词，重复的挪到最前。 */
	noteKeyword(word) {
		const w = String(word ?? '').trim();
		if (w === '') return;
		const list = [w, ...this.recentKeywords().filter((x) => x !== w)].slice(0, 5);
		try { setKv(this.db, 'bili.search.recent', JSON.stringify(list)); } catch { /* 记不住不影响搜索 */ }
	}

	/** 没填词表时，让她自己按最近看过的提一个搜索词（一次小模型调用，只输出几个字）。 */
	async draftSearchKeyword() {
		const titles = this.recentTitles(5);
		if (titles.length === 0) return '';
		const p = this.persona?.() ?? { name: '鱼' };
		const recent = this.recentKeywords();
		const prompt = [
			`你是「${p.name}」。你最近刷到这些视频：`,
			...titles.map((t) => `- ${t}`),
			...(recent.length > 0 ? ['', `你最近已经搜过：${recent.join('、')}。这次换个方向，别重复。`] : []),
			'',
			'你现在想在 B站 搜一个新词，找点新鲜的。只输出一个 2-8 字的搜索词，不要解释、不要引号、不要标点。'
		].join('\n');
		try {
			const raw = String((await this.callLlm(prompt)) ?? '').trim();
			const first = raw.split(/\n/)[0] ?? '';
			return oneLine(first.replace(/[「」“”"'`]/g, ''), 12);
		} catch { return ''; }
	}

	/** 这一轮要不要搜、搜什么词（没开 / 今天额度用完 / 想不出词 → 空串）。 */
	async nextSearchKeyword() {
		const c = this.cfg();
		if (c.search !== true) return '';
		if (this.searchedToday() >= Number(c.searchPerDay ?? 2)) return '';
		const words = (Array.isArray(c.searchKeywords) ? c.searchKeywords : [])
			.map((w) => String(w ?? '').trim()).filter((w) => w !== '');
		if (words.length > 0) {
			const picked = words[Math.floor(Math.random() * words.length)];
			this.noteKeyword(picked);
			return picked;
		}
		const drafted = await this.draftSearchKeyword();
		if (drafted !== '') this.noteKeyword(drafted);
		return drafted;
	}

	promptFor(v, like, share = false, favorite = false, hasFrames = false) {
		const p = this.persona?.() ?? { name: '鱼', brief: '' };
		return [
			`你是「${p.name}」。${p.brief}`.trim(),
			'你刚在 B站刷到一个视频：',
			`标题：${oneLine(v.title, 80)}`,
			`UP主：${oneLine(v.owner, 30) || '未知'}${v.tname ? `；分区：${v.tname}` : ''}`,
			'（留意一下这是谁发的——如果他的东西一直合你口味，以后可以多看他；喜欢就点赞/收藏，我会记住这个 UP。）',
			v.desc ? `简介：${oneLine(v.desc, 200)}` : '',
			v.subtitle ? `字幕节选：${v.subtitle}` : '（这个视频没有字幕，只能看简介和评论）',
			v.comments.length > 0 ? `热评：\n${v.comments.map((c) => `- ${c}`).join('\n')}` : '',
			hasFrames ? '画面：附了一张九宫格截图（从开头每 6 秒一格，共 9 格）。如果画面能看清，就在感受里写一句画面里的具体细节——谁在做什么、什么颜色、场景长什么样；实在看不清就写“没看到画面”。' : '',
			(v.danmaku ?? []).length > 0 ? `弹幕（按时间抽了几条）：${v.danmaku.map((d) => oneLine(d, 30)).join(' / ')}` : '',
			'',
			'用第一人称、口语化写一两句你看完的感受（大概讲了什么 + 你怎么看），不超过 80 字，不要照抄标题。',
			'完全没兴趣、划走了就只输出 [划走]。' + (like ? '特别喜欢的话在末尾加 [点赞]。' : '') + (share ? '特别有意思、很想发给朋友看的，在末尾加 [分享]（大多数视频不用）。' : '') +
				(favorite ? '以后还想再看、值得存起来的（教程、攻略、菜谱、特别喜欢的），在末尾加 [收藏]（大多数视频不用）。' : '')
		].filter((l) => l !== '').join('\n');
	}

	writeMemory(content, bvid) {
		const now = this.clock.now();
		const result = this.db.prepare(`
			INSERT INTO memory (character_id, owner_id, channel, channel_id, kind, content, keywords,
			                    importance, emotion, source_session, created_at, updated_at, status)
			VALUES ('feiyu', 'self', 'bili', ?, 'event', ?, ?, 1, 0, '', ?, ?, 'active')
		`).run(`bili:video:${bvid}`, content, tokenizeForBm25(content), now, now);
		const id = Number(result.lastInsertRowid);
		try { this.worker?.enqueueRealtime(id, content); } catch { /* 向量可缺 */ }
		return id;
	}

	/**
	 * 要不要抽帧看画面：开关开着、有 cid、不是短片、今天还有额度。
	 * 失败只记一条 warn，返回 null —— 绝不因为抽帧失败就看不到视频。
	 */
	async frameIfWanted(v, c) {
		if (c.frames !== true || typeof this.framesOf !== 'function') return null;
		if (!v.cid || (Number(v.duration ?? 0) < 120)) return null;
		if (this.framedToday() >= Number(c.framesPerDay ?? 1)) return null;
		try {
			const img = await this.framesOf(v);
			if (img?.data) {
				setKv(this.db, this.framesDayKey(), this.framedToday() + 1);
				return img;
			}
		} catch (error) {
			this.log('warn', `[fish-soul] 抽帧没成（照旧只看文字）：${String(error instanceof Error ? error.message : error)}`);
		}
		return null;
	}

	/** 你发链接过来时抽一帧，额度跟"自己刷"分开。 */
	async frameForLink(v, c) {
		if (c.frames !== true || typeof this.framesOf !== 'function') return null;
		if (!v.cid || (Number(v.duration ?? 0) < 60)) return null;
		if (this.framedTodayChat() >= Number(c.framesPerDayChat ?? 10)) return null;
		try {
			const img = await this.framesOf(v);
			if (img?.data) {
				setKv(this.db, this.framesChatDayKey(), this.framedTodayChat() + 1);
				return img;
			}
		} catch (error) {
			this.log('warn', `[fish-soul] 分享抽帧没成（照旧只看文字）：${String(error instanceof Error ? error.message : error)}`);
		}
		return null;
	}

	/** 把一张九宫格读成一句话，写进聊天时她能看到的那段文字里。 */
	async visualNote(v, frame) {
		try {
			const text = await this.callLlm(
				`这是 B站 视频《${oneLine(v.title, 40)}》开头的九宫格截图（每格约 6 秒）。` +
					'用一句不超过 30 字的话，写画面里看到的具体东西：谁在做什么、什么颜色、什么场景。' +
					'看不清就只写「没看清」。不要分点、不要引号、不要写"这张图"。',
				{ feature: 'browse', maxTokens: 80, images: [frame] }
			);
			const t = oneLine(String(text ?? '').replace(/^["“]|["”]$/g, ''), 40);
			return t && t !== '没看清' ? t : '';
		} catch (error) {
			this.log('warn', `[fish-soul] 读画面没成：${String(error instanceof Error ? error.message : error)}`);
			return '';
		}
	}

	/** 评论区留一句的提示词（短、口语、像真人随手写的）。 */
	commentPrompt(v, impression) {
		const p = this.persona?.() ?? { name: '鱼', brief: '' };
		return [
			`你是「${p.name}」。${p.brief}`.trim(),
			`你刚看完 B站 视频《${oneLine(v.title, 60)}》${v.owner ? `（UP主 ${oneLine(v.owner, 20)}）` : ''}。`,
			`你自己记下的感受：${oneLine(impression, 100)}`,
			'现在想在评论区留一句（不是回谁，就是自己看完想说）。',
			'要求：第一人称、口语、一到两句，不超过 25 个字；像真人随手写的，不要「打卡」「沙发」「前排」这类；不@人、不贴链接、不复述标题、不评价 UP主 本人。',
			PUBLIC_RULES,
			'只想说「好看」这种空话，就只输出 [不评]。否则只输出那句话本身。'
		].filter(Boolean).join('\n');
	}

	/** 在视频底下留一句。成功返回评论文本，没留返回 ''。 */
	async commentOn(v, impression) {
		let text = '';
		try {
			const out = String((await this.callLlm(this.commentPrompt(v, impression))) ?? '').trim();
			if (/\[不评\]/.test(out)) return '';
			text = oneLine(out.replace(/^[「“"']|[」”"']$/g, ''), 25);
		} catch (error) {
			this.log('warn', `[fish-soul] 想评论没想出来：${String(error instanceof Error ? error.message : error)}`);
			return '';
		}
		if (text === '') return '';
		const guarded = guardPublicText(text, { maxChars: 25 });
		if (!guarded.ok) {
			this.log('warn', `[fish-soul] 评论被护栏拦下（${guarded.reason}）：${text}`);
			return '';
		}
		text = guarded.text;
		let timer = null;
		try {
			await Promise.race([
				this.client.replyComment({ type: 1, oid: v.aid, root: 0, parent: 0, message: text }),
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('评论发帖超时')), 15_000); timer.unref?.(); })
			]);
			setKv(this.db, this.commentDayKey(), this.commentedToday() + 1);
			this.log('info', `[fish-soul] 在《${oneLine(v.title, 30)}》评论区留了一句：${text}`);
			return text;
		} catch (error) {
			this.log('warn', `[fish-soul] 评论没发出去：${String(error instanceof Error ? error.message : error)}`);
			return '';
		} finally { if (timer !== null) clearTimeout(timer); }
	}

	/**
	 * 楼中楼：从视频现有评论里挑一条值得搭话的，回一句（只回一条，不追着聊）。
	 * 模型输出「序号|回复内容」；[不回] / 序号不合法 / 内容为空都算没回。
	 */
	async commentReplyOn(v) {
		let list = [];
		try {
			list = await this.client.commentList(v.aid, 10);
		} catch (error) {
			this.log('warn', `[fish-soul] 读评论没成：${String(error instanceof Error ? error.message : error)}`);
			return '';
		}
		const me = String(this.client.uid ?? '');
		list = (list ?? []).filter((x) => x.content && x.rpid && String(x.mid) !== me);
		if (list.length === 0) return '';
		const p = this.persona?.() ?? { name: '鱼', brief: '' };
		const lines = [
			`你是「${p.name}」。${p.brief}`.trim(),
			`你刚看完 B站 视频《${oneLine(v.title, 50)}》。评论区长这样：`,
			...list.map((x, i) => `${i + 1}. ${x.name || '有人'}：${x.content}`),
			'挑一条你想接话的，回一句。要求：第一人称、口语、一到两句，不超过 30 个字；',
			'不要复述他说的话，不要@人，不要引战、不要跟人抬杠，不评价 UP主 本人，广告和骂人的别接。',
			PUBLIC_RULES,
			'没有想接的就只输出 [不回]。要回就只输出「序号|回复内容」，两行都不要解释。'
		];
		const out = String((await this.callLlm(lines.join('\n'))) ?? '').trim();
		if (out === '' || /\[不回\]/.test(out)) return '';
		const m = out.match(/^\s*(\d{1,2})\s*[|｜]\s*([\s\S]+)$/);
		if (!m) return '';
		const pick = list[Number(m[1]) - 1];
		const text = oneLine(m[2].replace(/^[「“"']|[」”"']$/g, ''), 60);
		if (!pick || text === '') return '';
		const guarded = guardPublicText(text, { maxChars: 60 });
		if (!guarded.ok) {
			this.log('warn', `[fish-soul] 楼中楼回复被护栏拦下（${guarded.reason}）：${text}`);
			return '';
		}
		try {
			await this.client.replyComment({ type: 1, oid: v.aid, root: pick.rpid, parent: 0, message: guarded.text });
			setKv(this.db, this.replyDayKey(), this.repliedToday() + 1);
			setKv(this.db, 'bili.reply.last', { bvid: v.bvid, title: oneLine(v.title, 40), name: pick.name, text, root: pick.rpid, at: Date.now() });
			this.log('info', `[fish-soul] 回了 @${pick.name} 的评论：${text}`);
			return text;
		} catch (error) {
			this.log('warn', `[fish-soul] 回评论没发出去：${String(error instanceof Error ? error.message : error)}`);
			return '';
		}
	}

	async watch(item, like, share = false, favorite = false) {
		// 兜底：候选池之外（比如手动挑的）也可能是引流，别让她看、更别评论
		if (isPromoText(item.title) || isPromoText(item.owner)) {
			this.log('info', `[fish-soul] 跳过一条引流视频：${oneLine(item.title, 30)}`);
			return { bvid: item.bvid, title: item.title ?? '', owner: item.owner ?? '', impression: '', skipped: true, promo: true, liked: false, favorited: false, commented: '', replied: '', sharedAt: '', share: false, url: `https://www.bilibili.com/video/${item.bvid}` };
		}
		// 屏蔽词兜底（手动挑的也拦）：这类题材她看多了会一直被困在同一条推流里
		if (this.blocked(item)) {
			this.log('info', `[fish-soul] 按屏蔽词跳过：${oneLine(item.title, 30)}`);
			return { bvid: item.bvid, title: item.title ?? '', owner: item.owner ?? '', impression: '', skipped: true, blocked: true, liked: false, favorited: false, commented: '', replied: '', sharedAt: '', share: false, url: `https://www.bilibili.com/video/${item.bvid}` };
		}
		const v = await this.gather(item.bvid);
		const c = this.cfg();
		const frame = await this.frameIfWanted(v, c);
		const out = await this.callLlm(this.promptFor(v, like, share, favorite, frame !== null), frame ? { images: [frame] } : undefined);
		const raw = String(out ?? '').trim();
		const skipped = /\[划走\]/.test(raw);
		const liked = like && /\[点赞\]/.test(raw);
		const wantShare = share && !skipped && /\[分享\]/.test(raw);
		const wantFav = favorite && !skipped && /\[收藏\]/.test(raw);
		const impression = oneLine(raw.replace(/\[(划走|点赞|分享|收藏)\]/g, ''), 120);
		let memoryId = null;
		if (!skipped) {
			const who = v.owner ? `${v.owner} 的` : '';
			const content = impression !== ''
				? `我在B站刷到${who}视频《${oneLine(v.title, 60)}》：${impression}`
				: `我在B站刷到${who}视频《${oneLine(v.title, 60)}》${v.tname ? `（${v.tname}）` : ''}`;
			memoryId = this.writeMemory(content, v.bvid);
		}
		if (liked) {
			try { await this.client.like(v.aid); } catch (error) {
				this.log('warn', `[fish-soul] 点赞失败：${String(error instanceof Error ? error.message : error)}`);
			}
		}
		let favorited = false;
		if (wantFav && this.favoritedToday() < this.cfg().favoritePerDay) {
			try {
				await this.client.favorite(v.aid);
				favorited = true;
				setKv(this.db, this.favDayKey(), this.favoritedToday() + 1);
			} catch (error) {
				this.log('warn', `[fish-soul] 收藏失败：${String(error instanceof Error ? error.message : error)}`);
			}
		}
		// UP 主印象：看得多、点过赞、收藏过的会被记住 —— 时间久了她就有自己的"常看名单"
		this.rememberCreator(v, { liked, favorited });
		if (!skipped) this.bumpTopic(this.topicOf(v.title));
		// 评论区留一句：只在真看完、有感受、开关开着、今天还没到额度时
		let commented = '';
		if (!skipped && impression !== '' && c.comment && v.aid && this.commentedToday() < c.commentPerDay) {
			commented = await this.commentOn(v, impression);
		}
		// 楼中楼：回一条别人的评论（默认关，单独额度）
		let replied = '';
		const replyCfg = this.cfg();
		if (!skipped && replyCfg.commentReply && v.aid && this.repliedToday() < replyCfg.commentReplyPerDay) {
			replied = await this.commentReplyOn(v);
		}
		// 刷到特别想分享的：在那条视频下公开 @ 主人（和私信分享是两条路，额度独立）
		let sharedAt = '';
		if (wantShare && !skipped && impression !== '' && c.shareAt && this.shareAtToday() < c.shareAtPerDay) {
			sharedAt = await this.shareAtOwner(v, impression);
		}
		this.db.prepare(`
			INSERT INTO bili_seen (bvid, aid, title, owner_name, source, impression, skipped, liked, favorited, memory_id, seen_at, seen_real_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(bvid) DO NOTHING
		`).run(v.bvid, v.aid, oneLine(v.title, 120), oneLine(v.owner, 40), item.source ?? 'recommend', impression,
			skipped ? 1 : 0, liked ? 1 : 0, favorited ? 1 : 0, memoryId, this.clock.now(), Date.now());
		return { bvid: v.bvid, title: v.title, owner: v.owner, impression, skipped, liked, favorited, commented, replied, sharedAt, share: wantShare && impression !== '', url: `https://www.bilibili.com/video/${v.bvid}` };
	}

	/** 刷一轮。返回看过的视频。 */
	async run({ count } = {}) {
		if (this.running) return { ok: false, error: '正在刷，稍等' };
		this.running = true;
		try {
			const c = this.cfg();
			const items = await this.candidates(count ?? c.videosPerSession);
			const watched = [];
			for (const [i, item] of items.entries()) {
				if (i > 0) {
					const [lo, hi] = this.watchDelayMs;
					await sleep(lo + Math.floor(Math.random() * Math.max(0, hi - lo)));
				}
				try { watched.push(await this.watch(item, c.like, c.share && this.share !== null, c.favorite && this.favoritedToday() < c.favoritePerDay)); } catch (error) {
					this.log('warn', `[fish-soul] 看视频 ${item.bvid} 失败：${String(error instanceof Error ? error.message : error)}`);
				}
			}
			if (watched.length > 0) this.log('info', `[fish-soul] 刷了 ${watched.length} 条 B站视频：${watched.map((w) => w.title.slice(0, 16)).join(' / ')}`);
			afterRound(this, 'B站', watched, (w) => ({ title: w.title, author: w.owner }));
			return { ok: true, watched };
		} finally {
			this.running = false;
		}
	}

	/** 设置页：最近看过的。 */
	recent(limit = 8) {
		return this.db.prepare(`
			SELECT bvid, title, owner_name AS owner, impression, skipped, liked, favorited, source, seen_real_at AS seenAt
			FROM bili_seen ORDER BY seen_real_at DESC LIMIT ?
		`).all(limit).map((r) => ({ ...r, skipped: r.skipped === 1, liked: r.liked === 1, favorited: r.favorited === 1 }));
	}

	/**
	 * 瞬态块：最近看过的、有感受的几条。
	 *
	 * 🔴 窗口从「1 个虚拟日」放宽到 2 个：以前昨天刷的今天就查不到，表现是
	 *    「她明明刷了却说想不起来」（#78 真机复现：今天问昨天的视频，记忆里检索得到、
	 *    瞬态块里一条都不给）。
	 */
	contextLines(limit = 3) {
		const rows = this.db.prepare(`
			SELECT bvid, title, owner_name, impression FROM bili_seen
			WHERE skipped = 0 AND impression <> '' AND seen_at >= ?
			ORDER BY seen_at DESC LIMIT ?
		`).all(this.clock.now() - 2 * DAY_MS, limit);
		return rows.map((r) => `- 《${oneLine(r.title, 40)}》${r.owner_name ? `（${r.owner_name}）` : ''}：${r.impression}（链接 https://www.bilibili.com/video/${r.bvid}）`);
	}

	/** 聊天里有人发了 B站视频：取一段简短介绍拼进消息，让她"看过"再回。 */
	async describe(refs, { max = this.cfg().maxLinks } = {}) {
		const c = this.cfg();
		const bvids = [...(refs.bvids ?? [])];
		for (const s of refs.shorts ?? []) {
			if (bvids.length >= max) break;
			const bv = await this.client.resolveShort(s);
			if (bv && !bvids.includes(bv)) bvids.push(bv);
		}
		const notes = [];
		for (const bvid of bvids.slice(0, max)) {
			const hit = this.described.get(bvid);
			if (hit !== undefined && Date.now() - hit.at < DESCRIBE_TTL_MS) { notes.push(hit.text); continue; }
			try {
				const v = await this.gather(bvid, { subtitleChars: c.subtitleChars, danmaku: false });
				const frame = await this.frameForLink(v, c);
				const visual = frame ? await this.visualNote(v, frame) : '';
				const text = `【视频 ${bvid}：《${oneLine(v.title, 60)}》UP主 ${oneLine(v.owner, 20) || '未知'}` +
					(v.desc ? `；简介：${oneLine(v.desc, c.descChars)}` : '') +
					(v.subtitle ? `；字幕节选：${oneLine(v.subtitle, c.subtitleChars)}` : '') +
					(v.comments[0] ? `；热评：${oneLine(v.comments[0], c.hotCommentChars)}` : '') +
					(visual ? `；画面：${visual}` : '') + '】';
				this.described.set(bvid, { text, at: Date.now() });
				if (this.described.size > 200) this.described.delete(this.described.keys().next().value);
				notes.push(text);
			} catch { /* 这条看不了 */ }
		}
		return notes;
	}
}
