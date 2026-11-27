import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const zen = process.env.ZEN_TTS_DIR || join(homedir(), 'zen-tts');
const port = Number(process.env.PORT || 8765);
const host = '127.0.0.1';
const origin = `http://${host}:${port}`;
const apiKey = process.env.OPENAI_API_KEY?.trim();
const bluesky = process.env.BLUESKY_LICENSE_OK === '1';
const realtimeModel = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
const chatModel = process.env.OPENAI_CHAT_MODEL || 'gpt-4.1-mini';
const sttModel = process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe';
const mime = new Map([
  ['audio/webm', 'webm'], ['audio/mp4', 'mp4'], ['audio/ogg', 'ogg'],
]);
const files = new Map([
  ['/', [join(root, 'public/index.html'), 'text/html; charset=utf-8']],
  ['/style.css', [join(root, 'public/style.css'), 'text/css; charset=utf-8']],
  ['/app.js', [join(root, 'public/app.js'), 'text/javascript; charset=utf-8']],
  ['/zen/dist/index.js', [join(zen, 'dist/index.js'), 'text/javascript; charset=utf-8']],
  ['/zen/dist/version.js', [join(zen, 'dist/version.js'), 'text/javascript; charset=utf-8']],
  ['/zen/models/g2p/g2p.json', [join(zen, 'models/g2p/g2p.json'), 'application/json']],
  ['/zen/models/g2p/g2p.bin', [join(zen, 'models/g2p/g2p.bin'), 'application/octet-stream']],
  ['/zen/license', [join(zen, 'LICENSE.md'), 'text/plain; charset=utf-8']],
  ['/zen/notices', [join(zen, 'THIRD_PARTY_NOTICES.md'), 'text/plain; charset=utf-8']],
]);
if (bluesky) {
  files.set('/zen/bluesky.ztm', [join(zen, 'voices/bluesky.ztm'), 'application/octet-stream']);
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) {
    throw new RequestError(413, '送信サイズが上限を超えています。');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) {
      request.resume();
      throw new RequestError(413, '送信サイズが上限を超えています。');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function realtimeAuthMessage(headers, signal) {
  try {
    const check = await fetch('https://api.openai.com/v1/models', {
      headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    await check.body?.cancel().catch(() => {});
    if (check.ok) return '同じキーで通常のAPI認証は通りましたが、Realtime接続は拒否されました。キーを作ったプロジェクトのRealtime権限を確認してください。';
    if (check.status === 401) return '通常のAPI認証でもキーが拒否されました。発行時にコピーしたシークレットキーをターミナルに貼り直してください。';
    if (check.status === 403) return 'Realtime接続が拒否され、モデル一覧へのアクセスも許可されていません。キーを作ったプロジェクトとキーの権限を確認してください。';
  } catch {
    // The original Realtime authentication error is still available.
  }
  return 'Realtime接続の認証が拒否されました。キーとプロジェクトの権限を確認してください。';
}

async function openai(path, body, signal, format = 'json') {
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (typeof body === 'string') headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(`https://api.openai.com/v1/${path}`, {
      method: 'POST', headers, body, redirect: 'error', signal,
    });
  } catch {
    throw new RequestError(502, 'OpenAI APIに接続できませんでした。通信状況を確認して再試行してください。');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 && path === 'realtime/calls') {
      throw new RequestError(502, await realtimeAuthMessage(headers, signal));
    }
    const messages = {
      401: 'OpenAI APIキーを確認してください。',
      403: 'APIキーの権限とモデルへのアクセスを確認してください。',
      404: 'OpenAIのモデル設定を確認してください。',
      429: 'OpenAI APIの利用上限や請求設定を確認してください。',
    };
    throw new RequestError(502, messages[response.status] || `OpenAI APIで処理できませんでした（HTTP ${response.status}）。`);
  }
  return format === 'text' ? response.text() : response.json();
}

async function chat(request, type, signal) {
  if (type !== 'application/json') throw new RequestError(415, 'テキストの送信形式が無効です。');
  let messages;
  try {
    messages = JSON.parse(await readBody(request, 32 * 1024))?.messages;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, '会話の形式が無効です。');
  }
  if (!Array.isArray(messages) || !messages.length || messages.length > 9 ||
      messages.length % 2 === 0 || messages.some((item, index) =>
        item?.role !== (index % 2 ? 'assistant' : 'user') ||
        typeof item.content !== 'string' || !item.content.trim() || item.content.length > 1000)) {
    throw new RequestError(400, '会話の形式または文字数を確認してください。');
  }
  const result = await openai('chat/completions', JSON.stringify({
    model: chatModel,
    store: false,
    max_completion_tokens: 300,
    messages: [
      { role: 'system', content: 'あなたは日本語で話す会話相手です。親しみやすく、少し上品な口調で、読み上げやすい自然な日本語を使ってください。装飾記号、絵文字、Markdownを避け、原則3文以内で返してください。' },
      ...messages.map(({ role, content }) => ({ role, content })),
    ],
  }), signal);
  const reply = result.choices?.[0]?.message?.content?.trim().slice(0, 1000);
  if (!reply) throw new RequestError(502, '空の応答が返りました。');
  return { reply };
}

