/**
 * 桌面机器人 · DeepSeek 对话 + 语音 + 表情
 */

const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';
const STORAGE_KEY = 'robot-face-deepseek-api-key';
const VALID_EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'sleepy', 'love'];

const robotHead = document.getElementById('robotHead');
const currentExprSpan = document.getElementById('currentExpr');
const eyes = document.querySelectorAll('.eye');
const replyPlaceholder = document.getElementById('replyPlaceholder');
const replyText = document.getElementById('replyText');
const chatInput = document.getElementById('chatInput');
const chatHint = document.getElementById('chatHint');
const btnSend = document.getElementById('btnSend');
const btnMic = document.getElementById('btnMic');
const statusEl = document.getElementById('status');
const apiKeyInput = document.getElementById('apiKey');
const btnSaveKey = document.getElementById('btnSaveKey');

const EXPRESSIONS = {
  neutral: '中性',
  happy: '开心',
  sad: '悲伤',
  angry: '生气',
  surprised: '惊讶',
  sleepy: '困倦',
  love: '喜欢',
};

const SYSTEM_PROMPT = `你是一个可爱的桌面机器人，用自然、口语化的中文回复用户。可以多说几句，把意思说清楚，适当展开，但保持口语化。

重要——表情格式（必须严格遵守）：
回复的每一句或每一小段话前面，都要先写一个表情标记，格式为：[表情:xxx]
xxx 只能是以下之一：neutral, happy, sad, angry, surprised, sleepy, love
根据这一句/段话的情绪选择对应的表情。整条回复必须以 [表情:xxx] 开头，每换一种情绪就换一个标记。

示例：
[表情:happy] 哈哈，你好呀！
[表情:neutral] 今天天气不错，你那边怎么样？
[表情:sad] 听说你有点难过，抱抱你。
[表情:love] 有什么想聊的随时跟我说～

不要输出除 [表情:xxx] 和正常回复内容以外的解释。`;

let conversationHistory = [];
let speechSynth = window.speechSynthesis;
let currentUtterance = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('error', isError);
}

function getApiKey() {
  return apiKeyInput?.value?.trim() || (typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null) || '';
}

function saveApiKey() {
  const key = apiKeyInput?.value?.trim() || '';
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, key);
  chatHint.textContent = key ? 'API Key 已保存（仅存于本机）' : '已清除';
  setTimeout(() => { chatHint.textContent = ''; }, 2000);
}

function setExpression(expression) {
  const expr = VALID_EMOTIONS.includes(expression) ? expression : 'neutral';
  robotHead.classList.remove(...Object.keys(EXPRESSIONS).map((e) => `expr-${e}`));
  robotHead.classList.add(`expr-${expr}`);
  currentExprSpan.textContent = `当前: ${EXPRESSIONS[expr]}`;
  document.querySelectorAll('.expr-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.expression === expr);
  });
}

function blink() {
  eyes.forEach((eye) => eye.classList.add('blink'));
  setTimeout(() => eyes.forEach((eye) => eye.classList.remove('blink')), 150);
}

function startBlinkInterval() {
  function scheduleNext() {
    setTimeout(() => { blink(); scheduleNext(); }, 2000 + Math.random() * 4000);
  }
  scheduleNext();
}

