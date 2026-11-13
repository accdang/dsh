#!/usr/bin/env node
/**
 * 升级 DSH / 插件后先跑这个，30 秒判断「我们的补丁还活着吗」。
 *
 *   node tools/check-compat.mjs
 *
 * 查四件事：
 *  1. 所有 lib 文件语法是否还合法（DSH 换了模块格式会当场炸）
 *  2. 自包含模块能否 import（public-guard / db / retrieval / segment）
 *  3. 装进 profile 的那一份能否加载出插件对象（依赖解析、导出名）
 *  4. 我们补的那些关键点还在不在（工具名、配置字段、路由）
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const lib = join(repo, 'lib');
const installed = process.env.FISH_SOUL_INSTALLED
	?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-fish-soul');

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { bad += 1; console.log(`  ✗ ${m}`); };

function walk(dir, out = []) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (e.name.endsWith('.js')) out.push(p);
	}
	return out;
}

console.log('\n[1] 语法检查');
const files = walk(lib);
for (const f of files) {
	try {
		// 沙箱里 stdio:'pipe' 会被拦（named pipe 不可用），必须 inherit
		execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
	} catch {
		fail(`${f.replace(repo + '\\', '').replace(repo + '/', '')} 语法错误（报错见上方 node 输出）`);
	}
}
if (bad === 0) ok(`${files.length} 个文件都通过`);

console.log('\n[2] 自包含模块能否 import');
for (const name of ['public-guard.js', 'db.js', 'retrieval.js', 'segment.js', 'config-schema.js']) {
	const p = join(lib, name);
	if (!statSync(p, { throwIfNoEntry: false })) { fail(`${name} 不见了`); continue; }
	try {
		await import(pathToFileURL(p).href);
		ok(name);
	} catch (error) {
		fail(`${name} import 失败：${String(error.message ?? error).slice(0, 120)}`);
	}
}

console.log('\n[3] 装进 profile 的那一份能否加载');
try {
	const mod = await import(pathToFileURL(join(installed, 'lib', 'index.js')).href);
	const plugin = mod.default ?? mod;
	const hasApply = typeof plugin === 'function' || typeof plugin?.apply === 'function';
	hasApply ? ok(`插件入口可加载（${installed}）`) : fail('入口没有 apply，宿主不会认它');
} catch (error) {
	fail(`加载失败：${String(error.message ?? error).slice(0, 160)}`);
	console.log('      ↑ 多半是 DSH 更新后依赖名/导出变了，看这里的报错就知道哪一层断的');
}

console.log('\n[4] 本机补丁是否还在');
const index = readFileSync(join(lib, 'index.js'), 'utf8');
const gateway = readFileSync(join(lib, 'gateway.js'), 'utf8');
const routes = readFileSync(join(lib, 'routes.js'), 'utf8');
const schema = readFileSync(join(lib, 'config-schema.js'), 'utf8');
const checks = [
	['B站 工具 bili_open', index.includes("name: 'bili_open'")],
	['B站 工具 bili_feed', index.includes("name: 'bili_feed'")],
	['评论 oid 修正 commentOidOf', readFileSync(join(lib, 'channels', 'bilibili.js'), 'utf8').includes('commentOidOf')],
	['工具白名单含 bili_open', gateway.includes("'bili_open'")],
	['常驻底色记忆', index.includes('[你一直记着的')],
	['身份统一 [关于主人]', index.includes('[关于主人]')],
	['会话认领 /claim/state', routes.includes("'/claim/state'")],
	['私信分条 /dm/config', routes.includes("'/dm/config'")],
	['会话轮换 /sessions/rotate', routes.includes("'/sessions/rotate'")],
	['配置字段 dm', schema.includes('dm: z.object(')],
	['配置字段 drift', schema.includes('drift: z.object(')],
	['配置字段 rotateDays', schema.includes('rotateDays')]
];
for (const [label, passed] of checks) passed ? ok(label) : fail(`${label} 丢了（被上游覆盖？）`);

console.log(bad === 0 ? '\n全部通过：补丁在这版上还活着。\n' : `\n有 ${bad} 项没通过，先别升级 / 别让她跑。\n`);
process.exit(bad === 0 ? 0 : 1);
