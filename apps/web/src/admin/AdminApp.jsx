import * as React from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { adminName, adminToken, clearAdminSession } from './admin-api.js';
import AdminOverview from './AdminOverview.jsx';
import AdminUsers from './AdminUsers.jsx';
import AdminKnowledge from './AdminKnowledge.jsx';
import AdminBundlePreview from './AdminBundlePreview.jsx';
import AdminCourseware from './AdminCourseware.jsx';
import AdminCoursewarePreview from './AdminCoursewarePreview.jsx';
import CoursewareCollaboration from './CoursewareCollaboration.jsx';
import AdminOrg from './AdminOrg.jsx';
import BrandLogo from './BrandLogo.jsx';
import AdminSettings from './AdminSettings.jsx';

function navClass({ isActive }) {
  return isActive ? 'active' : undefined;
}

function AdminLoginRedirect() {
  React.useLayoutEffect(() => {
    window.location.replace('/login?admin=1');
  }, []);
  return null;
}

export default function AdminApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token, setToken] = React.useState(adminToken());
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const isLoginPath = path === '/admin/login';

  if (isLoginPath) {
    return <AdminLoginRedirect />;
  }
  if (!token) return <Navigate to="/admin/login" replace />;

  return (
    <div className="zx-admin">
      <aside className="zx-admin-sidebar">
        <Link className="zx-admin-brand" to="/admin">
          <BrandLogo size={34} />
          <span>
            智训云枢
            <small>管理端</small>
          </span>
        </Link>
        <nav className="zx-admin-nav">
          <NavLink to="/admin" end className={navClass}>概览</NavLink>
          <NavLink to="/admin/knowledge" className={navClass}>知识库</NavLink>
          <NavLink to="/admin/courseware" className={navClass}>课件管理</NavLink>
          <NavLink to="/admin/users" className={navClass}>用户</NavLink>
          <NavLink to="/admin/org" className={navClass}>机构设置</NavLink>
          <NavLink to="/admin/settings" className={navClass}>设置</NavLink>
        </nav>
        <div className="zx-admin-sidebar-footer">
          <strong>{adminName()}</strong>
          <a href="/" style={{ color: 'inherit', fontWeight: 600 }}>打开学习端</a>
          <button
            type="button"
            className="zx-btn zx-btn-sm zx-btn-ghost"
            onClick={() => {
              clearAdminSession();
              setToken('');
              navigate('/admin/login', { replace: true });
            }}
          >
            退出登录
          </button>
        </div>
      </aside>
      <main className={`zx-admin-main${path === '/admin/courseware' ? ' zx-admin-main-workspace' : ''}`}>
        <Routes>
          <Route
            path="/admin"
            element={<AdminOverview onOpenCourse={(courseId) => navigate(courseId ? `/admin/courses/${courseId}` : '/admin/courses')} />}
          />
          <Route path="/admin/knowledge" element={<AdminKnowledge />} />
          <Route path="/admin/knowledge/bundles/:bundleId" element={<AdminBundlePreview />} />
          <Route path="/admin/courseware" element={<AdminCourseware />} />
          <Route path="/admin/courseware/:coursewareId" element={<AdminCoursewarePreview />} />
          <Route path="/admin/courseware/:coursewareId/collaboration" element={<CoursewareCollaboration />} />
          <Route path="/admin/users" element={<AdminUsers />} />
          <Route path="/admin/org" element={<AdminOrg />} />
          <Route path="/admin/settings" element={<AdminSettings />} />
          <Route path="/admin/courses/*" element={<Navigate to="/admin/knowledge" replace />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
    </div>
  );
}
