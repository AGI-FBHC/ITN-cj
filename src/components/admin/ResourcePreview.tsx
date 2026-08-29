/**
 * 管理员端资源预览
 * 复用学员端设计语言：讲义走 lectureMdComponents（与学员端完全一致），
 * 实操/测验/PPT 大纲按同款玻璃卡片语言绘制。
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CheckCircle2, Clock, ExternalLink, FileText, ShieldCheck, Target, Terminal, TriangleAlert } from 'lucide-react';
import { lectureMdComponents } from '@/components/resources/lecture-markdown';
import SourceCitationMarks from '@/components/resources/SourceCitationMarks';
import remarkCitationMarks from '@/lib/remarkCitationMarks';
import { cn } from '@/lib/utils';
import type { AdminResourceDetail } from '@/lib/api';
import EvidenceDebateCourt from '@/components/resources/EvidenceDebateCourt';

/* ---------------- 数据结构（与 generated_learning_resources.content_json / presentation_tasks.outline_json 对应） ---------------- */

interface LectureSection { title?: string; content?: string; citations?: unknown; evidenceQuotes?: unknown }
interface LectureChapter { title?: string; overview?: string; sections?: LectureSection[] }
interface LectureDoc {
  title?: string; summary?: string; chapters?: LectureChapter[];
  keyPoints?: string[]; reviewQuestions?: string[]; learningObjectives?: string[];
}
interface PracticeStep {
  title?: string; instruction?: string; content?: string; detail?: string;
  code?: string; expectedOutput?: string; warning?: string; safety?: string;
  hint?: string; citations?: unknown; evidenceQuotes?: unknown;
}
interface TroubleshootItem { problem?: string; solution?: string }
interface PracticeDoc {
  title?: string; objective?: string; environment?: string | string[];
  steps?: PracticeStep[]; prerequisites?: string[];
  troubleshooting?: TroubleshootItem[] | string[];
  acceptanceCriteria?: string[]; estimatedMinutes?: number; challenge?: string;
  safetyNotice?: string; safetyChecklist?: string[];
}
interface QuizQuestion {
  id?: number | string; stem: string; options: string[];
  correctIndex?: number; explanation?: string; difficulty?: number | string; difficultyLevel?: number; citations?: unknown[];
  reviewStatus?: string; reviewMetrics?: Record<string, number>; riskLabels?: string[];
  generationRationale?: Record<string, string>; replacementUsed?: boolean;
  versionHistory?: Array<Record<string, unknown>>; reviewSnapshot?: Record<string, unknown>;
}
interface QuizDoc { title?: string; questions?: QuizQuestion[]; knowledgePoints?: string[] }
interface PptPoint { heading?: string; detail?: string }
interface PptSlide { kind?: string; title?: string; points?: PptPoint[]; takeaway?: string; speakerNotes?: string }
interface PptOutline { title?: string; subtitle?: string; slides?: PptSlide[]; agendaPlan?: string[] }


/**
 * 讲义预览：按"导语 / 逐章 / 收尾"分卡片展示（块间留缝），
 * 与讲师端卡片化翻页展示保持同一颗粒度——一章一张卡。
 */
