// Grok 生图 CLI 引擎（ry.live）— Node 24 零依赖
// 用法: node grok_image.mjs --prompt "..." --model standard|v2|quality --resolution 1k|1.5k|2k --ratio 1:1 --out "目录"
// 服务模式: node grok_image.mjs --serve [--port 8788]  → POST /generate + GET /health，空闲 5 分钟自动退出
// 密钥: 环境变量 NEW_API_KEY，或同目录 .env（NEW_API_KEY=xxx），或同目录 key.txt（一行）
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = 'https://ry.live';
const HOST = '127.0.0.1';
const DEFAULT_PORT = 8788; // 与 sysinfo-xapp(8787) 错开，避免同时使用时端口冲突
const DEFAULT_IDLE_SECONDS = 60; // 心跳驱动：无心跳且无进行中请求超过该秒数自动退出（面板关闭即停心跳）
const sleep = ms => new Promise(r => setTimeout(r, ms));
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// —— 密钥加载：环境变量 > cwd/.env > exeDir/.env > cwd/key.txt > exeDir/key.txt ——
function loadKey() {
  if (process.env.NEW_API_KEY) return process.env.NEW_API_KEY.trim();
  const exeDir = __dirname;
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(exeDir, '.env'),
    path.join(process.cwd(), 'key.txt'),
    path.join(exeDir, 'key.txt'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    const line = raw.split(/\r?\n/).find(l => /^NEW_API_KEY=/.test(l.trim()));
    const v = line ? line.split('=').slice(1).join('=').trim() : raw.trim();
    if (v && !v.startsWith('#')) return v;
  }
  return null;
}

// —— Eliroot 密钥：eliroot/key.txt（2026-10-26 已与主 KEY 合并为同一把；缺失时回退 loadKey()）——
function loadElirootKey() {
  if (process.env.ELIROOT_API_KEY) return process.env.ELIROOT_API_KEY.trim();
  const candidates = [
    path.join(__dirname, '..', 'eliroot', 'key.txt'),
    path.join(process.cwd(), 'eliroot', 'key.txt'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    const line = raw.split(/\r?\n/).find(l => /^NEW_API_KEY=/.test(l.trim()));
    const v = line ? line.split('=').slice(1).join('=').trim() : raw.trim();
    if (v && !v.startsWith('#')) return v;
  }
  return null;
}

function getKeyFor(modelName) {
  if (ELIROOT_MODELS.has(modelName)) return loadElirootKey() || loadKey();
  return loadKey();
}

// fetch 带超时（防上游挂起无限等待）
async function fetchT(url, opts = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else { args[key] = true; }
    }
  }
  return args;
}

const MODEL_MAP = {
  standard: 'grok-imagine-image',
  v2: 'grok-imagine-image-2.0',
  quality: 'grok-imagine-image-quality',
  eliroot: 'eliroot-image-2.1',
  'eliroot-turbo': 'eliroot-image-2.1-turbo',
};
const ELIROOT_MODELS = new Set(['eliroot', 'eliroot-turbo']);
const VALID_RES = ['1k', '1.5k', '2k'];
const VALID_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
// Eliroot 尺寸由宽高比映射（32 倍数、宽×高 ≤ 1,048,576，无 2K）
const RATIO_TO_ELIROOT_SIZE = {
  '1:1': '1024x1024',
  '16:9': '1024x576',
  '9:16': '576x1024',
  '4:3': '1024x768',
  '3:4': '768x1024',
};

