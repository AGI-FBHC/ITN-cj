/**
 * PlcLadderDemo — PLC 联锁梯形图交互演示（课件 demo block）
 * 点击安全门 / 急停 / 启动三个元件，观察 K1 得电、自保持与"常闭断开即停"的联锁逻辑。
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, RotateCcw, AlertTriangle } from 'lucide-react';
import TraceBadge from '@/components/TraceBadge';

const GREEN = '#4E7860';
const RED = '#B0483B';
const GRAY = '#CFC8B8';
const AMBER = '#E7B45A';
const INK = '#3D4A3A';
const STRUCT = '#5A6553';

type Journey = 'idle' | 'started' | 'tripped' | 'ready' | 'done';

/** 触点符号：常闭(NC，带斜杠)/常开(NO)，颜色随通断态变化，可点击 */
function ContactGlyph({
  x,
  y,
  kind,
  tickColor,
  top,
  bottom,
  onClick,
  clickable,
  highlight,
}: {
  x: number;
  y: number;
  kind: 'NC' | 'NO';
  tickColor: string;
  top: string;
  bottom: string;
  onClick?: () => void;
  clickable: boolean;
  highlight: boolean;
}) {
  return (
    <g>
      {highlight && (
        <rect
          x={x - 22}
          y={y - 24}
          width={44}
          height={48}
          rx={6}
          fill="none"
          stroke={AMBER}
          strokeWidth="1.6"
          strokeDasharray="3 2"
        />
      )}
      <line x1={x - 5} y1={y - 8} x2={x - 5} y2={y + 8} stroke={tickColor} strokeWidth="2.4" />
      <line x1={x + 5} y1={y - 8} x2={x + 5} y2={y + 8} stroke={tickColor} strokeWidth="2.4" />
      {kind === 'NC' && (
        <line x1={x - 8} y1={y + 9} x2={x + 8} y2={y - 9} stroke={INK} strokeWidth="1.4" />
      )}
      <text x={x} y={y - 14} textAnchor="middle" fontSize="8" fontFamily="monospace" fill={STRUCT}>
        {top}
      </text>
      <text x={x} y={y + 21} textAnchor="middle" fontSize="7.5" fontFamily="monospace" fill={tickColor}>
        {bottom}
      </text>
      {onClick && (
        <rect
          x={x - 17}
          y={y - 17}
          width={34}
          height={38}
          fill="transparent"
          className={clickable ? 'cursor-pointer' : ''}
          onClick={clickable ? onClick : undefined}
        />
      )}
    </g>
  );
}