function LecturePreview({ doc, sources }: { doc: LectureDoc; sources: Record<string, unknown>[] }) {
  const chapters = doc.chapters ?? [];
  return (
    <div className="space-y-4">
      {/* 导语卡 */}
      <div className="lf-card rounded-2xl p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto text-lg font-bold text-ink">{doc.title || '定制讲义'}</h3>
          <span className="lf-pill lf-pill-null">{chapters.length} 章</span>
        </div>
        {doc.summary && <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-ink-2">{doc.summary}</p>}
      </div>

      {/* 逐章卡：一章一块 */}
      {chapters.map((chapter, ci) => (
        <div key={ci} className="lf-card rounded-2xl p-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint font-mono text-[13px] font-bold text-brand">
              {ci + 1}
            </span>
            <h4 className="text-[16px] font-bold text-ink">{chapter.title || '章节 ' + (ci + 1)}</h4>
          </div>
          {chapter.overview && <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-ink-2">{chapter.overview}</p>}
          <div className="mt-4 space-y-5">
            {(chapter.sections ?? []).map((section, si) => (
              <section key={si}>
                {section.title && (
                  <h5 className="mb-2 border-l-[3px] border-brand/50 pl-3 text-[14px] font-bold text-ink">
                    {section.title}
                  </h5>
                )}
                {section.content && (
                  <div className="text-[14px] leading-7 text-ink-2">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkCitationMarks]} components={lectureMdComponents}>
                      {section.content}
                    </ReactMarkdown>
                  </div>
                )}
                <SourceCitationMarks citations={section.citations} evidenceQuotes={section.evidenceQuotes} sources={sources} />
              </section>
            ))}
          </div>
        </div>
      ))}

      {/* 收尾卡：目标 / 要点 / 复习 */}
      {(!!doc.learningObjectives?.length || !!doc.keyPoints?.length || !!doc.reviewQuestions?.length) && (
        <div className="lf-card rounded-2xl p-6">
          {!!doc.learningObjectives?.length && (
            <div className={cn(!!doc.keyPoints?.length && 'mb-5')}>
              <p className="text-xs font-bold uppercase tracking-wide text-brand">学习目标</p>
              <ul className="mt-2 space-y-1.5">
                {doc.learningObjectives.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13.5px] leading-6 text-ink-2">
                    <CheckCircle2 size={14} className="mt-1 shrink-0 text-brand" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!doc.keyPoints?.length && (
            <div className={cn(!!doc.reviewQuestions?.length && 'mb-5')}>
              <p className="text-xs font-bold uppercase tracking-wide text-ochre">关键要点</p>
              <ul className="mt-2 space-y-1.5">
                {doc.keyPoints.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13.5px] leading-6 text-ink-2">
                    <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-ochre/60" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!doc.reviewQuestions?.length && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-ink-muted">复习思考</p>
              <ul className="mt-2 space-y-1.5">
                {doc.reviewQuestions.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13.5px] leading-6 text-ink-2">
                    <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-muted/60" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- 实操指南：步骤卡片 ---------------- */

const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function PracticePreview({ doc, sources }: { doc: PracticeDoc; sources: Record<string, unknown>[] }) {
  const troubles = Array.isArray(doc.troubleshooting)
    ? doc.troubleshooting.map((item) => (typeof item === 'string' ? { problem: item, solution: '' } : item))
    : [];
  return (
    <div className="space-y-4">
      {/* 目标与环境卡 */}
      <div className="lf-card rounded-2xl p-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="mr-auto text-base font-bold text-ink">{doc.title || '实操指南'}</h3>
          <span className="lf-pill lf-pill-null">{doc.steps?.length ?? 0} 步</span>
          {doc.estimatedMinutes != null && (
            <span className="lf-pill lf-pill-null"><Clock size={11} />约 {doc.estimatedMinutes} 分钟</span>
          )}
        </div>
        {doc.objective && (
          <div className="mt-4 flex items-start gap-3 rounded-xl bg-brand-tint/60 p-4">
            <Target size={18} className="mt-0.5 shrink-0 text-brand" />
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-brand">目标</p>
              <p className="mt-1 text-sm leading-6 text-ink-2">{doc.objective}</p>
            </div>
          </div>
        )}
        {doc.environment && (
          <div className="mt-3 flex items-start gap-3 rounded-xl bg-white/55 p-4">
            <Terminal size={17} className="mt-0.5 shrink-0 text-ochre" />
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-ochre">环境</p>
              {Array.isArray(doc.environment) ? (
                <ul className="mt-1 space-y-1 font-mono text-[12.5px] leading-6 text-ink-2">
                  {doc.environment.map((item, index) => <li key={index}>• {item}</li>)}
                </ul>
              ) : <p className="mt-1 font-mono text-[12.5px] leading-6 text-ink-2">{doc.environment}</p>}
            </div>
          </div>
        )}
        {!!doc.prerequisites?.length && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {doc.prerequisites.map((item, index) => (
              <span key={index} className="lf-pill lf-pill-null">前置：{item}</span>
            ))}
          </div>
        )}
        {(!!doc.safetyChecklist?.length || doc.safetyNotice) && (
          <div className="mt-3 rounded-xl border border-amber-200/70 bg-amber-50/70 p-4">
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-amber-800"><ShieldCheck size={15} />开始前确认</p>
            {!!doc.safetyChecklist?.length && <ul className="mt-2 space-y-1 text-[12.5px] leading-6 text-ink-2">{doc.safetyChecklist.map((item, index) => <li key={index}>• {item}</li>)}</ul>}
            {doc.safetyNotice && <p className="mt-2 flex items-start gap-2 text-[12.5px] leading-6 text-amber-900"><TriangleAlert size={14} className="mt-1 shrink-0" />{doc.safetyNotice}</p>}
          </div>
        )}
      </div>

      {/* 步骤：一步一张卡 */}
      {(doc.steps ?? []).map((step, index) => (
        <div key={index} className="lf-card rounded-2xl p-5">
          <div className="flex items-start gap-3.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint font-mono text-[13px] font-bold text-brand">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              {step.title && <h4 className="text-[15px] font-bold text-ink">{step.title}</h4>}
              {(step.instruction || step.content || step.detail) && (
                <div className="mt-1.5 text-[13.5px] leading-7 text-ink-2">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkCitationMarks]} components={lectureMdComponents}>{step.instruction || step.content || step.detail || ''}</ReactMarkdown>
                </div>
              )}
              {step.code && <pre className="mt-3 max-h-[360px] overflow-auto rounded-xl bg-[#26322A] p-4 text-[12.5px] leading-6 text-emerald-50"><code>{step.code}</code></pre>}
              {step.expectedOutput && <div className="mt-3 rounded-lg border border-brand/20 bg-brand-tint/40 px-3.5 py-2.5 text-[12.5px] leading-6 text-ink-2"><span className="font-semibold text-brand">预期结果：</span>{step.expectedOutput}</div>}
              {(step.warning || step.safety) && <p className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3.5 py-2.5 text-[12.5px] leading-6 text-amber-900"><TriangleAlert size={14} className="mt-1 shrink-0" />{step.warning || step.safety}</p>}
              {step.hint && <p className="mt-2 rounded-lg bg-amber-tint/50 px-3.5 py-2.5 text-[12.5px] leading-6 text-[#8A6A2F]">💡 {step.hint}</p>}
              <SourceCitationMarks citations={step.citations} evidenceQuotes={step.evidenceQuotes} sources={sources} />
            </div>
          </div>
        </div>
      ))}

      {/* 验收标准卡 */}
      {!!doc.acceptanceCriteria?.length && (
        <div className="lf-card rounded-2xl border-ochre/30 p-5">
          <p className="text-xs font-bold uppercase tracking-wide text-[#9A5B3C]">验收标准</p>
          <ul className="mt-2.5 space-y-1.5">
            {doc.acceptanceCriteria.map((item, index) => (
              <li key={index} className="flex items-start gap-2 text-[13px] leading-6 text-ink-2">
                <CheckCircle2 size={14} className="mt-1 shrink-0 text-ochre" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 常见问题卡 */}
      {!!troubles.length && (
        <div className="lf-card rounded-2xl p-5">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-muted">常见问题</p>
          <div className="mt-2.5 space-y-2">
            {troubles.map((item, index) => (
              <div key={index} className="rounded-xl bg-white/50 px-4 py-3">
                <p className="text-[13px] font-semibold text-ink">{item.problem}</p>
                {item.solution && <p className="mt-1 text-[13px] leading-6 text-ink-2">{item.solution}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- 分阶测试：题目卡（含答案与解析） ---------------- */

function QuizPreview({ doc, sources }: { doc: QuizDoc; sources: Record<string, unknown>[] }) {
  const questions = doc.questions ?? [];
  return (
    <div className="space-y-4">
      <div className="lf-card flex flex-wrap items-center gap-2 rounded-2xl px-5 py-4">
        <h3 className="mr-auto text-base font-bold text-ink">{doc.title || '分阶测试'}</h3>
        <span className="lf-pill lf-pill-null">共 {questions.length} 题</span>
        {!!doc.knowledgePoints?.length && (
          <span className="lf-pill lf-pill-ok">{doc.knowledgePoints.length} 个知识点</span>
        )}
      </div>
      {questions.map((q, index) => {
        const correct = q.correctIndex;
        const metrics = q.reviewMetrics ?? {};
        const rationale = q.generationRationale ?? {};
        const metricLabels: Record<string, string> = {
          grounding: '证据支撑', answerConfidence: '答案可信', clarity: '题意清晰',
          distractorQuality: '干扰项质量', difficultyMatch: '难度匹配',
          explanationQuality: '解析完整', overall: '综合评分',
        };
        return (
          <div key={q.id ?? index} className="lf-card overflow-hidden rounded-2xl">
            <div className="flex items-start gap-3 px-5 py-4">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand font-mono text-[11.5px] font-semibold text-paper">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {(q.difficultyLevel ?? q.difficulty) != null && (
                    <span className="lf-pill lf-pill-null">难度 {q.difficultyLevel ?? q.difficulty}/5</span>
                  )}
                  <span className="lf-pill lf-pill-null">待人工审核</span>
                  {q.replacementUsed && <span className="lf-pill bg-amber-50 text-amber-700">已更换候选题</span>}
                  <span className="font-mono text-[10.5px] text-ink-muted">#{q.id ?? index + 1}</span>
                </div>
                <p className="mt-1.5 text-[14.5px] font-medium leading-[23px] text-ink">{q.stem}</p>
                <div className="mt-3 space-y-1.5">
                  {(q.options ?? []).map((option, oi) => {
                    const isCorrect = correct === oi;
                    return (
                      <div
                        key={oi}
                        className={cn(
                          'flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] leading-6 text-ink-2',
                          isCorrect
                            ? 'border-brand/45 bg-brand-tint/60 font-semibold text-ink'
                            : 'border-white/70 bg-white/50',
                        )}
                      >
                        <span className={cn('font-mono text-[11px] font-bold', isCorrect ? 'text-brand' : 'text-ink-muted')}>
                          {letters[oi] ?? oi + 1}
                        </span>
                        <span className="min-w-0 flex-1">{option}</span>
                        {isCorrect && <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-brand" />}
                      </div>
                    );
                  })}
                </div>
                {q.explanation && (
                  <div className="mt-3 rounded-xl bg-ochre-tint/50 px-4 py-3">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-[#9A5B3C]">解析</p>
                    <p className="mt-1 text-[13px] leading-6 text-ink-2">{q.explanation}</p>
                  </div>
                )}
                {(Object.keys(metrics).length > 0 || Object.keys(rationale).length > 0) && (
                  <details className="mt-3 rounded-xl border border-white/80 bg-white/55 px-4 py-3">
                    <summary className="cursor-pointer text-xs font-bold text-ink">生成依据与审核指标</summary>
                    {Object.keys(metrics).length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      {Object.entries(metrics).map(([key, value]) => <div key={key} className="rounded-lg bg-[#F3F5F0] px-3 py-2">
                        <p className="text-[10px] text-ink-muted">{metricLabels[key] ?? key}</p>
                        <p className="mt-0.5 text-sm font-bold text-ink">{Math.round(Number(value) || 0)} 分</p>
                      </div>)}
                    </div>}
                    {q.riskLabels?.length ? <p className="mt-3 text-xs leading-5 text-amber-800">关注项：{q.riskLabels.join('；')}</p> : null}
                    {Object.keys(rationale).length > 0 && <div className="mt-3 space-y-2">
                      {Object.entries(rationale).map(([key, value]) => <div key={key} className="text-xs leading-5 text-ink-2"><span className="font-semibold text-ink">{metricLabels[key] ?? key}：</span>{String(value)}</div>)}
                    </div>}
                    {!!q.versionHistory?.length && <p className="mt-3 text-[11px] text-ink-muted">共保留 {q.versionHistory.length} 个候选版本，可结合生成日志回看审核与换题过程。</p>}
                  </details>
                )}
                <SourceCitationMarks citations={q.citations} sources={sources} />
              </div>
            </div>
          </div>
        );
      })}
      {!questions.length && <div className="lf-empty px-6 py-12 text-center text-sm">该资源没有可展示的题目</div>}
    </div>
  );
}

function SourceSummary({ sources }: { sources: Record<string, unknown>[] }) {
  if (!sources.length) return null;
  return (
    <aside className="lf-card mt-5 rounded-2xl p-5">
      <div className="flex items-center gap-2">
        <FileText size={15} className="text-brand" />
        <h3 className="text-sm font-bold text-ink">引用来源</h3>
        <span className="lf-pill lf-pill-null">{sources.length} 条</span>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {sources.map((source, index) => {
          const title = String(source.document ?? source.title ?? `来源 ${index + 1}`);
          const content = String(source.content ?? source.summary ?? '');
          const url = typeof source.url === 'string' ? source.url : null;
          return (
            <div key={String(source.id ?? source.kbId ?? index)} className="rounded-xl border border-white/70 bg-white/50 px-4 py-3">
              <div className="flex items-start gap-2">
                <span className="font-mono text-[10px] text-brand">[{String(source.id ?? index + 1)}]</span>
                {source.debateVerified === true && <span className="shrink-0 rounded-full bg-[#51477F] px-2 py-0.5 text-[9px] font-semibold text-white">多源辩论通过</span>}
                <p className="line-clamp-2 flex-1 text-[12.5px] font-semibold text-ink">{title}</p>
                {url && <a href={url} target="_blank" rel="noreferrer" title="查看来源" className="text-brand"><ExternalLink size={12} /></a>}
              </div>
              {content && (
                <div className="mt-1 line-clamp-3 text-[11.5px] leading-5 text-ink-muted [&>*:first-child]:!mt-0 [&>*:last-child]:!mb-0 [&_h1]:!my-0.5 [&_h1]:!text-[12px] [&_h1]:!leading-5 [&_h2]:!my-0.5 [&_h2]:!border-0 [&_h2]:!pb-0 [&_h2]:!text-[12px] [&_h2]:!leading-5 [&_h2_span:first-child]:hidden [&_h3]:!my-0.5 [&_h3]:!text-[11.5px] [&_h4]:!my-0.5 [&_p]:!my-0.5 [&_p]:!text-[11.5px] [&_p]:!leading-5 [&_li]:!my-0 [&_li]:!text-[11.5px] [&_li]:!leading-5 [&_ol]:!my-0.5 [&_ul]:!my-0.5">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkCitationMarks]} components={lectureMdComponents}>{content}</ReactMarkdown>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/* ---------------- PPT：幻灯片大纲 ---------------- */

const slideKindLabel: Record<string, string> = {
  title: '封面', agenda: '议程', section: '章节', content: '内容', review: '回顾', ending: '结尾',
};

function PptPreview({ outline, fallback }: { outline: PptOutline | null; fallback: unknown }) {
  const slides = outline?.slides ?? [];
  if (!slides.length) {
    const req = (typeof fallback === 'object' && fallback !== null ? (fallback as Record<string, unknown>) : {}) as Record<string, unknown>;
    const reqTitle = typeof req.title === 'string' ? req.title : undefined;
    const requirement = typeof req.requirement === 'string' ? req.requirement : undefined;
    const summary = typeof req.summary === 'string' ? req.summary : undefined;
    return (
      <div className="lf-card rounded-2xl p-6">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-muted">PPT 大纲不可用</p>
        <h4 className="mt-2 text-[15px] font-bold text-ink">{reqTitle || 'PPT 内容概览'}</h4>
        {(requirement || summary) ? (
          <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-ink-2">{requirement || summary}</p>
        ) : (
          <pre className="mt-3 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-xl bg-[#2C3A30] p-4 text-xs leading-5 text-emerald-50/90">
            {typeof fallback === 'string' ? fallback : JSON.stringify(fallback, null, 2)}
          </pre>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="lf-card rounded-2xl px-5 py-4">
        <h3 className="text-base font-bold text-ink">{outline?.title || '演示大纲'}</h3>
        {outline?.subtitle && <p className="mt-1 text-[13px] text-ink-muted">{outline.subtitle}</p>}
        <span className="lf-pill lf-pill-null mt-2">共 {slides.length} 页</span>
      </div>
      {slides.map((slide, index) => (
        <div key={index} className="lf-card rounded-2xl px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="lf-pill lf-pill-ok">{index + 1}</span>
            {slide.kind && <span className="lf-pill lf-pill-warn">{slideKindLabel[slide.kind] || slide.kind}</span>}
            {slide.title && <h4 className="text-[14.5px] font-bold text-ink">{slide.title}</h4>}
          </div>
          {!!slide.points?.length && (
            <ul className="mt-2.5 space-y-1.5">
              {slide.points.map((point, pi) => (
                <li key={pi} className="flex items-baseline gap-2 text-[13px] leading-6 text-ink-2">
                  <span className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-brand/45" />
                  <span className="min-w-0">
                    {point.heading && <span className="font-semibold text-ink">{point.heading}：</span>}
                    {point.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {slide.takeaway && (
            <p className="mt-2.5 rounded-lg bg-amber-tint/50 px-3.5 py-2.5 text-[12.5px] leading-6 text-[#8A6A2F]">
              💡 {slide.takeaway}
            </p>
          )}
          {slide.speakerNotes && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11.5px] font-semibold text-ink-muted">演讲备注</summary>
              <p className="mt-1.5 text-[12.5px] leading-6 text-ink-muted">{slide.speakerNotes}</p>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------- 容器 ---------------- */

/** MySQL JSON 列经 JDBC 返回的是字符串，统一解析成对象 */
function asObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  }
  return null;
}

function QualityOverview({ decision, sourceCount }: { decision: Record<string, unknown> | null; sourceCount: number }) {
  if (!decision) return null;
  const knowledge = asObject(decision.knowledgeContext);
  const multiAgent = asObject(decision.multiAgent);
  const defenses = asObject(decision.questionBankDefenses);
  const evidence = Array.isArray(decision.evidenceSnapshot) ? decision.evidenceSnapshot : [];
  const review = asObject(multiAgent?.review);
  const score = Number(knowledge?.high_fidelity_score);
  const scoreText = Number.isFinite(score) ? `${Math.round(score * 100)} 分` : '已完成检查';
  const citationPassed = multiAgent?.citationVerified === true;
  const defenseItems = defenses ? [
    ['题目结构', asObject(defenses.schema)?.passed === true],
    ['证据对应', asObject(defenses.evidence)?.passed === true],
    ['内容复核', asObject(defenses.reviewer)?.passed === true],
    ['重复检查', asObject(defenses.duplicate)?.passed === true],
  ] as Array<[string, boolean]> : [];
  return (
    <section className="mb-4 rounded-2xl border border-brand/15 bg-brand-tint/25 p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-white"><CheckCircle2 size={17} /></div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-ink">内容依据与审核概览</h3>
          <p className="mt-1 text-xs leading-5 text-ink-muted">帮助管理员判断该资源是否具备清晰的知识依据，以及是否适合作为机构资源继续审核。</p>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <div className="rounded-xl bg-white/70 px-3 py-3"><p className="text-[10px] font-semibold text-ink-muted">知识依据充分度</p><p className="mt-1 text-sm font-bold text-ink">{scoreText}</p></div>
        <div className="rounded-xl bg-white/70 px-3 py-3"><p className="text-[10px] font-semibold text-ink-muted">可查看的依据</p><p className="mt-1 text-sm font-bold text-ink">{evidence.length || sourceCount} 条</p></div>
        <div className="rounded-xl bg-white/70 px-3 py-3"><p className="text-[10px] font-semibold text-ink-muted">引用核验</p><p className={cn('mt-1 text-sm font-bold', citationPassed ? 'text-emerald-700' : 'text-amber-700')}>{citationPassed ? '已通过' : '建议人工复核'}</p></div>
      </div>
      {!!defenseItems.length && <div className="mt-3 flex flex-wrap gap-2">{defenseItems.map(([label, passed]) => <span key={label} className={cn('rounded-full px-2.5 py-1 text-[11px] font-semibold', passed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700')}>{label} · {passed ? '通过' : '需复核'}</span>)}</div>}
      {Array.isArray(review?.issues) && review.issues.length > 0 && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">审核提示：{review.issues.slice(0, 3).map(String).join('；')}</p>}
    </section>
  );
}

export default function ResourcePreview({ detail }: { detail: AdminResourceDetail }) {
  const type = detail.type || '';
  const doc = asObject(detail.content);
  const generationContext = asObject(doc?.generationContext);
  const lectureResource = asObject(generationContext?.lectureResource);
  const rawSources = typeof detail.sources === 'string' ? (()=>{try{return JSON.parse(detail.sources) as unknown;}catch{return [];}})() : detail.sources;
  const inheritedSources = Array.isArray(lectureResource?.sources) ? lectureResource.sources : [];
  const sourceInput = type === 'ppt' && inheritedSources.length ? inheritedSources : rawSources;
  const sources = Array.isArray(sourceInput) ? sourceInput.filter((item):item is Record<string,unknown>=>Boolean(item)&&typeof item==='object') : [];
  const decision = asObject(detail.decision);
  const qualityDecision = type === 'ppt' && lectureResource ? {
    knowledgeContext: lectureResource.knowledgeContext,
    evidenceSnapshot: lectureResource.evidenceSnapshot,
    multiAgent: lectureResource.qualityReview,
    webEvidenceDebate: lectureResource.webEvidenceDebate,
  } : decision;
  let preview: React.ReactNode;
  if (type === 'lecture') {
    preview = <LecturePreview doc={(doc ?? {}) as unknown as LectureDoc} sources={sources} />;
  } else if (type === 'practice') {
    preview = <PracticePreview doc={(doc ?? {}) as unknown as PracticeDoc} sources={sources} />;
  } else if (type === 'quiz') {
    preview = <QuizPreview doc={(doc ?? {}) as unknown as QuizDoc} sources={sources} />;
  } else if (type === 'ppt') {
    const outline = asObject(detail.decision) as PptOutline | null;
    preview = <PptPreview outline={outline} fallback={doc ?? detail.content} />;
  } else {
    preview = <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-xl bg-[#2C3A30] p-4 text-xs leading-5 text-emerald-50/90">{typeof detail.content === 'string' ? detail.content : JSON.stringify(detail.content ?? {}, null, 2)}</pre>;
  }
  const debateArchive = asObject(qualityDecision?.webEvidenceDebate);
  return <><QualityOverview decision={qualityDecision} sourceCount={sources.length}/><EvidenceDebateCourt archive={debateArchive}/>{preview}<SourceSummary sources={sources}/></>;
}
