/**
 * RootErrorBoundary — 根级错误兜底
 * 任何未捕获的渲染错误都不再白屏，而是给出「刷新 / 清空本地数据」的自救出口
 * （典型场景：同源旧项目遗留的 localStorage 脏数据）
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { resetLocalData } from '@/lib/storageGuard';

interface State {
  error: Error | null;
}

export default class RootErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[RootErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const isChunkError = /Failed to fetch dynamically imported module|Importing a module script failed/i.test(this.state.error.message);
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-paper px-6">
        <div className="w-full max-w-[440px] rounded-[16px] border border-hairline bg-card-warm p-8 text-center shadow-warm">
          <div className="font-serif text-[22px] font-bold text-ink">页面出错了</div>
          <p className="mt-3 text-[13.5px] leading-[22px] text-ink-muted">
            {isChunkError
              ? '页面刚刚更新，旧资源已失效。刷新一次即可继续，不会丢失登录状态。'
              : '渲染过程中发生异常。若你此前在本机运行过其他版本的演示系统，多半是浏览器里遗留的旧数据不兼容导致——清空本地演示数据即可恢复。'}
          </p>
          <p className="mt-2 break-all rounded-[8px] bg-paper px-3 py-2 text-left font-mono text-[10.5px] leading-[16px] text-ink-muted">
            {this.state.error.message}
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-[10px] border border-hairline bg-paper px-4 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:border-brand/40"
            >
              刷新页面
            </button>
            {!isChunkError && (
              <button
                type="button"
                onClick={resetLocalData}
                className="rounded-[10px] bg-brand px-4 py-2 text-[13px] font-semibold text-paper transition-colors hover:bg-brand-hover"
              >
                清空本地数据并刷新
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
