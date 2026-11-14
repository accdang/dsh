#!/usr/bin/env node
/**
 * 全量重建记忆向量（embedding 配好之后用一次）。
 *
 *   node tools/backfill-vectors.mjs
 *
 * 读 fish-soul-config.json 的 embedding 段，对每条 active 记忆调一次
 * POST {baseURL}/embeddings，L2 归一化后按 Float32 小端序写进 vec 表，
 * 并把 vec_meta 设成和当前模型一致（否则检索会把索引判成 stale）。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeToBlob } from '../lib/retrieval.js';

const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const cfgPath = join(home, '.dsh', 'fish-soul-config.json');
const dbPath = join(home, '.dsh', 'fish-soul', 'soul.db');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const emb = cfg.embedding ?? {};
if (!emb.enabled || !emb.baseURL || !emb.apiKey || !emb.model) {
	console.log('embedding 没配全（enabled / baseURL / apiKey / model 缺一个）');
	process.exit(1);
}
const base = String(emb.baseURL).replace(/\/+$/, '');
const model = String(emb.model);
console.log(`接口 ${base}  模型 ${model}`);

const db = new DatabaseSync(dbPath);
const rows = db.prepare("SELECT id, content FROM memory WHERE status = 'active' ORDER BY id").all();
console.log('待建向量:', rows.length, '条');

async function embedBatch(texts) {
	const res = await fetch(`${base}/embeddings`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${emb.apiKey}` },
		body: JSON.stringify({ model, input: texts }),
		signal: AbortSignal.timeout(60_000)
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${String(await res.text()).slice(0, 120)}`);
	const j = await res.json();
	const list = (j.data ?? []).map((x) => x.embedding);
	if (list.length !== texts.length) throw new Error(`返回条数不对：${list.length}/${texts.length}`);
	return list;
}

const BATCH = 8;
let done = 0;
let dim = 0;
const ins = db.prepare('INSERT OR REPLACE INTO vec (memory_id, model_id, dim, generation_id, blob) VALUES (?, ?, ?, 1, ?)');
for (let i = 0; i < rows.length; i += BATCH) {
	const part = rows.slice(i, i + BATCH);
	const vecs = await embedBatch(part.map((r) => String(r.content ?? '').slice(0, 2000)));
	for (let k = 0; k < part.length; k += 1) {
		const v = vecs[k];
		dim = v.length;
		ins.run(part[k].id, model, dim, normalizeToBlob(v));
		done += 1;
	}
	process.stdout.write(`\r已建 ${done}/${rows.length}（dim=${dim}）`);
}
console.log('');

db.prepare(`INSERT INTO vec_meta (id, model_id, dim, provider, generation_id, built_at, status)
	VALUES (1, ?, ?, 'openai-compatible', 1, ?, 'ready')
	ON CONFLICT(id) DO UPDATE SET model_id = excluded.model_id, dim = excluded.dim,
		built_at = excluded.built_at, status = 'ready', generation_id = 1`)
	.run(model, dim, Date.now());

const n = db.prepare('SELECT COUNT(*) n FROM vec').get().n;
const meta = db.prepare('SELECT * FROM vec_meta').get();
console.log(`完成：vec ${n} 行 | model ${meta.model_id} dim ${meta.dim} status ${meta.status}`);
db.close();
