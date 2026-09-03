/**
 * AppShell — 应用外壳（双模式 · 双布局）
 * 学习者视角(learner)：顶部导航外壳（logo + 居中 4 站 + AI 教研组 + 画像 + 模式）；移动端底部 tab；内容单列。
 * 系统透视(expert / 评委模式)：左侧栏仪表盘（完整 7 页分组 + 时钟 + 引擎 ticker + 演示模式）。
 * 两种视角是两种布局形态——学习 App vs 控制台。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Home,
  BookOpen,
  MessagesSquare,
  BarChart3,
  LayoutDashboard,
  Users,
  Network,
  PenLine,
  Database,
  PanelLeftClose,
  PanelLeftOpen,
  NotebookPen,
  LogOut,
  Compass,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

import { Switch } from '@/components/ui/switch';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useProfile } from '@/context/ProfileContext';
import { useAuth } from '@/context/AuthContext';
import { useNotes } from '@/context/NotesContext';
import { useGrowth } from '@/context/GrowthContext';
import { api, type OrganizationBranding } from '@/lib/api';
import { useCachedData } from '@/hooks/useCachedData';
import { kbSlices } from '@/data/kbSlices';
import { resources } from '@/data/resources';
import { globalStats } from '@/data/metrics';
import LiveDot from './LiveDot';
import KBDrawer from './KBDrawer';
import AgentDock from './agent/AgentDock';
import ResumeLearningFab from './ResumeLearningFab';
import { SparkField } from './heal/Flora';
import DemoTour, { startDemoTour } from './tour/DemoTour';
import { cn } from '@/lib/utils';

type NavItem = {
  path: string;
  label: string;
  sub?: string;
  icon: typeof Home;
  end?: boolean;
};

/** 学习者视角：3 站旅程（学练一体改版：原「学」「练」两页合并为一站） */
const learnerNav: NavItem[] = [
  { path: '/me', label: '我的学习', icon: Home, end: true },
  { path: '/learn', label: '学 · 练', icon: BookOpen },
  { path: '/report', label: '我的成长', icon: BarChart3 },
];

/** 系统透视 / 评委视角：完整 7 页，分组呈现 */
const expertNavGroups: { heading?: string; items: NavItem[] }[] = [
  {
    items: [{ path: '/', label: '总览 Dashboard', icon: LayoutDashboard, end: true }],
  },
  {
    heading: '学习流程',
    items: [
      { path: '/profiles', label: '学情画像', icon: Users },
      { path: '/resources', label: '资源生成', icon: PenLine },
      { path: '/tutoring', label: '交互导学', icon: MessagesSquare },
      { path: '/report', label: '学情报告', icon: BarChart3 },
    ],
  },
  {
    heading: 'AI 引擎',
    items: [
      { path: '/agents', label: '协同调度', icon: Network },
      { path: '/knowledge', label: '知识库', icon: Database },
    ],
  },
];

const pageTitleMap: Record<string, { title: string; crumb: string }> = {
  '/': { title: '总览 Dashboard', crumb: 'LEARNFORGE / OVERVIEW' },
  '/me': { title: '我的学习', crumb: 'LEARNFORGE / MY LEARNING' },
  '/learn': { title: '学 · 练 · 我的课程', crumb: 'LEARNFORGE / COURSE' },
  '/profiles': { title: '学情画像', crumb: 'LEARNFORGE / PROFILES' },
  '/agents': { title: '多智能体协同调度', crumb: 'LEARNFORGE / AGENTS' },
  '/resources': { title: '个性化资源生成', crumb: 'LEARNFORGE / RESOURCES' },
  '/report': { title: '学情报告', crumb: 'LEARNFORGE / REPORT' },
  '/tutoring': { title: '交互导学', crumb: 'LEARNFORGE / TUTORING' },
  '/knowledge': { title: '知识库', crumb: 'LEARNFORGE / KNOWLEDGE' },
};

