/**
 * 学习日志 `/me/journal`（W7）
 *
 * 旧版 LearningJournal 是"按天翻页看今天做了什么"；网页版一直没有这一页，
 * 而数据早就在：/api/v1/learner-profile/journal?date=YYYY-MM-DD
 * 返回 { stats, timeline[], summary }，我的成长页也一直在用它拼近 7 天轨迹。
 *
 * 这一页只做一件事：选一天，把这一天真实发生的事按时间摆出来，需要的话让伴学助手写一句总结。
 * 不做假的连续打卡动画、不编"你今天很棒"这类话——没活动就说没活动。
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  BookOpen, ChevronLeft, ChevronRight, Clock3, Database, Headphones, ListChecks,
  Loader2, MessageCircleQuestion, Sparkles,
} from 'lucide-react';
import PageBack from '@/components/PageBack';
import { api } from '@/lib/api';
import type { LearningJournal } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { lectureMdComponents, mdRemarkPlugins, mdRehypePlugins } from '@/components/resources/lecture-markdown';
import ReactMarkdown from 'react-markdown';

const dayIcons: Record<string, typeof BookOpen> = {
  focus: Headphones,
  resource: BookOpen,
  knowledge: Database,
  chat: MessageCircleQuestion,
  quiz: ListChecks,
};

const dayLabels: Record<string, string> = {
  focus: '专注学习',
  resource: '看资源',
  knowledge: '看知识库',
  chat: '问伴学助手',
  quiz: '做题',
};

function localDateKey(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value: number) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function shiftDate(key: string, delta: number): string {
  const parts = key.split('-').map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  date.setDate(date.getDate() + delta);
  const pad = (value: number) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function friendlyDate(key: string): string {
  const today = localDateKey(0);
  if (key === today) return '今天';
  if (key === localDateKey(-1)) return '昨天';
  const parts = key.split('-').map(Number);
  return parts[1] + ' 月 ' + parts[2] + ' 日';
}

function minutesOf(seconds: number | null | undefined): number {
  return Math.round((seconds ?? 0) / 60);
}

export default function Journal() {
  const navigate = useNavigate();
  /* 支持 ?date=YYYY-MM-DD 深链：日志是要能"指着某一天"给人看的，也能让自检脚本直接跳过去 */
  const [searchParams, setSearchParams] = useSearchParams();
  const dateParam = searchParams.get('date') ?? '';
  const [date, setDate] = useState(() => (/^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : localDateKey(0)));
  const changeDate = (next: string) => {
    setDate(next);
    setSearchParams({ date: next }, { replace: true });
  };
  const [journal, setJournal] = useState<LearningJournal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summarizing, setSummarizing] = useState(false);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError('');
    try {
      const result = await api.getLearningJournal(target);
      setJournal(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '学习日志读取失败');
      setJournal(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(date); }, [date, load]);

  const stats = journal?.stats;
  const timeline = journal?.timeline ?? [];
  const isToday = date === localDateKey(0);

  const summarize = async () => {
    setSummarizing(true);
    try {
      const result = await api.generateLearningJournalSummary(date);
      setJournal(result);
      toast.success('这一天的总结写好了');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '总结生成失败');
    } finally {
      setSummarizing(false);
    }
  };

  const statItems = stats ? [
    { label: '专注', value: minutesOf(stats.focusSeconds), unit: '分', show: stats.focusSeconds > 0 },
    { label: '学习时长', value: minutesOf(stats.totalDurationSeconds), unit: '分', show: stats.totalDurationSeconds > 0 },
    { label: '资源', value: stats.resourceCount, unit: '份', show: stats.resourceCount > 0 },
    { label: '知识点', value: stats.knowledgeCount, unit: '个', show: stats.knowledgeCount > 0 },
    { label: '答题', value: stats.questionCount, unit: '题', show: stats.questionCount > 0 },
    { label: '答对', value: stats.correctCount, unit: '题', show: stats.questionCount > 0 },
    { label: '答错', value: stats.wrongCount, unit: '题', show: stats.questionCount > 0 },
  ].filter((item) => item.show) : [];

  return (
    <div className="mx-auto max-w-[900px] px-5 pb-12 pt-8 md:px-6">
      <PageBack parent={{ label: '我的学习', to: '/me' }} current="学习日志" />

      <motion.header initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="lf-mono-label">LEARNING JOURNAL</div>
          <h1 className="mt-2 font-serif text-[30px] font-bold leading-[38px] text-ink">学习日志</h1>
          <p className="mt-1 text-[13px] text-ink-muted">这里只记真实发生过的事：看了什么、做了什么、答对答错多少。</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => changeDate(shiftDate(date, -1))}
            aria-label="前一天"
            className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-hairline bg-paper text-ink-muted hover:border-brand/35 hover:text-brand"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[124px] text-center font-mono text-[13px] text-ink">
            {friendlyDate(date)}
            <span className="ml-1 text-[11px] text-ink-muted">{date}</span>
          </span>
          <button
            type="button"
            disabled={isToday}
            onClick={() => changeDate(shiftDate(date, 1))}
            aria-label="后一天"
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-[10px] border border-hairline bg-paper transition-colors',
              isToday ? 'cursor-not-allowed text-ink-muted/40' : 'text-ink-muted hover:border-brand/35 hover:text-brand',
            )}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </motion.header>

      {loading && (
        <div className="lf-card mt-6 flex items-center justify-center gap-2 p-10 text-[13px] text-ink-muted">
          <Loader2 size={16} className="animate-spin" />
          正在读取这一天的记录…
        </div>
      )}

      {!loading && error && (
        <div className="mt-6 rounded-[12px] border border-brand-danger/40 bg-brand-danger/10 px-4 py-3 text-[13px] text-brand-danger">
          {error}
          <button type="button" onClick={() => void load(date)} className="lf-btn-ghost ml-3 !px-3 !py-1 text-[12px]">重试</button>
        </div>
      )}

      {!loading && !error && (
        <>
          {statItems.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2.5">
              {statItems.map((item) => (
                <div key={item.label} className="rounded-[12px] border border-hairline bg-card-warm px-3.5 py-2">
                  <div className="text-[11px] text-ink-muted">{item.label}</div>
                  <div className="mt-0.5 font-mono text-[16px] font-semibold text-ink">
                    {item.value}
                    <span className="ml-0.5 text-[11px] font-normal text-ink-muted">{item.unit}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {journal?.summary && (
            <div className="lf-card mt-5 border-brand/25 bg-brand-tint/25 p-5">
              <div className="flex items-center gap-2 text-[12px] text-ink-muted">
                <Sparkles size={14} className="text-brand" />
                这一天的总结
              </div>
              <div className="mt-2.5 text-[13.5px] leading-[22px] text-ink-2">
                <ReactMarkdown remarkPlugins={mdRemarkPlugins} rehypePlugins={mdRehypePlugins} components={lectureMdComponents}>
                  {journal.summary.content}
                </ReactMarkdown>
              </div>
            </div>
          )}

          {timeline.length > 0 ? (
            <div className="lf-card mt-5 divide-y divide-hairline overflow-hidden">
              {timeline.map((item) => {
                const Icon = dayIcons[item.kind] ?? Clock3;
                const time = item.occurredAt ? new Date(item.occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
                return (
                  <div key={item.id} className="flex items-start gap-3.5 px-5 py-3.5">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-hairline bg-paper text-brand">
                      <Icon size={15} strokeWidth={1.8} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono text-[11px] text-ink-muted">{time}</span>
                        <span className="rounded bg-paper-deep px-1.5 py-0.5 text-[10.5px] text-ink-muted">{dayLabels[item.kind] ?? item.kind}</span>
                        {item.durationSeconds ? <span className="font-mono text-[11px] text-ink-muted">· {minutesOf(item.durationSeconds)} 分</span> : null}
                        {item.knowledgeName ? <span className="text-[11px] text-ink-muted">· {item.knowledgeName}</span> : null}
                        {item.correctCount != null && item.correctCount + (item.wrongCount ?? 0) > 0
                          ? <span className="font-mono text-[11px] text-ink-muted">· 对 {item.correctCount} / 错 {item.wrongCount ?? 0}</span>
                          : null}
                      </div>
                      <div className="mt-1 text-[13.5px] font-medium leading-6 text-ink">{item.title}</div>
                      {item.description ? <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-5 text-ink-muted">{item.description}</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="lf-card mt-5 p-10 text-center">
              <p className="text-[14px] font-medium text-ink">{friendlyDate(date)}还没有学习记录</p>
              <p className="mt-1.5 text-[12.5px] text-ink-muted">读一份讲义、做一组分阶题，或问伴学助手一个问题，都会出现在这里。</p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <button type="button" onClick={() => navigate('/learn')} className="lf-btn-primary !px-4 !py-2 text-[13px]">去学 · 练</button>
                <Link to="/me/wrong" className="lf-btn-ghost !px-4 !py-2 text-[13px]">看错题本</Link>
              </div>
            </div>
          )}

          {timeline.length > 0 && !journal?.summary && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={summarizing}
                onClick={() => void summarize()}
                className="lf-btn-primary !px-4 !py-2 text-[13px] disabled:opacity-60"
              >
                {summarizing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {summarizing ? '正在写…' : '让伴学助手总结这一天'}
              </button>
              <span className="text-[11.5px] text-ink-muted">总结由模型按当天记录写，写完会存在这一天里。</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
