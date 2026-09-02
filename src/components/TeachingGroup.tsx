/**
 * TeachingGroup — 「AI 教研组」按需浮层（透明层）
 * 学习者视角下，多智能体协同/辩论/溯源不再是一级页面，而是伴随学习的证据：
 * 随时点开即可看到 5 位 Agent 正在为「我」做什么，想深入再进「系统透视」的完整协同页。
 *
 * 自带触发按钮，可放侧栏(variant=sidebar)或行内(variant=pill)。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, ArrowRight, ShieldCheck, Database, ChevronRight } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { agents } from '@/data/agents';
import type { AgentId } from '@/data/agents';
import { coreMetrics } from '@/data/metrics';
import { useProfile } from '@/context/ProfileContext';
import { AgentIcon } from '@/components/AgentChip';
import LiveDot from '@/components/LiveDot';
import { cn } from '@/lib/utils';

/** 每个 Agent 面向学习者的「此刻在做什么」一句话（软化技术黑话） */
const nowDoing: Record<AgentId, string> = {
  'DIA-01': '读你的理论测试与作答，锁定当前最该补的盲区',
  'RET-02': '从 2,356 条国标/行标切片里挑出最权威的依据',
  'GEN-03': '照你的水平重写讲义与题目，每句都挂出处',
  'VER-04': '逐句核对事实与引用，查不到出处的直接打回',
  'ARB-05': '按你的答题对错，决定给你降维解释还是进阶挑战',
};

export default function TeachingGroup({
  variant = 'pill',
  collapsed = false,
}: {
  variant?: 'sidebar' | 'pill' | 'compact';
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { currentLearner } = useProfile();

  const halluc = coreMetrics.find((m) => m.id === 'hallucination');

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  return (
    <>
      {/* ===== 触发器 ===== */}
      {variant === 'sidebar' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="AI 教研组"
          className={cn(
            'group flex w-full items-center gap-3 rounded-[12px] border border-brand/25 bg-brand-tint/60 px-3 py-2.5 text-left transition-all duration-200 ease-lf hover:border-brand/45 hover:bg-brand-tint',
            collapsed && 'justify-center px-0',
          )}
        >
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-brand text-paper">
            <Sparkles size={16} />
            <span className="absolute -right-0.5 -top-0.5">
              <LiveDot status="running" />
            </span>
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold text-brand">AI 教研组</span>
              <span className="block truncate text-[11px] text-ink-muted">5 位智能体在线备课</span>
            </span>
          )}
        </button>
      ) : variant === 'compact' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="AI 教研组"
          className="inline-flex items-center gap-1.5 rounded-[10px] border border-brand/30 bg-brand-tint/60 px-2.5 py-1.5 text-[13px] font-medium text-brand transition-all duration-200 hover:border-brand/55 hover:bg-brand-tint"
        >
          <Sparkles size={14} />
          <span className="hidden lg:inline">AI 教研组</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 rounded-[10px] border border-brand/30 bg-brand-tint/60 px-3 py-1.5 text-[13px] font-medium text-brand transition-all duration-200 hover:border-brand/55 hover:bg-brand-tint"
        >
          <Sparkles size={14} />
          看 AI 如何为我备课
        </button>
      )}

      {/* ===== 浮层 ===== */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full gap-0 border-hairline bg-paper p-0 sm:max-w-md"
        >
          <SheetHeader className="border-b border-hairline bg-card-warm px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand text-paper">
                <Sparkles size={18} />
              </span>
              <div>
                <SheetTitle className="font-serif text-[17px] text-ink">AI 教研组</SheetTitle>
                <SheetDescription className="text-[12px] text-ink-muted">
                  5 位智能体正在协同，为 {currentLearner.name} 定制学习内容
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>

          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {/* 幻觉防控小结 */}
            <div className="flex items-center gap-3 rounded-[12px] border border-brand-amber/40 bg-brand-amber-tint/60 px-4 py-3">
              <ShieldCheck size={20} className="shrink-0 text-ochre" />
              <p className="text-[12.5px] leading-[19px] text-ink-2">
                每条内容都经<span className="font-semibold text-ochre">交叉验证</span>并挂接出处，
                当前幻觉率仅 <span className="font-mono font-semibold text-ochre">{halluc?.value}%</span>
                （参考线 &lt; 5%）。
              </p>
            </div>

            {/* 5 Agent 此刻在做什么 */}
            <div>
              <div className="lf-mono-label mb-2.5">正在为你做的事</div>
              <div className="space-y-2">
                {agents.map((a, i) => (
                  <div
                    key={a.id}
                    className="lf-anim-in-up flex items-start gap-3 rounded-[12px] border border-hairline bg-card-warm p-3"
                    style={{ animationDelay: `${i * 60}ms` }}
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border"
                      style={{ backgroundColor: `${a.color}14`, borderColor: `${a.color}45` }}
                    >
                      <AgentIcon agent={a} size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold text-ink">{a.name}</span>
                        <span
                          className="font-mono text-[10px] font-medium"
                          style={{ color: a.color }}
                        >
                          {a.code}
                        </span>
                        <LiveDot status="running" className="ml-auto" />
                      </div>
                      <p className="mt-0.5 text-[12px] leading-[18px] text-ink-muted">
                        {nowDoing[a.id]}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 底部：深入入口 */}
          <div className="space-y-2 border-t border-hairline bg-card-warm px-5 py-4">
            <button
              type="button"
              onClick={() => go('/agents?autoplay=1')}
              className="lf-btn-primary w-full !py-2.5 text-[14px]"
            >
              看 AI 完整协同与辩论过程
              <ArrowRight size={15} />
            </button>
            <button
              type="button"
              onClick={() => go('/knowledge')}
              className="flex w-full items-center justify-center gap-2 rounded-[10px] px-4 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:bg-paper-deep hover:text-ink"
            >
              <Database size={14} />
              浏览它引用的知识库
              <ChevronRight size={14} className="text-ink-muted" />
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
