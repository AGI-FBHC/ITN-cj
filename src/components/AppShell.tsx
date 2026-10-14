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
  MoreHorizontal,
  BookOpen,
  BarChart3,
  PenLine,
  Database,
  NotebookPen,
  LogOut,
  Loader2,
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
import type { RagChunkSummary } from '@/lib/api';
import { resources } from '@/data/resources';
import KBDrawer from './KBDrawer';
import AgentDock from './agent/AgentDock';
import ResumeLearningFab from './ResumeLearningFab';
import CompanionPet from './CompanionPet';
import { SparkField } from './heal/Flora';
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

/**
 * 学习者视角的"更多"入口。
 * 这些页面此前只存在于专家视角侧栏（或根本没有入口），学习者只能手输 URL 才能到达，
 * 属于"入口隐蔽"问题；这里统一收进一个可发现的菜单。
 */
const learnerMoreItems: { path: string; label: string; note: string }[] = [
  { path: '/resources', label: '我的资源', note: '定制讲义 / 实操 / 分阶题' },
  { path: '/knowledge', label: '领域知识库', note: '切片检索与原文溯源' },
  { path: '/chat', label: '伴学助手', note: '就当前进度提问' },
  { path: '/profiles', label: '学情画像', note: '六维能力与盲区' },
  { path: '/agents', label: '协同调度', note: '五个 Agent 的执行过程（需先生成课程）' },
  { path: '/collaboration', label: '协同工作台', note: '教研任务泳道（演示）' },
];





export default function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  /* 点击页面其它位置关闭"更多"菜单。 */
  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [moreOpen]);
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
  const { activeTasks } = useCustomizeActivity();
  const isLearner = viewMode === 'learner';

  const doLogout = () => {
    logout();
    toast('已退出登录', { description: '画像与学习记录都留在本机，下次登录接着用' });
    navigate('/login');
  };

  const base = useMemo(() => '/' + (location.pathname.split('/')[1] ?? ''), [location.pathname]);

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
              <img src="/logo.png" alt="智训云枢" className="h-7 w-7" />
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
              {isLearner && (
                <div className="relative">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                    onClick={(event) => { event.stopPropagation(); setMoreOpen((value) => !value); }}
                    className="flex items-center gap-2 rounded-[10px] px-3.5 py-1.5 text-[14px] font-medium text-ink-2 transition-all duration-200 ease-lf hover:bg-paper-deep hover:text-ink"
                  >
                    <MoreHorizontal size={16} strokeWidth={1.9} />
                    更多
                  </button>
                  {moreOpen && (
                    <div role="menu" onClick={(event) => event.stopPropagation()} className="absolute right-0 top-full z-50 mt-2 w-64 rounded-[14px] border border-hairline bg-paper p-2 shadow-warm-lg">
                      {learnerMoreItems.map((entry) => (
                        <Link key={entry.path} to={entry.path} onClick={() => setMoreOpen(false)} className="block rounded-[10px] px-3 py-2 transition-colors hover:bg-paper-deep">
                          <span className="block text-[13px] font-medium text-ink">{entry.label}</span>
                          <span className="block text-[11px] text-ink-muted">{entry.note}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              )}
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

          {/* 更多：移动端固定在底部 tab 之上，桌面端由顶部导航的下拉承担 */}
          {isLearner && moreOpen && (
            <div role="menu" onClick={(event) => event.stopPropagation()} className="fixed inset-x-3 bottom-16 z-[60] rounded-[14px] border border-hairline bg-paper p-2 shadow-warm-lg md:hidden">
              {learnerMoreItems.map((entry) => (
                <Link key={entry.path} to={entry.path} onClick={() => setMoreOpen(false)} className="block rounded-[10px] px-3 py-2 transition-colors hover:bg-paper-deep">
                  <span className="block text-[13px] font-medium text-ink">{entry.label}</span>
                  <span className="block text-[11px] text-ink-muted">{entry.note}</span>
                </Link>
              ))}
            </div>
          )}

          {/* 全局「继续学习」浮标 · 左下角，随时回到当前路径节点 */}
          {!isSlideMode && <ResumeLearningFab />}

          {/* 伴学角色「小鼋」· 右下角（伴学浮窗之上）：可拖拽、点开有快捷入口（旧版桌宠的核心交互） */}
          {(!focusMode || isSlideMode) && <CompanionPet />}

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
            {isLearner && (
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={(event) => { event.stopPropagation(); setMoreOpen((value) => !value); }}
                className="flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium text-ink-muted"
              >
                <MoreHorizontal size={19} strokeWidth={1.9} />
                更多
              </button>
            )}
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

    </>
  );
}