export default function PlcLadderDemo({ tourStep = null }: { tourStep?: number | null }) {
  const [doorOpen, setDoorOpen] = useState(false); // 安全门：true = 开
  const [estopPressed, setEstopPressed] = useState(false); // 急停：true = 按下
  const [k1, setK1] = useState(false); // K1 线圈得电（含自保持）
  const [sb2Flash, setSb2Flash] = useState(false); // 启动按钮瞬时按下的视觉反馈
  const [journey, setJourney] = useState<Journey>('idle');
  const touring = tourStep !== null;

  const sq1Closed = !doorOpen;
  const sb1Closed = !estopPressed;
  const reachedA = sq1Closed && sb1Closed;

  /* 联锁：任一常闭断开，K1 立即失电，不会自动恢复 */
  useEffect(() => {
    if (touring) return;
    if (k1 && !(sq1Closed && sb1Closed)) setK1(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doorOpen, estopPressed, touring]);

  /* 记录学习历程：启动 → 运行 → 开门跳闸 → 关门仍停 → 再次启动才算完成 */
  useEffect(() => {
    if (touring) return;
    setJourney((prev) => {
      if (prev === 'idle' && k1) return 'started';
      if (prev === 'started' && doorOpen && !k1) return 'tripped';
      if (prev === 'tripped' && !doorOpen && !k1) return 'ready';
      if (prev === 'ready' && k1) return 'done';
      return prev;
    });
  }, [k1, doorOpen, touring]);

  /* 语音导览：0=整体结构 1=启动得电 2=自保持 3=开门跳闸 */
  useEffect(() => {
    if (tourStep === null) return;
    if (tourStep === 0) {
      setDoorOpen(false);
      setEstopPressed(false);
      setK1(false);
    } else if (tourStep === 1) {
      setDoorOpen(false);
      setEstopPressed(false);
      setK1(true);
    } else if (tourStep === 2) {
      setDoorOpen(false);
      setEstopPressed(false);
      setK1(true);
    } else if (tourStep === 3) {
      setDoorOpen(true);
      setEstopPressed(false);
      setK1(false);
    }
  }, [tourStep]);

  const toggleDoor = () => {
    if (touring) return;
    setDoorOpen((d) => !d);
  };
  const toggleEstop = () => {
    if (touring) return;
    setEstopPressed((v) => !v);
  };
  const pressStart = () => {
    if (touring) return;
    setSb2Flash(true);
    setTimeout(() => setSb2Flash(false), 200);
    if (sq1Closed && sb1Closed) setK1(true);
  };
  const reset = () => {
    setDoorOpen(false);
    setEstopPressed(false);
    setK1(false);
    setJourney('idle');
  };

  const complete = journey === 'done';
  const nodeBPowered = k1 || (reachedA && sb2Flash);
  const branchPowered = reachedA && k1;

  const highlightAll = touring && tourStep === 0;
  const highlightEnergize = touring && tourStep === 1;
  const highlightSelfHold = touring && tourStep === 2;
  const highlightTrip = touring && tourStep === 3;

  const hint =
    journey === 'idle'
      ? doorOpen || estopPressed
        ? '先恢复安全门和急停（常闭），再按「启动」触点'
        : '点击「启动」触点，让 K1 得电运行'
      : journey === 'started'
        ? '现在试着打开安全门，看看联锁怎么响应'
        : journey === 'tripped'
          ? '把安全门关上——注意 K1 不会自动恢复'
          : journey === 'ready'
            ? '再次点击「启动」触点，验证必须重新起动'
            : '已完成一轮联锁验证';

  const Y1 = 55;
  const Y2 = 100;
  const BUS_L = 20;
  const BUS_R = 415;
  const SQ1_X = 80;
  const SB1_X = 150;
  const NODE_A = 205;
  const SB2_X = 275;
  const NODE_B = 335;
  const COIL_L = 358;
  const COIL_R = 392;
  const LAMP_X = 440;

  return (
    <div className="rounded-[12px] border border-brand/25 bg-paper p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10.5px] tracking-wide text-ink-muted">
          INTERACTIVE · 点击安全门 / 急停 / 启动触点，验证联锁
        </span>
        <span className="flex items-center gap-2">
          <TraceBadge kbId="KB-012" />
          <button
            type="button"
            onClick={reset}
            disabled={touring}
            className="inline-flex items-center gap-1 rounded-md border border-hairline bg-card-warm px-2 py-1 text-[11px] text-ink-muted hover:text-ink disabled:opacity-50"
          >
            <RotateCcw size={11} /> 重来
          </button>
        </span>
      </div>

      <svg viewBox="0 0 480 150" className="w-full rounded-[8px] border border-hairline bg-card-warm">
        {highlightAll && (
          <rect
            x={8}
            y={12}
            width={462}
            height={126}
            rx={8}
            fill="none"
            stroke={AMBER}
            strokeWidth="1.6"
            strokeDasharray="4 3"
          />
        )}

        {/* 母线 */}
        <line x1={BUS_L} y1={25} x2={BUS_L} y2={125} stroke={STRUCT} strokeWidth="2.4" />
        <line x1={BUS_R} y1={25} x2={BUS_R} y2={125} stroke={STRUCT} strokeWidth="2.4" />
        <text x={BUS_L - 10} y={20} fontSize="8" fontFamily="monospace" fill={STRUCT}>L+</text>
        <text x={BUS_R - 6} y={20} fontSize="8" fontFamily="monospace" fill={STRUCT}>L-</text>

        {/* 横档 1 主路径 */}
        <line x1={BUS_L} y1={Y1} x2={SQ1_X - 17} y2={Y1} stroke={GREEN} strokeWidth="2.2" />
        <ContactGlyph
          x={SQ1_X}
          y={Y1}
          kind="NC"
          tickColor={doorOpen ? RED : GREEN}
          top="SQ1 安全门"
          bottom={doorOpen ? '常闭·已开启' : '常闭·已闭合'}
          onClick={toggleDoor}
          clickable={!touring}
          highlight={highlightAll || highlightTrip}
        />
        <line
          x1={SQ1_X + 17}
          y1={Y1}
          x2={SB1_X - 17}
          y2={Y1}
          stroke={sq1Closed ? GREEN : GRAY}
          strokeWidth="2.2"
        />
        <ContactGlyph
          x={SB1_X}
          y={Y1}
          kind="NC"
          tickColor={estopPressed ? RED : sq1Closed ? GREEN : GRAY}
          top="SB1 急停"
          bottom={estopPressed ? '常闭·已按下' : '常闭·已复位'}
          onClick={toggleEstop}
          clickable={!touring}
          highlight={highlightAll}
        />
        <line
          x1={SB1_X + 17}
          y1={Y1}
          x2={NODE_A}
          y2={Y1}
          stroke={reachedA ? GREEN : GRAY}
          strokeWidth="2.2"
        />
        <circle cx={NODE_A} cy={Y1} r="3" fill={reachedA ? GREEN : GRAY} />

        <line
          x1={NODE_A}
          y1={Y1}
          x2={SB2_X - 17}
          y2={Y1}
          stroke={reachedA ? GREEN : GRAY}
          strokeWidth="2.2"
        />
        <ContactGlyph
          x={SB2_X}
          y={Y1}
          kind="NO"
          tickColor={reachedA && sb2Flash ? GREEN : GRAY}
          top="SB2 启动"
          bottom="常开·瞬动"
          onClick={pressStart}
          clickable={!touring}
          highlight={highlightAll || highlightEnergize}
        />
        <line
          x1={SB2_X + 17}
          y1={Y1}
          x2={NODE_B}
          y2={Y1}
          stroke={nodeBPowered ? GREEN : GRAY}
          strokeWidth="2.2"
        />
        <circle cx={NODE_B} cy={Y1} r="3" fill={nodeBPowered ? GREEN : GRAY} />

        <line
          x1={NODE_B}
          y1={Y1}
          x2={COIL_L}
          y2={Y1}
          stroke={nodeBPowered ? GREEN : GRAY}
          strokeWidth="2.2"
        />
        <motion.rect
          x={COIL_L}
          y={Y1 - 13}
          width={COIL_R - COIL_L}
          height={26}
          rx={13}
          fill={nodeBPowered ? '#E9F2EC' : '#F0EEE3'}
          stroke={nodeBPowered ? GREEN : GRAY}
          strokeWidth="2"
          animate={highlightEnergize ? { scale: [1, 1.08, 1] } : { scale: 1 }}
          transition={{ duration: 0.7, repeat: highlightEnergize ? Infinity : 0 }}
        />
        <text
          x={(COIL_L + COIL_R) / 2}
          y={Y1 + 4}
          textAnchor="middle"
          fontSize="9"
          fontFamily="monospace"
          fontWeight={600}
          fill={nodeBPowered ? GREEN : '#66725E'}
        >
          K1
        </text>
        <line
          x1={COIL_R}
          y1={Y1}
          x2={BUS_R}
          y2={Y1}
          stroke={nodeBPowered ? GREEN : GRAY}
          strokeWidth="2.2"
        />

        {/* 输出指示灯 */}
        <line
          x1={BUS_R}
          y1={Y1}
          x2={LAMP_X - 12}
          y2={Y1}
          stroke={nodeBPowered ? GREEN : GRAY}
          strokeWidth="1.6"
          strokeDasharray="3 2"
        />
        <circle
          cx={LAMP_X}
          cy={Y1}
          r="12"
          fill={nodeBPowered ? GREEN : '#F0EEE3'}
          stroke={nodeBPowered ? GREEN : GRAY}
          strokeWidth="1.6"
        />
        <text
          x={LAMP_X}
          y={Y1 + 3}
          textAnchor="middle"
          fontSize="8"
          fontFamily="monospace"
          fill={nodeBPowered ? '#F7F5EE' : '#66725E'}
        >
          M
        </text>
        <text x={LAMP_X} y={Y1 + 26} textAnchor="middle" fontSize="7.5" fontFamily="monospace" fill={nodeBPowered ? GREEN : '#66725E'}>
          {nodeBPowered ? '电机运行' : '电机停止'}
        </text>

        {/* 横档 2：K1 自保持支路，并联跨过 SB2 */}
        {highlightSelfHold && (
          <rect
            x={NODE_A - 14}
            y={Y2 - 22}
            width={NODE_B - NODE_A + 28}
            height={44}
            rx={8}
            fill="none"
            stroke={AMBER}
            strokeWidth="1.6"
            strokeDasharray="4 3"
          />
        )}
        <line x1={NODE_A} y1={Y1} x2={NODE_A} y2={Y2} stroke={reachedA ? GREEN : GRAY} strokeWidth="2.2" />
        <line
          x1={NODE_A}
          y1={Y2}
          x2={SB2_X - 17}
          y2={Y2}
          stroke={reachedA ? GREEN : GRAY}
          strokeWidth="2.2"
        />
        <ContactGlyph
          x={SB2_X}
          y={Y2}
          kind="NO"
          tickColor={branchPowered ? GREEN : GRAY}
          top="K1 辅助触点"
          bottom={branchPowered ? '常开·已自保持' : '常开·未闭合'}
          clickable={false}
          highlight={highlightSelfHold}
        />
        <line
          x1={SB2_X + 17}
          y1={Y2}
          x2={NODE_B}
          y2={Y2}
          stroke={branchPowered ? GREEN : GRAY}
          strokeWidth="2.2"
        />
        <line x1={NODE_B} y1={Y2} x2={NODE_B} y2={Y1} stroke={branchPowered ? GREEN : GRAY} strokeWidth="2.2" />
      </svg>

      <div className="mt-2.5 font-mono text-[11px] leading-[16px] text-ink-muted">
        {!touring && hint}
      </div>

      <AnimatePresence>
        {!touring && (doorOpen || estopPressed) && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-2.5 flex items-center gap-1.5 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-2.5 py-1.5 text-[12px] text-brand-danger"
          >
            <AlertTriangle size={13} />
            常闭断开即停——故障导向安全（{doorOpen ? '安全门开启' : '急停按下'}），K1 立即失电。
          </motion.div>
        )}
        {complete && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mt-2.5 flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand-tint px-2.5 py-1.5 text-[12px] font-medium text-brand"
          >
            <Check size={13} />
            你已经验证了联锁与自保持：开门即停，恢复后必须重新启动。
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