// —— 核心生成逻辑：返回 { b64, mode, fileSize, outputPath, model }，同时落盘 ——
async function generateImage({ key, prompt, modelName, resolution, ratio, outDir, timeoutMs, fast, noFallback }) {
  const model = MODEL_MAP[modelName] || MODEL_MAP.standard;
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(outDir, `grok_${ts}_${modelName || 'standard'}.jpg`);

  // --fast: 先试方式A（b64_json 直出，最快），失败自动降级方式B（可能两次计费）
  if (fast) {
    console.log('[engine] --fast: trying path A (b64_json)...');
    try {
      const r = await fetchT(`${BASE}/v1/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, n: 1, resolution, aspect_ratio: ratio, response_format: 'b64_json' }),
      }, timeoutMs);
      const d = await r.json();
      const item = d.data && d.data[0];
      if (item && item.b64_json) {
        fs.writeFileSync(outPath, Buffer.from(item.b64_json, 'base64'));
        return { status: 'success', b64: item.b64_json, outputPath: outPath, fileSize: fs.statSync(outPath).size, model: modelName, mode: 'A-b64' };
      }
      if (item && item.url) {
        try {
          const buf = Buffer.from(await (await fetchT(item.url, {}, timeoutMs)).arrayBuffer());
          fs.writeFileSync(outPath, buf);
          return { status: 'success', b64: buf.toString('base64'), outputPath: outPath, fileSize: buf.length, model: modelName, mode: 'A-url' };
        } catch (e) {
          console.log('[engine] Path A url download failed:', e.message);
        }
      }
      console.log('[engine] Path A returned no usable data:', r.status, JSON.stringify(d).slice(0, 200));
    } catch (e) {
      console.log('[engine] Path A error:', e.message);
    }
    if (noFallback) {
      throw new Error('Path A failed and --no-fallback set, aborting (no fallback to avoid double billing)');
    }
    console.log('[engine] Falling back to path B task flow (may bill twice)...');
  } else {
    console.log('[engine] Using path B task flow (default, single charge)...');
  }

  // 方式B: 任务流程（可靠，ry.live 域名下载）
  const submitRes = await fetchT(`${BASE}/v1/tasks/xai-imagine`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, n: 1, resolution, aspect_ratio: ratio }),
  }, timeoutMs);
  const submitData = await submitRes.json();
  const taskId = submitData.task_id || submitData.id || (submitData.data && submitData.data.task_id);
  if (!taskId) throw new Error('Submit task failed: ' + JSON.stringify(submitData).slice(0, 200));

  let status = '';
  for (let i = 0; i < 40; i++) {
    const r = await fetchT(`${BASE}/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${key}` } }, timeoutMs);
    const d = await r.json();
    status = d.status;
    if (status === 'SUCCESS') break;
    if (status === 'FAILURE') throw new Error('Task failed: ' + (d.fail_reason || 'unknown'));
    await sleep(3000);
  }
  if (status !== 'SUCCESS') throw new Error('Polling timeout');

  const artRes = await fetchT(`${BASE}/v1/tasks/${taskId}/artifacts`, { headers: { Authorization: `Bearer ${key}` } }, timeoutMs);
  const artData = await artRes.json();
  const keys = [];
  let contentUrl = null;
  const collect = o => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(collect); return; }
    if (typeof o.key === 'string' && !keys.includes(o.key)) keys.push(o.key);
    if (typeof o.content_url === 'string' && !contentUrl) contentUrl = o.content_url;
    Object.values(o).forEach(collect);
  };
  collect(artData);
  if (keys.length === 0 && !contentUrl) throw new Error('No artifacts');

  let url = null;
  if (keys.length > 0) {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const dlRes = await fetchT(`${BASE}/v1/tasks/${taskId}/artifacts/${encodeURIComponent(keys[0])}/download-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
      }, timeoutMs);
      const dlData = await dlRes.json();
      const retryAfter = parseInt(dlRes.headers.get('retry-after') || '0', 10);
      url = dlData.url || dlData.download_url || (dlData.data && (dlData.data.url || dlData.data.download_url));
      if (url) break;
      if (dlRes.status === 202 || dlData.artifact_status === 'publishing') {
        await sleep((retryAfter > 0 ? retryAfter : 5) * 1000);
        continue;
      }
      break;
    }
  }
  if (!url && contentUrl) url = contentUrl;
  if (!url) throw new Error('Download URL not ready');

  const buf = Buffer.from(await (await fetchT(url, {}, timeoutMs)).arrayBuffer());
  fs.writeFileSync(outPath, buf);
  return { status: 'success', b64: buf.toString('base64'), outputPath: outPath, fileSize: buf.length, model: modelName, mode: 'B-task', taskId };
}

