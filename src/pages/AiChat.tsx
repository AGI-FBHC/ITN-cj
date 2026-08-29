/**
 * AiChat — 全屏 AI 对话页面
 *
 * 左栏：会话列表  右栏：ChatStream 消息流
 * 从 AgentDock 侧边栏的"全屏"按钮进入。
 */
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Brain } from 'lucide-react';
import { ChatStream, SessionList } from '@/components/agent/ChatStream';

export default function AiChat() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex h-[calc(100dvh-80px)] max-w-[1200px] gap-3 overflow-hidden px-4 pb-2 pt-2">
      {/* 左栏：会话列表 */}
      <aside className="hidden w-[240px] shrink-0 flex-col overflow-hidden rounded-2xl border border-hairline bg-paper/60 lg:flex">
        <SessionList />
      </aside>

      {/* 右栏：消息流 + composer */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hairline bg-paper/60">
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-4 py-2.5">
          <button type="button" onClick={() => navigate(-1)} className="lf-row-btn !p-1.5">
            <ArrowLeft size={14} />
          </button>
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-paper">
            <Brain size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-ink">阿诊 · AI 学习助手</p>
            <p className="text-[10px] text-ink-muted">DIA-01 学情诊断</p>
          </div>
        </div>
        <ChatStream />
      </main>
    </div>
  );
}
