import type { AdminGenerationEvent } from '@/lib/api';
import { cn } from '@/lib/utils';

const labels: Record<string, string> = {
  activity: '正在执行',
  topic: '学习主题',
  query: '检索范围',
  ragCount: '知识库依据',
  webCount: '补充资料',
  sourceCount: '引用来源',
  questionCount: '题目数量',
  stepCount: '实操步骤',
  chapterCount: '章节数量',
  issueCount: '发现问题',
  citationVerified: '引用核验',
  decision: '处理决定',
  attempt: '生成轮次',
  questionNumber: '题目序号',
  questionDifficulty: '难度等级',
  coverage: '内容覆盖',
  acceptanceRubric: '验收标准',
  highFidelityScore: '依据充分度',
  fallbackUsed: '是否补充资料',
  knowledgeCoreCount: '知识库切片',
  debateStage: '辩论阶段',
  contradictionCount: '矛盾数量',
  grounding: '证据支撑',
  answerConfidence: '答案可信',
  clarity: '题意清晰',
  distractorQuality: '干扰项质量',
  difficultyMatch: '难度匹配',
  explanationQuality: '解析完整',
  overall: '综合评分',
};

const ignoredKeys = new Set([
  'display',
  'artifactContent',
  'artifactPreview',
  'evidenceItems',
  'question',
  'questionAudit',
  'checks',
  'issues',
  'outputs',
  'inputs',
  'actions',
  'ruleConstraints',
  'ruleCheckResults',
  'debateGroup',
  'contradictions',
  'supportingFindings',
  'challengeFindings',
  'arbitrationItems',
  'resolutions',
  'repairSuggestions',
  'hardErrors',
  'riskLabels',
  'scores',
]);

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function scalarValue(value: unknown): boolean {
  return value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function readableValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item)).join('；') || '无';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '—');
}

function ScoreCard({ audit }: { audit: Record<string, unknown> }) {
  const scores = audit.scores && typeof audit.scores === 'object' ? audit.scores as Record<string, unknown> : null;
  const entries = scores ? Object.entries(scores).filter(([, value]) => Number.isFinite(Number(value))) : [];
  if (!entries.length) return null;
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {entries.map(([key, value]) => (
        <div key={key} className="rounded-lg bg-[#F3F5F0] px-2 py-1.5">
          <p className="text-[8px] text-ink-muted">{labels[key] ?? key}</p>
          <p className="mt-0.5 text-[10px] font-bold text-ink">{Math.round(Number(value))} 分</p>
        </div>
      ))}
    </div>
  );
}

function QuestionFocus({ snapshot }: { snapshot: Record<string, unknown> }) {
  const question = snapshot.question && typeof snapshot.question === 'object' ? snapshot.question as Record<string, unknown> : null;
  const audit = snapshot.questionAudit && typeof snapshot.questionAudit === 'object' ? snapshot.questionAudit as Record<string, unknown> : null;
  const options = Array.isArray(question?.options) ? (question.options as unknown[]).map(String) : [];
  const correctIndex = Number(question?.correctIndex);
  const checks = recordArray(audit?.checks);
  const issues = stringArray(audit?.issues);
  const risks = stringArray(audit?.riskLabels);
  if (!question) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-brand-tint px-2 py-1 text-[9px] font-bold text-brand">第 {String(snapshot.questionNumber ?? '')} 题</span>
        <span className="text-[9px] text-ink-muted">难度 {String(question.difficultyLevel ?? question.difficulty ?? '')}</span>
        {audit && <span className={cn('rounded-full px-2 py-1 text-[8.5px] font-bold', audit.passed === true ? 'bg-emerald-50 text-emerald-700' : 'bg-ochre/10 text-ochre')}>{audit.passed === true ? '审核通过' : '需要关注'}</span>}
      </div>
      <p className="text-[11px] font-bold leading-5 text-ink">{String(question.stem ?? '')}</p>
      <div className="space-y-1">
        {options.map((option, index) => (
          <div key={index} className={cn('rounded-lg px-2.5 py-1.5 text-[10px] leading-5', index === correctIndex ? 'bg-emerald-50 font-semibold text-emerald-800 ring-1 ring-emerald-200' : 'bg-white/70 text-ink-2')}>
            <span className="mr-1.5 font-bold">{String.fromCharCode(65 + index)}.</span>
            <span>{option}</span>
            {index === correctIndex && <span className="ml-1.5 text-[8px] font-bold text-emerald-700">正确答案</span>}
          </div>
        ))}
      </div>
      {Boolean(question.explanation) && <p className="rounded-lg bg-brand-tint/40 px-2.5 py-1.5 text-[10px] leading-5 text-ink-2"><span className="font-semibold text-brand">解析：</span>{String(question.explanation)}</p>}
      <ScoreCard audit={audit ?? {}} />
      {checks.length > 0 && (
        <div className="space-y-1">
          {checks.map((check, index) => (
            <div key={index} className={cn('rounded-lg px-2.5 py-1.5', check.passed === false ? 'bg-ochre/5' : 'bg-white/65')}>
              <div className="flex items-center gap-2"><span className={cn('h-1.5 w-1.5 rounded-full', check.passed === false ? 'bg-ochre' : 'bg-emerald-500')} /><p className="min-w-0 flex-1 text-[9.5px] font-semibold text-ink">{String(check.label ?? `核验项 ${index + 1}`)}</p><span className={cn('text-[8.5px] font-bold', check.passed === false ? 'text-ochre' : 'text-emerald-700')}>{check.passed === false ? '未通过' : '通过'}</span></div>
              {Boolean(check.finding) && <p className="mt-1 line-clamp-3 text-[9px] leading-4 text-ink-2">{String(check.finding)}</p>}
            </div>
          ))}
        </div>
      )}
      {issues.length > 0 && <div className="space-y-1">{issues.map((issue) => <p key={issue} className="rounded-lg bg-ochre/10 px-2.5 py-1.5 text-[9px] leading-4 text-ochre">{issue}</p>)}</div>}
      {risks.length > 0 && <div className="flex flex-wrap gap-1">{risks.map((risk) => <span key={risk} className="rounded-md bg-amber-50 px-2 py-0.5 text-[8.5px] font-bold text-amber-700">{risk}</span>)}</div>}
    </div>
  );
}

