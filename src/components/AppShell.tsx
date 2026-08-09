/**
 * AppShell — 应用外壳（双模式 · 双布局）
 * 学习者视角(learner)：顶部导航外壳（logo + 居中 4 站 + AI 教研组 + 画像 + 模式）；移动端底部 tab；内容单列。
 * 系统透视(expert / 评委模式)：左侧栏仪表盘（完整 7 页分组 + 时钟 + 引擎 ticker + 演示模式）。
 * 两种视角是两种布局形态——学习 App vs 控制台。
 */
import { useEffect, useMemo, useState } from 'react';
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
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  Check,
  GraduationCap,
  Cpu,
  NotebookPen,
  LogOut,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useProfile } from '@/context/ProfileContext';
import type { ViewMode } from '@/context/ProfileContext';
import { useAuth } from '@/context/AuthContext';
import { useNotes } from '@/context/NotesContext';
import { useGrowth } from '@/context/GrowthContext';
import TeachingGroup from './TeachingGroup';
import AgentDock from './agent/AgentDock';
import ResumeLearningFab from './ResumeLearningFab';
import { SparkField } from './heal/Flora';
import { cn } from '@/lib/utils';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';

type NavItem = {
  path: string;
  label: string;
  sub?: string;
  icon: typeof Home;
  end?: boolean;
};

/** 学习者视角：4 站旅程 */
const learnerNav: NavItem[] = [
  { path: '/me', label: '我的学习', icon: Home, end: true },
  { path: '/learn', label: '学', icon: BookOpen },
  { path: '/tutoring', label: '练', icon: MessagesSquare },
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
  '/learn': { title: '学 · 我的课程', crumb: 'LEARNFORGE / COURSE' },
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
    <span className="hidden items-center gap-2 rounded-lg border border-hairline bg-paper px-2.5 py-1.5 font-mono text-[13px] font-medium text-ink-2 tabular md:inline-flex">
      <span className="h-1.5 w-1.5 rounded-full bg-brand-amber" />
      {text}
    </span>
  );
}

