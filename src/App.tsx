import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Lenis from 'lenis';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Toaster } from '@/components/ui/sonner';
import AppShell from '@/components/AppShell';
import Home from '@/pages/Home';
import Learn from '@/pages/Learn';
import LearnUnit from '@/pages/LearnUnit';
import CourseResourcePlayer from '@/pages/CourseResourcePlayer';
import LearnerHome from '@/pages/LearnerHome';
import MyNotes from '@/pages/MyNotes';
import WrongBook from '@/pages/WrongBook';
import MyProfile from '@/pages/MyProfile';
import Onboarding from '@/pages/Onboarding';
import Profiles from '@/pages/Profiles';
import Agents from '@/pages/Agents';
import Resources from '@/pages/Resources';
import Report from '@/pages/Report';
import Tutoring from '@/pages/Tutoring';
import Knowledge from '@/pages/Knowledge';
import Login from '@/pages/Login';
import Welcome from '@/pages/Welcome';
import { useAuth } from '@/context/AuthContext';

gsap.registerPlugin(ScrollTrigger);

/** 路由守卫：未登录一律回 /login（演示登录，全模拟） */
function RequireAuth() {
  const { isAuthed, session, knownOf } = useAuth();
  const { pathname } = useLocation();
  if (!isAuthed) return <Navigate to="/login" replace />;
  /* 真实账号（工号/手机/微信）还没绑画像 → 只许在建档流程里，
     否则会顶着上一个用户的 currentLearnerId 看到别人的园子/错题 */
  const needsProfile =
    session !== null &&
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
    const lenis = new Lenis({ lerp: 0.1 });
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
      <Routes>
        <Route path="login" element={<Login />} />
        <Route element={<RequireAuth />}>
        <Route path="welcome" element={<Welcome />} />
        <Route element={<AppShell />}>
          <Route index element={<Home />} />
          <Route path="me" element={<LearnerHome />} />
          <Route path="me/profile" element={<MyProfile />} />
          <Route path="me/notes" element={<MyNotes />} />
          <Route path="me/wrong" element={<WrongBook />} />
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
      <Toaster position="top-right" richColors closeButton />
    </BrowserRouter>
  );
}
