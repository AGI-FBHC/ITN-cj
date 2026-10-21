import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import App from './RecoveredApp.jsx';
import AdminApp from './admin/AdminApp.jsx';
import './tutor.js';
import { loadOrgBrand } from './org-brand.js';
import './styles.css';
import './login.css';
import './admin/admin.css';

// The admin console is a separate route tree so the recovered learner bundle stays untouched.
const isAdmin = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/');
if (!isAdmin) loadOrgBrand();
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>{isAdmin ? <AdminApp /> : <App />}</BrowserRouter>
  </React.StrictMode>
);
