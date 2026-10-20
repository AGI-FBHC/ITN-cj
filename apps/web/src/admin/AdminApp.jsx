import * as React from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { adminName, adminToken, clearAdminSession } from './admin-api.js';
import AdminLogin from './AdminLogin.jsx';
import AdminOverview from './AdminOverview.jsx';
import AdminUsers from './AdminUsers.jsx';
import AdminKnowledge from './AdminKnowledge.jsx';
import AdminSettings from './AdminSettings.jsx';

function navClass({ isActive }) {
  return isActive ? 'active' : undefined;
}

export default function AdminApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token, setToken] = React.useState(adminToken());
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const isLoginPath = path === '/admin/login';

  if (isLoginPath) {
    return (
      <AdminLogin
        onDone={() => {
          setToken(adminToken());
          navigate('/admin', { replace: true });
        }}
      />
    );
  }
  if (!token) return <Navigate to="/admin/login" replace />;

  return (
    <div className="zx-admin">
      <aside className="zx-admin-sidebar">
        <Link className="zx-admin-brand" to="/admin">
          <span className="zx-admin-mark" aria-hidden="true">智</span>
          <span>
            智训云枢
            <small>管理端</small>
          </span>
        </Link>
        <nav className="zx-admin-nav">
          <NavLink to="/admin" end className={navClass}>概览</NavLink>
          <NavLink to="/admin/knowledge" className={navClass}>知识库</NavLink>
          <NavLink to="/admin/users" className={navClass}>用户</NavLink>
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
      <main className="zx-admin-main">
        <Routes>
          <Route
            path="/admin"
            element={<AdminOverview onOpenCourse={(courseId) => navigate(courseId ? `/admin/courses/${courseId}` : '/admin/courses')} />}
          />
          <Route path="/admin/knowledge" element={<AdminKnowledge />} />
          <Route path="/admin/users" element={<AdminUsers />} />
          <Route path="/admin/settings" element={<AdminSettings />} />
          <Route path="/admin/courses/*" element={<Navigate to="/admin/knowledge" replace />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
    </div>
  );
}
