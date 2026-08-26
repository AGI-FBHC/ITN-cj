import type { AdminGenerationEvent } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface QuizExecutionSummary {
  number: number;
  question?: Record<string, unknown>;
  audit?: Record<string, unknown>;
  attempts: number;
  passed: boolean;
  reviewed: boolean;
}

const metricLabels: Record<string, string> = {
  grounding: '证据支撑',
  answerConfidence: '答案可信',
  clarity: '题意清晰',
  distractorQuality: '干扰项质量',
  difficultyMatch: '难度匹配',
  explanationQuality: '解析完整',
  overall: '综合评分',
};

const reviewModeLabels: Record<string, string> = {
  full: '完整审核',
  full_or_closure: '完整审核 + 定向复核',
  closure_only: '定向复核',
  score_only: '换题后评分',
  duplicate_check: '重复性检查',
};

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function isQuizQuestionEvent(event: AdminGenerationEvent) {
  const snapshot = event.snapshot ?? {};
  return Number(snapshot.questionNumber) > 0 || Boolean(snapshot.question) || Boolean(snapshot.questionAudit);
}

function QuestionDocument({ question, accent }: { question: Record<string, unknown>; accent?: 'plain' | 'final' }) {
  const options = Array.isArray(question.options) ? question.options.map(String) : [];
  const correctIndex = Number(question.correctIndex);
  const rationale = question.generationRationale && typeof question.generationRationale === 'object'
    ? question.generationRationale as Record<string, unknown>
    : null;
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-bold leading-5 text-ink">{String(question.stem ?? '')}</p>
      <div className="space-y-1">
        {options.map((option, index) => (
          <div
            key={index}
            className={cn(
              'rounded-lg px-2.5 py-1.5 text-[10px] leading-5',
              index === correctIndex
                ? 'bg-emerald-50 font-semibold text-emerald-800 ring-1 ring-emerald-200'
                : 'bg-white/70 text-ink-2',
            )}
          >
            <span className="mr-1.5 font-bold">{String.fromCharCode(65 + index)}.</span>
            <span>{option}</span>
            {index === correctIndex && <span className="ml-1.5 text-[8.5px] font-bold text-emerald-700">正确答案</span>}
          </div>
        ))}
      </div>
      {Boolean(question.explanation) && (
        <div className={cn('rounded-lg px-2.5 py-1.5 text-[10px] leading-5 text-ink-2', accent === 'final' ? 'bg-emerald-50/70' : 'bg-brand-tint/40')}>
          <span className="font-semibold text-brand">解析：</span>
          {String(question.explanation)}
        </div>
      )}
      {rationale && Object.keys(rationale).length > 0 && (
        <details className="rounded-lg border border-white/80 bg-white/50 px-2.5 py-1.5">
          <summary className="cursor-pointer text-[9px] font-bold text-ink-muted">生成说明</summary>
          <div className="mt-1.5 space-y-1">
            {Object.entries(rationale).map(([key, value]) => (
              <p key={key} className="text-[9px] leading-4 text-ink-2">
                <span className="font-semibold text-ink">{metricLabels[key] ?? key}：</span>
                {String(value)}
              </p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export default function QuizExecutionDetail({
  event,
  summary,
}: {
  event: AdminGenerationEvent;
  summary: QuizExecutionSummary;
}) {
  const snapshot = event.snapshot ?? {};
  const eventAudit = snapshot.questionAudit && typeof snapshot.questionAudit === 'object'
    ? snapshot.questionAudit as Record<string, unknown>
    : undefined;
  const audit = eventAudit ?? summary.audit;
  const original = snapshot.question && typeof snapshot.question === 'object'
    ? snapshot.question as Record<string, unknown>
    : summary.question;
  const finalQuestion = summary.question;
  const reviewMode = String(audit?.reviewMode ?? snapshot.reviewMode ?? '');
  const scores = audit?.scores && typeof audit.scores === 'object' ? audit.scores as Record<string, unknown> : null;
  const scoreEntries = scores ? Object.entries(scores).filter(([, value]) => Number.isFinite(Number(value))) : [];
  const checks = recordArray(audit?.checks);
  const issues = stringArray(audit?.issues);
  const riskLabels = stringArray(audit?.riskLabels);
  const hardErrorRecords = recordArray(audit?.hardErrors);
  const hardErrorStrings = stringArray(audit?.hardErrors);
  const repairRecords = recordArray(audit?.repairSuggestions);
  const repairStrings = stringArray(audit?.repairSuggestions);
  const passed = Boolean(audit?.passed) || summary.passed;
  const statusLabel = passed ? '已通过 · 待人工审核' : summary.reviewed ? '待复核' : '生成中';
  const reviewModeLabel = (reviewModeLabels[reviewMode] ?? reviewMode) || '逐题核验';

  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-white/85 bg-white/70 p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-brand-tint px-2 py-1 text-[9px] font-bold text-brand">第 {summary.number || Number(snapshot.questionNumber ?? '')} 题</span>
          <span className="text-[9px] text-ink-muted">难度 {String(summary.question?.difficultyLevel ?? summary.question?.difficulty ?? '')}</span>
          <span className={cn('ml-auto rounded-full px-2 py-1 text-[8.5px] font-bold', passed ? 'bg-emerald-50 text-emerald-700' : summary.reviewed ? 'bg-ochre/10 text-ochre' : 'bg-white/80 text-ink-muted')}>{statusLabel}</span>
        </div>
        {summary.attempts > 1 && <p className="mt-2 text-[9px] text-ink-muted">本题共生成 {summary.attempts} 个候选轮次</p>}
        <p className="mt-2 text-[10px] leading-5 text-ink-2">{String(event.detail || audit?.summary || '查看该题的生成、核验与最终内容')}</p>
      </section>

      <section className="rounded-2xl border border-white/80 bg-white/55 p-3">
        <div className="flex items-center gap-2"><span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-tint font-mono text-[9px] font-bold text-brand">1</span><h4 className="text-[11px] font-bold text-ink">生成原文</h4></div>
        {original ? (
          <div className="mt-2"><QuestionDocument question={original} /></div>
        ) : (
          <p className="mt-2 rounded-lg bg-white/60 px-3 py-2 text-[10px] text-ink-muted">该版本正在生成，暂无原文。</p>
        )}
      </section>

      <section className="rounded-2xl border border-white/80 bg-white/55 p-3">
        <div className="flex items-center gap-2"><span className="flex h-5 w-5 items-center justify-center rounded-md bg-ochre/15 font-mono text-[9px] font-bold text-ochre">2</span><h4 className="text-[11px] font-bold text-ink">怎么审核的</h4><span className="ml-auto rounded-full bg-white/80 px-2 py-0.5 text-[8.5px] font-bold text-ink-muted">{reviewModeLabel}</span></div>
        {audit ? (
          <>
            {scoreEntries.length > 0 && (
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                {scoreEntries.map(([key, value]) => (
                  <div key={key} className="rounded-lg bg-[#F3F5F0] px-2 py-1.5">
                    <p className="text-[8px] text-ink-muted">{metricLabels[key] ?? key}</p>
                    <p className="mt-0.5 text-[10px] font-bold text-ink">{Math.round(Number(value))} 分</p>
                  </div>
                ))}
              </div>
            )}
            {checks.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {checks.map((check, index) => (
                  <div key={index} className={cn('rounded-lg px-2.5 py-1.5', check.passed === false ? 'bg-ochre/5' : 'bg-white/65')}>
                    <div className="flex items-center gap-2">
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', check.passed === false ? 'bg-ochre' : 'bg-emerald-500')} />
                      <p className="min-w-0 flex-1 text-[9.5px] font-semibold text-ink">{String(check.label ?? `核验项 ${index + 1}`)}</p>
                      <span className={cn('text-[8.5px] font-bold', check.passed === false ? 'text-ochre' : 'text-emerald-700')}>{check.passed === false ? '未通过' : '通过'}</span>
                    </div>
                    {Boolean(check.finding) && <p className="mt-1 line-clamp-3 text-[9px] leading-4 text-ink-2">{String(check.finding)}</p>}
                  </div>
                ))}
              </div>
            )}
            {issues.length > 0 && <div className="mt-2 space-y-1">{issues.map((issue) => <p key={issue} className="rounded-lg bg-ochre/10 px-2.5 py-1.5 text-[9px] leading-4 text-ochre">{issue}</p>)}</div>}
            {riskLabels.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{riskLabels.map((label) => <span key={label} className="rounded-md bg-amber-50 px-2 py-0.5 text-[8.5px] font-bold text-amber-700">{label}</span>)}</div>}
            {hardErrorStrings.length > 0 && <div className="mt-2 space-y-1">{hardErrorStrings.map((item) => <p key={item} className="rounded-lg bg-rose-50 px-2.5 py-1.5 text-[9px] leading-4 text-red-700">硬错误：{item}</p>)}</div>}
            {repairStrings.length > 0 && <div className="mt-2 space-y-1">{repairStrings.map((item) => <p key={item} className="rounded-lg bg-amber-50/80 px-2.5 py-1.5 text-[9px] leading-4 text-amber-800">返修建议：{item}</p>)}</div>}
            {hardErrorRecords.length > 0 && <div className="mt-2 space-y-1">{hardErrorRecords.map((item, index) => <p key={index} className="rounded-lg bg-rose-50 px-2.5 py-1.5 text-[9px] leading-4 text-red-700">硬错误：{String(item.issue ?? item.finding ?? item.requiredAction ?? JSON.stringify(item))}</p>)}</div>}
            {repairRecords.length > 0 && <div className="mt-2 space-y-1">{repairRecords.map((item, index) => <p key={index} className="rounded-lg bg-amber-50/80 px-2.5 py-1.5 text-[9px] leading-4 text-amber-800">返修建议：{String(item.suggestion ?? item.instruction ?? item.issue ?? JSON.stringify(item))}</p>)}</div>}
          </>
        ) : (
          <p className="mt-2 rounded-lg bg-white/60 px-3 py-2 text-[10px] text-ink-muted">该版本尚未进入质量核验。</p>
        )}
      </section>

      <section className="rounded-2xl border border-white/80 bg-white/55 p-3">
        <div className="flex items-center gap-2"><span className="flex h-5 w-5 items-center justify-center rounded-md bg-emerald-100 font-mono text-[9px] font-bold text-emerald-700">3</span><h4 className="text-[11px] font-bold text-ink">审核后的内容</h4><span className="ml-auto rounded-full bg-white/80 px-2 py-0.5 text-[8.5px] font-bold text-ink-muted">{finalQuestion ? '最终版本' : '待生成'}</span></div>
        {finalQuestion ? (
          <div className="mt-2"><QuestionDocument question={finalQuestion} accent="final" /></div>
        ) : (
          <p className="mt-2 rounded-lg bg-white/60 px-3 py-2 text-[10px] text-ink-muted">审核通过后将在这里展示最终题目内容。</p>
        )}
      </section>
    </div>
  );
}
