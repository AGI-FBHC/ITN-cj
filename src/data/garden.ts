/**
 * garden — 知识花园的品种与收获
 * 六个能力域各长一种植物（确定性映射，不随机）：网络上一眼能认出"这株是哪门课"，
 * 种子期也靠幼苗轮廓区分。掌握度过目标线 = 开花（收获），达 95 = 结果（金果）。
 * 收获记录（首次达成时间 + 当时分数）存本地，陈列在「我的成长」的温室区。
 */
export type Species = 'sunflower' | 'iris' | 'pine' | 'morningGlory' | 'bamboo' | 'mint';

export interface SpeciesMeta {
  key: Species;
  name: string;
  /** 为什么是这种植物——温室里讲给学习者听 */
  why: string;
}

export const SPECIES_OF: Record<string, SpeciesMeta> = {
  'kp-ds': { key: 'bamboo', name: '竹', why: '一节一节，像链表一节节连起来' },
  'kp-co': { key: 'pine', name: '松', why: '四季常青，像计算机底层架构一样稳固' },
  'kp-os': { key: 'morningGlory', name: '牵牛花', why: '顺着调度和线程的架子往上攀' },
  'kp-network': { key: 'iris', name: '鸢尾', why: '像网络一样层层互联、通达' },
  'kp-db': { key: 'mint', name: '薄荷', why: '药草——数据哪里出问题就治哪里' },
  'kp-agent': { key: 'sunflower', name: '向日葵', why: '智能体追着目标指令走，像追着太阳' },
};

export const speciesOf = (kpId: string): SpeciesMeta => SPECIES_OF[kpId] ?? SPECIES_OF['kp-ds'];

/* ================= 收获记录 ================= */
const KEY = 'lf.harvest';

export interface HarvestRecord {
  kpId: string;
  /** bloom 开花（过目标线）· fruit 结果（≥95） */
  stage: 'bloom' | 'fruit';
  /** 达成时的分数 */
  score: number;
  /** 达成日期 YYYY-MM-DD */
  date: string;
}

type Store = Record<string, HarvestRecord>;

const keyOf = (learnerId: string, kpId: string) => `${learnerId}:${kpId}`;

function read(): Store {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Store;
  } catch {
    return {};
  }
}

/**
 * 记录/升级一次收获（幂等）：只在首次开花、首次结果时写入，返回本次是否为新收获。
 * 由课件完课与掌握度变化处调用。
 */
export function recordHarvest(learnerId: string, kpId: string, score: number, target: number): HarvestRecord | null {
  const stage: HarvestRecord['stage'] | null = score >= 95 ? 'fruit' : score >= target ? 'bloom' : null;
  if (!stage) return null;
  const store = read();
  const k = keyOf(learnerId, kpId);
  const prev = store[k];
  /* 已经结果了就不再降级回开花 */
  if (prev && (prev.stage === 'fruit' || prev.stage === stage)) return null;
  const rec: HarvestRecord = {
    kpId,
    stage,
    score,
    date: new Date().toISOString().slice(0, 10),
  };
  store[k] = rec;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
  return rec;
}

/** 某学习者的全部收获 */
export function harvestsOf(learnerId: string): Record<string, HarvestRecord> {
  const store = read();
  const out: Record<string, HarvestRecord> = {};
  Object.entries(store).forEach(([k, v]) => {
    if (k.startsWith(`${learnerId}:`)) out[v.kpId] = v;
  });
  return out;
}
