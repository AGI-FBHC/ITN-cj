/**
 * SafetyLoopDemo — 安全回路串联链路交互演示（课件 demo block）
 * 触发急停 / 光幕 / 门锁任一环节，观察链路断开、复位「就绪」与必须人工再启动的区别。
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, RotateCcw, AlertTriangle, Power, Play } from 'lucide-react';
import TraceBadge from '@/components/TraceBadge';
import { cn } from '@/lib/utils';

const GREEN = '#4E7860';
const RED = '#B0483B';
const GRAY = '#CFC8B8';
const AMBER = '#E7B45A';
const STRUCT = '#5A6553';

type Journey = 'idle' | 'tripped' | 'recovered' | 'readied' | 'done';
type Shape = 'estop' | 'curtain' | 'lock';

/** 安全器件方框：常闭触点，颜色随状态变化，可点击触发/恢复 */
function DeviceGlyph({
  x,
  y,
  shape,
  color,
  top,
  bottom,
  onClick,
  clickable,
  highlight,
}: {
  x: number;
  y: number;
  shape: Shape;
  color: string;
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
          x={x - 26}
          y={y - 30}
          width={52}
          height={62}
          rx={8}
          fill="none"
          stroke={AMBER}
          strokeWidth="1.6"
          strokeDasharray="4 3"
        />
      )}
      <rect x={x - 18} y={y - 16} width={36} height={32} rx={6} fill="#FBFAF5" stroke={color} strokeWidth="2" />
      {shape === 'estop' && <circle cx={x} cy={y} r="9" fill={color} opacity={0.85} />}
      {shape === 'curtain' && (
        <>
          <line x1={x - 9} y1={y - 10} x2={x - 9} y2={y + 10} stroke={color} strokeWidth="2" strokeDasharray="3 2" />
          <line x1={x} y1={y - 10} x2={x} y2={y + 10} stroke={color} strokeWidth="2" strokeDasharray="3 2" />
          <line x1={x + 9} y1={y - 10} x2={x + 9} y2={y + 10} stroke={color} strokeWidth="2" strokeDasharray="3 2" />
        </>
      )}
      {shape === 'lock' && (
        <>
          <rect x={x - 8} y={y - 1} width={16} height={12} rx={2} fill={color} />
          <path d={`M ${x - 5} ${y - 1} v -5 a 5 5 0 0 1 10 0 v 5`} fill="none" stroke={color} strokeWidth="2.2" />
        </>
      )}
      <text x={x} y={y - 22} textAnchor="middle" fontSize="8" fontFamily="monospace" fill={STRUCT}>
        {top}
      </text>
      <text x={x} y={y + 27} textAnchor="middle" fontSize="7.5" fontFamily="monospace" fill={color}>
        {bottom}
      </text>
      {onClick && (
        <rect
          x={x - 20}
          y={y - 18}
          width={40}
          height={36}
          fill="transparent"
          className={clickable ? 'cursor-pointer' : ''}
          onClick={clickable ? onClick : undefined}
        />
      )}
    </g>
  );
}