// —— Eliroot 生成逻辑：同步 OpenAI 兼容接口，文生图或图生图（1-4 参考图）——
// images 入参为数组，元素支持 { data: 'data:image/xxx;base64,...', name? } 或纯 base64 字符串
async function generateEliroot({ key, prompt, modelName, model, size, quality, seed, images, outDir, timeoutMs }) {
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeModel = modelName.replace(/[^a-zA-Z0-9.-]/g, '_');
  const outPath = path.join(outDir, `eliroot_${ts}_${safeModel}.png`);

  const parseImg = entry => {
    const obj = typeof entry === 'string' ? { data: entry } : (entry || {});
    const data = String(obj.data || '');
    let mime = 'image/png';
    const m = /^data:([^;,]+);base64,/.exec(data);
    if (m) mime = m[1];
    const b64 = data.replace(/^data:[^,]+,/, '');
    const ext = mime === 'image/webp' ? '.webp' : /jpe?g/.test(mime) ? '.jpg' : '.png';
    return { buf: Buffer.from(b64, 'base64'), mime, name: (obj.name || 'ref' + Math.random().toString(36).slice(2, 8)) + ext };
  };

  let raw;
  if (images && images.length > 0) {
    // 图生图 / 参考图编辑: POST /v1/images/edits (multipart/form-data)
    // ry.live 文档：支持 1-4 张参考图；单图可用一次 image 或一项 image[]，
    // 2-4 图必须重复提交 image[]（按顺序=图1、图2…）；不可混用 image 与 image[]，
    // 也不可重复 image。统一用 image[] 对 1-4 张均合法。
    const fd = new FormData();
    fd.append('model', model);
    fd.append('prompt', prompt);
    fd.append('size', size);
    fd.append('quality', quality || 'auto');
    fd.append('seed', String(seed ?? 42));
    for (const entry of images.slice(0, 4)) {
      const { buf, mime, name } = parseImg(entry);
      fd.append('image[]', new Blob([buf], { type: mime }), name);
    }
    const r = await fetchT(`${BASE}/v1/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    }, timeoutMs);
    const d = await r.json();
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(d).slice(0, 400)}`);
    const item = d.data && d.data[0];
    if (!item || !item.b64_json) throw new Error('No b64_json in edits response: ' + JSON.stringify(d).slice(0, 300));
    raw = Buffer.from(item.b64_json, 'base64');
  } else {
    // 文生图: POST /v1/images/generations
    const body = { model, prompt, size, n: 1, quality: quality || 'auto', response_format: 'b64_json', seed: seed ?? 42 };
    const r = await fetchT(`${BASE}/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMs);
    const d = await r.json();
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(d).slice(0, 400)}`);
    const item = d.data && d.data[0];
    if (!item || !item.b64_json) throw new Error('No b64_json in response: ' + JSON.stringify(d).slice(0, 300));
    raw = Buffer.from(item.b64_json, 'base64');
  }

  fs.writeFileSync(outPath, raw);
  return {
    status: 'success', b64: raw.toString('base64'), outputPath: outPath, fileSize: raw.length,
    model: modelName, size, mode: images && images.length ? 'E-edit' : 'E-b64-sync',
  };
}