/** 从回复中解析多段 [表情:xxx] 文本，返回 { displayText, segments: [{ emotion, text }] } */
function parseSegmentsFromReply(text) {
  const raw = (text || '').trim();
  const segments = [];
  const regex = /\[表情:\s*(\w+)\]\s*([^[]*)/g;
  const firstTag = raw.search(/\[表情:\s*\w+\]\s*/);
  if (firstTag > 0) {
    const prefix = raw.slice(0, firstTag).trim();
    if (prefix) segments.push({ emotion: 'neutral', text: prefix });
  }
  let m;
  while ((m = regex.exec(raw)) !== null) {
    const emotion = VALID_EMOTIONS.includes(m[1]) ? m[1] : 'neutral';
    const segmentText = m[2].trim();
    if (segmentText) segments.push({ emotion, text: segmentText });
  }
  if (segments.length === 0) {
    const fallbackText = raw.replace(/\[表情:\s*\w+\]\s*/g, '').trim() || raw;
    const trailing = raw.match(/\n?\s*\[表情:\s*(\w+)\]\s*$/);
    const emotion = trailing && VALID_EMOTIONS.includes(trailing[1]) ? trailing[1] : 'neutral';
    segments.push({ emotion, text: fallbackText });
  }
  if (segments.length === 1 && segments[0].emotion === 'neutral') {
    const trailing = raw.match(/\n?\s*\[表情:\s*(\w+)\]\s*$/);
    if (trailing && VALID_EMOTIONS.includes(trailing[1])) segments[0].emotion = trailing[1];
  }
  const displayText = raw.replace(/\[表情:\s*\w+\]\s*/g, '').trim();
  return { displayText, segments };
}

/** 调用 DeepSeek 获取回复 */
async function callDeepSeek(userMessage) {
  const apiKey = getApiKey();
  if (!apiKey) {
    setStatus('请先在设置中填写并保存 DeepSeek API Key', true);
    return null;
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const res = await fetch(DEEPSEEK_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(res.status === 401 ? 'API Key 无效或未授权' : err || `HTTP ${res.status}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (content == null) throw new Error('接口返回格式异常');
  return content;
}

/** 按段朗读：每段先切换表情再读该段文字，读完后播下一段 */
function speakSegments(segments) {
  if (!speechSynth || !segments || segments.length === 0) return;
  speechSynth.cancel();
  const voices = speechSynth.getVoices().filter((v) => v.lang.startsWith('zh'));
  let index = 0;
  function speakNext() {
    if (index >= segments.length) {
      setStatus('');
      return;
    }
    const seg = segments[index];
    setExpression(seg.emotion);
    if (!seg.text) {
      index++;
      speakNext();
      return;
    }
    const u = new SpeechSynthesisUtterance(seg.text);
    u.lang = 'zh-CN';
    u.rate = 0.95;
    u.pitch = 1;
    if (voices.length) u.voice = voices[0];
    currentUtterance = u;
    u.onend = () => { index++; speakNext(); };
    u.onerror = () => { index++; speakNext(); };
    speechSynth.speak(u);
    index === 0 && setStatus('正在播放…');
  }
  speakNext();
}

function showReply(content) {
  replyText.textContent = content || '';
}

async function sendMessage() {
  const text = (chatInput?.value || '').trim();
  if (!text) {
    chatHint.textContent = '请输入或使用麦克风说话';
    return;
  }

  btnSend.disabled = true;
  chatInput.value = '';
  setStatus('正在思考…');
  showReply('');

  try {
    const rawReply = await callDeepSeek(text);
    if (rawReply == null) return;

    conversationHistory.push({ role: 'user', content: text });
    const { displayText, segments } = parseSegmentsFromReply(rawReply);

    showReply(displayText);
    conversationHistory.push({ role: 'assistant', content: rawReply });

    if (segments.length > 0) {
      setExpression(segments[0].emotion);
      speakSegments(segments);
    } else {
      setStatus('');
    }
  } catch (e) {
    setStatus(e.message || '请求失败', true);
    showReply('');
  } finally {
    btnSend.disabled = false;
  }
}

function initVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    btnMic.style.display = 'none';
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'zh-CN';
  recognition.continuous = false;
  recognition.interimResults = false;

  btnMic.addEventListener('click', () => {
    if (btnMic.classList.contains('recording')) {
      recognition.stop();
      return;
    }
    chatHint.textContent = '请说话…';
    btnMic.classList.add('recording');
    recognition.start();
  });

  recognition.onresult = (e) => {
    const t = e.results[e.results.length - 1][0].transcript;
    if (chatInput) chatInput.value = t;
    chatHint.textContent = '识别完成，可点击发送';
  };

  recognition.onend = () => {
    btnMic.classList.remove('recording');
    if (!chatHint.textContent.startsWith('识别')) chatHint.textContent = '';
  };

  recognition.onerror = () => {
    btnMic.classList.remove('recording');
    chatHint.textContent = '语音识别出错，请重试';
  };
}

function loadSavedApiKey() {
  const key = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  if (apiKeyInput && key) apiKeyInput.value = key;
}

// 初始化
document.querySelectorAll('.expr-btn').forEach((btn) => {
  btn.addEventListener('click', () => setExpression(btn.dataset.expression));
});

setExpression('neutral');
startBlinkInterval();
loadSavedApiKey();

if (btnSend) btnSend.addEventListener('click', sendMessage);
if (chatInput) {
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
}
if (btnSaveKey) btnSaveKey.addEventListener('click', saveApiKey);

initVoiceInput();
