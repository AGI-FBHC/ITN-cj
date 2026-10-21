export const DETAIL_LEVELS = [
  { value: 'concise', label: '精简', description: '重点结论，适合快速浏览' },
  { value: 'standard', label: '标准', description: '保持当前的完整度' },
  { value: 'detailed', label: '详细', description: '增加案例、练习和讲解' },
];

export const PPT_BACKGROUNDS = [
  { value: '', label: '系统默认（推荐）', preview: '/presentation-backgrounds/clean-minimal.jpg' },
  { value: 'clean-minimal', label: '极简留白', preview: '/presentation-backgrounds/clean-minimal.jpg' },
  { value: 'colorful-ink', label: '彩墨', preview: '/presentation-backgrounds/colorful-ink.jpg' },
  { value: 'sunset-mountains', label: '落日山脉', preview: '/presentation-backgrounds/sunset-mountains.jpg' },
  { value: 'abstract-gradient', label: '抽象渐变', preview: '/presentation-backgrounds/abstract-gradient.jpg' },
  { value: 'cartoon-doodle', label: '卡通涂鸦', preview: '/presentation-backgrounds/cartoon-doodle.jpg' },
  { value: 'blue-white-minimal', label: '蓝白极简', preview: '/presentation-backgrounds/blue-white-minimal.jpg' },
  { value: 'blue-conference', label: '蓝色会议', preview: '/presentation-backgrounds/blue-conference.jpg' },
  { value: 'morandi-blue-gray', label: '莫兰迪蓝灰', preview: '/presentation-backgrounds/morandi-blue-gray.jpg' },
  { value: 'business-gray', label: '商务灰', preview: '/presentation-backgrounds/business-gray.jpg' },
  { value: 'watercolor', label: '水彩', preview: '/presentation-backgrounds/watercolor.jpg' },
  { value: 'none', label: '无背景', preview: '' },
];

export const DEFAULT_GENERATION_OPTIONS = Object.freeze({
  lectureDetailLevel: 'standard',
  guideDetailLevel: 'standard',
  questionCount: 8,
  slideCount: 12,
  backgroundStyle: '',
  includeSpeakerNotes: true,
  note: '',
});

const DETAIL_LABEL = Object.fromEntries(DETAIL_LEVELS.map((item) => [item.value, item.label]));
const BACKGROUND_LABEL = Object.fromEntries(PPT_BACKGROUNDS.map((item) => [item.value, item.label]));

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function detailLevelOf(source, kind) {
  const specific = kind === 'guide' ? source.guideDetailLevel : source.lectureDetailLevel;
  const legacy = source.detailLevel;
  const candidate = specific || legacy;
  return DETAIL_LABEL[candidate] ? candidate : DEFAULT_GENERATION_OPTIONS[`${kind}DetailLevel`];
}

export function normalizeGenerationOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    lectureDetailLevel: detailLevelOf(source, 'lecture'),
    guideDetailLevel: detailLevelOf(source, 'guide'),
    questionCount: clampNumber(source.questionCount, 5, 20, DEFAULT_GENERATION_OPTIONS.questionCount),
    slideCount: clampNumber(source.slideCount, 8, 20, DEFAULT_GENERATION_OPTIONS.slideCount),
    backgroundStyle: typeof source.backgroundStyle === 'string'
      ? source.backgroundStyle
      : DEFAULT_GENERATION_OPTIONS.backgroundStyle,
    includeSpeakerNotes: typeof source.includeSpeakerNotes === 'boolean'
      ? source.includeSpeakerNotes
      : DEFAULT_GENERATION_OPTIONS.includeSpeakerNotes,
    note: typeof source.note === 'string' ? source.note.slice(0, 300) : '',
  };
}

export function generationOptionChips(kind, raw) {
  const options = normalizeGenerationOptions(raw);
  if (kind === 'lecture' || kind === 'guide') {
    const level = kind === 'guide' ? options.guideDetailLevel : options.lectureDetailLevel;
    return [`详细程度：${DETAIL_LABEL[level]}`];
  }
  if (kind === 'bank') {
    return [`题目数量：${options.questionCount} 题`];
  }
  if (kind === 'slides') {
    return [
      `页数：${options.slideCount} 页`,
      `背景：${BACKGROUND_LABEL[options.backgroundStyle] || '系统默认（推荐）'}`,
      options.includeSpeakerNotes ? '讲者备注：生成' : '讲者备注：不生成',
    ];
  }
  return [];
}

export function resourceOptionSummary(kind, raw) {
  const options = normalizeGenerationOptions(raw);
  if (kind === 'lecture') return DETAIL_LABEL[options.lectureDetailLevel];
  if (kind === 'guide') return DETAIL_LABEL[options.guideDetailLevel];
  if (kind === 'bank') return `${options.questionCount} 题`;
  if (kind === 'slides') {
    return `${options.slideCount} 页 · ${options.includeSpeakerNotes ? '含讲稿' : '不含讲稿'}`;
  }
  return '';
}

export function generationOptionsAreDefault(raw) {
  const options = normalizeGenerationOptions(raw);
  return options.lectureDetailLevel === DEFAULT_GENERATION_OPTIONS.lectureDetailLevel
    && options.guideDetailLevel === DEFAULT_GENERATION_OPTIONS.guideDetailLevel
    && options.questionCount === DEFAULT_GENERATION_OPTIONS.questionCount
    && options.slideCount === DEFAULT_GENERATION_OPTIONS.slideCount
    && options.backgroundStyle === DEFAULT_GENERATION_OPTIONS.backgroundStyle
    && options.includeSpeakerNotes === DEFAULT_GENERATION_OPTIONS.includeSpeakerNotes
    && options.note.trim() === '';
}
