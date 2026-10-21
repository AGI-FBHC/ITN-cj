import React from 'react';
import { api, refreshLearning } from './learning-api.jsx';

export const RESOURCE_OPTIONS = [
  { type: 'lecture', mode: 'lecture', label: '阅读讲义', detail: '阅读概念、案例与知识要点' },
  { type: 'guide', mode: 'guide', label: '动手实操', detail: '按步骤操作，查看代码和预期结果' },
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
  const resource = lesson?.resources?.[type];
  const raw = resource?.sections ?? (type === 'lecture' ? lesson?.content?.sections : []);
  const sections = (Array.isArray(raw) ? raw : []).filter((item) => item && textValue(item.text).trim()).map((item, index) => ({
    id: item.id || `${type}-${index}`,
    eyebrow: item.eyebrow || (type === 'guide' ? '实操指南' : '本章讲义'),
    heading: item.heading || `内容 ${index + 1}`,
    text: textValue(item.text),
    markdown: true,
  }));
  if (type !== 'guide' || !resource) return sections;
  const details = [];
  const add = (id, heading, text, eyebrow = '实操准备') => {
    if (text?.trim()) details.push({ id, heading, text, eyebrow, markdown: true });
  };
  add('guide-objective', '本次目标', textValue(resource.objective));
  add('guide-prerequisites', '开始之前', bulletList(resource.prerequisites));
  add('guide-environment', '运行环境', bulletList(resource.environment));
  add('guide-safety-notice', '操作提醒', textValue(resource.safetyNotice));
  add('guide-safety-checklist', '操作前检查', bulletList(resource.safetyChecklist));
  // Generated guide sections already contain the steps in some resource versions.
  // Prefer structured steps when supplied, so instructions, code and expected output
  // remain together in the same reader card.
  if (Array.isArray(resource.steps) && resource.steps.length) {
    resource.steps.forEach((step, index) => {
      const parts = [textValue(step.instruction ?? step.description ?? step.content)];
      if (step.code) {
        const code = textValue(step.code);
        const ticks = Math.max(3, ...(code.match(/`+/g) || []).map((part) => part.length + 1));
        const fence = '`'.repeat(ticks);
        parts.push(`${fence}${/^[a-z0-9_+-]+$/i.test(step.language || '') ? step.language : ''}\n${code}\n${fence}`);
      }
      if (step.expectedOutput || step.expectedResult) parts.push(`**预期结果**\n\n${textValue(step.expectedOutput ?? step.expectedResult)}`);
      if (step.warning) parts.push(`**操作提醒**\n\n${textValue(step.warning)}`);
      add(`guide-step-${step.id || index}`, step.title || `步骤 ${index + 1}`, parts.filter(Boolean).join('\n\n'), `步骤 ${index + 1}`);
    });
  } else {
    details.push(...sections);
  }
  add('guide-acceptance', '验收清单', bulletList(resource.acceptanceCriteria), '操作验证');
  const troubleshooting = asList(resource.troubleshooting).map((item) => typeof item === 'string' ? `- ${item}` : `- **${textValue(item.problem ?? item.symptom ?? item.title)}**：${textValue(item.solution ?? item.fix ?? item.description)}`).join('\n');
  add('guide-troubleshooting', '遇到问题时', troubleshooting, '操作提示');
  add('guide-challenge', '进阶挑战', textValue(resource.challenge), '拓展实践');
  return details;
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

export function ChapterCompletion({ course, index, lesson, onQuiz }) {
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
      await api(`/courses/${encodeURIComponent(course.id)}/lessons/${index}/progress`, 'PUT', { read: true, complete: true });
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