/** 实时时钟 mono HH:MM:SS 每秒走动（仅系统透视） */
function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const text = now.toLocaleTimeString('zh-CN', { hour12: false });
  return (
    <span className="hidden h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-hairline bg-paper px-2 font-mono text-[12px] font-medium text-ink-2 tabular lg:inline-flex">
      <span className="h-1.5 w-1.5 rounded-full bg-brand-amber" />
      {text}
    </span>
  );
}

/** 侧栏导航项（系统透视用） */
function SideNavRow({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  return (
    <NavLink
      to={item.path}
      end={item.end}
      title={item.label}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[14px] font-medium transition-all duration-200 ease-lf',
          collapsed && 'justify-center px-0',
          isActive ? 'bg-brand-tint text-brand' : 'text-ink-2 hover:bg-paper-deep hover:text-ink',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              'absolute left-0 top-1/2 h-[22px] w-[3px] -translate-y-1/2 rounded-r-full bg-brand transition-opacity duration-200',
              isActive ? 'opacity-100' : 'opacity-0',
            )}
          />
          <item.icon
            size={18}
            strokeWidth={1.75}
            className={cn('shrink-0', isActive ? 'text-brand' : 'text-ink-muted group-hover:text-ink')}
          />
          {!collapsed && item.label}
        </>
      )}
    </NavLink>
  );
}

