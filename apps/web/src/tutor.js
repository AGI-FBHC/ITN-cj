// All tutor surfaces share the authenticated client and bounded conversation contract.
const TOKEN_KEY = 'zhixun-learning-v2-token';
export const TUTOR_MAX_IMAGES = 3;
export const TUTOR_MAX_IMAGE_BYTES = 700 * 1024;
export const TUTOR_MAX_TOTAL_BYTES = 2.5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function tutorHistory(messages = []) {
  const encoder = new TextEncoder();
  let bytes = 0;
  const history = [];
  for (const item of [...messages].reverse()) {
    if (!['user', 'assistant'].includes(item.role) || item.pending || item.error || item.greeting) continue;
    const content = Array.from(String(item.content ?? item.text ?? '')).slice(0, 4000).join('').trim();
    if (!content) continue;
    const size = encoder.encode(content).length;
    if (bytes + size > 24000 || history.length === 12) break;
    bytes += size;
    history.unshift({ role: item.role, content });
  }
  return history;
}

async function tutorRequest(path, { method = 'GET', body, signal, timeout = 120000 } = {}) {
  const token = localStorage.getItem(TOKEN_KEY) || '';
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, timeout);
  try {
    const response = await fetch(`/api/tutor/${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error('服务返回格式异常，请重试');
    }
    if (!response.ok) throw new Error(data.message || `请求失败（${response.status}）`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError' && !signal?.aborted) throw new Error('回答超时，请重试');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function askTutor({ message = '', quote = '', courseId = '', lessonIndex = -1, lessonTitle = '', history = [], attachments = [], signal } = {}) {
  const images = validateTutorAttachments(attachments);
  return tutorRequest('chat', {
    method: 'POST', signal,
    body: { message, quote, courseId, lessonIndex, lessonTitle, history: tutorHistory(history), attachments: images },
  });
}

function validateTutorAttachments(attachments = []) {
  const images = attachments.map(({ type, name, mimeType, dataUrl }) => ({ type, name, mimeType, dataUrl }));
  if (images.length > TUTOR_MAX_IMAGES || images.some((image) => !IMAGE_TYPES.has(image.mimeType))) {
    throw new Error('最多添加 3 张 PNG、JPEG 或 WebP 图片');
  }
  if (images.some((image) => image.dataUrl?.length > TUTOR_MAX_IMAGE_BYTES)
    || images.reduce((total, image) => total + (image.dataUrl?.length || 0), 0) > TUTOR_MAX_TOTAL_BYTES) {
    throw new Error('图片过大，请重新选择图片');
  }
  return images;
}

/**
 * Streams the tutor answer over SSE. Calls onEvent for every parsed frame
 * (meta/delta/done/error). Falls back to the non-streaming endpoint when the
 * server predates this route.
 */
export async function askTutorStream(payload = {}, onEvent, { signal } = {}) {
  const images = validateTutorAttachments(payload.attachments);
  const token = localStorage.getItem(TOKEN_KEY) || '';
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, 120000);
  const body = {
    message: payload.message || '', quote: payload.quote || '',
    courseId: payload.courseId || '', lessonIndex: payload.lessonIndex ?? -1,
    lessonTitle: payload.lessonTitle || '',
    history: tutorHistory(payload.history || []), attachments: images,
  };
  try {
    const response = await fetch(`/api/tutor/${'chat/stream'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 405 || !response.body) {
      const result = await askTutor({ ...payload, signal: controller.signal });
      onEvent?.({ type: 'meta', model: result.model, mode: result.mode, citations: result.citations });
      onEvent?.({ type: 'done', answer: result.answer });
      return result;
    }
    if (!response.ok) {
      const text = await response.text();
      let message = `请求失败（${response.status}）`;
      try { message = JSON.parse(text).message || message; } catch { /* keep default */ }
      throw new Error(message);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const index = match.index;
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + match[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        if (event.type === 'delta') answer += event.text || '';
        if (event.type === 'done' && event.answer) answer = event.answer;
        if (event.type === 'error') throw new Error(event.message || '回答中断，请重试');
        onEvent?.(event);
      }
    }
    return { answer };
  } catch (error) {
    if (error.name === 'AbortError' && !signal?.aborted) throw new Error('回答超时，请重试');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function getTutorHistory({ courseId = '', lessonIndex = -1, signal } = {}) {
  const params = new URLSearchParams({ courseId, lessonIndex: String(lessonIndex) });
  const data = await tutorRequest(`history?${params}`, { signal, timeout: 20000 });
  return (data.items || data.messages || []).filter((message) => ['user', 'assistant'].includes(message.role));
}

export async function prepareTutorImage(file) {
  if (!IMAGE_TYPES.has(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  if (file.size > 20 * 1024 * 1024) throw new Error('原图不能超过 20 MB，请先缩小图片');
  const source = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const value = new Image();
      value.onload = () => resolve(value);
      value.onerror = () => reject(new Error('这张图片无法读取，请换一张'));
      value.src = source;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error('图片尺寸无效，请换一张');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理图片');
    for (const edge of [1800, 1440, 1080, 800]) {
      const scale = Math.min(1, edge / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.72, 0.56]) {
        const dataUrl = canvas.toDataURL('image/webp', quality);
        if (dataUrl.length > TUTOR_MAX_IMAGE_BYTES) continue;
        const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
        const extension = mimeType === 'image/webp' ? 'webp' : 'png';
        return {
          id: crypto.randomUUID(), type: 'image',
          name: `${file.name.replace(/\.[^.]+$/, '').slice(0, 72) || '图片'}.${extension}`,
          mimeType, dataUrl,
        };
      }
    }
    throw new Error('图片压缩后仍然过大，请换一张较小的图片');
  } finally {
    URL.revokeObjectURL(source);
  }
}

if (typeof window !== 'undefined') window.zxTutorAsk = askTutor;
