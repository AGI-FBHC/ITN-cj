import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Lenis from 'lenis';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Toaster } from '@/components/ui/sonner';
import AppShell from '@/components/AppShell';
import { CustomizeActivityProvider } from '@/context/CustomizeActivityContext';
import Login from '@/pages/Login';

/* 路由级懒加载：重型页面（3D/课件/图表/PPT）按需分包，降低首屏主包体积 */
const Home = lazy(() => import('@/pages/Home'));
const PersonaSelect = lazy(() => import('@/pages/PersonaSelect'));
const Welcome = lazy(() => import('@/pages/Welcome'));
const Learn = lazy(() => import('@/pages/Learn'));
const LearnUnit = lazy(() => import('@/pages/LearnUnit'));
const CourseResourcePlayer = lazy(() => import('@/pages/CourseResourcePlayer'));
const ResourceFileViewer = lazy(() => import('@/pages/ResourceFileViewer'));
const LearnerHome = lazy(() => import('@/pages/LearnerHome'));
const MyNotes = lazy(() => import('@/pages/MyNotes'));
const WrongBook = lazy(() => import('@/pages/WrongBook'));
const MyGarden = lazy(() => import('@/pages/MyGarden'));
const MyProfile = lazy(() => import('@/pages/MyProfile'));
const Journal = lazy(() => import('@/pages/Journal'));
const Calibrate = lazy(() => import('@/pages/Calibrate'));
const Onboarding = lazy(() => import('@/pages/Onboarding'));
const Profiles = lazy(() => import('@/pages/Profiles'));
const Agents = lazy(() => import('@/pages/Agents'));
const Resources = lazy(() => import('@/pages/Resources'));
const Discover = lazy(() => import('@/pages/Discover'));
const CourseIntro = lazy(() => import('@/pages/CourseIntro'));
const Rankings = lazy(() => import('@/pages/Rankings'));
const Report = lazy(() => import('@/pages/Report'));
const Tutoring = lazy(() => import('@/pages/Tutoring'));
const Knowledge = lazy(() => import('@/pages/Knowledge'));
const Admin = lazy(() => import('@/pages/Admin'));
const CollaborationWorkbench = lazy(() => import('@/pages/CollaborationWorkbench'));
const AiChat = lazy(() => import('@/pages/AiChat'));
const CustomizePipeline = lazy(() => import('@/pages/CustomizePipeline'));
const CustomizeTeam = lazy(() => import('@/pages/CustomizeTeam'));
const SlidePlayer = lazy(() => import('@/pages/SlidePlayer'));
/** W6 渲染增强的开发期自检页（仅 DEV 注册路由，生产不注册） */
const MarkdownCheck = lazy(() => import('@/pages/dev/MarkdownCheck'));
import { useAuth } from '@/context/AuthContext';
import { api, type OrganizationBranding } from '@/lib/api';
import { useCachedData } from '@/hooks/useCachedData';

gsap.registerPlugin(ScrollTrigger);

const DEFAULT_TITLE = '智训云枢 — 领域知识个性化生成与多智能体协同决策系统';

/** 登录后把浏览器标签页的图标和标题切换为当前机构品牌。 */
function BrandingEffects() {
  const { isAuthed } = useAuth();
  const brandingQ = useCachedData<OrganizationBranding>(
    isAuthed ? 'learner:organizationBranding' : null,
    () => api.getOrganizationBranding(),
    { ttlMs: 5 * 60_000 },
  );

  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!isAuthed) {
      if (icon) icon.href = '/logo.png';
      document.title = DEFAULT_TITLE;
      return;
    }
    const branding = brandingQ.data;
    if (!branding) return;
    if (icon) icon.href = branding.logoUrl || '/logo.png';
    const shortName = branding.shortName?.trim();
    document.title = shortName ? `${shortName} · 智训云枢` : DEFAULT_TITLE;
  }, [isAuthed, brandingQ.data]);

  return null;
}

