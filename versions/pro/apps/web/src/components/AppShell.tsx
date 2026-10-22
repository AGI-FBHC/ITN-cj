/**
 * AppShell — 应用外壳（学习者视角单一布局）
 * 顶部导航外壳（logo + 居中 4 站 + AI 教研组 + 画像 + 模式）；移动端底部 tab；内容单列。
 * 「系统透视 / 评委视角」控制台布局与「评委导览」已按用户要求整体移除，现在只剩学习者外壳；
 * 原先只挂在系统透视侧栏的「交互导学」在学习者视角下本来就是重定向到校准页，
 * 因此不再给它补入口（导航项另见 docs/change-trace.md 的说明）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Home,
  BookOpen,
  Compass,
  BarChart3,
  PenLine,
  Database,
  NotebookPen,
  LogOut,
  Loader2,
  User,
  ChevronDown,
  ListX,
  Sun,
  Settings,
  Check,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { customizeTeamPathForTask, useCustomizeActivity } from '@/context/CustomizeActivityContext';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useProfile } from '@/context/ProfileContext';
import { useAuth } from '@/context/AuthContext';
import { useNotes } from '@/context/NotesContext';
import { useGrowth } from '@/context/GrowthContext';
import { api, type OrganizationBranding } from '@/lib/api';
import { useCachedData } from '@/hooks/useCachedData';
import { useStudyTimeTracker } from '@/hooks/useStudyTimeTracker';
import type { RagChunkSummary } from '@/lib/api';
import { resources } from '@/data/resources';
import KBDrawer from './KBDrawer';
import CompanionPet from './CompanionPet';
import { SparkField } from './heal/Flora';
import { BACKGROUNDS, applyBackground, readBackground } from '@/lib/theme';
import { cn } from '@/lib/utils';

type NavItem = {
  path: string;
  label: string;
  sub?: string;
  icon: typeof Home;
  end?: boolean;
};

/** 学习者视角：导航项（保持原有「首页 / 我的学习 / 我的资源」命名，仅新增「发现课程」） */
const learnerNav: NavItem[] = [
  { path: '/me', label: '首页', icon: Home, end: true },
  { path: '/learn', label: '我的学习', icon: BookOpen },
  { path: '/discover', label: '发现课程', icon: Compass },
  { path: '/resources', label: '我的资源', icon: Database },
];





