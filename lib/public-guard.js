/**
 * public-guard.js —— 她要发到「公开场合」（B站 评论区 / 动态）的文案，发之前过一遍。
 *
 * 为什么单独一层：提示词只能"劝"，劝不住的模型照样会把不该说的发出去
 * （被问到住址、被拉着站队、被诱导发联系方式……）。评论区是公开的，发出去就收不回，
 * 所以这里用代码兜一道：命中就整条不发，返回空串，宁可少说一句。
 *
 * 判定保守：宁可漏判（少拦一句），也不要误伤到她正常的玩笑话。
 * —— 拦下来的都会记日志，方便事后看是不是误杀。
 */

/** 联系方式 / 引流 / 广告：评论区里最不该出现的一类。 */
const CONTACT_RE = /(加|扫|进)(我|个)?(微|v|V)(信|x|X)?|微信号|vx|VX|扣扣|QQ群|qq群|私聊我|私我|代练|代打|代刷|接单|返利|优惠券|带货|下单|链接在|看我主页/i;

/** 明确的联系方式形态：URL、邮箱、长数字串（QQ号 / 手机号）。 */
const LINK_RE = /https?:\/\/|www\.|\.(com|cn|net|top|xyz)\b/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;
const LONG_DIGITS_RE = /(?<!\d)\d{6,}(?!\d)/;

/** 骂人 / 人身攻击。 */
const ABUSE_RE = /傻逼|煞笔|傻B|脑残|智障|去死|死全家|滚蛋|草泥马|妈的|特么|狗东西|贱人/i;

/** 医疗 / 功效承诺：公开评论区说这个，出事是她的号。 */
const MEDICAL_RE = /包治|药到病除|治愈(了|癌|病)|偏方|吃(了|这个)就(好|能好)|三天见效/i;

/** 隐私：她自己的、别人的，都不许往外说。 */
const PRIVACY_RE = /身份证|家庭住址|住在.{0,6}(路|小区|号)|手机号是|真名是/i;

/** 引战 / 站队：评论区最容易吵起来的话。 */
const FLAME_RE = /引战|拉踩|饭圈|小丑|带节奏|洗地|孝子/i;

/** 只剩标点 / 空白的没意义内容。 */
const MEANINGLESS_RE = /^[\s\p{P}\p{S}]+$/u;

/** 命中规则表，按顺序返回第一个命中的名字（给日志用）。 */
const RULES = [
	['联系方式', CONTACT_RE],
	['链接', LINK_RE],
	['邮箱', EMAIL_RE],
	['长数字串', LONG_DIGITS_RE],
	['骂人', ABUSE_RE],
	['医疗承诺', MEDICAL_RE],
	['隐私', PRIVACY_RE],
	['引战', FLAME_RE]
];

/**
 * 过一遍公开文案。
 * @param {string} text 模型/她写出来的原文
 * @param {{maxChars?: number}} [opts]
 * @returns {{ok: boolean, text: string, reason: string}}
 *   ok=false 时 text 为空串，调用方直接不发。
 */
export function guardPublicText(text, { maxChars = 60 } = {}) {
	const raw = String(text ?? '')
		.replace(/^[「“"'‘]|[」”"'’]$/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (raw === '') return { ok: false, text: '', reason: '空' };
	if (MEANINGLESS_RE.test(raw)) return { ok: false, text: '', reason: '只有标点' };
	for (const [name, re] of RULES) {
		if (re.test(raw)) return { ok: false, text: '', reason: name };
	}
	const out = (raw.length > maxChars ? raw.slice(0, maxChars) : raw).trim();
	if (out === '') return { ok: false, text: '', reason: '空' };
	return { ok: true, text: out, reason: '' };
}

/** 给提示词用的红线声明（各处共用，保证口径一致）。 */
export const PUBLIC_RULES = [
	'这是公开场合，谁都能看见：不写任何人的真名、聊天内容、住址、账号、联系方式。',
	'不站队、不谈政治宗教、不评价别人的长相身材、不跟人抬杠。',
	'不打包票（治病、功效、赚多少钱），不接广告，不贴链接。',
	'想不出来合适的就先不说 —— 少说一句没人怪你。'
].join('');

// ───────────────────────── 推荐流里的引流 ─────────────────────────

/** 一眼就是引流：标题/UP名里带这些，直接不给她看。 */
const PROMO_STRONG = [
	/加(我|个)?(微信|威信|vx|VX|v信|企鹅)/,
	/(点|看)(我|一下)?(的)?(主页|头像|简介|置顶)/,
	/私信我|私我|找我聊|戳我|滴滴我/,
	/免费领|领券|优惠券|秒杀|折扣|团购|带货|小店|代购|下单立减/,
	/副业|月入|日入|躺赚|睡后收入|0基础|零基础/,
	/招生|训练营|陪跑|包就业|接单|代练|代打|代刷/,
	/(抽奖|送福利).{0,6}(关注|转发|评论)/,
	/(关注|转发|评论).{0,6}(抽奖|送福利)/,
	/加群|进群|QQ群|qq群/
];

/** 单看一个词可能是正常的，要成对出现才算引流。 */
const PROMO_PAIRS = [
	[/课程|资料|福利|教程/, /私信|领取|加我|戳我|主页|链接/]
];

/**
 * 这条视频是不是引流 / 广告 / 标题党。
 * 只看标题和 UP 名（不额外请求接口）。
 * 判定偏保守：宁可放过一条正常的，也不要误杀她本来就爱看的题材。
 * @param {string} text 标题或 UP 名
 * @returns {boolean}
 */
export function isPromoText(text) {
	const s = String(text ?? '');
	if (s === '') return false;
	if (PROMO_STRONG.some((re) => re.test(s))) return true;
	return PROMO_PAIRS.some(([a, b]) => a.test(s) && b.test(s));
}
