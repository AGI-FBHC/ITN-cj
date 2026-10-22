/**
 * 全局单音频通道总线：演讲 / Agent 回答 / 字幕 TTS / 用户录音回放 / 录音中，
 * 同一时刻只允许一个通道发声。任意通道播放前调用 stopAll() 停掉其余通道。
 */
export type AudioChannel = 'lecture' | 'agent' | 'subtitle' | 'user' | 'recording';

const stops = new Map<AudioChannel, Set<() => void>>();

function fire(set: Set<() => void>): void {
  for (const stop of [...set]) {
    try {
      stop();
    } catch {
      /* 忽略单个停止器的异常 */
    }
  }
}

export const audioBus = {
  /** 注册一个"停止该通道"的函数（不抢占），返回注销函数。 */
  register(channel: AudioChannel, stop: () => void): () => void {
    let set = stops.get(channel);
    if (!set) {
      set = new Set();
      stops.set(channel, set);
    }
    set.add(stop);
    return () => {
      set.delete(stop);
      if (set.size === 0) stops.delete(channel);
    };
  },

  /** 停掉所有通道的正在播放音频。 */
  stopAll(): void {
    for (const set of stops.values()) fire(set);
    stops.clear();
  },

  /** 只停指定通道。 */
  stopChannel(channel: AudioChannel): void {
    const set = stops.get(channel);
    if (!set) return;
    fire(set);
    set.clear();
    stops.delete(channel);
  },
};