export default function AppShell() {
  /* 全局学习计时：所有 /learn 页面自动累计学习时长 */
  useStudyTimeTracker();
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bg, setBg] = useState(readBackground);

  /* 头像下拉：点击其它位置、按 Esc 或切换路由时收起。 */
  useEffect(() => {
    if (!userMenuOpen) return;
    const close = () => setUserMenuOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setUserMenuOpen(false);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [userMenuOpen]);
  /* ⌘K 的知识切片结果改为真实检索（此前取硬编码的旧赛题切片，见 BUG-007）。 */
  const [kbQuery, setKbQuery] = useState('');
  const [kbHits, setKbHits] = useState<RagChunkSummary[]>([]);
/* ⌘K 知识切片：防抖调用 /api/v1/rag/chunks/search，避免每次按键都打慢接口。 */
useEffect(() => {
  const text = kbQuery.trim();
  if (!searchOpen || text.length < 2) { setKbHits([]); return; }
  let alive = true;
  const timer = window.setTimeout(() => {
    void api.searchRagChunks(text, 0, 6)
  .then((page) => { if (alive) setKbHits(page.items ?? []); })
  .catch(() => { if (alive) setKbHits([]); });
  }, 400);
  return () => { alive = false; window.clearTimeout(timer); };
}, [kbQuery, searchOpen]);

  const [drawerKb, setDrawerKb] = useState<string | null>(null);
  const {
    currentLearner,
    currentLearnerId,
    viewMode,
  } = useProfile();
  const { notes } = useNotes();
  const { focusMode, orb } = useGrowth();
  const { logout, session } = useAuth();
  const orgBranding = useCachedData<OrganizationBranding>(
    'learner:organizationBranding',
    () => api.getOrganizationBranding(),
    { ttlMs: 5 * 60_000 },
  );
  const orgShortName = orgBranding.data?.shortName?.trim() || null;
  const location = useLocation();
  const isSlideMode = location.pathname.startsWith('/learn/slide/');
  const navigate = useNavigate();
  const { activeTasks } = useCustomizeActivity();
  const isLearner = viewMode === 'learner';

  const doLogout = async () => {
    const wasGuest = session?.roles?.includes('guest') === true;
    await logout();
    if (wasGuest) {
      /* 游客退出后整页重载，确保各页面内存里的体验数据一并清掉 */
      window.location.assign('/login');
      return;
    }
    toast('已退出登录', { description: '画像与学习记录都留在本机，下次登录接着用' });
    navigate('/login');
  };

  const base = useMemo(() => '/' + (location.pathname.split('/')[1] ?? ''), [location.pathname]);

  /* 顶栏错题数：与 /me/wrong 同源（后端错题记录），本地错题本只覆盖课件检查点 */
  const [serverWrongCount, setServerWrongCount] = useState(0);
  useEffect(() => {
    if (!currentLearnerId) { setServerWrongCount(0); return undefined; }
    let cancelled = false;
    const load = () => {
      void api.listWrongAnswers()
        .then((result) => {
          if (!cancelled) setServerWrongCount((result.items ?? []).filter((item) => !item.mastered).length);
        })
        .catch(() => { /* 读取失败保留上一次数量 */ });
    };
    load();
    window.addEventListener('focus', load);
    return () => { cancelled = true; window.removeEventListener('focus', load); };
  }, [currentLearnerId, location.pathname]);
  const wrongCount = serverWrongCount;

  /* 路由变化后收起头像下拉，避免停留在新页面上。 */
  useEffect(() => {
    setUserMenuOpen(false);
  }, [location.pathname]);

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
          <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-hairline bg-paper/95 px-4 md:px-6">
            {/* logo */}
            <Link to="/me" className="flex shrink-0 items-center gap-2.5">
              <img src={orgBranding.data?.logoUrl || '/logo.png'} alt={orgShortName || '智训云枢'} className="h-7 w-7" />
              <span className="hidden items-center gap-1.5 sm:flex">
                <span className="font-serif text-[16px] font-bold text-ink">智训云枢</span>
                {orgShortName && (
                  <span className="rounded-md border border-hairline bg-paper px-1.5 py-0.5 font-mono text-[9.5px] font-medium tracking-wide text-ink-muted">
                    {orgShortName}
                  </span>
                )}
              </span>
            </Link>

            {/* 左侧导航（桌面，仅文字） */}
            <nav className="hidden flex-1 items-center justify-start gap-1 md:ml-8 md:flex">
              {learnerNav.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center rounded-[10px] px-3.5 py-1.5 text-[14px] font-medium transition-all duration-200 ease-lf',
                      isActive
                        ? 'bg-brand-tint text-brand'
                        : 'text-ink-2 hover:bg-paper-deep hover:text-ink',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>

            {/* 右侧集群 */}
            <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap md:ml-0">
              {activeTasks[0] && (
                <button
                  type="button"
                  onClick={() => {
                    const path = customizeTeamPathForTask(activeTasks[0]);
                    if (path) navigate(path);
                  }}
                  title={activeTasks.length > 1 ? `查看生成进度（${activeTasks.length} 项正在生成）` : '查看生成进度'}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-brand-amber/50 bg-brand-amber-tint px-2.5 text-[12px] font-medium text-ochre transition-all duration-200 hover:border-brand-amber/80 hover:bg-brand-amber-tint/80"
                >
                  <Loader2 size={14} className="animate-spin" />
                  <span className="hidden lg:inline">正在生成</span>
                  {activeTasks.length > 1 && (
                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-ochre px-1 font-mono text-[9px] font-semibold leading-4 text-paper">
                      {activeTasks.length}
                    </span>
                  )}
                </button>
              )}
              <Link
                to="/me/wrong"
                title="错题本"
                aria-label={`错题本，共 ${wrongCount} 道`}
                className="relative flex h-9 items-center gap-1.5 rounded-[10px] border border-hairline bg-card-warm px-2.5 text-[12.5px] font-medium text-ink-2 transition-all duration-200 hover:border-brand/35 hover:bg-brand-tint/30 hover:text-brand"
              >
                <ListX size={15} />
                <span className="hidden lg:inline">错题本</span>
                {wrongCount > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-danger/10 px-1 font-mono text-[9px] font-semibold leading-none text-brand-danger">
                    {wrongCount > 99 ? '99+' : wrongCount}
                  </span>
                )}
              </Link>
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
              <div className="relative">
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={userMenuOpen}
                  title={`当前学习者：${currentLearner.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setUserMenuOpen((value) => !value);
                  }}
                  className="flex items-center gap-2 rounded-[10px] border border-hairline bg-card-warm py-1.5 pl-1.5 pr-2 transition-all duration-200 hover:border-brand/35"
                >
                  <Avatar className="h-7 w-7 border border-hairline">
                    <AvatarImage src={currentLearner.avatar} alt={currentLearner.name} />
                    <AvatarFallback className="bg-brand-tint text-[11px] text-brand">
                      {currentLearner.name.slice(0, 1)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="hidden whitespace-nowrap text-[13px] font-medium text-ink lg:inline">{currentLearner.name}</span>
                  <ChevronDown
                    size={13}
                    className={cn('text-ink-muted transition-transform duration-200', userMenuOpen && 'rotate-180')}
                  />
                </button>
                {userMenuOpen && (
                  <div
                    role="menu"
                    onClick={(event) => event.stopPropagation()}
                    className="absolute right-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-[14px] border border-hairline bg-paper p-1.5 shadow-warm-lg"
                  >
                    <div className="px-3 py-2">
                      <p className="text-[13px] font-medium text-ink">{currentLearner.name}</p>
                      <p className="text-[10.5px] text-ink-muted">学习者</p>
                    </div>
                    <div className="my-1 h-px bg-hairline" />
                    <Link
                      to="/me/profile"
                      role="menuitem"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2 rounded-[10px] px-3 py-2 text-[13px] text-ink-2 transition-colors hover:bg-paper-deep hover:text-ink"
                    >
                      <User size={15} />
                      我的画像
                    </Link>
                    <Link
                      to="/report"
                      role="menuitem"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2 rounded-[10px] px-3 py-2 text-[13px] text-ink-2 transition-colors hover:bg-paper-deep hover:text-ink"
                    >
                      <BarChart3 size={15} />
                      我的成长
                    </Link>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        setSettingsOpen(true);
                      }}
                      className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-paper-deep hover:text-ink"
                    >
                      <Settings size={15} />
                      设置
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setUserMenuOpen(false);
                        void doLogout();
                      }}
                      className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-paper-deep hover:text-ink"
                    >
                      <LogOut size={15} />
                      退出登录
                    </button>
                  </div>
                )}
              </div>

              {/* 养分 · 头像右侧：悬停看规则，点击进「我的园子」独立页 */}
              <div className="group relative">
                <Link
                  to="/me/garden"
                  aria-label={`养分 ${orb}，点击查看我的园子`}
                  onClick={() => setUserMenuOpen(false)}
                  className="flex h-9 items-center gap-1.5 rounded-[10px] border border-hairline bg-card-warm px-2.5 text-[12.5px] font-medium text-ink-2 transition-all duration-200 hover:border-brand-amber/60 hover:bg-brand-amber-tint/50 hover:text-ochre"
                >
                  <Sun size={15} className={orb > 0 ? 'text-ochre' : 'text-ink-muted'} />
                  <span className="font-mono text-[12px] font-semibold">{orb}</span>
                  <span className="hidden lg:inline">养分</span>
                </Link>

                {/* 悬停提示：说明这个数字点开能看规则 */}
                <span
                  role="tooltip"
                  className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden whitespace-nowrap rounded-[8px] bg-ink px-2 py-1 text-[11px] text-paper shadow-warm group-hover:block"
                >
                  点击查看养分获取规则
                </span>
              </div>
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

          {/* 伴学角色「小鼋」· 右下角：可拖拽、点开有快捷入口（旧版桌宠的核心交互） */}
          {(!focusMode || isSlideMode) && <CompanionPet />}

          {/* 移动端底部 tab */}
          {!(focusMode || isSlideMode) && (
          <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-hairline bg-paper/95 md:hidden">
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
      ) : null}

      {/* ⌘K 检索弹层（两种布局共用） */}
      <CommandDialog open={searchOpen} onOpenChange={setSearchOpen}>
        <CommandInput placeholder="检索知识库 / 资源 / 标准号…" value={kbQuery} onValueChange={setKbQuery} />
        <CommandList>
          <CommandEmpty>未找到匹配结果</CommandEmpty>
          <CommandGroup heading="知识切片">
            {kbHits.map((k) => (
              <CommandItem
                key={k.id}
                value={`${kbQuery} ${k.chunkCode} ${k.sectionTitle ?? ''} ${k.titlePath ?? ''}`}
                onSelect={() => {
                  setSearchOpen(false);
                  const q = k.sectionTitle || k.titlePath || k.chunkCode || '';
                  navigate(`/knowledge?q=${encodeURIComponent(q)}`);
                }}
              >
                <Database size={14} className="mr-2 text-brand" />
                <span className="font-mono text-[12px] text-brand">{k.chunkCode}</span>
                <span className="ml-2 truncate">{k.sectionTitle || k.titlePath || '未命名切片'}</span>
              </CommandItem>
            ))}
            {kbQuery.trim().length >= 2 && kbHits.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-ink-muted">没有匹配的知识切片</div>
            )}
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

      {settingsOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/25 px-4"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            role="dialog"
            aria-label="外观设置"
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-[380px] rounded-[14px] border border-hairline bg-paper p-5 shadow-warm-lg"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-serif text-[17px] font-semibold text-ink">外观设置</h3>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setSettingsOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-paper-deep hover:text-ink"
              >
                <X size={15} />
              </button>
            </div>
            <p className="mt-1 text-[12px] text-ink-muted">选择网页的整体背景色，立即生效并记住选择</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {BACKGROUNDS.map((item) => (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => { applyBackground(item.name); setBg(item.name); }}
                  className={cn(
                    'flex items-center gap-2 rounded-[10px] border px-3 py-2.5 text-left transition-colors',
                    bg === item.name ? 'border-brand bg-brand-tint/60' : 'border-hairline hover:border-brand/40',
                  )}
                >
                  <span className="h-4 w-4 shrink-0 rounded-full border border-hairline" style={{ backgroundColor: item.swatch }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-ink">{item.label}</span>
                    <span className="block text-[10px] text-ink-muted">{item.hint}</span>
                  </span>
                  {bg === item.name && <Check size={13} className="shrink-0 text-brand" />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

    </>
  );
}


