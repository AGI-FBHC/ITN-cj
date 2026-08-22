import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Lenis from 'lenis';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Toaster } from '@/components/ui/sonner';
import AppShell from '@/components/AppShell';
import Login from '@/pages/Login';

/* 路由级懒加载：重型页面（3D/课件/图表/PPT）按需分包，降低首屏主包体积 */
const Home = lazy(() => import('@/pages/Home'));
const Welcome = lazy(() => import('@/pages/Welcome'));
const Learn = lazy(() => import('@/pages/Learn'));
const LearnUnit = lazy(() => import('@/pages/LearnUnit'));
const CourseResourcePlayer = lazy(() => import('@/pages/CourseResourcePlayer'));
const LearnerHome = lazy(() => import('@/pages/LearnerHome'));
const MyNotes = lazy(() => import('@/pages/MyNotes'));
const WrongBook = lazy(() => import('@/pages/WrongBook'));
const MyProfile = lazy(() => import('@/pages/MyProfile'));
const Calibrate = lazy(() => import('@/pages/Calibrate'));
const Onboarding = lazy(() => import('@/pages/Onboarding'));
const Profiles = lazy(() => import('@/pages/Profiles'));
const Agents = lazy(() => import('@/pages/Agents'));
const Resources = lazy(() => import('@/pages/Resources'));
const Report = lazy(() => import('@/pages/Report'));
const Tutoring = lazy(() => import('@/pages/Tutoring'));
const Knowledge = lazy(() => import('@/pages/Knowledge'));
const Admin = lazy(() => import('@/pages/Admin'));
import { useAuth } from '@/context/AuthContext';

gsap.registerPlugin(ScrollTrigger);

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
      <ScrollToTop />
      <Suspense fallback={<div className="flex min-h-[70vh] items-center justify-center text-[13px] text-ink-muted">正在加载页面…</div>}>
      <Routes>
        <Route path="login" element={<Login />} />
        <Route element={<RequireAuth />}>
        <Route path="welcome" element={<Welcome />} />
        <Route path="admin" element={<Admin />} />
        <Route path="admin/:section" element={<Admin />} />
        <Route element={<AppShell />}>
          <Route index element={<Home />} />
          <Route path="me" element={<LearnerHome />} />
          <Route path="me/profile" element={<MyProfile />} />
          <Route path="me/notes" element={<MyNotes />} />
          <Route path="me/wrong" element={<WrongBook />} />
          <Route path="me/calibrate" element={<Calibrate />} />
          <Route path="learn" element={<Learn />} />
          <Route path="learn/resource/:resourceId" element={<CourseResourcePlayer />} />
          <Route path="learn/:kpId" element={<LearnUnit />} />
          <Route path="onboarding" element={<Onboarding />} />
          <Route path="profiles" element={<Profiles />} />
          <Route path="agents" element={<Agents />} />
          <Route path="resources" element={<Resources />} />
          <Route path="report" element={<Report />} />
          <Route path="tutoring" element={<Tutoring />} />
          <Route path="knowledge" element={<Knowledge />} />
          <Route path="*" element={<Home />} />
        </Route>
        </Route>
      </Routes>
      </Suspense>
      <Toaster position="top-right" richColors closeButton offset={72} />
    </BrowserRouter>
  );
}
