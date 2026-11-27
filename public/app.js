import { ZenTts, ztmUrl } from '/zen/dist/index.js';

const get = (id) => document.getElementById(id);
const form = document.querySelector('form');
const input = get('message');
const mic = get('mic');
const live = get('live');
const status = get('status');
const log = get('log');
const history = [];
const sampleText = 'こんにちは。今日もお話しできてうれしいです。';
const micAvailable = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
let config;
let audio;
let engine;
let recording;
let busy = false;
let realtime;

function tell(message, error = false) {
  status.textContent = message;
  status.toggleAttribute('data-error', error);
}

function updateControls() {
  const occupied = busy || Boolean(recording) || Boolean(realtime);
  live.disabled = !config?.apiReady || !navigator.mediaDevices?.getUserMedia ||
    !window.RTCPeerConnection || (!realtime && occupied);
  live.textContent = realtime ? 'リアルタイム会話を終了' : 'リアルタイム会話を開始';
  get('sample').disabled = !config || occupied;
  get('send').disabled = !config?.apiReady || occupied;
  get('clear').disabled = occupied || log.childElementCount === 0;
  input.disabled = occupied;
  mic.disabled = !config?.apiReady || !micAvailable || busy || Boolean(realtime);
  mic.textContent = recording ? '録音を止めて送信' : '録音する';
}

async function action(run) {
  busy = true;
  updateControls();
  try {
    await run();
  } catch (error) {
    tell(error.message || '処理に失敗しました。', true);
  } finally {
    busy = false;
    updateControls();
  }
}

async function api(path, type, body, signal) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': type, 'X-Voice-App': '1' }, body, signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function unlockAudio() {
  try {
    audio ??= new AudioContext();
    return audio.resume().then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

async function speak(text, ready, signal) {
  if (!await ready) throw new Error('音声を再生できません。ブラウザの音声設定を確認してください。');
  if (!navigator.gpu) throw new Error('WebGPUが利用できません。Mac版Chromeで開いてください。');
  if (signal?.aborted) return;
  if (!engine) {
    tell('音声モデルを読み込んでいます…');
    try {
      engine = await ZenTts.load({
        backend: 'webgpu', modelsUrl: '/zen/models',
        model: config.bluesky ? '/zen/bluesky.ztm' : ztmUrl('marine'),
      });
    } catch (error) {
      console.warn('ZEN-TTS model load failed', error);
      throw new Error('音声モデルを読み込めませんでした。ChromeのWebGPU設定と通信状況を確認してください。');
    }
  }
  if (signal?.aborted) return;
  tell('WebGPUで音声を生成・再生中…');
  for await (const { pcm, sampleRate } of engine.speakStream(text)) {
    if (signal?.aborted) return;
    if (!pcm.length) continue;
    const buffer = audio.createBuffer(1, pcm.length, sampleRate);
    buffer.copyToChannel(pcm, 0);
    await new Promise((done) => {
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      const stop = () => source.stop();
      source.onended = () => {
        signal?.removeEventListener('abort', stop);
        source.disconnect();
        done();
      };
      source.start();
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
  if (!signal?.aborted) tell('再生が終わりました。');
}

function addMessage(role, content) {
  history.push({ role, content });
  return renderMessage(role, content);
}

function renderMessage(role, content) {
  const entry = document.createElement('li');
  const name = document.createElement('strong');
  name.textContent = role === 'user' ? 'あなた' : config.bluesky ? 'Blueskyちゃん' : '全力マリン';
  entry.dataset.role = role;
  const text = document.createTextNode(content);
  entry.append(name, text);
  log.append(entry);
  log.scrollTop = log.scrollHeight;
  get('empty').hidden = true;
  return text;
}

async function talk(message, ready) {
  input.value = message;
  tell('返事を考えています…');
  const { reply } = await api('/api/chat', 'application/json', JSON.stringify({
    messages: [...history.slice(-8), { role: 'user', content: message }],
  }));
  addMessage('user', message);
  addMessage('assistant', reply);
  input.value = '';
  await speak(reply, ready);
}

get('sample').addEventListener('click', () => {
  const ready = unlockAudio();
  void action(() => speak(sampleText, ready));
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || busy || recording || realtime || !config?.apiReady) return;
  const ready = unlockAudio();
  void action(() => talk(message, ready));
});
get('clear').addEventListener('click', () => {
  history.length = 0;
  log.replaceChildren();
  get('empty').hidden = false;
  tell('会話を消去しました。');
  updateControls();
});

async function startRecording(ready) {
  let stream;
  let timer;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']
      .find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!type) throw new Error('このブラウザの録音形式に対応していません。Chromeで開いてください。');
    const recorder = new MediaRecorder(stream, { mimeType: type });
    const chunks = [];
    const release = () => {
      clearTimeout(timer);
      stream.getTracks().forEach((track) => track.stop());
    };
    recorder.ondataavailable = ({ data }) => {
      if (data.size) chunks.push(data);
    };
    recorder.onerror = () => {
      release();
      recording = null;
      tell('録音できませんでした。もう一度お試しください。', true);
      updateControls();
    };
    recorder.onstop = () => {
      release();
      if (recording !== recorder) return;
      recording = null;
      void action(async () => {
        const type = recorder.mimeType.split(';')[0];
        const blob = new Blob(chunks, { type });
        if (!blob.size) throw new Error('録音データが空です。');
        tell('音声を文字に変換しています…');
        const { text } = await api('/api/transcribe', type, blob);
        await talk(text, ready);
      });
    };
    recorder.start();
    recording = recorder;
    timer = setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, 30_000);
    tell('録音中です。停止時に送信します（最長30秒）。');
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    if (error.name === 'NotAllowedError') {
      throw new Error('ChromeとmacOSの設定で、マイクへのアクセスを許可してください。');
    }
    if (error.name === 'NotFoundError' || error.name === 'NotReadableError') {
      throw new Error('マイクを使用できません。Macの入力設定を確認してください。');
    }
    throw error;
  }
}

