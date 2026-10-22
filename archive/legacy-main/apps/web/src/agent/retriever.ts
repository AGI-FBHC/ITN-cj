/**
 * retriever — RET-02「知识检索 Agent」的前端可闭环实现（纯函数，离线可跑）
 *
 * 目标：不依赖后端与外部 embedding 模型，也能给出"真实"的混合检索链路，
 * 让评测脚本能算出真实的覆盖率/幻觉率，而不是读硬编码常量。
 *
 * 双通道 + RRF 融合：
 *   ① 关键词通道 = BM25（over CJK 单字+二元组 与 ASCII 词）—— 对应"关键词 FULLTEXT"
 *   ② 向量通道   = 每篇文档的 TF-IDF 稀疏向量与查询向量 cosine —— 离线代替 embedding，确定性
 *   融合         = Reciprocal Rank Fusion（k=60）
 *
 * 后端到位后：保持本文件导出的 `retrieve` 接口签名不变，把实现换成真向量库调用即可。
 */
import { kbSlices } from '@/data/kbSlices';
import type { KBSlice, KBType } from '@/data/kbSlices';
import { getKnowledgePoint } from '@/data/knowledgePoints';

/* ================= 分词（无外部分词器，确定性） ================= */
const isCJK = (ch: string) => /[一-鿿]/.test(ch);

/** CJK 单字 + 二元组；ASCII 连续字母数字（含标准号）小写成词 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase();
  // ASCII 词（含 gb/t、iso、数字、型号如 srvo-062）
  const asciiWords = normalized.match(/[a-z0-9][a-z0-9./-]*/g) ?? [];
  tokens.push(...asciiWords.filter((w) => w.length >= 2 || /\d/.test(w)));
  // CJK 单字 + 相邻二元组
  const cjk = Array.from(text).filter(isCJK);
  const raw = Array.from(text);
  for (let i = 0; i < raw.length; i++) {
    if (isCJK(raw[i])) {
      tokens.push(raw[i]);
      if (i + 1 < raw.length && isCJK(raw[i + 1])) tokens.push(raw[i] + raw[i + 1]);
    }
  }
  void cjk;
  return tokens;
}

/* ================= 语料索引 ================= */
interface DocIndex {
  slice: KBSlice;
  tokens: string[];
  tf: Map<string, number>;
  len: number;
}

function docText(s: KBSlice): string {
  return [s.title, s.standardNo ?? '', s.source, s.type, s.summary, s.excerpt].join(' ');
}

function buildIndex(corpus: KBSlice[]) {
  const docs: DocIndex[] = corpus.map((slice) => {
    const tokens = tokenize(docText(slice));
    const tf = new Map<string, number>();
    tokens.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + 1));
    return { slice, tokens, tf, len: tokens.length };
  });
  const N = docs.length;
  const avgdl = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, N);
  // 文档频率 → idf
  const df = new Map<string, number>();
  docs.forEach((d) => new Set(d.tokens).forEach((t) => df.set(t, (df.get(t) ?? 0) + 1)));
  const idf = new Map<string, number>();
  df.forEach((f, t) => idf.set(t, Math.log(1 + (N - f + 0.5) / (f + 0.5))));
  return { docs, N, avgdl, idf };
}

// 全库索引（模块级缓存，纯数据，构建一次）
const INDEX = buildIndex(kbSlices);

/* ================= 通道一：BM25 ================= */
const K1 = 1.5;
const B = 0.75;

function bm25Scores(queryTokens: string[], docs: DocIndex[], avgdl: number, idf: Map<string, number>) {
  const qset = Array.from(new Set(queryTokens));
  return docs.map((d) => {
    let score = 0;
    for (const t of qset) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idfT = idf.get(t) ?? 0;
      score += idfT * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / avgdl))));
    }
    return { id: d.slice.id, score };
  });
}