/** 路由守卫：未登录一律回 /login（演示登录，全模拟） */
function RequireAuth() {
  const { isAuthed, session, knownOf } = useAuth();
  const { pathname } = useLocation();
  if (!isAuthed) return <Navigate to="/login" replace />;
  const isAdmin = session?.roles?.includes('admin') === true;
  if (isAdmin && !pathname.startsWith('/admin')) {
    return <Navigate to="/admin" replace />;
  }
  if (pathname.startsWith('/admin') && !isAdmin) {
    return <Navigate to="/me" replace />;
  }
  /* 真实账号（工号/手机/微信）还没绑画像 → 只许在建档流程里，
     否则会顶着上一个用户的 currentLearnerId 看到别人的园子/错题 */
  const needsProfile =
    session !== null &&
    !isAdmin &&
    (session.method === 'sso' || session.method === 'sms' || session.method === 'wechat') &&
    knownOf(session.account) === null;
  if (needsProfile && pathname !== '/welcome' && pathname !== '/onboarding') {
    return <Navigate to="/welcome" replace />;
  }
  return <Outlet />;
}

/** 路由切换回滚到顶部 */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [pathname]);
  return null;
}

export default function App() {
  /* 全站 Lenis 平滑滚动（lerp 0.1），与 GSAP ScrollTrigger 同步 */
  useEffect(() => {
    const lenis = new Lenis({
      lerp: 0.1,
      /* 嵌套滚动容器（本讲目录/面板/代码块等）保持原生滚轮：否则 Lenis 会劫持滚轮，
         导致只能拖动滚动条、滚轮无效 */
      allowNestedScroll: true,
    });
    lenis.on('scroll', ScrollTrigger.update);
    const raf = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(raf);
      lenis.destroy();
    };
  }, []);

  return (
    <BrowserRouter>
      <BrandingEffects />
      <ScrollToTop />
      <Suspense fallback={<div className="flex min-h-[70vh] items-center justify-center text-[13px] text-ink-muted">正在加载页面…</div>}>
      <Routes>
        <Route path="login" element={<Login />} />
        <Route path="persona" element={<PersonaSelect />} />
        {/* 开发期 Markdown 渲染自检（公式 + 代码高亮）：dev-only，不参与生产路由 */}
        {import.meta.env.DEV && <Route path="__mdcheck" element={<MarkdownCheck />} />}
        <Route element={<RequireAuth />}>
        <Route path="welcome" element={<Welcome />} />
        <Route path="admin" element={<Admin />} />
        <Route path="admin/:section" element={<Admin />} />
        <Route element={<CustomizeActivityProvider><AppShell /></CustomizeActivityProvider>}>
          <Route index element={<Home />} />
          <Route path="me" element={<LearnerHome />} />
          <Route path="me/profile" element={<MyProfile />} />
      <Route path="me/journal" element={<Journal />} />
          <Route path="me/notes" element={<MyNotes />} />
          <Route path="me/wrong" element={<WrongBook />} />
          <Route path="me/garden" element={<MyGarden />} />
          <Route path="me/calibrate" element={<Calibrate />} />
          <Route path="learn" element={<Learn />} />
          <Route path="learn/resource/:resourceId" element={<CourseResourcePlayer />} />
          <Route path="learn/file/:resourceId" element={<ResourceFileViewer />} />
          <Route path="learn/customize/:taskId" element={<CustomizePipeline />} />
          <Route path="learn/slide/:taskId" element={<SlidePlayer />} />
          <Route path="learn/slide/resource/:resourceId" element={<SlidePlayer />} />
                    <Route path="learn/customize-team/:kpId" element={<CustomizeTeam />} />
          <Route path="learn/:kpId" element={<LearnUnit />} />
          <Route path="onboarding" element={<Onboarding />} />
          <Route path="profiles" element={<Profiles />} />
          <Route path="agents" element={<Agents />} />
          <Route path="resources" element={<Resources />} />
          <Route path="discover" element={<Discover />} />
          <Route path="discover/:code" element={<CourseIntro />} />
          <Route path="rankings" element={<Rankings />} />
          <Route path="report" element={<Report />} />
          <Route path="tutoring" element={<Tutoring />} />
          <Route path="knowledge" element={<Knowledge />} />
          <Route path="collaboration" element={<CollaborationWorkbench />} />
          <Route path="chat" element={<AiChat />} />
          <Route path="*" element={<Home />} />
        </Route>
        </Route>
      </Routes>
      </Suspense>
      <Toaster position="top-right" richColors closeButton offset={72} />
    </BrowserRouter>
  );
}
