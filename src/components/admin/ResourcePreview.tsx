/**
 * 管理员端资源预览
 * 复用学员端设计语言：讲义走 lectureMdComponents（与学员端完全一致），
 * 实操/测验/PPT 大纲按同款玻璃卡片语言绘制。
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CheckCircle2, Clock, Target, Terminal } from 'lucide-react';
import { lectureMdComponents } from '@/components/resources/lecture-markdown';
import { cn } from '@/lib/utils';
import type { AdminResourceDetail } from '@/lib/api';

/* ---------------- 数据结构（与 generated_learning_resources.content_json / presentation_tasks.outline_json 对应） ---------------- */

interface LectureSection { title?: string; content?: string }
interface LectureChapter { title?: string; overview?: string; sections?: LectureSection[] }
interface LectureDoc {
  title?: string; summary?: string; chapters?: LectureChapter[];
  keyPoints?: string[]; reviewQuestions?: string[]; learningObjectives?: string[];
}
interface PracticeStep { title?: string; content?: string; detail?: string; hint?: string }
interface TroubleshootItem { problem?: string; solution?: string }
interface PracticeDoc {
  title?: string; objective?: string; environment?: string;
  steps?: PracticeStep[]; prerequisites?: string[];
  troubleshooting?: TroubleshootItem[] | string[];
  acceptanceCriteria?: string[]; estimatedMinutes?: number; challenge?: string;
}
interface QuizQuestion {
  id?: number | string; stem: string; options: string[];
  correctIndex?: number; explanation?: string; difficulty?: number; citations?: unknown[];
}
interface QuizDoc { title?: string; questions?: QuizQuestion[]; knowledgePoints?: string[] }
interface PptPoint { heading?: string; detail?: string }
interface PptSlide { kind?: string; title?: string; points?: PptPoint[]; takeaway?: string; speakerNotes?: string }
interface PptOutline { title?: string; subtitle?: string; slides?: PptSlide[]; agendaPlan?: string[] }

/* ---------------- 讲义：合成 markdown 后走学员端渲染器 ---------------- */

function lectureToMarkdown(doc: LectureDoc): string {
  const parts: string[] = [];
  if (doc.title) parts.push(`# ${doc.title}`);
  if (doc.summary) { parts.push('## 导语'); parts.push(doc.summary); }
  for (const chapter of doc.chapters ?? []) {
    parts.push(`## ${chapter.title ?? '章节'}`);
    if (chapter.overview) parts.push(chapter.overview);
    for (const section of chapter.sections ?? []) {
      if (section.title) parts.push(`### ${section.title}`);
      if (section.content) parts.push(section.content);
    }
  }
  if (doc.learningObjectives?.length) {
    parts.push('## 学习目标');
    parts.push(doc.learningObjectives.map((item) => `- ${item}`).join('\n'));
  }
  if (doc.keyPoints?.length) {
    parts.push('## 关键要点');
    parts.push(doc.keyPoints.map((item) => `- ${item}`).join('\n'));
  }
  if (doc.reviewQuestions?.length) {
    parts.push('## 复习思考');
    parts.push(doc.reviewQuestions.map((item) => `- ${item}`).join('\n'));
  }
  return parts.join('\n\n');
}

function LecturePreview({ doc }: { doc: LectureDoc }) {
  return (
    <div className="lf-card rounded-2xl p-6 md:p-8">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={lectureMdComponents}>
        {lectureToMarkdown(doc)}
      </ReactMarkdown>
    </div>
  );
}

/* ---------------- 实操指南：步骤卡片 ---------------- */

const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function PracticePreview({ doc }: { doc: PracticeDoc }) {
  const troubles = Array.isArray(doc.troubleshooting)
    ? doc.troubleshooting.map((item) => (typeof item === 'string' ? { problem: item, solution: '' } : item))
    : [];
  return (
    <div className="space-y-4">
      {/* 目标与环境 */}
      <div className="lf-card rounded-2xl p-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="mr-auto text-base font-bold text-ink">{doc.title || '实操指南'}</h3>
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
              <p className="mt-1 font-mono text-[12.5px] leading-6 text-ink-2">{doc.environment}</p>
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
      </div>
      {/* 步骤 */}
      <div className="lf-card rounded-2xl p-5">
        <h3 className="text-sm font-bold text-ink">操作步骤</h3>
        <ol className="mt-4 space-y-3">
          {(doc.steps ?? []).map((step, index) => (
            <li key={index} className="flex items-start gap-3.5">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-tint font-mono text-[12px] font-bold text-brand">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 rounded-xl border border-white/70 bg-white/50 px-4 py-3">
                {step.title && <p className="text-sm font-semibold text-ink">{step.title}</p>}
                {(step.content || step.detail) && (
                  <p className="mt-1 text-[13px] leading-6 text-ink-2">{step.content || step.detail}</p>
                )}
                {step.hint && <p className="mt-1.5 text-xs leading-5 text-ochre">{step.hint}</p>}
              </div>
            </li>
          ))}
        </ol>
        {!!doc.acceptanceCriteria?.length && (
          <div className="mt-5 rounded-xl border border-ochre/25 bg-ochre-tint/40 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-[#9A5B3C]">验收标准</p>
            <ul className="mt-2 space-y-1.5">
              {doc.acceptanceCriteria.map((item, index) => (
                <li key={index} className="flex items-start gap-2 text-[13px] leading-6 text-ink-2">
                  <CheckCircle2 size={14} className="mt-1 shrink-0 text-ochre" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!troubles.length && (
          <div className="mt-5">
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
    </div>
  );
}

/* ---------------- 分阶测试：题目卡（含答案与解析） ---------------- */

function QuizPreview({ doc }: { doc: QuizDoc }) {
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
        return (
          <div key={q.id ?? index} className="lf-card overflow-hidden rounded-2xl">
            <div className="flex items-start gap-3 px-5 py-4">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand font-mono text-[11.5px] font-semibold text-paper">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {q.difficulty != null && (
                    <span className="lf-pill lf-pill-null">难度 {q.difficulty}/5</span>
                  )}
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
              </div>
            </div>
          </div>
        );
      })}
      {!questions.length && <div className="lf-empty px-6 py-12 text-center text-sm">该资源没有可展示的题目</div>}
    </div>
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

export default function ResourcePreview({ detail }: { detail: AdminResourceDetail }) {
  const type = detail.type || '';
  const doc = asObject(detail.content);
  if (type === 'lecture') {
    return <LecturePreview doc={(doc ?? {}) as unknown as LectureDoc} />;
  }
  if (type === 'practice') {
    return <PracticePreview doc={(doc ?? {}) as unknown as PracticeDoc} />;
  }
  if (type === 'quiz') {
    return <QuizPreview doc={(doc ?? {}) as unknown as QuizDoc} />;
  }
  if (type === 'ppt') {
    /* PPT 详情：content=request_json，decision=outline_json（幻灯片大纲） */
    const outline = asObject(detail.decision) as PptOutline | null;
    return <PptPreview outline={outline} fallback={doc ?? detail.content} />;
  }
  return (
    <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-xl bg-[#2C3A30] p-4 text-xs leading-5 text-emerald-50/90">
      {typeof detail.content === 'string' ? detail.content : JSON.stringify(detail.content ?? {}, null, 2)}
    </pre>
  );
}