// —— CLI 模式（默认）：打印 JSON 退出，输出格式保持兼容 ——
async function main() {
  const args = parseArgs();
  if (args.help || args.h) {
    console.log(`Image CLI (ry.live) — Grok + Eliroot
Usage: node grok_image.mjs --prompt "description" [options]
Options:
  --prompt      required, image description
  --model       standard | v2 | quality | eliroot | eliroot-turbo (default standard)
  --resolution  1k | 1.5k | 2k (default 1k; 1.5k only for v2; Grok only)
  --ratio       1:1 | 16:9 | 9:16 | 4:3 | 3:4 (default 1:1)
  --size        Eliroot only: 1024x1024 etc (default from ratio, 32-multiple, <=1M px)
  --image       Eliroot only: reference image path for img2img/edit (repeatable, 1-4)
  --quality     Eliroot only: auto | high | standard (default auto)
  --seed        Eliroot only: seed (default 42)
  --out         output directory (default ./grok-images)
  --timeout     per-request timeout seconds (default 60; Eliroot default 660)
  --fast        Grok only: try path A (b64_json) first, fall back to path B if it fails (may bill twice)
  --no-fallback with --fast: fail instead of falling back (single charge, may produce no image)
  --serve       run as bridge service on 127.0.0.1:8788 (POST /generate, GET /health|/heartbeat|/shutdown)
  --port        service port (default 8788)
  --idle        serve mode: auto-exit after N seconds without heartbeat (default 60; panel closes → heartbeat stops → exit)
Mode: Grok default = path B task flow (reliable, single charge); Eliroot = sync b64 API
Key: Grok = NEW_API_KEY / .env / key.txt; Eliroot = eliroot/key.txt (or ELIROOT_API_KEY)`);
    return;
  }
  const prompt = args.prompt;
  if (!prompt) throw new Error('Missing --prompt');
  const modelName = args.model || 'standard';
  if (!MODEL_MAP[modelName]) throw new Error(`Invalid --model: ${modelName}`);
  const key = getKeyFor(modelName);
  if (!key) throw new Error('Missing API key for this model family');
  const ratio = args.ratio || '1:1';
  if (!VALID_RATIOS.includes(ratio)) throw new Error(`Invalid --ratio: ${ratio}`);
  const outDir = args.out || path.join(process.cwd(), 'grok-images');

  let result;
  if (ELIROOT_MODELS.has(modelName)) {
    const size = args.size || RATIO_TO_ELIROOT_SIZE[ratio] || '1024x1024';
    const timeoutMs = parseInt(args.timeout || '660', 10) * 1000;
    // --image 可重复指定参考图路径（1-4 张），读取转 data URI 供图生图
    const images = [];
    if (args.image) {
      const paths = Array.isArray(args.image) ? args.image : [args.image];
      for (const p of paths) {
        if (!fs.existsSync(p)) throw new Error(`Reference image not found: ${p}`);
        const buf = fs.readFileSync(p);
        const mime = /\.(jpe?g)$/i.test(p) ? 'image/jpeg' : /\.webp$/i.test(p) ? 'image/webp' : 'image/png';
        images.push({ data: `data:${mime};base64,${buf.toString('base64')}`, name: path.basename(p) });
      }
    }
    result = await generateEliroot({
      key, prompt, modelName, model: MODEL_MAP[modelName],
      size, quality: args.quality || 'auto', seed: args.seed != null ? parseInt(args.seed, 10) : 42,
      images, outDir, timeoutMs,
    });
  } else {
    const resolution = args.resolution || '1k';
    if (!VALID_RES.includes(resolution)) throw new Error(`Invalid --resolution: ${resolution}`);
    const timeoutMs = parseInt(args.timeout || '60', 10) * 1000;
    result = await generateImage({
      key, prompt, modelName, resolution, ratio, outDir, timeoutMs,
      fast: !!args.fast, noFallback: !!args.noFallback,
    });
  }
  const { b64, ...rest } = result;
  console.log(JSON.stringify(rest));
}

// —— 端口探测：返回 true 表示端口空闲可用 ——
function isPortFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

