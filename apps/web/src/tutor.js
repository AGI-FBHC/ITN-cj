// AI 导师客户端：阅读页的提问面板通过 window.zxTutorAsk 调到这里。
// 反编译产出的 RecoveredApp.jsx 里只保留一次调用，业务逻辑都放在这个文件。
const TOKEN_KEY = 'zhixun-learning-v2-token';

export async function askTutor({ message, quote = '', courseId = '', lessonIndex = -1, lessonTitle = '' }) {
  const token = localStorage.getItem(TOKEN_KEY) || '';
  const controller = new AbortController();
  // 模型写长回答要几十秒，这里的超时比普通请求宽。
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch('/api/tutor/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ message, quote, courseId, lessonIndex, lessonTitle }),
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
    if (error.name === 'AbortError') throw new Error('回答超时，请重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

if (typeof window !== 'undefined') {
  window.zxTutorAsk = askTutor;
}
