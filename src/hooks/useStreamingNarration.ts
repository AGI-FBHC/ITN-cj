import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { streamAssistantTts, type TtsSpeed } from '@/lib/api';
import { audioBus } from '@/lib/audioBus';

export const narrationSpeeds: Array<{ value: TtsSpeed; label: string; rate: number }> = [
  { value: 'very_slow', label: '0.8×', rate: 0.8 },
  { value: 'slow', label: '0.9×', rate: 0.9 },
  { value: 'normal', label: '1.0×', rate: 1 },
  { value: 'fast', label: '1.1×', rate: 1.1 },
  { value: 'very_fast', label: '1.2×', rate: 1.2 },
];

const browserRate = (speed: TtsSpeed) => narrationSpeeds.find((item) => item.value === speed)?.rate ?? 1;

/** MiMo 流式 PCM 讲播；行为与完整阅读播放器保持一致。 */
export function useStreamingNarration(onFinished?: () => void) {
  const [speaking, setSpeaking] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const abortRef = useRef<AbortController | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const volumeRef = useRef(1);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const timerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const stop = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    sourcesRef.current.forEach((source) => { try { source.stop(); } catch { /* already ended */ } });
    sourcesRef.current.clear();
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  const browserFallback = useCallback((text: string, speed: TtsSpeed, generation: number) => {
    if (!('speechSynthesis' in window) || generation !== generationRef.current) {
      setSpeaking(false);
      toast.error('当前设备暂时无法播放语音');
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = browserRate(speed);
    utterance.volume = volumeRef.current;
    const finish = () => {
      if (generation !== generationRef.current) return;
      setSpeaking(false);
      onFinishedRef.current?.();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  }, []);

  const setVolume = useCallback((value: number) => {
    volumeRef.current = Math.max(0, Math.min(1, value));
    setVolumeState(volumeRef.current);
    if (gainRef.current) gainRef.current.gain.value = volumeRef.current;
  }, []);

  const play = useCallback(async (text: string, speed: TtsSpeed) => {
    stop();
    if (!text) return;
    audioBus.stopAll();
    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setSpeaking(true);
    try {
      const response = await streamAssistantTts(text, speed, controller.signal);
      const reader = response.body!.getReader();
      const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) throw new Error('AudioContext unavailable');
      contextRef.current ??= new AudioContextCtor({ sampleRate: 24_000 });
      const context = contextRef.current;
      await context.resume();
      gainRef.current ??= (() => {
        const gain = context.createGain();
        gain.gain.value = volumeRef.current;
        gain.connect(context.destination);
        return gain;
      })();
      let nextStart = context.currentTime + 0.06;
      let pending = new Uint8Array();
      let scheduled = 0;
      const chunkBytes = 3_840;
      const schedule = (pcm: Uint8Array) => {
        const usable = pcm.length - (pcm.length % 2);
        if (!usable || generation !== generationRef.current) return;
        const samples = new Float32Array(usable / 2);
        const view = new DataView(pcm.buffer, pcm.byteOffset, usable);
        for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
        const buffer = context.createBuffer(1, samples.length, 24_000);
        buffer.copyToChannel(samples, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(gainRef.current ?? context.destination);
        sourcesRef.current.add(source);
        source.onended = () => sourcesRef.current.delete(source);
        source.start(nextStart);
        nextStart += buffer.duration;
        scheduled += 1;
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (generation !== generationRef.current) { await reader.cancel(); return; }
        if (!value?.length) continue;
        const merged = new Uint8Array(pending.length + value.length);
        merged.set(pending);
        merged.set(value, pending.length);
        let offset = 0;
        while (merged.length - offset >= chunkBytes) {
          schedule(merged.slice(offset, offset + chunkBytes));
          offset += chunkBytes;
        }
        pending = merged.slice(offset);
      }
      schedule(pending);
      if (!scheduled) throw new Error('empty audio stream');
      timerRef.current = window.setTimeout(() => {
        if (generation !== generationRef.current) return;
        setSpeaking(false);
        onFinishedRef.current?.();
      }, Math.max(50, Math.ceil((nextStart - context.currentTime) * 1000) + 80));
    } catch (reason) {
      if ((reason as Error).name === 'AbortError' || generation !== generationRef.current) return;
      browserFallback(text, speed, generation);
    }
  }, [browserFallback, stop]);

  useEffect(() => {
    const release = audioBus.register('lecture', stop);
    return () => {
      release();
      stop();
      if (contextRef.current) void contextRef.current.close();
    };
  }, [stop]);

  return { speaking, play, stop, volume, setVolume };
}