async function transcribe(request, type, signal) {
  const extension = mime.get(type);
  if (!extension) throw new RequestError(415, 'この録音形式は使えません。Chromeで開いてください。');
  const audio = await readBody(request, 8 * 1024 * 1024);
  if (!audio.length) throw new RequestError(400, '録音データが空です。');
  const form = new FormData();
  form.append('file', new Blob([audio], { type }), `recording.${extension}`);
  form.append('model', sttModel);
  form.append('language', 'ja');
  const result = await openai('audio/transcriptions', form, signal);
  const text = result.text?.trim();
  if (!text) throw new RequestError(422, '発話を認識できませんでした。もう一度お試しください。');
  if (text.length > 1000) throw new RequestError(422, '認識結果が長すぎます。短めに話してください。');
  return { text };
}

async function realtimeCall(request, type, signal) {
  if (type !== 'application/sdp') throw new RequestError(415, '通話の接続形式が無効です。');
  const sdp = (await readBody(request, 64 * 1024)).toString('utf8');
  if (!sdp.startsWith('v=0')) throw new RequestError(400, '通話の接続情報が無効です。');
  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify({
    type: 'realtime',
    model: realtimeModel,
    output_modalities: ['text'],
    instructions: '日本語で会話してください。少し上品で自然な話し言葉で、原則として短い1〜2文で答えます。Markdownや絵文字は使いません。',
    max_output_tokens: 220,
    audio: { input: {
      transcription: { model: sttModel, language: 'ja' },
      turn_detection: {
        type: 'server_vad', silence_duration_ms: 600,
        create_response: true, interrupt_response: false,
      },
    } },
  }));
  return { sdp: await openai('realtime/calls', form, signal, 'text') };
}

const postHandlers = new Map([
  ['/api/chat', chat], ['/api/transcribe', transcribe], ['/api/realtime', realtimeCall],
]);
let inFlight = false;
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'microphone=(self)');
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' https://tts-models.zenryoku.work; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if (request.headers.host !== `${host}:${port}`) throw new RequestError(403, '127.0.0.1の起動URLから開いてください。');
    const path = request.url;
    if (request.method === 'GET') {
      if (path === '/config') return json(response, 200, { apiReady: Boolean(apiKey), bluesky });
      const file = files.get(path) || (/^\/zen\/dist\/runtime\/[a-z0-9-]+\.js$/.test(path)
        ? [join(zen, 'dist/runtime', basename(path)), 'text/javascript; charset=utf-8'] : null);
      if (!file) throw new RequestError(404, '見つかりません。');
      const [filename, contentType] = file;
      const info = await stat(filename).catch(() => null);
      if (!info?.isFile()) throw new RequestError(404, '必要なファイルが見つかりません。');
      response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': info.size });
      await pipeline(createReadStream(filename), response);
      return;
    }
    const handler = postHandlers.get(path);
    if (request.method !== 'POST' || !handler) throw new RequestError(404, '見つかりません。');
    if (request.headers.origin !== origin || request.headers['x-voice-app'] !== '1') {
      throw new RequestError(403, 'このアプリの画面から操作してください。');
    }
    if (!apiKey) throw new RequestError(503, '起動時にOpenAI APIキーを設定してください。');
    if (inFlight) throw new RequestError(429, '処理中です。少し待ってから再試行してください。');
    inFlight = true;
    const cancelled = new AbortController();
    response.once('close', () => cancelled.abort());
    try {
      const type = request.headers['content-type']?.split(';')[0];
      const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(75_000)]);
      json(response, 200, await handler(request, type, signal));
    } finally {
      inFlight = false;
    }
  } catch (error) {
    if (!response.headersSent && !response.destroyed) {
      json(response, error.status || 500, { error: error.status ? error.message : '処理に失敗しました。' });
    }
  }
});

for (const path of ['/zen/dist/index.js', '/zen/models/g2p/g2p.json', '/zen/models/g2p/g2p.bin', ...(bluesky ? ['/zen/bluesky.ztm'] : [])]) {
  await access(files.get(path)[0]).catch(() => {
    console.error(`必要なファイルがありません。 ${files.get(path)[0]}`);
    process.exit(1);
  });
}
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `ポート ${port} は使用中です。PORT を変更してください。` : '起動できませんでした。');
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(origin);
  if (process.env.VOICE_OPEN_BROWSER === '1') {
    execFile('/usr/bin/open', ['-a', 'Google Chrome', origin], (error) => {
      if (error) console.error('Chromeで起動URLを開いてください。');
    });
  }
});
