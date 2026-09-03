/** 我的成长 · 盲区选择（消解目标）
 * 让学习者从近期待学知识点中选出 1~3 个盲区目标，
 * 完成后依据真实学习进度自动判定消散并计入看板。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, CheckCircle2, Crosshair, RefreshCw, Sparkles, Target } from 'lucide-react';
import { cn } from '@/lib/utils';
import { learnMapPath } from '@/lib/learnNav';

export interface FocusKp {
  id: string;
  name: string;
  progress: number;
  mastery: number;
}

export interface FocusRecord {
  kpId: string;
  name: string;
  selectedAt: string;
  resolvedAt?: string | null;
}

const KEY_PREFIX = 'lf.blindFocus:v1:';
const MAX_ACTIVE = 3;
const CHOICE_COUNT = 3;

function isComplete(kp: FocusKp): boolean {
  return kp.progress >= 100;
}

export function readBlindFocusRecords(learnerId: string): FocusRecord[] {
  try {
    const raw = window.localStorage.getItem(`${KEY_PREFIX}${learnerId}`);
    const parsed = raw ? JSON.parse(raw) as FocusRecord[] : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBlindFocusRecords(learnerId: string, records: FocusRecord[]): void {
  try {
    window.localStorage.setItem(`${KEY_PREFIX}${learnerId}`, JSON.stringify(records));
  } catch {
    /* ignore */
  }
}

function shuffle<T>(items: T[], nonce: number): T[] {
  const list = [...items];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.abs(Math.sin(nonce * 7919 + index * 137)) * (index + 1));
    [list[index], list[target]] = [list[target], list[index]];
  }
  return list;
}