export default function SafetyLoopDemo({ tourStep = null }: { tourStep?: number | null }) {
  const [estopTripped, setEstopTripped] = useState(false);
  const [curtainBlocked, setCurtainBlocked] = useState(false);
  const [doorOpen, setDoorOpen] = useState(false);
  const [relayReset, setRelayReset] = useState(true);
  const [running, setRunning] = useState(true);
  const [journey, setJourney] = useState<Journey>('idle');
  const [resetBlocked, setResetBlocked] = useState(false);
  const [startBlocked, setStartBlocked] = useState(false);
  const touring = tourStep !== null;

  const anyFault = estopTripped || curtainBlocked || doorOpen;

  /* 任一常闭断开：链路跳闸，电机停转，继电器失电（需要重新复位） */
  useEffect(() => {
    if (touring) return;
    if (anyFault) {
      setRunning(false);
      setRelayReset(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estopTripped, curtainBlocked, doorOpen, touring]);

  /* 记录学习历程：触发 → 恢复 → 复位（就绪不转） → 启动（才运行） */
  useEffect(() => {
    if (touring) return;
    setJourney((prev) => {
      if (prev === 'idle' && anyFault) return 'tripped';
      if (prev === 'tripped' && !anyFault) return 'recovered';
      if (prev === 'recovered' && relayReset) return 'readied';
      if (prev === 'readied' && running) return 'done';
      return prev;
    });
  }, [anyFault, relayReset, running, touring]);

  /* 语音导览：0=整条链路（都是常闭）1=急停跳闸 2=复位就绪 3=启动恢复运行 */
  useEffect(() => {
    if (tourStep === null) return;
    if (tourStep === 0) {
      setEstopTripped(false);
      setCurtainBlocked(false);
      setDoorOpen(false);
      setRelayReset(true);
      setRunning(true);
    } else if (tourStep === 1) {
      setEstopTripped(true);
      setCurtainBlocked(false);
      setDoorOpen(false);
      setRelayReset(false);
      setRunning(false);
    } else if (tourStep === 2) {
      setEstopTripped(false);
      setCurtainBlocked(false);
      setDoorOpen(false);
      setRelayReset(true);
      setRunning(false);
    } else if (tourStep === 3) {
      setEstopTripped(false);
      setCurtainBlocked(false);
      setDoorOpen(false);
      setRelayReset(true);
      setRunning(true);
    }
  }, [tourStep]);

  const complete = journey === 'done';

  const doReset = () => {
    if (touring) return;
    if (anyFault) {
      setResetBlocked(true);
      setTimeout(() => setResetBlocked(false), 700);
      return;
    }
    setRelayReset(true);
  };
  const doStart = () => {
    if (touring) return;
    if (anyFault || !relayReset) {
      setStartBlocked(true);
      setTimeout(() => setStartBlocked(false), 700);
      return;
    }
    setRunning(true);
  };
  const fullReset = () => {
    setEstopTripped(false);
    setCurtainBlocked(false);
    setDoorOpen(false);
    setRelayReset(true);
    setRunning(true);
    setJourney('idle');
  };

  const devices = [
    {
      key: 'estop',
      shape: 'estop' as Shape,
      top: 'SB1 急停',
      tripped: estopTripped,
      sub: estopTripped ? '常闭·已触发' : '常闭·正常',
      toggle: () => {
        if (!touring) setEstopTripped((v) => !v);
      },
    },
    {
      key: 'curtain',
      shape: 'curtain' as Shape,
      top: '安全光幕',
      tripped: curtainBlocked,
      sub: curtainBlocked ? '常闭·被遮挡' : '常闭·正常',
      toggle: () => {
        if (!touring) setCurtainBlocked((v) => !v);
      },
    },
    {
      key: 'doorlock',
      shape: 'lock' as Shape,
      top: '安全门锁',
      tripped: doorOpen,
      sub: doorOpen ? '常闭·已打开' : '常闭·已锁闭',
      toggle: () => {
        if (!touring) setDoorOpen((v) => !v);
      },
    },
  ];

  const firstBreakIdx = devices.findIndex((d) => d.tripped);
  const reachedRelay = firstBreakIdx === -1;
  const poweredBefore = (i: number) => firstBreakIdx === -1 || i <= firstBreakIdx;
  const wireAfterPowered = (i: number) => poweredBefore(i) && !devices[i].tripped;

  const relayColor = !reachedRelay ? GRAY : running ? GREEN : relayReset ? AMBER : GRAY;
  const relayLabel = !reachedRelay ? '未通电' : running ? '已保持' : relayReset ? '就绪·未启动' : '待复位';
  const servoColor = running ? GREEN : GRAY;
  const breakDevice = firstBreakIdx !== -1 ? devices[firstBreakIdx] : null;

  const hint =
    journey === 'idle'
      ? anyFault
        ? '先把刚才触发的地方恢复正常'
        : '点击急停 / 光幕 / 门锁中任意一处，模拟触发停机'
      : journey === 'tripped'
        ? '现在把触发的地方恢复正常（常闭重新闭合）'
        : journey === 'recovered'
          ? '按「复位」——注意链路就绪但电机还不会转'
          : journey === 'readied'
            ? '再按「启动」，验证必须由人工重新起动'
            : '已完成一轮联锁验证';

  const highlightAll = touring && tourStep === 0;
  const highlightEstop = touring && tourStep === 1;
  const highlightReset = touring && tourStep === 2;
  const highlightStart = touring && tourStep === 3;

  const POWER_X = 30;
  const DEV_X = [110, 205, 300];
  const RELAY_X = 375;
  const SERVO_X = 445;
  const Y = 62;

  return (
    <div className="rounded-[12px] border border-brand/25 bg-paper p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10.5px] tracking-wide text-ink-muted">
          INTERACTIVE · 触发任一环节，再复位 + 启动，感受"复位≠重启"
        </span>
        <span className="flex items-center gap-2">
          <TraceBadge kbId="KB-005" />
          <button
            type="button"
            onClick={fullReset}
            disabled={touring}
            className="inline-flex items-center gap-1 rounded-md border border-hairline bg-card-warm px-2 py-1 text-[11px] text-ink-muted hover:text-ink disabled:opacity-50"
          >
            <RotateCcw size={11} /> 重来
          </button>
        </span>
      </div>

      <svg viewBox="0 0 480 140" className="w-full rounded-[8px] border border-hairline bg-card-warm">
        {highlightAll && (
          <rect
            x={8}
            y={16}
            width={462}
            height={92}
            rx={8}
            fill="none"
            stroke={AMBER}
            strokeWidth="1.6"
            strokeDasharray="4 3"
          />
        )}

        {/* 电源 */}
        <circle cx={POWER_X} cy={Y} r="14" fill="#FBFAF5" stroke={GREEN} strokeWidth="2" />
        <foreignObject x={POWER_X - 8} y={Y - 8} width="16" height="16">
          <Power size={16} color={GREEN} />
        </foreignObject>
        <text x={POWER_X} y={Y + 27} textAnchor="middle" fontSize="7.5" fontFamily="monospace" fill={STRUCT}>
          电源
        </text>
        <line x1={POWER_X + 14} y1={Y} x2={DEV_X[0] - 20} y2={Y} stroke={GREEN} strokeWidth="2.2" />

        {devices.map((d, i) => {
          const color = d.tripped ? RED : poweredBefore(i) ? GREEN : GRAY;
          const highlight = highlightAll || (highlightEstop && i === 0);
          return (
            <g key={d.key}>
              <DeviceGlyph
                x={DEV_X[i]}
                y={Y}
                shape={d.shape}
                color={color}
                top={d.top}
                bottom={d.sub}
                onClick={d.toggle}
                clickable={!touring}
                highlight={highlight}
              />
              {i < devices.length - 1 && (
                <line
                  x1={DEV_X[i] + 20}
                  y1={Y}
                  x2={DEV_X[i + 1] - 20}
                  y2={Y}
                  stroke={wireAfterPowered(i) ? GREEN : GRAY}
                  strokeWidth="2.2"
                />
              )}
            </g>
          );
        })}

        {/* 到安全继电器 KA */}
        <line
          x1={DEV_X[2] + 20}
          y1={Y}
          x2={RELAY_X - 22}
          y2={Y}
          stroke={wireAfterPowered(2) ? GREEN : GRAY}
          strokeWidth="2.2"
        />
        <rect
          x={RELAY_X - 22}
          y={Y - 16}
          width={44}
          height={32}
          rx={6}
          fill={relayColor === AMBER ? '#F6E7C6' : relayColor === GREEN ? '#E9F2EC' : '#F0EEE3'}
          stroke={relayColor}
          strokeWidth="2"
        />
        <text x={RELAY_X} y={Y + 3} textAnchor="middle" fontSize="9" fontFamily="monospace" fontWeight={600} fill={relayColor}>
          KA
        </text>
        <text x={RELAY_X} y={Y - 22} textAnchor="middle" fontSize="8" fontFamily="monospace" fill={STRUCT}>
          安全继电器
        </text>
        <text x={RELAY_X} y={Y + 27} textAnchor="middle" fontSize="7.5" fontFamily="monospace" fill={relayColor}>
          {relayLabel}
        </text>
        {(highlightAll || highlightReset) && (
          <rect
            x={RELAY_X - 28}
            y={Y - 26}
            width={56}
            height={58}
            rx={8}
            fill="none"
            stroke={AMBER}
            strokeWidth="1.6"
            strokeDasharray="4 3"
          />
        )}

        {/* 到伺服驱动 / 电机 */}
        <line
          x1={RELAY_X + 22}
          y1={Y}
          x2={SERVO_X - 16}
          y2={Y}
          stroke={running ? GREEN : GRAY}
          strokeWidth="2.2"
        />
        <circle cx={SERVO_X} cy={Y} r="16" fill="#FBFAF5" stroke={servoColor} strokeWidth="2" />
        <motion.g
          animate={running ? { rotate: 360 } : { rotate: 0 }}
          transition={running ? { repeat: Infinity, ease: 'linear', duration: 1.1 } : { duration: 0.2 }}
          style={{ originX: `${SERVO_X}px`, originY: `${Y}px` }}
        >
          <line x1={SERVO_X} y1={Y} x2={SERVO_X + 10} y2={Y - 6} stroke={servoColor} strokeWidth="2" />
          <line x1={SERVO_X} y1={Y} x2={SERVO_X - 10} y2={Y - 2} stroke={servoColor} strokeWidth="2" />
          <line x1={SERVO_X} y1={Y} x2={SERVO_X - 2} y2={Y + 10} stroke={servoColor} strokeWidth="2" />
        </motion.g>
        <text x={SERVO_X} y={Y - 24} textAnchor="middle" fontSize="8" fontFamily="monospace" fill={STRUCT}>
          伺服 / 电机
        </text>
        <text x={SERVO_X} y={Y + 29} textAnchor="middle" fontSize="7.5" fontFamily="monospace" fill={servoColor}>
          {running ? '运行中' : '已停转'}
        </text>
        {(highlightAll || highlightStart) && (
          <rect
            x={SERVO_X - 22}
            y={Y - 26}
            width={44}
            height={56}
            rx={8}
            fill="none"
            stroke={AMBER}
            strokeWidth="1.6"
            strokeDasharray="4 3"
          />
        )}
      </svg>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={doReset}
          disabled={touring}
          className={cn(
            'rounded-[10px] border px-2.5 py-1.5 text-[12px] transition-colors',
            'border-hairline bg-card-warm text-ink-2 hover:border-brand/40 disabled:opacity-50',
          )}
        >
          复位（允许再启动）
        </button>
        <motion.button
          type="button"
          onClick={doStart}
          disabled={touring}
          animate={startBlocked ? { x: [0, -4, 4, -3, 0] } : { x: 0 }}
          transition={{ duration: 0.35 }}
          className={cn(
            'inline-flex items-center justify-center gap-1 rounded-[10px] border px-2.5 py-1.5 text-[12px] transition-colors',
            'border-brand/40 bg-brand-tint text-brand hover:border-brand disabled:opacity-50',
          )}
        >
          <Play size={12} /> 启动
        </motion.button>
      </div>

      <div className="mt-2.5 font-mono text-[11px] leading-[16px] text-ink-muted">{!touring && hint}</div>

      <AnimatePresence>
        {!touring && anyFault && breakDevice && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-2.5 flex items-center gap-1.5 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-2.5 py-1.5 text-[12px] text-brand-danger"
          >
            <AlertTriangle size={13} />
            安全链路在【{breakDevice.top}】处断开——伺服已停转，后段回路失电。
          </motion.div>
        )}
        {!touring && resetBlocked && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-2.5 flex items-center gap-1.5 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-2.5 py-1.5 text-[12px] text-brand-danger"
          >
            <AlertTriangle size={13} />
            先排除所有故障（常闭全部恢复闭合），才能复位。
          </motion.div>
        )}
        {!touring && startBlocked && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-2.5 flex items-center gap-1.5 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-2.5 py-1.5 text-[12px] text-brand-danger"
          >
            <AlertTriangle size={13} />
            必须先「复位」才能启动——复位只是允许再启动（GB 11291.1）。
          </motion.div>
        )}
        {complete && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mt-2.5 flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand-tint px-2.5 py-1.5 text-[12px] font-medium text-brand"
          >
            <Check size={13} />
            故障导向安全：断开即停；复位≠重启，必须由人再次启动。
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