/* ================= 通道二：TF-IDF 向量 cosine ================= */
function tfidfVector(tf: Map<string, number>, len: number, idf: Map<string, number>): Map<string, number> {
  const v = new Map<string, number>();
  tf.forEach((f, t) => {
    const w = (f / Math.max(1, len)) * (idf.get(t) ?? 0);
    if (w !== 0) v.set(t, w);
  });
  return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((w) => (na += w * w));
  b.forEach((w) => (nb += w * w));
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  small.forEach((w, t) => {
    const o = large.get(t);
    if (o) dot += w * o;
  });
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function vectorScores(queryTokens: string[], docs: DocIndex[], idf: Map<string, number>) {
  const qtf = new Map<string, number>();
  queryTokens.forEach((t) => qtf.set(t, (qtf.get(t) ?? 0) + 1));
  const qv = tfidfVector(qtf, queryTokens.length, idf);
  return docs.map((d) => ({ id: d.slice.id, score: cosine(qv, tfidfVector(d.tf, d.len, idf)) }));
}

/* ================= RRF 融合 ================= */
const RRF_K = 60;
function rrf(ranked: { id: string; score: number }[][]): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of ranked) {
    const sorted = [...list].filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    sorted.forEach((item, rank) => {
      fused.set(item.id, (fused.get(item.id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return fused;
}

/* ================= 对外检索接口 ================= */
export type HitChannel = 'keyword' | 'vector' | 'both';

export interface RetrievalHit {
  sliceId: string;
  slice: KBSlice;
  /** RRF 融合分（越大越相关） */
  score: number;
  /** BM25 原始分 */
  bm25: number;
  /** 向量 cosine 原始分 */
  vector: number;
  /** 命中通道 */
  channel: HitChannel;
  credibility: number;
}

export interface RetrieveOptions {
  /** 限定知识点 */
  kpId?: string;
  /** 限定文档类型 */
  types?: KBType[];
  /** 最低可信度 */
  minCredibility?: number;
  /** 返回条数 */
  topK?: number;
}

/**
 * 混合检索：BM25 + TF-IDF 向量，RRF 融合，返回 Top-K。
 * 无查询词命中时回退到该 kp 下按可信度排序（保证生成有事实源可挂）。
 */
export function retrieve(query: string, opts: RetrieveOptions = {}): RetrievalHit[] {
  const { kpId, types, minCredibility = 0, topK = 6 } = opts;
  const pool = INDEX.docs.filter(
    (d) =>
      (!kpId || d.slice.kpId === kpId) &&
      (!types || types.includes(d.slice.type)) &&
      d.slice.credibility >= minCredibility,
  );
  if (pool.length === 0) return [];

  const qTokens = tokenize(query);
  const bm25 = bm25Scores(qTokens, pool, INDEX.avgdl, INDEX.idf);
  const vec = vectorScores(qTokens, pool, INDEX.idf);
  const bmMap = new Map(bm25.map((x) => [x.id, x.score]));
  const vecMap = new Map(vec.map((x) => [x.id, x.score]));
  const fused = rrf([bm25, vec]);

  let hits: RetrievalHit[] = pool.map((d) => {
    const bm = bmMap.get(d.slice.id) ?? 0;
    const vc = vecMap.get(d.slice.id) ?? 0;
    const channel: HitChannel = bm > 0 && vc > 0 ? 'both' : bm > 0 ? 'keyword' : vc > 0 ? 'vector' : 'both';
    return {
      sliceId: d.slice.id,
      slice: d.slice,
      score: fused.get(d.slice.id) ?? 0,
      bm25: bm,
      vector: vc,
      channel,
      credibility: d.slice.credibility,
    };
  });

  const anyHit = hits.some((h) => h.score > 0);
  if (anyHit) {
    hits = hits.filter((h) => h.score > 0);
    // 融合分并列时按可信度打破平局
    hits.sort((a, b) => b.score - a.score || b.credibility - a.credibility);
  } else {
    // 冷启动/查询过短：回退按可信度，保证生成侧有事实源
    hits.sort((a, b) => b.credibility - a.credibility);
  }
  return hits.slice(0, topK);
}

/**
 * 面向"某知识点生成资源"的检索：用知识点名称 + 核心 topic 组合成查询。
 * GEN-03 生成课件时的事实源就来自这里。
 */
export function retrieveForKp(kpId: string, topK = 6): RetrievalHit[] {
  const kp = getKnowledgePoint(kpId);
  const query = `${kp.name} ${kp.coreTopics.join(' ')} ${kp.description}`;
  return retrieve(query, { kpId, topK });
}
