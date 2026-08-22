import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  Database,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, type LearnerProfileData, type RagDomain } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';

type AdminSection = 'overview' | 'learners' | 'knowledge';

const nav: { id: AdminSection; label: string; description: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: '工作台总览', description: '平台运行与内容概况', icon: LayoutDashboard },
  { id: 'learners', label: '学习者管理', description: '查看与维护学习者画像', icon: Users },
  { id: 'knowledge', label: '知识库管理', description: '知识域与内容入口', icon: Database },
];

function StatusPill({ ok, children }: { ok: boolean; children: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium', ok ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700')}>
      <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-emerald-500' : 'bg-amber-500')} />
      {children}
    </span>
  );
}

function Metric({ label, value, hint, icon: Icon }: { label: string; value: string | number; hint: string; icon: typeof Users }) {
  return (
    <div className="rounded-2xl border border-hairline bg-card-warm p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[12px] text-ink-muted">{label}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-tint text-brand"><Icon size={16} /></span>
      </div>
      <div className="mt-4 font-serif text-[30px] font-semibold tracking-tight text-ink">{value}</div>
      <p className="mt-1 text-[11px] text-ink-muted">{hint}</p>
    </div>
  );
}

function LearnerTable({ learners, onEdit }: { learners: LearnerProfileData[]; onEdit: (learner: LearnerProfileData) => void }) {
  if (!learners.length) return <div className="rounded-2xl border border-dashed border-hairline p-10 text-center text-[13px] text-ink-muted">当前账号没有可管理的学习者数据。</div>;
  return (
    <div className="overflow-hidden rounded-2xl border border-hairline bg-card-warm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-[13px]">
          <thead className="border-b border-hairline bg-paper-deep text-[11px] text-ink-muted">
            <tr><th className="px-5 py-3 font-medium">学习者</th><th className="px-5 py-3 font-medium">身份 / 目标</th><th className="px-5 py-3 font-medium">掌握度</th><th className="px-5 py-3 font-medium">更新时间</th><th className="px-5 py-3 text-right font-medium">操作</th></tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {learners.map((learner) => (
              <tr key={learner.id} className="transition-colors hover:bg-paper/70">
                <td className="px-5 py-4"><div className="font-medium text-ink">{learner.name || '未命名学习者'}</div><div className="mt-0.5 font-mono text-[10px] text-ink-muted">{learner.code || learner.id.slice(0, 8)}</div></td>
                <td className="px-5 py-4"><div className="text-ink-2">{learner.role || '未设置角色'}</div><div className="mt-0.5 text-[11px] text-ink-muted">{learner.targetJob || learner.education || '未设置目标'}</div></td>
                <td className="px-5 py-4"><div className="flex items-center gap-2"><div className="h-1.5 w-20 overflow-hidden rounded-full bg-paper-deep"><div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, Math.max(0, learner.overallMastery || 0))}%` }} /></div><span className="font-mono text-[11px] text-ink-2">{Math.round(learner.overallMastery || 0)}%</span></div></td>
                <td className="px-5 py-4 text-[11px] text-ink-muted">{learner.updatedAt ? new Date(learner.updatedAt).toLocaleDateString('zh-CN') : '—'}</td>
                <td className="px-5 py-4 text-right"><button type="button" onClick={() => onEdit(learner)} className="rounded-lg border border-hairline px-3 py-1.5 text-[11px] text-ink-2 transition hover:border-brand/40 hover:text-brand">编辑画像</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EditLearner({ learner, onClose, onSaved }: { learner: LearnerProfileData; onClose: () => void; onSaved: (learner: LearnerProfileData) => void }) {
  const [name, setName] = useState(learner.name || '');
  const [role, setRole] = useState(learner.role || '');
  const [targetJob, setTargetJob] = useState(learner.targetJob || '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try { onSaved(await api.updateLearner(learner.id, { name, role, targetJob })); toast.success('学习者画像已保存'); onClose(); }
    catch (error) { toast.error(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="编辑学习者画像">
    <div className="w-full max-w-md rounded-2xl border border-hairline bg-paper p-6 shadow-2xl"><div className="flex items-start justify-between"><div><p className="lf-mono-label">LEARNER PROFILE</p><h2 className="mt-1 font-serif text-xl font-semibold text-ink">编辑学习者画像</h2></div><button type="button" onClick={onClose} className="rounded-lg p-2 text-ink-muted hover:bg-paper-deep" aria-label="关闭"><X size={17} /></button></div><div className="mt-6 space-y-4">{[['姓名', name, setName], ['角色', role, setRole], ['目标方向', targetJob, setTargetJob]].map(([label, value, setValue]) => <label key={label as string} className="block"><span className="mb-1.5 block text-[12px] text-ink-muted">{label as string}</span><input value={value as string} onChange={(event) => (setValue as (value: string) => void)(event.target.value)} className="h-10 w-full rounded-xl border border-hairline bg-card-warm px-3 text-[13px] text-ink outline-none transition focus:border-brand/50" /></label>)}</div><div className="mt-7 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-xl px-4 py-2 text-[12px] text-ink-muted hover:bg-paper-deep">取消</button><button type="button" disabled={saving} onClick={() => void save()} className="rounded-xl bg-brand px-4 py-2 text-[12px] font-medium text-paper disabled:opacity-50">{saving ? '保存中…' : '保存修改'}</button></div></div>
  </div>;
}

export default function Admin() {
  const location = useLocation();
  const { session, logout } = useAuth();
  const [learners, setLearners] = useState<LearnerProfileData[]>([]);
  const [domains, setDomains] = useState<RagDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LearnerProfileData | null>(null);
  const section = (location.pathname.split('/')[2] as AdminSection) || 'overview';
  const active = nav.some((item) => item.id === section) ? section : 'overview';
  const load = async () => { setLoading(true); setError(null); try { const [nextLearners, nextDomains] = await Promise.all([api.listLearners(), api.listRagDomains()]); setLearners(nextLearners); setDomains(nextDomains); } catch (reason) { setError(reason instanceof Error ? reason.message : '管理员数据读取失败'); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);
  const averageMastery = useMemo(() => learners.length ? Math.round(learners.reduce((sum, item) => sum + (item.overallMastery || 0), 0) / learners.length) : 0, [learners]);
  const title = nav.find((item) => item.id === active)?.label || '工作台总览';
  return <div className="min-h-[100dvh] bg-paper text-ink"><aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col border-r border-hairline bg-paper lg:flex"><Link to="/admin" className="flex h-16 items-center gap-2.5 border-b border-hairline px-5"><img src="/logo.svg" alt="智训云枢" className="h-8 w-8" /><span><span className="block font-serif text-[17px] font-bold">智训云枢</span><span className="font-mono text-[10px] tracking-wider text-ink-muted">ADMIN CONSOLE</span></span></Link><nav className="flex-1 space-y-1 px-3 py-5">{nav.map(({ id, label, description, icon: Icon }) => <NavLink key={id} to={`/admin/${id}`} className={({ isActive }) => cn('group flex items-center gap-3 rounded-xl px-3 py-3 transition', isActive ? 'bg-brand-tint text-brand' : 'text-ink-2 hover:bg-paper-deep')}><Icon size={18} /><span className="min-w-0"><span className="block text-[13px] font-medium">{label}</span><span className="mt-0.5 block truncate text-[10px] text-ink-muted group-[.text-brand]:text-brand/70">{description}</span></span><ChevronRight size={14} className="ml-auto opacity-40" /></NavLink>)}</nav><div className="border-t border-hairline p-4"><div className="rounded-xl bg-card-warm p-3"><div className="flex items-center gap-2 text-[12px] font-medium"><ShieldCheck size={15} className="text-brand" />管理员端</div><p className="mt-1 truncate text-[10px] text-ink-muted">{session?.label || session?.account || '当前账号'}</p></div><Link to="/me" className="mt-3 flex items-center gap-2 px-1 text-[11px] text-ink-muted hover:text-brand"><ArrowUpRight size={13} />返回学习者端</Link><button type="button" onClick={logout} className="mt-3 flex items-center gap-2 px-1 text-[11px] text-ink-muted hover:text-brand"><LogOut size={13} />退出登录</button></div></aside><main className="lg:pl-[248px]"><header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-hairline bg-paper/90 px-5 backdrop-blur-md md:px-8"><div><p className="lf-mono-label">ADMIN / {active.toUpperCase()}</p><h1 className="mt-1 font-serif text-xl font-semibold">{title}</h1></div><div className="flex items-center gap-2"><StatusPill ok={!error}>{error ? '接口异常' : '数据连接正常'}</StatusPill><button type="button" onClick={() => void load()} disabled={loading} className="flex h-9 items-center gap-1.5 rounded-lg border border-hairline bg-card-warm px-3 text-[11px] text-ink-2 hover:border-brand/40 disabled:opacity-50"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} />刷新</button></div></header><div className="mx-auto max-w-[1280px] p-5 md:p-8">{error && <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-800">{error}。当前页面只展示已成功读取的数据。</div>}{active === 'overview' && <><div className="mb-7"><h2 className="font-serif text-2xl font-semibold">平台概况</h2><p className="mt-1 text-[13px] text-ink-muted">管理员可以从这里确认学习者、知识库和服务接入状态。</p></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="学习者" value={loading ? '—' : learners.length} hint="当前账号可见的画像数量" icon={Users} /><Metric label="平均掌握度" value={loading ? '—' : `${averageMastery}%`} hint="来自学习者真实画像" icon={Activity} /><Metric label="知识域" value={loading ? '—' : domains.length} hint="后端知识库域数量" icon={Database} /><Metric label="管理员权限" value="已登录" hint="最终写权限由后端校验" icon={ShieldCheck} /></div><div className="mt-6 grid gap-5 xl:grid-cols-[1.3fr_1fr]"><section className="rounded-2xl border border-hairline bg-card-warm p-5"><div className="flex items-center justify-between"><div><h3 className="font-serif text-lg font-semibold">管理模块</h3><p className="mt-1 text-[12px] text-ink-muted">按业务域进入具体管理页面</p></div><BookOpen size={19} className="text-brand" /></div><div className="mt-5 grid gap-3 sm:grid-cols-2">{nav.slice(1).map(({ id, label, description, icon: Icon }) => <Link key={id} to={`/admin/${id}`} className="group rounded-xl border border-hairline bg-paper p-4 transition hover:-translate-y-0.5 hover:border-brand/35"><Icon size={17} className="text-brand" /><div className="mt-3 text-[13px] font-medium">{label}</div><p className="mt-1 text-[11px] leading-5 text-ink-muted">{description}</p><span className="mt-3 inline-flex items-center gap-1 text-[11px] text-brand">进入管理 <ArrowUpRight size={12} /></span></Link>)}</div></section><section className="rounded-2xl border border-hairline bg-card-warm p-5"><h3 className="font-serif text-lg font-semibold">接入状态</h3><p className="mt-1 text-[12px] text-ink-muted">当前版本的能力边界</p><div className="mt-5 space-y-3">{[['学习者与画像', learners.length > 0 || !loading, '已接入真实接口'], ['知识域读取', domains.length > 0 || !loading, '已接入真实接口'], ['题库审核', false, '待 QuestionBank 后端接入'], ['图谱审核', false, '待 KnowledgeCore 管理 API 接入'], ['预处理任务', false, '待 predeal 管理 API 接入']].map(([label, ok, detail]) => <div key={label as string} className="flex items-center justify-between gap-3 rounded-xl border border-hairline bg-paper px-3.5 py-3"><span className="text-[12px] text-ink-2">{label as string}</span><span className={cn('text-right text-[10px]', ok ? 'text-emerald-700' : 'text-ink-muted')}>{detail as string}</span></div>)}</div></section></div></>}{active === 'learners' && <><div className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><h2 className="font-serif text-2xl font-semibold">学习者管理</h2><p className="mt-1 text-[13px] text-ink-muted">查看当前管理员账号可见的学习者画像，并维护基础字段。</p></div><span className="text-[11px] text-ink-muted">{learners.length} 个画像</span></div><LearnerTable learners={learners} onEdit={setEditing} /></>}{active === 'knowledge' && <><div className="mb-6"><h2 className="font-serif text-2xl font-semibold">知识库管理</h2><p className="mt-1 text-[13px] text-ink-muted">先从知识域确认后端内容边界；题库、图谱审核会在管理 API 接入后开放。</p></div><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{domains.map((domain) => <div key={domain.code} className="rounded-2xl border border-hairline bg-card-warm p-5"><div className="flex items-start justify-between gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-tint text-brand"><Database size={17} /></span><StatusPill ok>已连接</StatusPill></div><h3 className="mt-4 font-serif text-lg font-semibold">{domain.name}</h3><p className="mt-1 font-mono text-[10px] text-ink-muted">{domain.code}</p><Link to="/knowledge" className="mt-5 inline-flex items-center gap-1 text-[11px] text-brand hover:underline">查看知识库 <ArrowUpRight size={12} /></Link></div>)}{!loading && !domains.length && <div className="rounded-2xl border border-dashed border-hairline p-10 text-center text-[13px] text-ink-muted">后端暂未返回知识域。</div>}</div></>}{editing && <EditLearner learner={editing} onClose={() => setEditing(null)} onSaved={(updated) => setLearners((items) => items.map((item) => item.id === updated.id ? updated : item))} />}</div></main></div>;
}