function JsonTree({ value }: { value: unknown }) {
  if (value == null) return <span className="jz">—</span>;
  if (typeof value === 'number') return <span className="jn">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="jb">{String(value)}</span>;
  if (typeof value === 'string') return <span className={cn('js', value.length > 220 && 'line-clamp-6 whitespace-pre-wrap')}>{JSON.stringify(value)}</span>;
  if (Array.isArray(value)) {
    return (
      <>
        <span className="jp">[</span>
        {value.map((item, index) => (
          <div key={index} className="pl-4">
            <JsonTree value={item} />
            {index < value.length - 1 && <span className="jp">,</span>}
          </div>
        ))}
        <span className="jp">]</span>
      </>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <>
        <span className="jp">{'{'}</span>
        {entries.map(([key, val], index) => (
          <div key={key} className="pl-4">
            <span className="jk">"{key}"</span><span className="jp">: </span>
            <JsonTree value={val} />
            {index < entries.length - 1 && <span className="jp">,</span>}
          </div>
        ))}
        <span className="jp">{'}'}</span>
      </>
    );
  }
  return <span className="jz">—</span>;
}

export default function ExecutionDetailPanel({ event, title }: { event: AdminGenerationEvent; title: string }) {
  const snapshot = event.snapshot ?? {};
  const display = snapshot.display && typeof snapshot.display === 'object' ? snapshot.display as Record<string, unknown> : {};
  const scalarFacts = Object.entries(snapshot)
    .filter(([key, value]) => !ignoredKeys.has(key) && scalarValue(value))
    .map(([key, value]) => [key, value] as const);
  const evidence = recordArray(snapshot.evidenceItems).concat(recordArray(display.evidence));
  const outputs = recordArray(display.outputs);
  const checks = recordArray(snapshot.checks).concat(recordArray(display.checks));
  const issues = stringArray(snapshot.issues).concat(stringArray(display.issues));
  const summary = String(display.summary ?? event.detail ?? '');
  const decision = String(display.decision ?? snapshot.decision ?? '');
  const agentName = event.agentName || event.agent;

  return (
    <div className="space-y-3">
      <header className="rounded-2xl border border-white/85 bg-white/70 p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-sm font-bold text-ink">{title}</h3>
          <span className="lf-pill lf-pill-null">{event.phase || event.status}</span>
          <span className="ml-auto text-[9px] font-mono text-ink-muted">{event.time ? new Date(event.time).toLocaleString('zh-CN', { hour12: false }) : `记录 #${event.seq}`}</span>
        </div>
        <p className="mt-1.5 text-[10px] font-semibold text-ink-muted">{agentName}</p>
      </header>

      <section className="rounded-2xl border border-white/80 bg-white/55 p-3">
        <div className="flex items-center gap-2 border-b border-white/70 pb-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-tint font-mono text-[9px] font-bold text-brand">1</span>
          <h4 className="text-[11px] font-bold text-ink">重点内容</h4>
        </div>
        <div className="mt-3 space-y-3">
          <QuestionFocus snapshot={snapshot} />
          {summary && <p className="rounded-lg bg-white/70 px-3 py-2.5 text-[10.5px] leading-5 text-ink-2">{summary}</p>}
          {decision && <div className="rounded-lg bg-brand-tint/45 px-3 py-2"><p className="text-[8.5px] font-semibold text-brand">处理决定</p><p className="mt-0.5 text-[10.5px] font-semibold text-ink">{decision}</p></div>}
          {scalarFacts.length > 0 && (
            <div className="grid grid-cols-2 gap-1.5">
              {scalarFacts.map(([key, value]) => (
                <div key={key} className="rounded-lg bg-white/65 px-2.5 py-2">
                  <p className="text-[8.5px] text-ink-muted">{labels[key] ?? key}</p>
                  <p className="mt-0.5 break-words text-[10px] font-semibold text-ink">{readableValue(value)}</p>
                </div>
              ))}
            </div>
          )}
          {evidence.length > 0 && (
            <div>
              <p className="text-[9px] font-semibold text-ink-muted">采用依据 · {evidence.length} 项</p>
              <div className="mt-1.5 space-y-1">
                {evidence.slice(0, 4).map((item, index) => (
                  <div key={index} className="rounded-lg bg-white/65 px-2.5 py-1.5">
                    <p className="text-[9px] font-semibold text-ink">{String(item.title ?? `依据 ${index + 1}`)}</p>
                    {Boolean(item.excerpt) && <p className="mt-0.5 line-clamp-2 text-[9px] leading-4 text-ink-muted">{String(item.excerpt)}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {outputs.length > 0 && (
            <div>
              <p className="text-[9px] font-semibold text-ink-muted">本次产出 · {outputs.length} 项</p>
              <div className="mt-1.5 space-y-1">
                {outputs.map((item, index) => (
                  <div key={index} className="rounded-lg bg-white/65 px-2.5 py-1.5"><p className="text-[9px] font-semibold text-ink">{String(item.label ?? `产出 ${index + 1}`)}</p><p className="mt-0.5 line-clamp-2 text-[9px] leading-4 text-ink-muted">{readableValue(item.value)}</p></div>
                ))}
              </div>
            </div>
          )}
          {checks.length > 0 && (
            <div>
              <p className="text-[9px] font-semibold text-ink-muted">核验结论 · {checks.length} 项</p>
              <div className="mt-1.5 space-y-1">
                {checks.map((check, index) => (
                  <div key={index} className="flex items-center gap-2 rounded-lg bg-white/65 px-2.5 py-1.5"><span className={cn('h-1.5 w-1.5 rounded-full', check.passed === false ? 'bg-ochre' : 'bg-emerald-500')} /><p className="min-w-0 flex-1 truncate text-[9.5px] font-semibold text-ink">{String(check.label ?? `核验项 ${index + 1}`)}</p><span className={cn('text-[8.5px] font-bold', check.passed === false ? 'text-ochre' : 'text-emerald-700')}>{check.passed === false ? '未通过' : '通过'}</span></div>
                ))}
              </div>
            </div>
          )}
          {issues.length > 0 && <div className="space-y-1">{issues.map((issue) => <p key={issue} className="rounded-lg bg-ochre/10 px-2.5 py-1.5 text-[9px] leading-4 text-ochre">{issue}</p>)}</div>}
        </div>
      </section>

      <section className="rounded-2xl border border-white/80 bg-white/55 p-3">
        <div className="flex items-center gap-2 border-b border-white/70 pb-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-ink-muted/10 font-mono text-[9px] font-bold text-ink-muted">2</span>
          <h4 className="text-[11px] font-bold text-ink">原始 JSON</h4>
        </div>
        <div className="lf-json mt-3 p-3 text-[10.5px] leading-5">
          <JsonTree value={{ seq: event.seq, time: event.time, agent: event.agent, agentName: event.agentName, phase: event.phase, status: event.status, title: event.title, detail: event.detail, snapshot }} />
        </div>
      </section>
    </div>
  );
}