mic.addEventListener('click', () => {
  if (busy) return;
  if (recording) {
    if (recording.state === 'recording') recording.stop();
    return;
  }
  const ready = unlockAudio();
  void action(() => startRecording(ready));
});

function endRealtime(session, message, error = false) {
  if (session !== realtime) return;
  realtime = undefined;
  clearTimeout(session.timer);
  session.abort.abort();
  session.stream?.getTracks().forEach((track) => track.stop());
  session.peer?.close();
  tell(message, error);
  updateControls();
}

function listenAgain(session) {
  if (session !== realtime) return;
  session.track.enabled = true;
  tell('聞いています。話しかけてください。');
}

async function playRealtimeReply(session, response) {
  if (session.playing) return;
  const text = response?.output?.flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text).join('').trim();
  if (!text) {
    endRealtime(session, '応答を取得できませんでした。もう一度開始してください。', true);
    return;
  }
  session.playing = true;
  session.track.enabled = false;
  busy = true;
  renderMessage('assistant', text);
  try {
    await speak(text, session.ready, session.abort.signal);
    listenAgain(session);
  } catch (error) {
    endRealtime(session, error.message, true);
  } finally {
    busy = false;
    session.playing = false;
    updateControls();
  }
}

function realtimeEvent(session, { data }) {
  if (session !== realtime) return;
  let event;
  try { event = JSON.parse(data); } catch { return; }
  switch (event.type) {
    case 'session.updated':
    case 'session.created':
      if (!session.connected) {
        session.connected = true;
        clearTimeout(session.timer);
        listenAgain(session);
      }
      break;
    case 'input_audio_buffer.speech_started':
      if (!session.playing) tell('発話を検出しました…');
      break;
    case 'input_audio_buffer.committed':
      session.track.enabled = false;
      session.transcripts.set(event.item_id, renderMessage('user', '文字起こし中…'));
      tell('返事を考えています…');
      break;
    case 'conversation.item.input_audio_transcription.completed':
    case 'conversation.item.input_audio_transcription.failed': {
      const node = session.transcripts.get(event.item_id);
      if (node) node.data = event.transcript?.trim() || '文字起こしできませんでした。';
      session.transcripts.delete(event.item_id);
      break;
    }
    case 'response.done':
      if (event.response?.status === 'failed') {
        endRealtime(session, 'Realtime APIの応答生成に失敗しました。利用枠とモデルへのアクセスを確認してください。', true);
      } else if (event.response?.status === 'cancelled') {
        listenAgain(session);
      } else {
        void playRealtimeReply(session, event.response);
      }
      break;
    case 'error':
      endRealtime(session, 'Realtime APIでエラーが発生しました。設定を確認し、もう一度開始してください。', true);
      break;
  }
}

async function connectRealtime(session) {
  try {
    if (!navigator.gpu) throw new Error('WebGPUを使えるMac版Chromeで開いてください。');
    if (!await session.ready) throw new Error('音声再生を開始できませんでした。');
    if (session !== realtime) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    if (session !== realtime) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    session.stream = stream;
    session.track = stream.getAudioTracks()[0];
    session.track.enabled = false;
    const peer = new RTCPeerConnection();
    session.peer = peer;
    peer.addTrack(session.track, stream);
    peer.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(peer.connectionState)) {
        endRealtime(session, '接続が切れました。もう一度開始してください。', true);
      }
    };
    const channel = peer.createDataChannel('oai-events');
    channel.onmessage = (event) => realtimeEvent(session, event);
    channel.onclose = () => endRealtime(session, '接続が切れました。もう一度開始してください。', true);
    session.timer = setTimeout(() => {
      endRealtime(session, '接続に時間がかかっています。もう一度開始してください。', true);
    }, 30_000);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const answer = await api('/api/realtime', 'application/sdp', offer.sdp, session.abort.signal);
    await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  } catch (error) {
    endRealtime(session, error.name === 'NotAllowedError'
      ? 'ChromeとmacOSの設定でマイクへのアクセスを許可してください。'
      : error.message, true);
  }
}

live.addEventListener('click', () => {
  if (realtime) {
    endRealtime(realtime, 'リアルタイム会話を終了しました。');
    return;
  }
  if (live.disabled) return;
  realtime = { ready: unlockAudio(), abort: new AbortController(), transcripts: new Map() };
  tell('マイクとRealtime APIに接続しています…');
  updateControls();
  void connectRealtime(realtime);
});

window.addEventListener('pagehide', () => {
  if (realtime) endRealtime(realtime, 'リアルタイム会話を終了しました。');
});

try {
  const response = await fetch('/config');
  if (!response.ok) throw new Error();
  config = await response.json();
  get('voice').textContent = config.bluesky ? 'Blueskyちゃん · WebGPU' : '全力マリン · WebGPU';
  get('credit').hidden = !config.bluesky;
  if (!config.apiReady) tell('「声を試す」はAPIキーなしで使えます。対話を有効にするには --api を付けて起動してください。');
  else if (!micAvailable) tell('マイクを使うにはMac版Chromeで開いてください。テキストでの会話は可能です。');
  updateControls();
} catch {
  tell('アプリの設定を読み込めませんでした。起動し直してください。', true);
}