export default function BlindFocusBoard({
  learnerId,
  pending,
  onStatsChange,
}: {
  learnerId: string;
  pending: FocusKp[];
  onStatsChange?: (stats: { active: number; resolved: number }) => void;
}) {
  const navigate = useNavigate();
  const [records, setRecords] = useState<FocusRecord[]>(() => readBlindFocusRecords(learnerId));
  const [shuffleNonce, setShuffleNonce] = useState(() => Date.now() % 997);

  const activeRecords = records.filter((record) => !record.resolvedAt);
  const candidatePool = pending.filter((kp) => !isComplete(kp) && !activeRecords.some((record) => record.kpId === kp.id));

  const suggestions = useMemo(
    () => shuffle(candidatePool, shuffleNonce).slice(0, CHOICE_COUNT),
    [candidatePool, shuffleNonce],
  );

  const stats = useMemo(
    () => ({
      active: activeRecords.length,
      resolved: records.filter((record) => Boolean(record.resolvedAt)).length,
    }),
    [records],
  );

  /* 依据真实学习进度自动消散：用户学完该知识点后无需手动勾选 */
  useEffect(() => {
    const now = new Date().toISOString();
    const pendingById = new Map(pending.map((kp) => [kp.id, kp]));
    const next = records.map((record) => {
      if (record.resolvedAt) return record;
      const kp = pendingById.get(record.kpId);
      return kp && isComplete(kp) ? { ...record, resolvedAt: now } : record;
    });
    const changed = next.some((record, index) => record.resolvedAt !== records[index]?.resolvedAt);
    if (changed) {
      writeBlindFocusRecords(learnerId, next);
      setRecords(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learnerId, pending, records]);

  useEffect(() => {
    onStatsChange?.({ active: stats.active, resolved: stats.resolved });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.active, stats.resolved]);

  const choose = (kp: FocusKp) => {
    if (activeRecords.length >= MAX_ACTIVE) {
      toast.info(`最多同时消解 ${MAX_ACTIVE} 个盲区`, { description: '完成当前目标或先取消一个，再新增下一个。' });
      return;
    }
    const now = new Date().toISOString();
    const next = [
      ...records.filter((record) => record.kpId !== kp.id || Boolean(record.resolvedAt)),
      { kpId: kp.id, name: kp.name, selectedAt: now, resolvedAt: null },
    ];
    writeBlindFocusRecords(learnerId, next);
    setRecords(next);
    toast.success(`已把「${kp.name}」设为盲区目标`, { description: '学完对应资源后会自动消散并计入看板。' });
  };

  const remove = (kpId: string) => {
    const next = records.filter((record) => record.kpId !== kpId || Boolean(record.resolvedAt));
    writeBlindFocusRecords(learnerId, next);
    setRecords(next);
  };

  return (
    <div className="lf-card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand-tint text-brand">
            <Crosshair size={18} />
          </span>
          <div>
            <div className="text-[15px] font-semibold text-ink">盲区选择</div>
            <p className="mt-0.5 text-[12px] leading-5 text-ink-muted">选几个最近要补的知识点，学完对应资源后自动消散并计入看板。</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShuffleNonce((value) => value + 1)}
          className="lf-btn-ghost !px-3 !py-1.5 text-[12px]"
        >
          <RefreshCw size={13} />
          换一批
        </button>
      </div>

      <div className="grid gap-0 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="border-b border-hairline p-5 lg:border-b-0 lg:border-r">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-medium text-ink">建议优先消解</span>
            <span className="font-mono text-[10.5px] text-ink-muted">{activeRecords.length}/{MAX_ACTIVE} 已选</span>
          </div>
          {suggestions.length === 0 ? (
            <div className="flex min-h-[112px] flex-col items-center justify-center rounded-[12px] border border-dashed border-hairline p-5 text-center">
              <Sparkles size={16} className="text-brand" />
              <p className="mt-2 text-[12.5px] text-ink-muted">暂时没有可选的待学知识点，先保持当前节奏即可。</p>
            </div>
          ) : (
            <div className="grid gap-2.5">
              {suggestions.map((kp) => {
                const active = activeRecords.some((record) => record.kpId === kp.id);
                const pct = Math.min(100, Math.round(kp.progress));
                return (
                  <div
                    key={kp.id}
                    className={cn(
                      'rounded-[12px] border p-3 transition-colors',
                      active ? 'border-brand/35 bg-brand-tint/45' : 'border-hairline bg-paper hover:border-brand/30 hover:bg-brand-tint/15',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <Target size={15} className="mt-0.5 shrink-0 text-brand" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[13.5px] font-medium text-ink">{kp.name}</span>
                          <span className="font-mono text-[10.5px] text-ink-muted tabular">{pct}%</span>
                        </div>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-paper-deep">
                          <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {active ? (
                          <button type="button" onClick={() => remove(kp.id)} className="lf-btn-ghost !px-2.5 !py-1 text-[11px]">
                            已选
                          </button>
                        ) : (
                          <button type="button" onClick={() => choose(kp)} className="lf-btn-primary !px-2.5 !py-1 text-[11px]">
                            设为盲区
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={`去学 ${kp.name}`}
                          onClick={() => navigate(learnMapPath(learnerId, kp.id))}
                          className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-hairline bg-paper text-ink-muted transition-colors hover:border-brand/40 hover:text-brand"
                        >
                          <ArrowRight size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-card-warm/70 p-5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-medium text-ink">正在消解</span>
            <span className="rounded-md border border-brand/30 bg-brand-tint px-1.5 py-0.5 font-mono text-[10.5px] text-brand">
              已消散 {stats.resolved}
            </span>
          </div>
          <div className="mt-3 h-[264px] space-y-2 overflow-y-auto pr-1">
            {activeRecords.length === 0 ? (
              <div className="rounded-[12px] border border-dashed border-hairline bg-paper p-4 text-[12px] leading-5 text-ink-muted">
                尚未选择盲区目标。建议先选一个最近要学的知识点，完成后这里会自动显示消散状态。
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {activeRecords.map((record) => {
                  const kp = pending.find((item) => item.id === record.kpId);
                  const pct = kp ? Math.min(100, Math.round(kp.progress)) : 100;
                  const done = Boolean(kp && isComplete(kp));
                  return (
                    <motion.div
                      key={record.kpId}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="rounded-[12px] border border-hairline bg-paper p-3"
                    >
                      <div className="flex items-center gap-2">
                        <CheckCircle2 size={15} className={done ? 'text-brand' : 'text-ink-muted'} />
                        <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', done ? 'text-brand' : 'text-ink')}>
                          {record.name}
                        </span>
                        <span className="font-mono text-[10.5px] text-ink-muted tabular">{pct}%</span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-deep">
                          <div className="h-full rounded-full bg-gradient-to-r from-brand-amber to-brand" style={{ width: `${pct}%` }} />
                        </div>
                        {done ? (
                          <span className="rounded-md border border-brand/30 bg-brand-tint px-1.5 py-0.5 font-mono text-[10px] text-brand">已消散</span>
                        ) : (
                          <button type="button" onClick={() => remove(record.kpId)} className="rounded-md border border-hairline px-1.5 py-0.5 text-[10.5px] text-ink-muted hover:text-brand">
                            取消
                          </button>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
