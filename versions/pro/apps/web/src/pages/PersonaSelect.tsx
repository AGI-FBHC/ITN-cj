/**
 * 游客体验 `/persona` — 三个预建画像，选一个以游客身份进入系统
 * 画像决定讲解深度、实操方式与推荐路径
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Loader2, Sprout, Brain, Rocket } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

type Persona = {
  id: string;
  label: string;
  desc: string;
  detail: string;
  icon: typeof Sprout;
  evaluation: string;
  gradient: string;
  borderColor: string;
  accentText: string;
};

const PERSONAS: Persona[] = [
  {
    id: 'beginner',
    label: '小明 · 零基础探索者',
    desc: '本科在校生 · 目标 Agent 工程师',
    detail: '会基础编程，但尚未系统接触 Agent。希望先听懂核心概念，再通过分步操作完成第一个工具调用应用。',
    icon: Sprout,
    evaluation: '多类比、术语解释、图示与分步实操',
    gradient: 'from-green-50 to-emerald-50',
    borderColor: 'border-green-200',
    accentText: 'text-green-600',
  },
  {
    id: 'research',
    label: '小智 · 研究进阶者',
    desc: '硕士在校生 · 目标多智能体开发工程师',
    detail: '具备 Agent 理论和系统设计基础，希望重点强化复杂流程推理、问题诊断与证据分析能力。',
    icon: Brain,
    evaluation: '原理分析、架构推演、故障诊断与证据对比',
    gradient: 'from-violet-50 to-indigo-50',
    borderColor: 'border-violet-200',
    accentText: 'text-violet-700',
  },
  {
    id: 'practitioner',
    label: '小李 · 工程实践者',
    desc: '后端工程师 · 目标 RAG 应用工程师',
    detail: '有 3—5 年开发经验并做过简单 RAG 应用，希望补齐评估、多智能体协作和工程化方法。',
    icon: Rocket,
    evaluation: '代码案例、RAG 实操、部署排错与项目任务',
    gradient: 'from-blue-50 to-indigo-50',
    borderColor: 'border-blue-200',
    accentText: 'text-blue-600',
  },
];

export default function PersonaSelect() {
  const navigate = useNavigate();
  const { loginRemote } = useAuth();
  const [busyId, setBusyId] = useState<string | null>(null);

  /* 预取进入后的建档页：登录只需一次请求，点选后立即切页，不再等代码分包下载 */
  useEffect(() => {
    void import('@/pages/Welcome');
  }, []);

  const enter = async (persona: Persona) => {
    setBusyId(persona.id);
    try {
      const ok = await loginRemote('guest', `guest:${persona.id}`, persona.label);
      if (ok) {
        navigate('/welcome', { replace: true });
      } else {
        toast.error('登录失败，请稍后重试');
      }
    } catch {
      toast.error('登录失败，请稍后重试');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-paper">
      <div className="flex items-center border-b border-hairline px-6 py-4">
        <button type="button" onClick={() => navigate('/login', { replace: true })} className="mr-3 text-[13px] text-ink-muted hover:text-ink">
          ← 返回登录
        </button>
        <h1 className="font-serif text-[18px] font-bold text-ink">选择体验角色</h1>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[780px]">
          <p className="mb-8 text-center text-[14px] text-ink-muted">
            选择一个学习者画像进入系统，讲解深度、实操方式与推荐路径会随画像调整
          </p>
          <div className="grid gap-5 sm:grid-cols-3">
            {PERSONAS.map((persona, index) => {
              const Icon = persona.icon;
              return (
              <motion.button
                key={persona.id}
                type="button"
                disabled={busyId !== null}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                onClick={() => enter(persona)}
                className={`group flex flex-col items-start rounded-[16px] border ${persona.borderColor} bg-gradient-to-br ${persona.gradient} p-6 text-left transition-all hover:border-brand/40 hover:shadow-lg disabled:opacity-60`}
              >
                <span className="mb-4 text-brand"><Icon size={34} strokeWidth={1.6} /></span>
                <div className="mb-1 text-[16px] font-semibold text-ink">{persona.label}</div>
                <div className="mb-4 text-[13px] text-ink-muted">{persona.desc}</div>
                <div className="mb-4 text-[12px] leading-[19px] text-ink-2">{persona.detail}</div>
                <div className={`mt-auto w-full rounded-[10px] bg-white/70 px-3 py-2.5 text-[11px] ${persona.accentText}`}>
                  <span className="font-semibold">画像评价：</span>
                  {persona.evaluation}
                </div>
                {busyId === persona.id && (
                  <div className="mt-3 flex items-center gap-1.5 text-[12px] text-ink-muted">
                    <Loader2 size={13} className="animate-spin" />
                    正在进入…
                  </div>
                )}
              </motion.button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