/** 视图模式切换段控 */
function ModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  const opts: { key: ViewMode; label: string; icon: typeof Home }[] = [
    { key: 'learner', label: '学习', icon: GraduationCap },
    { key: 'expert', label: '系统透视', icon: Cpu },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-[11px] border border-hairline bg-paper p-0.5">
      {opts.map((o) => {
        const active = mode === o.key;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            title={o.key === 'expert' ? '系统透视 / 评委视角：展开完整多智能体机制' : '学习者视角'}
            className={cn(
              'flex items-center gap-1.5 rounded-[9px] px-2.5 py-1.5 text-[12.5px] font-medium transition-all duration-200',
              active ? 'bg-brand text-paper shadow-warm' : 'text-ink-muted hover:text-ink',
            )}
          >
            <o.icon size={14} />
            <span className="hidden sm:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 画像切换下拉（两种布局共用） */
function ProfileSwitcher({
  currentLearner,
  currentLearnerId,
  learners,
  onSwitch,
}: {
  currentLearner: ReturnType<typeof useProfile>['currentLearner'];
  currentLearnerId: string;
  learners: ReturnType<typeof useProfile>['learners'];
  onSwitch: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-[10px] border border-hairline bg-card-warm py-1.5 pl-1.5 pr-2.5 transition-all duration-200 hover:border-brand/35"
        >
          <Avatar className="h-7 w-7 border border-hairline">
            <AvatarImage src={currentLearner.avatar} alt={currentLearner.name} />
            <AvatarFallback className="bg-brand-tint text-[11px] text-brand">
              {currentLearner.name.slice(0, 1)}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-[13px] font-medium text-ink lg:inline">{currentLearner.name}</span>
          <ChevronDown size={14} className="text-ink-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 border-hairline bg-card-warm">
        <DropdownMenuLabel className="lf-mono-label !text-[10px]">切换学习者画像</DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-hairline" />
        {learners.map((l) => (
          <DropdownMenuItem
            key={l.id}
            onClick={() => onSwitch(l.id)}
            className="flex cursor-pointer items-center gap-3 py-2.5 focus:bg-brand-tint"
          >
            <Avatar className="h-8 w-8 border border-hairline">
              <AvatarImage src={l.avatar} alt={l.name} />
              <AvatarFallback className="bg-brand-tint text-[11px] text-brand">
                {l.name.slice(0, 1)}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium text-ink">{l.name}</span>
              <span className="block truncate text-[11.5px] text-ink-muted">
                {l.tag} · {l.role}
              </span>
            </span>
            {l.id === currentLearnerId && <Check size={15} className="text-brand" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  const [searchQuery, setSearchQuery] = useState('');
  const {
    currentLearner,
    currentLearnerId,
    setCurrentLearnerId,
    learners,
    viewMode,
    setViewMode,
  } = useProfile();
  const { notes } = useNotes();
  const { focusMode } = useGrowth();
  const { logout } = useAuth();
  const courseLearning = useCourseLearning();
  const location = useLocation();
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

  const switchLearner = (id: string) => {
    if (id === currentLearnerId) return;
    setCurrentLearnerId(id);
    const l = learners.find((x) => x.id === id);
    toast.success(`已切换为 ${l?.name}，全站数据已更新`, {
      description: '画像 / 报告 / 资源 / 导学 / 协同已重新取数',
    });
  };

  const changeMode = (m: ViewMode) => {
    if (m === viewMode) return;
    setViewMode(m);
    if (m === 'learner') {
      navigate('/me');
      toast('已切换到学习者视角', { description: '顶部导航 · 单列聚焦，AI 机制收进「教研组」按需查看' });
    } else {
      navigate('/');
      toast('已切换到系统透视 / 评委视角', { description: '侧栏仪表盘 · 完整展开多智能体协同机制' });
    }
  };

  return (
    <>
      {isLearner ? (
        /* ==================== 学习者：顶部导航外壳（专注模式收起全部 chrome） ==================== */
        <div className="flex min-h-[100dvh] flex-col">
          {/* 漂浮微光（治愈氛围，专注时收起） */}
          {!focusMode && <SparkField />}
          {/* 顶栏 */}
          {!focusMode && (
          <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-hairline bg-paper/85 px-4 backdrop-blur-md md:px-6">
            {/* logo */}
            <Link to="/me" className="flex shrink-0 items-center gap-2.5">
              <img src="/logo.svg" alt="智训云枢" className="h-7 w-7" />
              <span className="hidden font-serif text-[16px] font-bold text-ink sm:inline">智训云枢</span>
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

            {/* 右侧集群（画像切换仅系统透视提供——学习者视角里"我"就是当前画像） */}
            <div className="ml-auto flex items-center gap-2 md:ml-0">
              <TeachingGroup variant="compact" />
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                title="检索（⌘K）"
                className="hidden h-9 w-9 items-center justify-center rounded-[10px] border border-hairline bg-card-warm text-ink-muted transition-all duration-200 hover:border-brand/35 hover:text-ink sm:flex"
              >
                <Search size={15} />
              </button>
              <ModeToggle mode={viewMode} onChange={changeMode} />
              <Link
                to="/me/profile"
                title={`当前学习者：${currentLearner.name}`}
                className="flex items-center gap-2 rounded-[10px] border border-hairline bg-card-warm py-1.5 pl-1.5 pr-2.5 transition-all duration-200 hover:border-brand/35"
              >
                <Avatar className="h-7 w-7 border border-hairline">
                  <AvatarImage src={currentLearner.avatar} alt={currentLearner.name} />
                  <AvatarFallback className="bg-brand-tint text-[11px] text-brand">
                    {currentLearner.name.slice(0, 1)}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden text-[13px] font-medium text-ink lg:inline">{currentLearner.name}</span>
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

          {/* 阿诊 · 常驻画像助手（专注时收起） */}
          {!focusMode && <AgentDock />}

          {/* 全局「继续学习」浮标 · 左下角，随时回到当前路径节点 */}
          <ResumeLearningFab />

          {/* 移动端底部 tab */}
          {!focusMode && (
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
                <Database size={14} className="shrink-0 text-brand" />
                {!collapsed && (
                  <span className="flex-1 font-mono text-[10.5px] text-ink-muted">BACKEND DATA MODE</span>
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
            <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-hairline bg-paper/85 px-6 backdrop-blur-md">
              <div className="min-w-0">
                <h1 className="truncate font-serif text-[17px] font-semibold leading-[24px] text-ink">
                  {pageInfo.title}
                </h1>
                <div className="font-mono text-[10.5px] tracking-[0.12em] text-ink-muted">{pageInfo.crumb}</div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setSearchOpen(true)}
                  className="hidden items-center gap-2 rounded-[10px] border border-hairline bg-card-warm px-3 py-1.5 text-[13px] text-ink-muted transition-all duration-200 hover:border-brand/35 hover:text-ink sm:flex"
                >
                  <Search size={14} />
                  <span className="max-w-[180px] truncate">检索知识库 / 资源 / 标准号…</span>
                  <kbd className="rounded border border-hairline bg-paper px-1.5 py-px font-mono text-[10px] text-ink-muted">
                    ⌘K
                  </kbd>
                </button>

                <LiveClock />

                <ModeToggle mode={viewMode} onChange={changeMode} />
                <ProfileSwitcher
                  currentLearner={currentLearner}
                  currentLearnerId={currentLearnerId}
                  learners={learners}
                  onSwitch={switchLearner}
                />
                <button
                  type="button"
                  onClick={doLogout}
                  title="退出登录"
                  className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-hairline bg-card-warm text-ink-muted transition-all duration-200 hover:border-brand/35 hover:text-ink"
                >
                  <LogOut size={14} />
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
        <CommandInput value={searchQuery} onValueChange={setSearchQuery} placeholder="检索真实知识库或当前课程资源…" />
        <CommandList>
          <CommandEmpty>未找到匹配结果</CommandEmpty>
          <CommandGroup heading="真实知识库">
            <CommandItem value={`搜索真实知识库 ${searchQuery}`} onSelect={() => { const query = searchQuery.trim(); setSearchOpen(false); navigate(query ? `/knowledge?q=${encodeURIComponent(query)}` : '/knowledge'); }}>
              <Database size={14} className="mr-2 text-brand" />
              <span className="truncate">{searchQuery.trim() ? `在 RAG 知识库搜索“${searchQuery.trim()}”` : '打开 RAG 知识库'}</span>
            </CommandItem>
          </CommandGroup>
          {courseLearning.resources.length > 0 && <CommandGroup heading="当前课程资源">
            {courseLearning.resources.slice(0, 12).map((resource) => (
              <CommandItem
                key={resource.id}
                value={`${resource.title} ${resource.topic}`}
                onSelect={() => {
                  setSearchOpen(false);
                  navigate(learningResourcePath(resource));
                }}
              >
                <PenLine size={14} className="mr-2 text-ochre" />
                <span className="truncate">{resource.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>}
          {notes.length > 0 && (
            <CommandGroup heading="我的笔记 · 个人知识库">
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
          <CommandGroup heading="学习者画像">
            {learners.map((l) => (
              <CommandItem
                key={l.id}
                value={`${l.name} ${l.tag}`}
                onSelect={() => {
                  setSearchOpen(false);
                  switchLearner(l.id);
                }}
              >
                <Users size={14} className="mr-2 text-brand-amber" />
                {l.name} · {l.tag}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>

    </>
  );
}
