/**
 * bili-emotes.js —— B站 私信表情面板。
 *
 * B站 的表情**不用发图片**：正文里写 `[doge]` 这种码，服务端自己渲染成表情。
 * 依据：官方文档里 `e_infos`（表情列表）「仅当 msg[msg_type] 为 1、且私信内容中有表情时有此项」
 * ⇒ 表情是文本消息的一部分。真机私信历史里也抓到过 `msg_type=1` 的正文嵌着 `[给心心]`。
 *
 * 所以这里只做一件事：把面板里的「可用码 + 它是什么意思」拿下来给她看，
 * 她就能写 `[doge]` 而不是照抄提示词里硬编码的那三个。
 *
 * 四件套（项目惯例）：
 *   · 默认关（stickers.biliPanel）
 *   · 只读（只 GET 面板，不发任何消息）
 *   · 上限（最多 listed 个码进提示词，面板本身 400+ 个放不下）
 *   · 兜底（拿不到就用硬编码的旧句子，不报错、不影响回复）
 */
const PANEL_URL = 'https://api.bilibili.com/x/emote/user/panel?business=im';
const CACHE_MS = 6 * 3600_000;
/** 面板里塞满 400 多个，提示词只放得下这些。 */
const DEFAULT_LISTED = 80;
/** 这几个包是「大家都认得」的，优先给她；收藏/付费包按账号不同，放后面。 */
const PACK_PRIORITY = ['小黄脸', 'tv_小电视', '颜文字'];

/** 表情码 → 好不好写。带包名/长名字的（`[2233·群星闪耀时收藏集表情包_达咩]`）默认不给，写不对。 */
const usable = (text, allowUnderscore = false) => {
	const t = String(text ?? '').trim();
	const maxLen = allowUnderscore ? 40 : 12;
	if (!/^\[[^\]\n]+\]$/.test(t)) return false;
	const inner = t.slice(1, -1);
	if (inner.length > maxLen) return false;
	if (allowUnderscore) return true;
	return !inner.includes('_') || inner.length <= 8;
};

/** 一个表情 → 给人看的「码（别名）」。别名来自 meta.alias，没有就只给码。 */
const label = (e) => {
	const alias = String(e?.alias ?? e?.meta?.alias ?? '').trim();
	const text = String(e?.text ?? '').trim();
	if (text === '') return '';
	// 别名和码本身一样（`[笑哭]（笑哭）`）就别重复写，白占提示词
	const inner = text.replace(/^\[|\]$/g, '');
	return alias === '' || alias === inner ? text : `${text}（${alias}）`;
};

/**
 * 面板响应 → 码清单。纯函数，好测。
 * @param {object} json 面板接口的返回
 * @param {{limit?: number, packs?: string[]}} [opts]
 * @returns {Array<{text: string, pack: string}>}
 */
export function panelCodes(json, { limit = DEFAULT_LISTED, packs = PACK_PRIORITY, allowUnderscore = false, perPack = 12 } = {}) {
	const packages = json?.data?.packages;
	if (!Array.isArray(packages)) return [];
	const rank = (name) => {
		const i = packs.indexOf(name);
		return i < 0 ? packs.length : i;
	};
	// 收藏集 / 付费包优先（她有这些，而且比小黄脸有意思）；剩下的按习惯优先级
	const isCollect = (name) => /收藏集|静态表情|动态表情/.test(name);
	const ordered = [...packages].sort((a, b) => {
		const ca = isCollect(String(a.text ?? ''));
		const cb = isCollect(String(b.text ?? ''));
		if (ca !== cb) return ca ? -1 : 1;
		return rank(String(a.text ?? '')) - rank(String(b.text ?? ''));
	});
	const out = [];
	const seen = new Set();
	for (const pk of ordered) {
		let taken = 0;
		const cap = isCollect(String(pk.text ?? '')) ? Math.max(perPack, 20) : perPack;
		for (const e of pk.emote ?? []) {
			if (out.length >= limit) return out;
			if (taken >= cap) break; // 普通包最多 12 个；收藏集整包给
			if (!usable(e?.text, allowUnderscore) || seen.has(e.text)) continue;
			seen.add(e.text);
			taken += 1;
			out.push({ text: String(e.text), alias: String(e?.meta?.alias ?? ''), pack: String(pk.text ?? '') });
		}
	}
	return out;
}

/** 码清单 → 提示词里那一句（`[doge]（狗头） [笑哭] [星星眼]`）。 */
export function codesLine(codes) {
	if (!Array.isArray(codes) || codes.length === 0) return '';
	return codes.map((x) => label(x)).filter(Boolean).join(' ');
}

export class BiliEmotes {
	/**
	 * @param {object} deps
	 * @param {() => object} deps.getConfig 读 stickers 配置
	 * @param {object} deps.client BiliClient（要有 call）
	 * @param {(msg: string) => void} [deps.log]
	 */
	constructor({ getConfig, client, log }) {
		this.getConfig = getConfig;
		this.client = client;
		this.log = log ?? (() => {});
		this.codes = [];
		this.fetchedAt = 0;
		this.lastError = '';
		this.pending = null;
	}

	cfg(raw) {
		const v = raw?.stickers ?? raw ?? {};
		const n = Number(v.biliPanelListed);
		return {
			enabled: v.biliPanel === true,
			limit: Number.isFinite(n) ? Math.min(120, Math.max(0, Math.floor(n))) : DEFAULT_LISTED
		};
	}

	/**
	 * 拿码清单（带缓存）。失败返回缓存里的旧值（可能是空），**不抛错**。
	 * 在途只发一次请求（同时来几个人不重复打接口）。
	 */
	async list() {
		return await this.listFor('im', {});
	}

	/**
	 * 按用途取码：'im' 私信 / 'reply' 评论区。两个面板内容不一样
	 * （收藏集表情只在 reply 里才排得进前几条），各自缓存。
	 */
	async listFor(business = 'im', { allowUnderscore = false } = {}) {
		this.cache = this.cache ?? new Map();
		const cfg = this.cfg(this.getConfig());
		if (!cfg.enabled || cfg.limit === 0) return [];
		const key = String(business) + (allowUnderscore ? ':long' : '');
		const hit = this.cache.get(key);
		if (hit && hit.codes.length > 0 && Date.now() - hit.at < CACHE_MS) return hit.codes;
		if (this.pending !== null) return await this.pending;
		this.pending = (async () => {
			try {
				const json = await this.client.call('api', '/x/emote/user/panel', { params: { business } });
				const got = panelCodes(json, { limit: cfg.limit, allowUnderscore });
				if (got.length > 0) {
					this.cache.set(key, { codes: got, at: Date.now() });
					this.codes = business === 'im' ? got : this.codes;
					this.fetchedAt = Date.now();
					this.lastError = '';
				} else {
					this.lastError = `面板(${business})里没拿到能用的表情码`;
				}
			} catch (error) {
				this.lastError = String(error instanceof Error ? error.message : error);
				this.log(`[fish-soul] B站表情面板没拿到：${this.lastError}`);
			}
			return this.cache.get(key)?.codes ?? this.codes;
		})();
		try {
			return await this.pending;
		} finally {
			this.pending = null;
		}
	}

	status() {
		const cfg = this.cfg(this.getConfig());
		return { enabled: cfg.enabled, limit: cfg.limit, count: this.codes.length, fetchedAt: this.fetchedAt, lastError: this.lastError };
	}
}
