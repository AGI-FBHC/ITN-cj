import React from 'react';
import { api, refreshLearning } from './learning-api.jsx';
import { lessonReferences, normalizeCoursewareCitations } from './courseware-references.js';

export const RESOURCE_OPTIONS = [
  { type: 'lecture', mode: 'lecture', label: '阅读讲义', detail: '阅读概念、案例与知识要点' },
  { type: 'slides', mode: 'presentation', label: '幻灯片学习', detail: '逐页浏览本章重点' },
  { type: 'bank', mode: 'quiz', label: '章节测验', detail: '完成题目，查看判分与解析' },
];

export function resourceTypes(value) {
  const declared = value?.resourceTypes ?? (Array.isArray(value?.resources) ? value.resources : null);
  if (Array.isArray(declared)) return RESOURCE_OPTIONS.map((item) => item.type).filter((type) => declared.includes(type));
  const resources = value?.resources;
  if (resources && typeof resources === 'object') return RESOURCE_OPTIONS.map((item) => item.type).filter((type) => resources[type]);
  const types = [];
  if (value?.content?.sections?.length) types.push('lecture');
  if (value?.content?.slides?.length) types.push('slides');
  if (value?.questions?.length) types.push('bank');
  return types;
}

const textValue = (value) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const asList = (value) => Array.isArray(value) ? value : value ? [value] : [];
const bulletList = (value) => asList(value).map((item) => `- ${textValue(item)}`).join('\n');

export function lessonSections(lesson, type = 'lecture') {
  const references = lessonReferences(lesson, type);
  const resource = lesson?.resources?.[type];
  const raw = resource?.sections ?? (type === 'lecture' ? lesson?.content?.sections : []);
  const sections = (Array.isArray(raw) ? raw : []).filter((item) => item && textValue(item.text).trim()).map((item, index) => ({
    id: item.id || `${type}-${index}`,
    eyebrow: item.eyebrow || '本章讲义',
    heading: normalizeCoursewareCitations(item.heading || `内容 ${index + 1}`, []),
    text: normalizeCoursewareCitations(textValue(item.text), references),
    markdown: true,
  }));
  return sections;
}

export function lessonSlides(lesson) {
  const slides = lesson?.resources?.slides?.slides ?? lesson?.content?.slides ?? [];
  return (Array.isArray(slides) ? slides : []).filter((slide) => slide && (slide.title || slide.bullets?.length || slide.points?.length)).map((slide, index) => ({
    kicker: `本章幻灯片 · ${index + 1}`,
    title: textValue(slide.title),
    subtitle: textValue(slide.subtitle),
    points: asList(slide.bullets ?? slide.points).map(textValue),
    narration: textValue(slide.notes ?? slide.narration),
    accent: ['#b8a3ff', '#7dc9fa', '#f5c98e'][index % 3],
  }));
}

export function ChapterCompletion({ course, index, lesson, onQuiz, resourceKind = '' }) {
  const lessonKey = `${course.id}:${index}`;
  const currentKey = React.useRef(lessonKey);
  currentKey.current = lessonKey;
  const [state, setState] = React.useState({ lessonKey, saving: false, completed: false, error: '' });
  React.useEffect(() => {
    setState({ lessonKey, saving: false, completed: false, error: '' });
  }, [lessonKey]);
  const current = state.lessonKey === lessonKey;
  const completed = Boolean(lesson?.progress?.completed || course.chapters?.[index]?.done || (current && state.completed));
  const saving = current && state.saving;
  const error = current ? state.error : '';
  const hasQuiz = lesson?.completion?.requiresQuiz ?? resourceTypes(lesson).includes('bank');
  const markComplete = async () => {
    setState({ lessonKey, saving: true, completed: false, error: '' });
    try {
      await api(`/courses/${encodeURIComponent(course.id)}/lessons/${index}/progress`, 'PUT', {
        read: true,
        complete: true,
        ...(resourceKind ? { resourceKind, resourceVersion: lesson?.resourceVersions?.[resourceKind] } : {}),
      });
      await refreshLearning();
      if (currentKey.current === lessonKey) setState({ lessonKey, saving: false, completed: true, error: '' });
    } catch (error) {
      if (currentKey.current === lessonKey) setState({ lessonKey, saving: false, completed: false, error: error.message });
    }
  };
  return <section className="mt-6 rounded-3xl bg-[#f7f5fc] px-7 py-8 text-center sm:px-10">
    <h2 className="text-2xl font-black text-[#111318]">{completed ? '本章已完成' : '学到这里，检验一下收获'}</h2>
    <p className="mt-3 text-sm font-semibold leading-6 text-[#777b85]">{completed ? '学习进度已保存，可以随时回来复习。' : hasQuiz ? `完成章节测验并达到 ${lesson?.completion?.passScore ?? 60} 分，即可完成本章。` : '按需学习本章资料，完成后保存学习进度。'}</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
    <button type="button" disabled={saving || completed} onClick={hasQuiz ? onQuiz : markComplete} className="mt-5 min-h-11 w-full max-w-md rounded-xl bg-[#6038ef] px-6 py-3.5 text-base font-black text-white shadow-[0_7px_18px_rgba(96,56,239,0.22)] transition hover:bg-[#512bdc] disabled:cursor-default disabled:opacity-60">
      {saving ? '正在保存…' : completed ? '已保存进度' : hasQuiz ? '开始章节测验' : '学完本章'}
    </button>
  </section>;
}
