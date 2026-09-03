import { Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import { api, type AdminAccount, type AdminAccountPage } from '@/lib/api';
import { useCachedData } from '@/hooks/useCachedData';

export default function InstitutionUsers() {
  const q = useCachedData<AdminAccountPage>('admin:accounts', () => api.listAdminAccounts(), { ttlMs: 15_000 });
  const items = q.data?.items ?? [];
  const total = q.data?.totalElements ?? 0;
  const loading = q.loading;
  const [busyId, setBusyId] = useState<string | null>(null);
  const toggle = async (item: AdminAccount) => {
    try {
      await api.setAdminAccountEnabled(item.id, !item.active);
      toast.success(item.active ? '账号已停用' : '账号已启用');
      await q.refresh(true);
    } catch (e) { toast.error(e instanceof Error ? e.message : '操作失败'); }
  };
  const reset = async (item: AdminAccount) => {
    if (!window.confirm(`确定重置“${item.email}”的使用记录吗？\n\n将清空画像、学习进度、已生成资源、会话与记忆，账号本身保留；该账号下次登录会重新进入画像建档。`)) return;
    setBusyId(item.id);
    try {
      await api.resetAdminUser(item.id);
      toast.success('使用记录已重置');
      await q.refresh(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '重置失败');
    } finally {
      setBusyId(null);
    }
  };
  return (
    <div className="lf-anim-in-up">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">机构用户</h2>
          <p className="mt-1.5 text-sm text-ink-muted">管理本机构注册账号的启用状态。</p>
        </div>
        <div className="flex items-center gap-2">
          {q.refreshing && <span className="text-[11px] text-ink-muted">更新中…</span>}
          <span className="lf-pill lf-pill-null">共 {total} 个账号</span>
        </div>
      </div>
      <div className="lf-table-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr>
                <th className="px-4 py-3.5">账号</th>
                <th className="px-4 py-3.5">昵称</th>
                <th className="px-4 py-3.5">类型</th>
                <th className="px-4 py-3.5">状态</th>
                <th className="px-4 py-3.5">创建时间</th>
                <th className="px-4 py-3.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-3.5 font-semibold text-ink">{item.email}</td>
                  <td className="px-4 py-3.5 text-ink-2">{item.nickname || '—'}</td>
                  <td className="px-4 py-3.5 text-ink-2">{item.accountType === 'ADMIN' ? '管理员/教师' : '学习者'}</td>
                  <td className="px-4 py-3.5">
                    <span className={'lf-pill ' + (item.active ? 'lf-pill-ok' : 'lf-pill-null')}>{item.active ? '正常' : '已停用'}</span>
                  </td>
                  <td className="px-4 py-3.5 text-xs text-ink-muted">{new Date(item.createdAt).toLocaleDateString('zh-CN')}</td>
                  <td className="px-4 py-3.5 text-right">
                    <button onClick={() => void toggle(item)} className="lf-row-btn">
                      {item.active ? '停用' : '启用'}
                    </button>
                    {item.accountType !== 'ADMIN' && (
                      <button
                        disabled={busyId === item.id}
                        onClick={() => void reset(item)}
                        className="lf-row-btn text-ochre disabled:cursor-default disabled:opacity-50"
                        title="重置学习记录，恢复为注册后状态"
                      >
                        {busyId === item.id ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                        重置为新人
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && <div className="flex justify-center py-12 text-sm text-ink-muted"><Loader2 className="mr-2 animate-spin" size={16} />加载中…</div>}
        {!loading && !items.length && <div className="lf-empty m-4 py-12 text-center text-sm">暂无账号</div>}
      </div>
    </div>
  );
}
