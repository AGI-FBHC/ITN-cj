export interface WavRecorder {
  stop(): Promise<Blob>
  cancel(): Promise<void>
}

interface RecorderOptions {
  onSilence?: () => void
  silenceMs?: number
  maxDurationMs?: number
}

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const buffer = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount * 2, true)
  let offset = 44
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample))
      view.setInt16(offset, clamped < 0 ? clamped * 32768 : clamped * 32767, true)
      offset += 2
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export async function startWavRecording(options: RecorderOptions = {}): Promise<WavRecorder> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器无法访问麦克风')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  const sampleRate = context.sampleRate
  const processor = context.createScriptProcessor(4096, 1, 1)
  const silentOutput = context.createGain()
  silentOutput.gain.value = 0
  const chunks: Float32Array[] = []
  const silenceMs = options.silenceMs ?? 1300
  let speechStarted = false
  let silentSince = 0
  let stopped = false
  let silenceNotified = false
  let voicedSamples = 0
  let peakRms = 0

  processor.onaudioprocess = event => {
    if (stopped) return
    const samples = event.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(samples))
    let energy = 0
    for (const sample of samples) energy += sample * sample
    const rms = Math.sqrt(energy / samples.length)
    peakRms = Math.max(peakRms, rms)
    const now = performance.now()
    if (rms >= 0.018) {
      speechStarted = true
      voicedSamples += samples.length
      silentSince = 0
    } else if (speechStarted) {
      silentSince ||= now
      if (!silenceNotified && now - silentSince >= silenceMs) {
        silenceNotified = true
        options.onSilence?.()
      }
    }
  }
  source.connect(processor)
  processor.connect(silentOutput)
  silentOutput.connect(context.destination)

  const close = async () => {
    if (stopped) return
    stopped = true
    processor.disconnect()
    source.disconnect()
    silentOutput.disconnect()
    stream.getTracks().forEach(track => track.stop())
    await context.close()
  }
  const maxTimer = window.setTimeout(() => {
    if (!silenceNotified) {
      silenceNotified = true
      options.onSilence?.()
    }
  }, options.maxDurationMs ?? 15_000)

  return {
    async stop() {
      window.clearTimeout(maxTimer)
      await close()
      if (!chunks.length) throw new Error('没有录到声音')
      const voicedDurationMs = voicedSamples / sampleRate * 1000
      // Ignore microphone activation clicks and brief AGC/noise bursts. Keep
      // this aligned with the server-side VAD so silence never becomes an
      // invented user message even before the request leaves the browser.
      if (!speechStarted || voicedDurationMs < 240 || peakRms < 0.02) {
        chunks.length = 0
        throw new Error('没有检测到有效语音，请靠近麦克风后再试')
      }
      return encodeWav(chunks, sampleRate)
    },
    async cancel() {
      window.clearTimeout(maxTimer)
      chunks.length = 0
      await close()
    },
  }
}
