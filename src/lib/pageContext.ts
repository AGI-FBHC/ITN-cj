export interface LearningPageContext {
  version: 1;
  route: string;
  pageType: string;
  pageTitle: string;
  capturedAt: string;
  selection?: string;
  focus?: { kind: string; title?: string; text: string; index?: number; total?: number; state?: Record<string, string> };
  dialog?: { title?: string; text: string };
  headings: string[];
  visibleText: string;
  entities: Record<string, string>;
  interaction?: {
    kind: 'quiz' | 'practice' | 'reading' | 'page';
    submitted?: boolean;
    selectedAnswer?: string;
    correct?: boolean;
    answerIndex?: string;
    assessed?: boolean;
    assessment?: string;
    completed?: boolean;
    stepCompleted?: boolean;
    progress?: string;
  };
}

const PAGE_TYPES: Array<[RegExp, string]> = [
  [/^\/me\/notes/, '我的笔记'], [/^\/me\/wrong/, '错题本'], [/^\/me\/profile/, '个人资料'],
  [/^\/me/, '我的学习'], [/^\/learn\/slide\//, '幻灯片学习'],
  [/^\/learn\/resource\//, '完整阅读'], [/^\/learn\/customize-team\//, 'AI教研组'],
  [/^\/learn\/customize\//, '资源定制'],
  [/^\/learn\/[^/]+/, '知识点学习'], [/^\/learn/, '知识网络'],
  [/^\/report/, '成长报告'], [/^\/profiles/, '学情画像'], [/^\/resources/, '资源生成'],
  [/^\/tutoring/, '交互导学'], [/^\/knowledge/, '知识库'], [/^\/agents/, '协同调度'],
  [/^\/chat/, '伴学对话'], [/^\/$/, '系统总览'],
];

const clean = (value: string | null | undefined, max: number) =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function visible(element: Element): boolean {
  const html = element as HTMLElement;
  const style = window.getComputedStyle(html);
  const rect = html.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    && rect.bottom >= 0 && rect.top <= window.innerHeight;
}

function entityIds(route: string): Record<string, string> {
  const parts = route.split('/').filter(Boolean);
  const entities: Record<string, string> = {};
  const uuid = route.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
  if (uuid) entities.resourceOrTaskId = uuid;
  if (parts[0] === 'learn' && parts.length === 2) entities.knowledgePointId = parts[1];
  document.querySelectorAll<HTMLElement>('[data-assistant-context]').forEach((element) => {
    Object.entries(element.dataset).forEach(([key, value]) => {
      if (key.startsWith('context') && value) entities[key.slice(7, 8).toLowerCase() + key.slice(8)] = clean(value, 160);
    });
  });
  return entities;
}

function elementContext(element: HTMLElement | null, kind: string) {
  if (!element || !visible(element)) return undefined;
  const title = clean(element.dataset.contextTitle || element.querySelector('h1,h2,h3,h4,[data-context-title]')?.textContent, 240);
  const text = clean(element.dataset.contextText || element.innerText, 6000);
  if (!text) return undefined;
  const index = Number(element.dataset.contextIndex);
  const total = Number(element.dataset.contextTotal);
  const state: Record<string, string> = {};
  const seen = new Set(['kind', 'title', 'text', 'index', 'total']);
  for (const el of [element, ...element.querySelectorAll<HTMLElement>('*')]) {
    for (const [key, value] of Object.entries(el.dataset)) {
      if (!key.startsWith('context') || !value) continue;
      const name = key.slice(7).replace(/^./, (c) => c.toLowerCase());
      if (!name || seen.has(name)) continue;
      state[name] = clean(value, 300);
    }
  }
  return {
    kind: element.dataset.contextKind || kind,
    ...(title ? { title } : {}),
    text,
    ...(Number.isFinite(index) ? { index } : {}),
    ...(Number.isFinite(total) ? { total } : {}),
    ...(Object.keys(state).length ? { state } : {}),
  };
}

function buildInteraction(focus: NonNullable<LearningPageContext['focus']>): LearningPageContext['interaction'] | undefined {
  const s = focus.state ?? {};
  const hasQuiz = focus.kind === '当前题目' || s.quizSubmitted !== undefined || s.selectedAnswer !== undefined;
  if (hasQuiz) {
    return {
      kind: 'quiz',
      ...(s.quizSubmitted !== undefined ? { submitted: s.quizSubmitted === 'true' } : {}),
      ...(s.selectedAnswer ? { selectedAnswer: s.selectedAnswer } : {}),
      ...(s.quizCorrect !== undefined ? { correct: s.quizCorrect === 'true' } : {}),
      ...(s.answerIndex ? { answerIndex: s.answerIndex } : {}),
    };
  }
  const hasState = s.assessed !== undefined || s.assessment || s.progress || s.completed !== undefined || s.stepCompleted !== undefined || s.currentPage;
  if (!hasState) return undefined;
  return {
    kind: focus.kind.includes('实操') ? 'practice' : focus.kind.includes('阅读') ? 'reading' : 'page',
    ...(s.assessed !== undefined ? { assessed: s.assessed === 'true' } : {}),
    ...(s.assessment ? { assessment: s.assessment } : {}),
    ...(s.completed !== undefined ? { completed: s.completed === 'true' } : {}),
    ...(s.stepCompleted !== undefined ? { stepCompleted: s.stepCompleted === 'true' } : {}),
    ...(s.progress ? { progress: s.progress } : {}),
  };
}

export function collectLearningPageContext(): LearningPageContext {
  const route = `${window.location.pathname}${window.location.search}`;
  const pageType = PAGE_TYPES.find(([pattern]) => pattern.test(window.location.pathname))?.[1] ?? '学习页面';
  const main = document.querySelector('main') ?? document.body;
  const selection = clean(window.getSelection()?.toString(), 2000);
  const dialogElement = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((element) => !element.closest('[data-agent-dock]') && visible(element)) ?? null;
  const focusElement = [...document.querySelectorAll<HTMLElement>(
    '[data-assistant-focus="true"], [data-assistant-context][aria-current="true"], [data-assistant-context]',
  )].find(visible) ?? null;
  const focus = elementContext(focusElement, '当前内容');
  const interaction = focus ? buildInteraction(focus) : undefined;
  const dialog = elementContext(dialogElement, '当前弹窗');
  const headings = [...main.querySelectorAll('h1,h2,h3')].filter(visible)
    .map((element) => clean(element.textContent, 160)).filter(Boolean).slice(0, 12);
  const visiblePieces = [...main.querySelectorAll<HTMLElement>('p,li,pre,code,article,[data-assistant-visible]')]
    .filter((element) => visible(element) && !element.closest('[data-agent-dock]'))
    .map((element) => clean(element.innerText, 1000)).filter(Boolean);
  const visibleText = clean([...new Set(visiblePieces)].join('\n'), 6000);
  const snapshot: LearningPageContext = {
    version: 1,
    route,
    pageType,
    pageTitle: clean(headings[0] || document.title || pageType, 200),
    capturedAt: new Date().toISOString(),
    ...(selection ? { selection } : {}),
    ...(focus ? { focus } : {}),
    ...(dialog ? { dialog: { title: dialog.title, text: dialog.text } } : {}),
    headings,
    visibleText,
    entities: entityIds(route),
    ...(interaction ? { interaction } : {}),
  };
  try {
    if (pageType === '伴学对话') {
      const saved = sessionStorage.getItem('lf.last-learning-page-context');
      if (saved) return JSON.parse(saved) as LearningPageContext;
    } else {
      sessionStorage.setItem('lf.last-learning-page-context', JSON.stringify(snapshot));
    }
  } catch { /* storage is optional */ }
  return snapshot;
}

export function describeLearningPageContext(context: LearningPageContext): string {
  const focus = context.selection
    ? `已选择“${clean(context.selection, 32)}”`
    : context.focus?.title || context.dialog?.title || context.headings[0];
  return focus ? `${context.pageType} · ${focus}` : context.pageType;
}
