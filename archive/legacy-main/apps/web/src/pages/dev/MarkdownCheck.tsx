/**
 * MarkdownCheck — W6 渲染增强的**开发期验证页**（仅 DEV 构建注册路由 /__mdcheck）。
 *
 * 为什么需要它：讲义/实操/笔记/聊天四处都已切到统一插件（GFM + KaTeX 公式 + 代码高亮），
 * 而这些内容平时必须依赖后端数据才看得到；本页用一段固定样例复现同一条渲染链路，
 * 让"公式是否渲染成排版公式、代码是否有语法配色"能在不连数据库的情况下自测与截图取证。
 * 排查渲染问题时：打开 http://localhost:3002/__mdcheck 对照本页即可。
 */
import ReactMarkdown from 'react-markdown';
import {
  lectureMdComponents,
  mdRemarkPluginsCited,
  mdRehypePlugins,
} from '@/components/resources/lecture-markdown';

const SAMPLE = [
  '## 公式与代码渲染自检',
  '',
  '行内公式：注意力权重 $a_{ij} = \\dfrac{\\exp(e_{ij})}{\\sum_{k} \\exp(e_{ik})}$，温度系数 $\\Delta\\theta = k(T - T_0)$。',
  '',
  '块级公式：',
  '',
  '$$',
  '\\text{ReAct} = \\arg\\max_{a_t} \\; \\mathbb{E}\\Big[\\sum_{t=0}^{T} \\gamma^{t} r_t \\Big]',
  '$$',
  '',
  '## 代码高亮自检',
  '',
  '```python',
  'def pick_adaptive_question(pool, target, used_ids):',
  '    candidates = [q for q in pool if q["id"] not in used_ids]',
  '    return min(candidates, key=lambda q: abs(rank(q) - rank(target)))',
  '```',
  '',
  '```ts',
  "const state = await api.answerLearningQuiz(resourceId, { questionId, answer: '1' });",
  "if (state.correct) void api.recordProfileQuiz({ quizType: 'FORMATIVE', knowledgeCategoryCode: 'kp-1-2' });",
  '```',
  '',
  '## 其他元素自检',
  '',
  '| 项 | 期望 | 实际 |',
  '| --- | --- | --- |',
  '| 表格 | 有边框与表头底色 | 见左 |',
  '| 列表 | 圆点/序号正常 | 见下 |',
  '',
  '1. 有序列表第一项',
  '2. 有序列表第二项，含行内代码 `normalizeMarkdownLists()`',
  '',
  '> **重点**：引用块应按内容分流成标准引用 / 安全警示 / 重点 callout。',
  '',
  '结尾一句话，用于确认段落间距与行高。',
].join('\n');

export default function MarkdownCheck() {
  return (
    <main className="mx-auto max-w-[860px] px-6 py-10">
      <p className="font-mono text-[10px] tracking-[0.16em] text-ink-muted">DEV ONLY · /__mdcheck</p>
      <h1 className="mt-1 font-serif text-[26px] font-bold text-ink">Markdown 渲染自检</h1>
      <p className="mt-2 text-[12.5px] leading-6 text-ink-muted">
        本页与讲义/实操/笔记/聊天共用同一套插件（mdRemarkPluginsCited + mdRehypePlugins + lectureMdComponents）。
        公式未渲染成排版公式、或代码块没有语法配色时，说明 Markdown 增强链路被破坏。
      </p>
      <article className="mt-6 rounded-[18px] border border-hairline bg-card-warm p-6">
        <ReactMarkdown remarkPlugins={mdRemarkPluginsCited} rehypePlugins={mdRehypePlugins} components={lectureMdComponents}>
          {SAMPLE}
        </ReactMarkdown>
      </article>
    </main>
  );
}