export default function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerKb, setDrawerKb] = useState<string | null>(null);
  const {
    currentLearner,
    demoMode,
    setDemoMode,
    viewMode,
  } = useProfile();
  const { notes } = useNotes();
  const { focusMode } = useGrowth();
  const { logout } = useAuth();
  const orgBranding = useCachedData<OrganizationBranding>(
    'learner:organizationBranding',
    () => api.getOrganizationBranding(),
    { ttlMs: 5 * 60_000 },
  );
  const orgShortName = orgBranding.data?.shortName?.trim() || null;
  const location = useLocation();
  const isSlideMode = location.pathname.startsWith('/learn/slide/');
  const navigate = useNavigate();
  const isLearner = viewMode === 'learner';

  const doLogout = () => {
    logout();
    toast('已退出登录', { description: '画像与学习记录都留在本机，下次登录接着用' });
    navigate('/login');
  };

  const base = useMemo(() => '/' + (location.pathname.split('/')[1] ?? ''), [location.pathname]);
  const pageInfo = pageTitleMap[base] ?? pageTitleMap['/me'];

  /* 学习者视角进入根路径 → 落到「我的学习」 */
  useEffect(() => {
    if (isLearner && location.pathname === '/') navigate('/me', { replace: true });
  }, [isLearner, location.pathname, navigate]);

  /* 交互导学是沉浸式对话页：进入自动收起侧栏让位给对话区，离开时恢复原状 */
  const collapsedBeforeTutoringRef = useRef<boolean | null>(null);
  const onTutoring = base === '/tutoring';
  useEffect(() => {
    if (onTutoring) {
      collapsedBeforeTutoringRef.current = collapsed;
      setCollapsed(true);
    } else if (collapsedBeforeTutoringRef.current !== null) {
      setCollapsed(collapsedBeforeTutoringRef.current);
      collapsedBeforeTutoringRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onTutoring]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {isLearner ? (
        /* ==================== 学习者：顶部导航外壳（专注模式收起全部 chrome） ==================== */
        <div className="flex min-h-[100dvh] flex-col">
          {/* 漂浮微光（治愈氛围，专注时收起） */}
          {!(focusMode || isSlideMode) && <SparkField />}
          {/* 顶栏 */}
          {!(focusMode || isSlideMode) && (
          <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-hairline bg-paper/85 px-4 backdrop-blur-md md:px-6">
            {/* logo */}
            <Link to="/me" className="flex shrink-0 items-center gap-2.5">
              <img src="/logo.svg" alt="智训云枢" className="h-7 w-7" />
              <span className="hidden items-center gap-1.5 sm:flex">
                <span className="font-serif text-[16px] font-bold text-ink">智训云枢</span>
                {orgShortName && (
                  <span className="rounded-md border border-hairline bg-paper px-1.5 py-0.5 font-mono text-[9.5px] font-medium tracking-wide text-ink-muted">
                    {orgShortName}
                  </span>
                )}
              </span>
            </Link>

            {/* 居中导航（桌面） */}
            <nav className="hidden flex-1 items-center justify-center gap-1 md:flex">
              {learnerNav.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2 rounded-[10px] px-3.5 py-1.5 text-[14px] font-medium transition-all duration-200 ease-lf',
                      isActive
                        ? 'bg-brand-tint text-brand'
                        : 'text-ink-2 hover:bg-paper-deep hover:text-ink',
                    )
                  }
                >
                  <item.icon size={16} strokeWidth={1.9} />
                  {item.label}
                </NavLink>
              ))}
            </nav>

            {/* 右侧集群 */}
            <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap md:ml-0">
              <Link
                to="/me/notes"
                title="我的笔记"
                aria-label={`我的笔记，共 ${notes.length} 条`}
                className="relative flex h-9 items-center gap-1.5 rounded-[10px] border border-hairline bg-card-warm px-2.5 text-[12.5px] font-medium text-ink-2 transition-all duration-200 hover:border-brand/35 hover:bg-brand-tint/30 hover:text-brand"
              >
                <NotebookPen size={15} />
                <span className="hidden lg:inline">笔记</span>
                {notes.length > 0 && <span className="flex min-w-4 items-center justify-center rounded-full bg-brand-tint px-1 font-mono text-[9px] leading-4 text-brand">{notes.length > 99 ? '99+' : notes.length}</span>}
              </Link>
              <Link to="/me/profile"
                title={`当前学习者：${currentLearner.name}`}
                className="flex items-center gap-2 rounded-[10px] border border-hairline bg-card-warm py-1.5 pl-1.5 pr-2.5 transition-all duration-200 hover:border-brand/35"
              >
                <Avatar className="h-7 w-7 border border-hairline">
                  <AvatarImage src={currentLearner.avatar} alt={currentLearner.name} />
                  <AvatarFallback className="bg-brand-tint text-[11px] text-brand">
                    {currentLearner.name.slice(0, 1)}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden whitespace-nowrap text-[13px] font-medium text-ink lg:inline">{currentLearner.name}</span>
              </Link>
              <button
                type="button"
                onClick={doLogout}
                title="退出登录"
                className="hidden h-9 w-9 items-center justify-center rounded-[10px] border border-hairline bg-card-warm text-ink-muted transition-all duration-200 hover:border-brand/35 hover:text-ink sm:flex"
              >
                <LogOut size={14} />
              </button>
            </div>
          </header>
          )}

          {/* 内容（单列，底部留出移动 tab 空间）· lf-learner：治愈系暖光作用域 */}
          <main className="lf-learner min-w-0 flex-1 pb-24 md:pb-10">
            {/* 路由柔和交叉淡入（去焦虑：不硬切） */}
            <div key={location.pathname} className="lf-page-in">
              <Outlet />
            </div>
          </main>

          {/* 伴学助手 · 常驻画像助手（专注时收起） */}
          {(!focusMode || isSlideMode) && <AgentDock />}

          {/* 全局「继续学习」浮标 · 左下角，随时回到当前路径节点 */}
          {!isSlideMode && <ResumeLearningFab />}

          {/* 移动端底部 tab */}
          {!(focusMode || isSlideMode) && (
          <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-hairline bg-paper/95 backdrop-blur-md md:hidden">
            {learnerNav.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors',
                    isActive ? 'text-brand' : 'text-ink-muted',
                  )
                }
              >
                <item.icon size={19} strokeWidth={1.9} />
                {item.label}
              </NavLink>
            ))}
          </nav>
          )}
        </div>
      ) : (
        /* ==================== 系统透视：侧栏仪表盘 ==================== */
        <div className="flex min-h-[100dvh]">
          {/* 左侧导航 */}
          <aside
            className={cn(
              'sticky top-0 z-40 flex h-[100dvh] shrink-0 flex-col border-r border-hairline bg-paper transition-[width] duration-300 ease-lf',
              collapsed ? 'w-[72px]' : 'w-[248px]',
            )}
          >
            <Link
              to="/"
              className={cn(
                'flex h-16 items-center gap-2.5 border-b border-hairline px-4',
                collapsed && 'justify-center px-0',
              )}
            >
              <img src="/logo.svg" alt="智训云枢" className="h-8 w-8 shrink-0" />
              {!collapsed && (
                <span className="flex flex-col leading-tight">
                  <span className="font-serif text-[17px] font-bold text-ink">智训云枢</span>
                  <span className="font-mono text-[10px] tracking-wider text-ink-muted">LearnForge v2.1</span>
                </span>
              )}
            </Link>

            <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
              {expertNavGroups.map((group, gi) => (
                <div key={gi} className={gi > 0 ? 'pt-3' : undefined}>
                  {group.heading && !collapsed && (
                    <div className="lf-mono-label mb-1 px-3 !text-[10px]">{group.heading}</div>
                  )}
                  {group.heading && collapsed && gi > 0 && <div className="mx-3 mb-2 border-t border-hairline" />}
                  {group.items.map((item) => (
                    <SideNavRow key={item.path} item={item} collapsed={collapsed} />
                  ))}
                </div>
              ))}
            </nav>

            <div className="border-t border-hairline p-3">
              <div
                className={cn(
                  'flex items-center gap-2 rounded-[10px] bg-card-warm px-3 py-2.5',
                  collapsed && 'justify-center px-0',
                )}
              >
                <LiveDot status="running" />
                {!collapsed && (
                  <span className="relative flex-1 overflow-hidden">
                    <span className="flex w-max animate-marquee gap-8 font-mono text-[10.5px] whitespace-nowrap text-ink-muted">
                      <span>
                        {globalStats.agentsOnline} AGENTS ONLINE · 今日协同 {globalStats.todayCollabCount} 次
                      </span>
                      <span aria-hidden>
                        {globalStats.agentsOnline} AGENTS ONLINE · 今日协同 {globalStats.todayCollabCount} 次
                      </span>
                    </span>
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setCollapsed((v) => !v)}
                className={cn(
                  'mt-2 flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-[12.5px] text-ink-muted transition-colors hover:bg-paper-deep hover:text-ink',
                  collapsed && 'justify-center px-0',
                )}
              >
                {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
                {!collapsed && '折叠导航'}
              </button>
            </div>
          </aside>

          {/* 主区 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-hairline bg-paper/85 px-6 backdrop-blur-md">
              {/* 左侧标题区：可压缩但只截断、不折行（面包屑逐字换行就是从这儿来的） */}
              <div className="min-w-0 flex-1">
                <h1 className="truncate font-serif text-[16px] font-semibold leading-[22px] text-ink">
                  {pageInfo.title}
                </h1>
                <div className="truncate whitespace-nowrap font-mono text-[10px] tracking-[0.12em] text-ink-muted">
                  {pageInfo.crumb}
                </div>
              </div>

              {/* 右侧控件群：整体不参与压缩，窄屏按重要度分级隐藏，杜绝挤压变形 */}
              <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                <Link
                  to="/me/notes"
                  title="我的笔记"
                  aria-label={`我的笔记，共 ${notes.length} 条`}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border border-hairline bg-card-warm px-2.5 text-[12px] font-medium text-ink-2 transition-all duration-200 hover:border-brand/35 hover:text-brand"
                >
                  <NotebookPen size={13} />
                  <span className="hidden lg:inline">笔记</span>
                  {notes.length > 0 && <span className="font-mono text-[9px] text-brand">{notes.length > 99 ? '99+' : notes.length}</span>}
                </Link>

                {/* 评委一键导览：5 分钟自动串场，把五步闭环叙事喂到评委嘴边 */}
                <button
                  type="button"
                  onClick={() => startDemoTour()}
                  title="评委一键导览 · 5 分钟串场演示"
                  className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-brand-amber/45 bg-brand-amber-tint px-2.5 text-[12px] font-medium text-ochre transition-all duration-200 hover:border-brand-amber/70"
                >
                  <Compass size={13} />
                  <span className="hidden md:inline">评委导览</span>
                </button>

                <LiveClock />
                <label className="hidden h-8 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-[9px] border border-hairline bg-card-warm px-2.5 xl:flex">
                  <span className={cn('text-[12px] font-medium', demoMode ? 'text-brand' : 'text-ink-muted')}>
                    演示模式
                  </span>
                  <Switch
                    checked={demoMode}
                    onCheckedChange={(v) => {
                      setDemoMode(v);
                      toast(v ? '演示模式已开启' : '演示模式已关闭', {
                        description: v ? '各页面将自动播放模拟脚本' : '自动播放已停止',
                      });
                    }}
                  />
                </label>

                <Link
                  to="/me/profile"
                  title={currentLearner.name}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border border-hairline bg-card-warm pl-1 pr-2.5 transition-all duration-200 hover:border-brand/35"
                >
                  <Avatar className="h-6 w-6 border border-hairline">
                    <AvatarImage src={currentLearner.avatar} alt={currentLearner.name} />
                    <AvatarFallback className="bg-brand-tint text-[11px] text-brand">
                      {currentLearner.name.slice(0, 1)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="hidden whitespace-nowrap text-[12.5px] font-medium text-ink xl:inline">{currentLearner.name}</span>
                </Link>
                <button
                  type="button"
                  onClick={doLogout}
                  title="退出登录"
                  aria-label="退出登录"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-hairline bg-card-warm text-ink-muted transition-all duration-200 hover:border-brand/35 hover:text-ink"
                >
                  <LogOut size={13} />
                </button>
              </div>
            </header>

            <main className="min-w-0 flex-1">
              <Outlet />
            </main>
          </div>

          {/* DIA-01 决策日志（评委透视） */}
          <AgentDock />
        </div>
      )}

      {/* ⌘K 检索弹层（两种布局共用） */}
      <CommandDialog open={searchOpen} onOpenChange={setSearchOpen}>
        <CommandInput placeholder="检索知识库 / 资源 / 标准号…" />
        <CommandList>
          <CommandEmpty>未找到匹配结果</CommandEmpty>
          <CommandGroup heading="知识切片">
            {kbSlices.slice(0, 8).map((k) => (
              <CommandItem
                key={k.id}
                value={`${k.id} ${k.title} ${k.standardNo ?? ''}`}
                onSelect={() => {
                  setSearchOpen(false);
                  setDrawerKb(k.id);
                }}
              >
                <Database size={14} className="mr-2 text-brand" />
                <span className="font-mono text-[12px] text-brand">{k.id}</span>
                <span className="ml-2 truncate">{k.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="生成资源">
            {resources.map((r) => (
              <CommandItem
                key={`${r.learnerId}-${r.form}`}
                value={r.title}
                onSelect={() => {
                  setSearchOpen(false);
                  /* 带上形态，否则搜到 A 却打开 B */
                  navigate(`/resources?tab=${r.form}`);
                }}
              >
                <PenLine size={14} className="mr-2 text-ochre" />
                <span className="truncate">{r.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          {notes.length > 0 && (
            <CommandGroup heading="我的笔记">
              {notes.slice(0, 6).map((n) => (
                <CommandItem
                  key={n.id}
                  value={`笔记 ${n.text} ${n.source}`}
                  onSelect={() => {
                    setSearchOpen(false);
                    navigate('/me/notes');
                  }}
                >
                  <NotebookPen size={14} className="mr-2 text-brand" />
                  <span className="truncate">{n.text}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>

      <KBDrawer sliceId={drawerKb} open={drawerKb !== null} onOpenChange={(o) => !o && setDrawerKb(null)} />

      {/* 评委一键导览：挂载在 Router 内部，跨路由不卸载，进度存 sessionStorage */}
      <DemoTour />
    </>
  );
}


