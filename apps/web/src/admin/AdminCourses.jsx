import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, StatusPill, useLoad } from './admin-ui.jsx';

const EMPTY_FORM = { id: '', name: '', description: '', level: '入门', duration: 60, sourceLabel: '管理员创建' };

export default function AdminCourses() {
  const navigate = useNavigate();
  const state = useLoad(() => adminApi.courses(), []);
  const [form, setForm] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState('');
  const [message, setMessage] = React.useState('');

  async function toggleStatus(course) {
    setBusy(course.id);
    setError('');
    setMessage('');
    try {
      const next = course.status === 'published' ? 'draft' : 'published';
      await adminApi.setCourseStatus(course.id, next);
      setMessage(`《${course.name}》已${next === 'published' ? '发布' : '下架'}。`);
      state.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }

  async function create(event) {
    event.preventDefault();
    if (!form) return;
    setBusy('create');
    setError('');
    try {
      const created = await adminApi.createCourse({
        ...form,
        id: form.id.trim(),
        name: form.name.trim(),
        duration: Number(form.duration) || 0,
      });
      navigate(`/admin/courses/${created.course.id}`);
    } catch (failure) {
      setError(failure.message);
      setBusy('');
    }
  }

  if (state.loading && !state.data) return <Loading label="正在读取课程列表…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;

  const courses = state.data.courses || [];

  return (
    <div className="zx-admin-page">
      <PageHead
        title="课程"
        description="课程按这里的顺序出现在学习端。新建的课程默认是草稿，确认内容后再发布。"
        actions={
          <>
            <button type="button" className="zx-btn zx-btn-ghost" onClick={state.reload}>刷新</button>
            <button
              type="button"
              className="zx-btn zx-btn-primary"
              onClick={() => { setForm(form ? null : { ...EMPTY_FORM }); setError(''); }}
            >
              {form ? '取消新建' : '新建课程'}
            </button>
          </>
        }
      />

      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="ok">{message}</Notice> : null}

      {form ? (
        <form className="zx-card" onSubmit={create} style={{ marginBottom: 16 }}>
          <h2 className="zx-card-title">新建课程</h2>
          <div className="zx-form">
            <div className="zx-field">
              <label htmlFor="course-id">课程编号</label>
              <input
                id="course-id"
                value={form.id}
                placeholder="例如 python-basics"
                onChange={(event) => setForm({ ...form, id: event.target.value })}
                required
              />
              <small>用作地址里的标识，发布后不建议再改：小写字母、数字、横线。</small>
            </div>
            <div className="zx-field">
              <label htmlFor="course-name">课程名称</label>
              <input
                id="course-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
              />
            </div>
            <div className="zx-field">
              <label htmlFor="course-level">难度</label>
              <input
                id="course-level"
                value={form.level}
                onChange={(event) => setForm({ ...form, level: event.target.value })}
              />
            </div>
            <div className="zx-field">
              <label htmlFor="course-duration">建议时长（分钟）</label>
              <input
                id="course-duration"
                type="number"
                min="0"
                value={form.duration}
                onChange={(event) => setForm({ ...form, duration: event.target.value })}
              />
            </div>
            <div className="zx-field">
              <label htmlFor="course-source">来源标注</label>
              <input
                id="course-source"
                value={form.sourceLabel}
                onChange={(event) => setForm({ ...form, sourceLabel: event.target.value })}
              />
              <small>会显示在学习端，用来说明内容出处。</small>
            </div>
            <div className="zx-field zx-field-full">
              <label htmlFor="course-description">课程简介</label>
              <textarea
                id="course-description"
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <button type="submit" className="zx-btn zx-btn-primary" disabled={busy === 'create'}>
              {busy === 'create' ? '正在创建…' : '创建并继续添加课时'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="zx-card">
        <table className="zx-table">
          <thead>
            <tr>
              <th>课程</th>
              <th>状态</th>
              <th>课时</th>
              <th>更新时间</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {courses.map((course) => (
              <tr key={course.id}>
                <td>
                  <div className="zx-cell-title">{course.name}</div>
                  <div className="zx-cell-sub">{course.id} · {course.level} · {course.duration} 分钟</div>
                </td>
                <td><StatusPill status={course.status} /></td>
                <td className="zx-num">{course.lessonCount} 节</td>
                <td className="zx-num">{course.updatedAt || '—'}</td>
                <td className="zx-actions">
                  <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" onClick={() => navigate(`/admin/courses/${course.id}`)}>
                    编辑内容
                  </button>
                  <button
                    type="button"
                    className="zx-btn zx-btn-sm"
                    disabled={busy === course.id}
                    onClick={() => toggleStatus(course)}
                  >
                    {course.status === 'published' ? '下架' : '发布'}
                  </button>
                </td>
              </tr>
            ))}
            {courses.length === 0 ? (
              <tr><td colSpan={5}><div className="zx-empty">还没有课程，先新建一门。</div></td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