// —— 服务模式：常驻监听 + 端口自动避让 + 心跳驱动自动退出 ——
async function serve(startPort, idleSeconds = DEFAULT_IDLE_SECONDS) {
  const idleMs = Math.max(10, parseInt(idleSeconds, 10) || DEFAULT_IDLE_SECONDS) * 1000;
  const TRY_COUNT = 5; // 尝试 startPort ~ startPort+4
  let port = null;
  for (let i = 0; i < TRY_COUNT; i++) {
    const p = startPort + i;
    if (await isPortFree(p)) { port = p; break; }
  }
  if (!port) {
    console.error(`[grok] 启动失败: 端口 ${startPort}~${startPort + TRY_COUNT - 1} 均被占用`);
    process.exit(1);
  }
  if (port !== startPort) {
    console.log(`[grok] 端口 ${startPort} 被占用，已自动切换到 ${port}`);
  }

  // 心跳驱动生命周期：面板打开期间每 15s 发 /heartbeat 刷新活动时间；
  // 超过 idleMs 无心跳且无进行中请求 → 自动退出（面板关闭即停心跳）
  let lastActivity = Date.now();
  let activeRequests = 0;
  const idleCheck = setInterval(() => {
    if (activeRequests > 0) return; // 有请求进行中，不退出
    if (Date.now() - lastActivity > idleMs) {
      console.log(`[grok] 无心跳超过 ${Math.round(idleMs / 1000)}s（面板已关闭），自动退出`);
      process.exit(0);
    }
  }, 2000);

  const server = http.createServer((req, res) => {
    lastActivity = Date.now();
    const url = new URL(req.url, `http://${HOST}:${port}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', ts: Date.now() }));
    }

    if (req.method === 'GET' && url.pathname === '/heartbeat') {
      // 面板保活心跳：窗口打开期间每 15s 调用一次
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', ts: Date.now() }));
    }

    if (req.method === 'GET' && url.pathname === '/shutdown') {
      // 面板关闭时尽力通知立即退出（beforeunload fire-and-forget；心跳超时兜底）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', bye: true }));
      setTimeout(() => process.exit(0), 50);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/open-folder') {
      // 打开图片输出目录（固定为引擎旁的 grok-images，不接受任意路径参数，避免被滥用）
      const folder = path.join(__dirname, 'grok-images');
      fs.mkdirSync(folder, { recursive: true });
      const cmd = process.platform === 'win32'
        ? `explorer "${folder}"`
        : process.platform === 'darwin'
          ? `open "${folder}"`
          : `xdg-open "${folder}"`;
      exec(cmd, () => { /* 打开窗口异步执行，不阻塞响应 */ });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'success', folder }));
    }

    if (req.method === 'POST' && url.pathname === '/generate') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        activeRequests++; // 进行中的生成请求：心跳检查跳过，避免长任务误退
        try {
          const p = JSON.parse(body || '{}');
          if (!p.prompt) throw new Error('Missing prompt');
          const modelName = p.model || 'standard';
          if (!MODEL_MAP[modelName]) throw new Error(`Invalid model: ${modelName}`);
          const ratio = p.ratio || '1:1';
          if (!VALID_RATIOS.includes(ratio)) throw new Error(`Invalid ratio: ${ratio}`);
          const key = getKeyFor(modelName);
          if (!key) throw new Error('Missing API key for this model family');
          const outDir = p.out || path.join(__dirname, 'grok-images');

          let result;
          if (ELIROOT_MODELS.has(modelName)) {
            // Eliroot：同步接口，超时上限 600s（排队+推理），ratio → size（32 倍数）
            const size = p.size || RATIO_TO_ELIROOT_SIZE[ratio] || '1024x1024';
            const timeoutMs = parseInt(p.timeout || '660', 10) * 1000;
            result = await generateEliroot({
              key, prompt: p.prompt, modelName, model: MODEL_MAP[modelName],
              size, quality: p.quality || 'auto', seed: p.seed != null ? parseInt(p.seed, 10) : 42,
              images: Array.isArray(p.images) ? p.images.slice(0, 4) : [],
              outDir, timeoutMs,
            });
          } else {
            // GROK：任务端点，支持 resolution
            const resolution = p.resolution || '1k';
            if (!VALID_RES.includes(resolution)) throw new Error(`Invalid resolution: ${resolution}`);
            const timeoutMs = parseInt(p.timeout || '60', 10) * 1000;
            result = await generateImage({
              key, prompt: p.prompt, modelName, resolution, ratio, outDir, timeoutMs,
              fast: !!p.fast, noFallback: !!p.noFallback,
            });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: e.message }));
        } finally {
          activeRequests--;
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', message: 'not found' }));
  });

  server.on('error', (err) => {
    console.error(`[grok] 启动失败: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    console.log(`[grok] 桥接服务已启动: http://${HOST}:${port}`);
    console.log(`[grok] POST /generate 生成图片，GET /health 健康检查。心跳驱动：无心跳 ${Math.round(idleMs / 1000)}s 自动退出（面板关闭即停心跳）。Ctrl+C 手动停止`);
  });
}

const args = parseArgs();
if (args.serve) {
  serve(
    parseInt(args.port || String(DEFAULT_PORT), 10) || DEFAULT_PORT,
    parseInt(args.idle || String(DEFAULT_IDLE_SECONDS), 10) || DEFAULT_IDLE_SECONDS
  );
} else {
  main().catch(e => { console.error('[engine] Error:', e.message); process.exit(1); });
}
