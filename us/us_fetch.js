#!/usr/bin/env node
/**
 * 美区煤炉（www.mercari.com）章昊小卡监控 —— 抓取 + 生成快照 + 钉钉汇总
 *
 * 为什么不用 puppeteer / playwright 的自动化通道：
 *   美区煤炉在 Cloudflare 后面（managed challenge + Turnstile）。
 *   凡是带自动化标记的浏览器都会被卡在 Just a moment... 页。
 *   实测可行的做法：用命令行**直接起真 Chrome**（不加 --enable-automation），
 *   再通过 --remote-debugging-port 用 CDP 接管。navigator.webdriver 保持 false，
 *   指纹与真人浏览器一致，6 秒即可通过。
 *
 * 用法：
 *   node us_fetch.js                     # 正常跑一轮
 *   node us_fetch.js --probe             # 只验证能不能过 cf，打印前几个商品
 *   node us_fetch.js --kw=zhanghao       # 只跑一个关键词
 *   US_PROXY=http://127.0.0.1:7891 node us_fetch.js
 *   CHROME_PATH=/usr/bin/google-chrome node us_fetch.js
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ARG = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? (process.argv[i + 1] || true) : null; };
const HAS = n => process.argv.includes('--' + n);

const PROXY = String(process.env.US_PROXY || '').trim();
const PORT = Number(process.env.US_CDP_PORT || 9333);
const CHROME = process.env.CHROME_PATH ||
  (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/usr/bin/google-chrome');
const OUT = String(process.env.US_OUT || 'mus.json');
const KW_ONLY = ARG('kw');
const PROBE = HAS('probe');

// 钉钉汇总用的常量
const SITE = 'https://mercari-card-watch.app.workbuddy.host/us.html?sharecode=L2A6N4ATZQ';
const JP_SITE = 'https://mercari-card-watch.app.workbuddy.host/?sharecode=L2A6N4ATZQ';
const SHEET_MAX = 20;      // 一张集合图最多 20 格
const LINE_CAP = 22;       // 每条钉钉消息「卡片区」能用的元素行数
const BYTE_CAP = 1800;     // 每条正文的字节预算（钉钉 markdown 超了会 errcode -1）

// ── 监控词：美区卖家写英文，拼写五花八门；中文/韩文也扫一遍（用户 11-20 指定）──
const KEYWORDS = [
  'zhanghao',
  'zhang hao',
  'hao zhang',
  '장하오',
  '章昊',
  'zb1 hao',        // 11-20 新增：粉丝习惯「团名 + 名字」
  'and2ble hao',    // 11-20 新增：同上（他新团）
];

// 明显不是小卡的词（跟日区一样做一层兜底，避免整本专辑/海报刷屏）
const MUST_NOT = [/\balbum\b/i, /\bposter\b/i, /\bsealed\b/i];

// 标题必须带章昊相关词（美区很多卖家一条一条刷「别人的卡」，
// 搜索会把关键词匹配到描述里的也算进来，不卡标题会被刷屏）
const TITLE_STRICT = /zhang\s*hao|zhanghao|jang\s*hao|haohao|hao\s*zhang|章昊|장하오/i;

// 「zb1 hao」「and2ble hao」这两个词本身已经把成员框住了（搜索词里没有别人），
// 标题只要出现独立的 hao 就算命中，否则会把「ZB1 HAO photocard」这种全过滤掉。
const KW_LOOSE = new Set(['zb1 hao', 'and2ble hao']);
const TITLE_LOOSE = /(^|[^a-z])hao([^a-z]|$)/i;
const TITLE_OFF = process.env.US_TITLE_MUST === '0';

function titleOk(nm, kw) {
  if (TITLE_OFF) return true;
  if (TITLE_STRICT.test(nm)) return true;
  return KW_LOOSE.has(String(kw || '').toLowerCase()) && TITLE_LOOSE.test(nm);
}

const MAX_PER_KW = Number(process.env.US_MAX_PER_KW || 260);

// 拦掉的资源类型（省机场流量）。只拦静态媒体，JS/CSS/XHR 一律放行，
// 否则 Cloudflare 挑战跑不起来。US_BLOCK=0 可以整体关掉。
const BLOCK_URLS = process.env.US_BLOCK === '0' ? [] : [
  '*.jpg', '*.jpeg', '*.png', '*.webp', '*.gif', '*.svg', '*.ico', '*.avif',
  '*.bmp', '*.mp4', '*.webm', '*.m3u8', '*.woff', '*.woff2', '*.ttf', '*.otf', '*.eot',
];

const HOURS = 72;          // 快照保留时长（小时）
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const log = (...a) => console.log('[us]', ...a);

// ---------------------------------------------------------------- Chrome 启动
function chromeArgs(profile) {
  const a = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-sync',
    '--lang=en-US', '--window-size=1366,900',
    '--disable-features=Translate,OptimizationHints',
  ];
  if (PROXY) a.push(`--proxy-server=${PROXY}`);
  return a;
}

async function cdpHttp(p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
  return await r.json();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  let bytes = 0;          // 本会话经浏览器下载的字节数（用来盯机场流量）
  const pending = new Map();
  const events = [];
  const send = (method, params = {}) => new Promise(res => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = ev => {
    const d = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); return; }
    if (d.method) {
      events.push(d);
      if (d.method === 'Network.loadingFinished' && d.params && d.params.encodedDataLength) bytes += d.params.encodedDataLength;
    }
  };
  const ready = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return {
    ws, send, events, ready,
    bytes: () => bytes,
    resetBytes: () => { bytes = 0; },
  };
}

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'us-chrome-'));
  const child = spawn(CHROME, chromeArgs(profile).concat(['about:blank']), { stdio: 'ignore' });
  let ok = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { const v = await cdpHttp('/json/version'); log('浏览器', v.Browser); ok = true; break; } catch (e) { }
  }
  if (!ok) { child.kill(); throw new Error('Chrome 调试端口未就绪（检查 CHROME_PATH / xvfb）'); }
  const list = await cdpHttp('/json/list');
  const page = list.find(t => t.type === 'page') || list[0];
  const C = connect(page.webSocketDebuggerUrl);
  await C.ready;
  await C.send('Network.enable', { maxPostDataSize: 262144 });
  // ⚠️ 机场流量大户就在这里：美区搜索页一次要拉几百张缩略图，
  //    每轮 7 个词 × 整页资源 = 几十 MB，而我们要的只是 XHR 里的 JSON。
  //    拦掉图片/字体/音视频（不动 JS/CSS，否则过不了 Cloudflare 挑战）。
  try { await C.send('Network.setBlockedURLs', { urls: BLOCK_URLS }); } catch (e) { log('⚠️ 资源拦截没生效：' + e.message); }
  await C.send('Page.enable');
  const evalJs = async expr => {
    const r = await C.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return null;
    return r && r.result ? r.result.value : null;
  };
  return { child, C, evalJs, close: () => { try { C.ws.close(); } catch (e) { } try { child.kill(); } catch (e) { } } };
}

// ---------------------------------------------------------------- 过 Cloudflare
async function ensurePassed(env, url) {
  env.C.events.length = 0;
  env.C.resetBytes();
  await env.C.send('Page.navigate', { url });
  for (let t = 0; t < 40; t++) {
    await sleep(2000);
    const st = await env.evalJs(`JSON.stringify({t:document.title,w:navigator.webdriver,n:document.querySelectorAll('[data-productid]').length})`);
    if (!st) continue;
    const o = JSON.parse(st);
    if (!/moment|just a/i.test(o.t)) return { ok: true, sec: t * 2, title: o.t, cards: o.n };
  }
  const t = await env.evalJs('document.title');
  return { ok: false, sec: 80, title: t || '?' };
}

// ---------------------------------------------------------------- 抓搜索
async function searchOne(env, kw) {
  const url = `https://www.mercari.com/search/?keyword=${encodeURIComponent(kw)}&sortBy=2`;
  const pass = await ensurePassed(env, url);
  if (!pass.ok) { log(`  ✗ ${kw} 未过挑战：${pass.title}`); return { kw, items: [], pass }; }

  // 等首屏商品渲染，再多滚两屏把分页带出来（每屏 100 条）
  for (let i = 0; i < 20; i++) {
    const n = await env.evalJs(`document.querySelectorAll('[data-productid]').length`);
    if (n > 0) break;
    await sleep(1500);
  }
  for (let i = 0; i < 2; i++) {
    await env.evalJs('window.scrollTo(0,document.body.scrollHeight);1');
    await sleep(2200);
  }

  const bodies = env.C.events.filter(e => e.method === 'Network.responseReceived' && /searchFacetQuery/.test(e.params.response.url));
  const bag = new Map();
  for (const b of bodies) {
    let j = null;
    try {
      const r = await env.C.send('Network.getResponseBody', { requestId: b.params.requestId });
      j = JSON.parse(r.body);
    } catch (e) { continue; }
    const s = j && j.data && j.data.search;
    if (!s || !Array.isArray(s.itemsList)) continue;
    for (const it of s.itemsList) {
      if (!it || !it.id) continue;
      if (!bag.has(it.id) && bag.size >= MAX_PER_KW) continue;
      bag.set(it.id, it);
    }
  }
  log(`  ${kw}：${pass.sec}s 过挑战，收 ${bag.size} 条，流量 ${(env.C.bytes() / 1048576).toFixed(1)} MB`);
  return { kw, items: [...bag.values()], pass };
}

// ---------------------------------------------------------------- 补运费/卖家
async function enrich(env, ids) {
  if (!ids.length) return {};
  const out = {};
  const CHUNK = 8;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const r = await env.evalJs(`(async () => {
      const ids = ${JSON.stringify(part)};
      const res = await Promise.all(ids.map(async iid => {
        try {
          const r = await fetch('https://www.mercari.com/us/item/' + iid + '/', { credentials: 'include' });
          if (!r.ok) return { iid, status: r.status };
          const h = await r.text();
          const ship = h.match(/"shippingRate":\\{[^}]*"value":([0-9.]+)/);
          const seller = h.match(/"@type":"Organization","name":"([^"]+)"/);
          const avail = h.match(/"availability":"https:[^"]*\\/(\\w+)"/);
          const desc = h.match(/"description":"((?:[^"\\\\]|\\\\.){0,400})"/);
          return {
            iid, status: r.status,
            ship: ship ? Number(ship[1]) : null,
            seller: seller ? seller[1] : null,
            avail: avail ? avail[1] : null,
            desc: desc ? desc[1].replace(/\\\\n/g, ' ') : ''
          };
        } catch (e) { return { iid, err: String(e).slice(0, 60) }; }
      }));
      return JSON.stringify(res);
    })()`);
    try {
      (JSON.parse(r || '[]')).forEach(x => { if (x && x.iid) out[x.iid] = x; });
    } catch (e) { }
    await sleep(220);
  }
  return out;
}

// ---------------------------------------------------------------- 钉钉
function dingSign(secret) {
  const crypto = require('crypto');
  const ts = Date.now();
  const str = `${ts}\n${secret}`;
  const sign = crypto.createHmac('sha256', secret).update(str).digest('base64');
  return { ts, sign: encodeURIComponent(sign) };
}

async function dingSend(payload, tag) {
  const hook = process.env.DINGTALK_WEBHOOK;
  const secret = process.env.DINGTALK_SECRET;
  if (!hook) { log('未配置钉钉，跳过推送'); return false; }
  let url = hook;
  if (secret) { const s = dingSign(secret); url += `&timestamp=${s.ts}&sign=${s.sign}`; }
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  log(`钉钉推送(${tag}):`, r.status, j.errmsg || '');
  return r.ok && (j.errcode === 0);
}
const dingText = t => dingSend({ msgtype: 'text', text: { content: t } }, 'text');
const dingMd = (title, text) => dingSend({ msgtype: 'markdown', markdown: { title, text } }, 'md');

// ---------------------------------------------------------------- 集合图 / 图片托管
// 跟卡市（_poca_cloud/notify.js）同一套做法：把一批商品图拼成一张带序号徽章的网格图，
// 传到仓库 main 的 us/notify/，钉钉 markdown 用 ![](url) 引。
// ⚠️ 图片别放会被 force push 的分支，否则下一轮就 404；main 上的按 36 小时清理。
const REPO = String(process.env.GH_REPO || 'LONGXIASASO/mercari-watch').trim();
const GH_TOKEN = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const GH_API = `https://api.github.com/repos/${REPO}/contents/`;
const IMG_DIR = 'us/notify';
const IMG_KEEP_MS = 36 * 3600e3;

const ghHeaders = () => ({
  Authorization: 'Bearer ' + GH_TOKEN,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'us-notify',
  'Content-Type': 'application/json',
});

function rawGet(url, timeout = 20000) {
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.get(url, { timeout, headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return rawGet(next, timeout).then(resolve);
      }
      const bufs = [];
      res.on('data', c => bufs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(bufs) }));
    });
    req.on('error', () => resolve({ status: 0, buf: Buffer.alloc(0) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, buf: Buffer.alloc(0) }); });
  });
}

// 美区的图在 mercdn.net，海外 runner 直连就行；直连空手再退 wsrv
async function fetchImg(u) {
  if (!u) return null;
  const direct = await rawGet(u, 15000);
  if (direct.status === 200 && direct.buf.length > 2000) return direct.buf;
  const viaProxy = await rawGet('https://wsrv.nl/?url=' + encodeURIComponent(u) + '&w=360&output=jpg&q=80', 20000);
  if (viaProxy.status === 200 && viaProxy.buf.length > 2000) return viaProxy.buf;
  return null;
}

/**
 * 把一批商品拼成一张网格图：左上角序号徽章（与消息里的编号对应）+ 底部价格条。
 * list 是 [{ u: 图片URL, p: '主价格', s: '副价格（可空）' }]。
 * 返回 false 表示没生成（sharp 不可用 / 空列表）。
 */
const SHEET_FONT = 'DejaVu Sans, Liberation Sans, Arial, Helvetica, sans-serif';
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 粗估字宽，放不下就缩字号（我们这些价格串基本是 ASCII，0.6 系数够用）
function fitFont(txt, size, maxW) {
  let s = size;
  while (s > 10 && String(txt).length * s * 0.62 > maxW) s -= 1;
  return s;
}

async function buildSheet(sharp, list, outPath) {
  const PAD = 8, GAP = 6;
  const n = Math.min(list.length, 20);
  if (!n) return false;
  const CW = n === 1 ? 220 : (n <= 3 ? 190 : 150);
  const CH = Math.round(CW * 4 / 3);
  const COLS = Math.min(5, n);
  const ROWS = Math.ceil(n / COLS);
  const W = COLS * CW + (COLS - 1) * GAP + PAD * 2;
  const H = ROWS * CH + (ROWS - 1) * GAP + PAD * 2;
  // 同一张图里所有格子的价格条高度一致，看起来才齐
  const barH = list.slice(0, n).some(x => x && x.s) ? 44 : 28;

  const layer = [];
  const overlays = [];
  for (let i = 0; i < n; i++) {
    const c = i % COLS, r = Math.floor(i / COLS);
    const x = PAD + c * (CW + GAP), y = PAD + r * (CH + GAP);
    let tile = null;
    const buf = await fetchImg(list[i].u);
    if (buf) {
      try {
        tile = await sharp(buf).resize(CW, CH, { fit: 'cover', position: 'centre' }).jpeg({ quality: 82 }).toBuffer();
      } catch (e) { tile = null; }
    }
    if (!tile) {
      tile = await sharp({ create: { width: CW, height: CH, channels: 3, background: '#ededed' } }).jpeg().toBuffer();
    }
    layer.push({ input: tile, left: x, top: y });

    // 序号徽章
    const cx = x + 19, cy = y + 19;
    overlays.push(
      `<circle cx="${cx}" cy="${cy}" r="15" fill="#DF3363"/>` +
      `<text x="${cx}" y="${cy + 6}" font-family="${SHEET_FONT}" font-size="18" ` +
      `font-weight="bold" fill="#ffffff" text-anchor="middle">${i + 1}</text>`
    );

    // 底部价格条：白底深字，压在图上保证任何底图都看得清
    const price = String((list[i] && list[i].p) || '');
    const sub = String((list[i] && list[i].s) || '');
    if (price) {
      overlays.push(`<rect x="${x}" y="${y + CH - barH}" width="${CW}" height="${barH}" fill="#ffffff" opacity="0.95"/>`);
      const y1 = sub ? y + CH - barH + 21 : y + CH - 9;
      overlays.push(
        `<text x="${x + CW / 2}" y="${y1}" font-family="${SHEET_FONT}" ` +
        `font-size="${fitFont(price, 21, CW - 8)}" font-weight="bold" fill="#23262d" ` +
        `text-anchor="middle">${xmlEsc(price)}</text>`
      );
      if (sub) {
        overlays.push(
          `<text x="${x + CW / 2}" y="${y + CH - 7}" font-family="${SHEET_FONT}" ` +
          `font-size="${fitFont(sub, 12, CW - 8)}" fill="#6b7280" text-anchor="middle">${xmlEsc(sub)}</text>`
        );
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${overlays.join('')}</svg>`;
  layer.push({ input: Buffer.from(svg), left: 0, top: 0 });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
    .composite(layer)
    .jpeg({ quality: 84 })
    .toFile(outPath);
  return true;
}

async function uploadImg(file, buf) {
  if (!GH_TOKEN) { log('⚠️ 没给 GITHUB_TOKEN，本轮不发图'); return ''; }
  try {
    const r = await fetch(GH_API + IMG_DIR + '/' + file, {
      method: 'PUT', headers: ghHeaders(),
      body: JSON.stringify({ message: 'us notify img ' + file, content: buf.toString('base64'), branch: 'main' }),
    });
    if (r.status !== 201 && r.status !== 200) {
      log(`⚠️ 上传集合图失败 ${file} HTTP ${r.status}`);
      return '';
    }
    // jsDelivr 用 @main 会命中长缓存，用 @<sha> 能立刻拿到这个 commit 的文件
    const j = await r.json();
    return (j && j.commit && j.commit.sha) ? j.commit.sha.slice(0, 10) : '';
  } catch (e) { log('⚠️ 上传集合图异常：' + e.message); return ''; }
}

// 上传后必须真的取到图才把 URL 写进消息，否则钉钉里就是一张破图
async function resolveUrl(file, sha) {
  const raw = `https://raw.githubusercontent.com/${REPO}/main/${IMG_DIR}/${file}`;
  const cands = [];
  cands.push('https://wsrv.nl/?url=' + encodeURIComponent(raw) + '&output=jpg&q=85&t=' + Date.now());
  if (sha) cands.push(`https://cdn.jsdelivr.net/gh/${REPO}@${sha}/${IMG_DIR}/${file}`);
  for (const u of cands) {
    for (let i = 0; i < 6; i++) {
      const r = await rawGet(u, 20000);
      if (r.status === 200 && r.buf.length > 2000) return u;
      await sleep(2000);
    }
  }
  log(`⚠️ 集合图 ${file} 取不到，消息里就不放图了`);
  return '';
}

async function publishSheet(sharp, list, fileName, tmpPath) {
  if (!GH_TOKEN) return '';
  if (!(await buildSheet(sharp, list, tmpPath))) return '';
  const sha = await uploadImg(fileName, fs.readFileSync(tmpPath));
  if (!sha) return '';
  return resolveUrl(fileName, sha);
}

// main 上的图会一直堆，超过 36 小时的清掉
async function pruneImgs() {
  if (!GH_TOKEN) return;
  try {
    const r = await fetch(GH_API + IMG_DIR + '?ref=main', { headers: ghHeaders() });
    if (r.status !== 200) return;
    const list = await r.json();
    if (!Array.isArray(list)) return;
    const now = Date.now();
    let n = 0;
    for (const f of list) {
      const m = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.jpg$/.exec(f.name);
      if (!m) continue;
      const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00`);
      if (!t || now - t < IMG_KEEP_MS) continue;
      await fetch(GH_API + IMG_DIR + '/' + f.name, {
        method: 'DELETE', headers: ghHeaders(),
        body: JSON.stringify({ message: 'prune ' + f.name, sha: f.sha, branch: 'main' }),
      });
      n++;
    }
    if (n) log(`   清理旧集合图 ${n} 张`);
  } catch (e) { }
}

const usd2 = n => '$' + (Number(n) || 0).toFixed(2);
const daiqie = (p, s) => ((Number(p) || 0) + (Number(s) || 0)) * 7.2 + 7;

// ---------------------------------------------------------------- 主流程
(async () => {
  const t0 = nowSec();

  // US_DIGEST_DRY=1：不抓取，直接拿本地快照造一条汇总，把 markdown 和集合图打印出来（不发钉钉）
  if (process.env.US_DIGEST_DRY === '1') {
    let p = { items: [] };
    try { p = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { log('没有本地快照 ' + OUT); }
    const fake = (p.items || []).slice(0, 14);
    if (!fake.length) { log('本地快照为空，无法预览'); process.exit(0); }
    const now = Math.floor(Date.now() / 1000);
    const snap = { at_cn: new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' '), items: fake, at: new Date().toISOString() };
    const newL = fake.slice(0, 8).map(i => Object.assign({}, i, { first_seen: now, last_seen: now }));
    const dropL = fake.slice(8, 11).map((i, k) => Object.assign({}, i, {
      // 前两条造降价、第三条造涨价，验证「改价」两种方向都能播
      prev_price_usd: k === 2 ? Math.max(0.5, (i.price_usd || 1) - 2) : (i.price_usd || 0) + 3,
      last_seen: now,
    }));
    log(`[dry] 造数据：美区上新 ${newL.length} / 降价 ${dropL.length}`);
    await pushDigest(snap, newL, dropL);
    log('[dry] 结束（没发钉钉）');
    process.exit(0);
  }

  let prev = { items: [], runs: [] };
  try {
    if (fs.existsSync(OUT)) prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (e) { log('旧快照读取失败，按空处理'); }
  const prevMap = new Map((prev.items || []).map(it => [it.id, it]));

  // US_DIGEST_REPLAY=1：不抓取，直接按时间窗从线上快照重算一遍汇总并真的发钉钉（重播用）
  //   US_DIGEST_WIN=<分钟> 指定窗口，默认 60；配合 US_DIGEST_DRY=1 则只打印不发送
  if (process.env.US_DIGEST_REPLAY === '1') {
    const winMin = Number(process.env.US_DIGEST_WIN || 60);
    const win = winMin * 60;
    const now = nowSec();
    const items = prev.items || [];
    const newList = items
      .filter(i => !i.sold && (Number(i.first_seen) || 0) >= now - win)
      .sort((a, b) => (b.first_seen || 0) - (a.first_seen || 0));
    const dropList = items
      .filter(i => !i.sold && i.prev_price_usd
        && Math.abs(i.prev_price_usd - (i.price_usd || 0)) >= 0.01
        && (Number(i.last_seen) || 0) >= now - win)
      .sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
    const snap = {
      at_cn: new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ') + ' 重播',
      items, at: new Date().toISOString(), digest: prev.digest || {},
    };
    log(`[replay] 窗口 ${winMin} 分钟：美区上新 ${newList.length} / 降价 ${dropList.length}`);
    const sent = await pushDigest(snap, newList, dropList);
    log('[replay] ' + (sent ? '已发出' : '没发（无内容或钉钉失败）'));
    process.exit(0);
  }

  const env = await launch();
  let all = [];
  try {
    const kws = KW_ONLY ? [KW_ONLY] : KEYWORDS;
    // 刚过挑战的头一两个词经常抓到 0 条（结果还没渲染出来），
    // 每轮把搜索顺序转一格，别让固定的两个词长期挨这一刀
    const rot = kws.length > 1 ? Math.floor(nowSec() / 600) % kws.length : 0;
    const order = kws.slice(rot).concat(kws.slice(0, rot));
    // 预热：先进首页把 Cloudflare 过掉，否则第一个关键词经常抓到 0 条
    const warm = await ensurePassed(env, 'https://www.mercari.com/');
    log('预热', warm.ok ? `${warm.sec}s 通过` : `失败(${warm.title})`);
    await sleep(2500);
    const zero = [];
    let flowMB = 0;
    for (const kw of order) {
      let r = await searchOne(env, kw);
      for (let a = 0; a < 2 && !r.items.length; a++) {   // 偶发空手：同会话再进一两次基本就出数据
        log(`   ${kw} 空手，第 ${a + 1} 次重试`);
        await sleep(2000 + a * 2000);
        r = await searchOne(env, kw);
      }
      flowMB += env.C.bytes() / 1048576;
      if (!r.items.length) zero.push(kw);
      r.items.forEach(it => { it.__kw = kw; all.push(it); });
      await sleep(1200);
    }
    if (zero.length) log('⚠️ 本轮零结果的词：' + zero.join(' / '));
    log(`本轮浏览器流量约 ${flowMB.toFixed(1)} MB（拦截：${BLOCK_URLS.length ? '图片/字体/音视频' : '关闭'}）`);

    if (PROBE) {
      log('探测模式，商品抽样：');
      all.slice(0, 10).forEach(it => log(' ', it.id, '|', usd2(it.price / 100), '|', (it.name || '').slice(0, 50)));
      env.close();
      process.exit(all.length ? 0 : 1);
    }

    // 去重
    const uniq = new Map();
    for (const it of all) if (!uniq.has(it.id)) uniq.set(it.id, it);
    all = [...uniq.values()];

    // 过滤
    const before = all.length;
    const rawTotal = all.length;
    let droppedTitle = 0;
    all = all.filter(it => {
      const nm = it.name || '';
      if (MUST_NOT.some(re => re.test(nm))) return false;
      if (!titleOk(nm, it.__kw)) { droppedTitle++; return false; }
      if (it.status && !/^(on_sale|trading)$/.test(it.status)) return false;
      return true;
    });
    log(`抓到 ${before} 条，标题不含章昊丢掉 ${droppedTitle} 条，余 ${all.length} 条`);

    // 各搜索词最后留下多少（哪个词长期为 0 一眼能看出来）
    const perKw = {};
    all.forEach(it => { const k = it.__kw || '-'; perKw[k] = (perKw[k] || 0) + 1; });
    log('各词留下：' + Object.entries(perKw).map(([k, v]) => `${k} ${v}`).join(' ｜ '));

    // 需要补运费的：新的 + 之前没拿到运费的
    // ⚠️ 2026-11-20 修：这里原来写 `p.ship`，但快照字段叫 `ship_usd`，
    //    于是「没有运费」永远成立 → 每轮都把全部 224 条详情页重抓一遍（约 45MB/轮，
    //    一天上 6GB 机场流量）。字段名改对，再加一道「上架 6 小时内才重试」的闸。
    const need = all.filter(it => {
      const p = prevMap.get(it.id);
      if (!p) return true;                       // 新卡：必须补
      if (p.ship_usd != null) return false;      // 已有运费：跳过
      // 一直拿不到运费的老卡，别每轮都去啃（详情页最费流量）
      return (Number(it.created) || 0) > t0 - 6 * 3600;
    }).map(it => it.id);
    log(`需补运费/卖家 ${need.length} 条（共 ${all.length} 条，其余沿用上一轮）`);

    const extra = await enrich(env, need.slice(0, 300));
    env.close();

    // 组装快照（字段名必须与页面一致：price_usd / ship_usd / created_ts / updated_ts）
    const items = [];
    const fresh = [];
    const changed = [];
    for (const it of all) {
      const p = prevMap.get(it.id);
      const e = extra[it.id] || {};
      const price = (Number(it.price) || 0) / 100;
      const ship = e.ship != null ? e.ship : (p ? p.ship_usd : null);
      const created = it.created || (p && p.created_ts) || 0;
      const photo = (it.photos && it.photos[0]) || {};
      const rec = {
        id: it.id,
        name: it.name || '',
        name_cn: (p && p.name_cn) || '',
        price_usd: price,
        orig_price_usd: (Number(it.originalPrice) || 0) / 100 || price,
        ship_usd: ship == null ? null : ship,
        daiqie: Number(daiqie(price, ship == null ? 0 : ship).toFixed(1)),
        created_ts: created,
        updated_ts: created,
        list_ts: created,
        thumb_url: photo.thumbnail || (p && p.thumb_url) || '',
        img_url: photo.imageUrl || (p && p.img_url) || '',
        sold: (it.status || 'on_sale') !== 'on_sale',
        cond_id: null,
        query_label: it.__kw || (p && p.query_label) || '',
        seller: e.seller || (p && p.seller) || '',
        seller_id: (it.seller && (it.seller.id || it.seller.sellerId)) || (p && p.seller_id) || null,
        first_seen: p ? p.first_seen : t0,
        last_seen: t0,
        prev_price_usd: p ? p.price_usd : null,
      };
      if (!p) fresh.push(rec);
      // ⚠️ 不只降价：涨价、改价都算「有变化」，一起进播报（她 11-20：别只播上新）
      else if (p.price_usd && Math.abs(price - p.price_usd) >= 0.01) changed.push(rec);
      items.push(rec);
    }

    // 保留旧快照里本轮没出现、但还在窗口内的（下架/已售留痕）
    const seen = new Set(items.map(i => i.id));
    for (const p of (prev.items || [])) {
      if (seen.has(p.id)) continue;
      if (p.price_usd == null) continue;           // 旧版本字段结构，直接丢
      if (t0 - (p.last_seen || 0) > HOURS * 3600) continue;
      items.push(Object.assign({}, p, { sold: true }));
    }

    items.sort((a, b) => (b.created_ts || 0) - (a.created_ts || 0));

    const cnNow = new Date(t0 * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const runs = (prev.runs || []).slice(0, 40);
    runs.unshift({ ran_at: new Date(t0 * 1000).toISOString(), win_hours: HOURS, fetched: rawTotal, matched: all.length, fresh: fresh.length, changed: changed.length });

    const snap = {
      at: new Date(t0 * 1000).toISOString(),
      at_cn: cnNow.slice(5, 16),
      window_hours: HOURS,
      rate: 7.2,
      fee: 7,
      items,
      runs,
      digest: prev.digest || {},
    };
    fs.writeFileSync(OUT, JSON.stringify(snap, null, 1));
    log(`快照写出：${items.length} 条（新增 ${fresh.length}，改价 ${changed.length}）→ ${OUT}`);

    // ── 钉钉：每小时汇总一次（带集合图，跟卡市同一套）──
    /* ⚠️ 别再用「UTC 小时桶」判新小时（dg.hour）：cron 落在 :58 和 :08 两轮跨整点，
       UTC 小时一变两轮都当成「新的一小时」→ 同一张卡连播两遍（她 11-20 反馈）。
       改成「距上次成功播报满 55 分钟」，跟触发点落在哪分钟无关，一小时只会发一条。 */
    const dg = snap.digest;
    const since = Number(dg.flushed_at) || 0;
    const gapSec = t0 - since;
    if (!since || gapSec >= 55 * 60) {
      // ⚠️ 必须排除已售：items 里含「本轮没再出现、按残留标成 sold」的旧条目，
      //    播报时它们早就卖掉了，放进「上新/降价」只会误导（她 11-20 明确指出）
      const newList = items.filter(i => !i.sold && i.first_seen > since && i.first_seen >= t0 - 2 * 3600);
      const dropList = changed.filter(i => !i.sold && (i.last_seen || 0) > since);
      // 无条件进汇总：美区这一小时没动静时日区可能上了新卡，由 pushDigest 自己判断有没有内容
      const sent = await pushDigest(snap, newList, dropList, since, gapSec > 600 ? gapSec : 3600);
      if (sent) dg.flushed_at = t0;
      delete dg.hour;
      snap.digest = dg;
      fs.writeFileSync(OUT, JSON.stringify(snap, null, 1));
    } else {
      log(`距上次播报 ${Math.round(gapSec / 60)} 分钟（未满 55），本轮不汇总`);
    }
  } catch (e) {
    log('异常：', e.message);
    try { env.close(); } catch (x) { }
    process.exit(1);
  }
  log('完成，用时', ((nowSec() - t0) / 60).toFixed(1), '分钟');
})();

/* ---------------------------------------------------------------- 钉钉汇总（带图） */

// ⚠️ 商品名里常带 [ ] ，直接塞进 [名字](链接) 会把 markdown 解析搞坏 → 换全角
const mdName = s => String(s || '').replace(/\[/g, '［').replace(/\]/g, '］').replace(/[\r\n]+/g, ' ').trim();

// 一条卡占一行（钉钉 markdown 里 \n 不换行，段落要空行，所以拆成两行反而翻倍占高）
// ⚠️ 只显示现价，不标原价（她 11-20 18:24 明确要求）；涨没涨看她自己的判断，段标题已分「上新/改价」
function cardLines(it, idx) {
  const name = mdName(it.name).slice(0, 30) || '（无标题）';
  const ship = it.ship_usd != null ? `+运${usd2(it.ship_usd)}` : '';
  return [
    `**${idx}**　[${name}](https://www.mercari.com/us/item/${it.id}/)　${usd2(it.price_usd)}${ship} → ¥${it.daiqie}`,
  ];
}

// 日区：日元原价 + 实时汇率折人民币（JP¥ 是日元、¥ 是人民币，别混）
// 只显示现价、不标原价（她 11-20 18:24 定的）
function jpCardLines(it, idx) {
  const name = mdName(it.name_cn || it.name).slice(0, 30) || '（无标题）';
  const jpy = Number(it.price_jpy) || 0;
  const cny = JP_RATE > 0 ? ` ≈ ¥${(jpy * JP_RATE).toFixed(1)}` : '';
  return [
    `**${idx}**　[${name}](https://jp.mercari.com/item/${it.id})　JP¥${jpy.toLocaleString('en-US')}${cny}`,
  ];
}

/**
 * 读同仓库 main 上的日区快照 mw.json，返回 { fresh: 上新, drops: 改价 }。
 * - sinceSec＝上次**成功播报**的时刻（快照 digest.flushed_at），作为下界：
 *   同一张卡绝不会在两轮播报里各出现一次（她 11-20 反馈「播报重复」就是没这个下界）。
 * - 日区抓取器从 11-20 起会写 prev_price_jpy（＝上一轮价格，价格没变就删掉），
 *   靠它判「刚改过价」；改完价下一轮 prev 自动消失，所以改价天然只播一次。
 */
async function fetchJpFresh(winSec, sinceSec) {
  const urls = [
    `https://raw.githubusercontent.com/${REPO}/main/mw.json`,
    `https://cdn.jsdelivr.net/gh/${REPO}@main/mw.json`,
  ];
  const now = Math.floor(Date.now() / 1000);
  const fallback = now - winSec;
  // 有上次播报时间就用它当起点（窗口自动放大，不漏播）；但最多回溯 6 小时，免得首跑把几百张全播了
  const since = Number(sinceSec) > 0 ? Math.max(Number(sinceSec), now - 6 * 3600) : fallback;

  const pick = (d, tag) => {
    const all = (d.items || []).filter(it => it && !it.sold);
    // 日区判售要连续 45 分钟搜不到才打 sold 标记，所以这里再用「45 分钟内还见过」兜一道：
    // 上架后没几个小时就消失的，多半在播报前已经卖了，不该算进上新。
    const fresh = all
      .filter(it => (Number(it.created_ts) || 0) > since
        && (!it.last_seen || Date.parse(it.last_seen) / 1000 >= now - 45 * 60))
      .sort((a, b) => (b.created_ts || 0) - (a.created_ts || 0));
    const drops = all
      .filter(it => {
        const op = Number(it.prev_price_jpy) || 0, np = Number(it.price_jpy) || 0;
        return op > 0 && np > 0 && op !== np && (Number(it.updated_ts) || 0) > since;
      })
      .sort((a, b) => (b.updated_ts || 0) - (a.updated_ts || 0));
    log(`${tag} ${(d.items || []).length} 张，近 ${Math.round((now - since) / 60)} 分钟：上新 ${fresh.length} 张 / 改价 ${drops.length} 张`);
    return { fresh, drops };
  };

  // 本地调试用：US_JP_FILE=<本地 mw.json 路径>，可以拿假数据验证改价播报的排版
  if (process.env.US_JP_FILE) {
    try { return pick(JSON.parse(fs.readFileSync(process.env.US_JP_FILE, 'utf8')), '[本地]日区快照'); }
    catch (e) { log('US_JP_FILE 读取失败：' + e.message); }
  }

  for (const u of urls) {
    const r = await rawGet(u, 25000);
    if (r.status !== 200 || r.buf.length < 5000) { log(`日区快照拉取失败 ${r.status} ${u.slice(0, 48)}`); continue; }
    try { return pick(JSON.parse(r.buf.toString('utf8')), '日区快照'); }
    catch (e) { log('日区快照解析失败：' + e.message); }
  }
  log('⚠️ 拉不到日区快照，本次汇总只播美区');
  return { fresh: [], drops: [] };
}

// 日元 → 人民币实时汇率（1 JPY = ? CNY）。多个免费源依次试，全挂了就不显示换算，绝不写死假汇率。
let JP_RATE = 0;

async function fetchJpyCny() {
  const srcs = [
    ['er-api', 'https://open.er-api.com/v6/latest/JPY', j => j && j.rates && j.rates.CNY],
    ['jsdelivr', 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/jpy.json', j => j && j.jpy && j.jpy.cny],
    ['frankfurter', 'https://api.frankfurter.app/latest?from=JPY&to=CNY', j => j && j.rates && j.rates.CNY],
  ];
  for (const [tag, u, pick] of srcs) {
    const r = await rawGet(u, 15000);
    if (r.status !== 200) { log(`汇率源 ${tag} 不可用（${r.status}）`); continue; }
    try {
      const v = Number(pick(JSON.parse(r.buf.toString('utf8'))));
      // 正常区间 0.01~0.3，超出多半是接口换了格式
      if (v > 0.01 && v < 0.3) { log(`日元汇率 1 JPY = ${v} CNY（${tag}）`); return v; }
    } catch (e) { log(`汇率源 ${tag} 解析失败`); }
  }
  log('⚠️ 汇率源全部取不到，日区只显示日元');
  return 0;
}

// 按行数 + 字节双约束装箱，切成多条消息（序号跨段不重来，跟图上的红圈一致）
function packCards(list, label, imgUrl, trunc, lineFn) {
  const chunks = [];
  let cur = [], lines = 0, bytes = 0;
  list.forEach((it, i) => {
    const block = lineFn(it, i + 1);
    const b = Buffer.byteLength(block.join('\n'));
    const over = cur.length && (lines + 1 + block.length > LINE_CAP || bytes + b > BYTE_CAP);
    if (over) { chunks.push(cur); cur = []; lines = 0; bytes = 0; }
    if (cur.length) { lines += 1; bytes += 2; }
    cur.push({ it, idx: i + 1 });
    lines += block.length;
    bytes += b;
  });
  if (cur.length) chunks.push(cur);
  return chunks.map((c, i) => ({
    label, img: i === 0 ? imgUrl : '', items: c, part: i + 1, of: chunks.length,
    lines: lineFn,
    trunc: i === chunks.length - 1 ? (trunc || 0) : 0,
  }));
}

function buildMd(p, snap) {
  const L = [`### 🃏 章昊小卡 · 小时汇总（${snap.at_cn}）`, ''];
  L.push(`[🇯🇵 日区看板](${JP_SITE})　｜　[🇺🇸 美区看板](${SITE})`, '');
  L.push(`**${p.label}**${p.of > 1 ? `（第 ${p.part}/${p.of} 段）` : ''}`, '');
  if (p.img) L.push(`![${p.label}](${p.img})`, '');
  p.items.forEach(({ it, idx }, k) => {
    if (k) L.push('');
    L.push(...p.lines(it, idx));
  });
  if (p.trunc > 0) L.push('', `> 另有 ${p.trunc} 条没列出，点上面看板看全部`);
  const tail = JP_RATE > 0
    ? `> 美区代切 =（卡价 + 运费）× 7.2 + 7；日区按实时汇率 1 日元 ≈ ${JP_RATE.toFixed(4)} 元折算`
    : `> 美区代切 =（卡价 + 运费）× 7.2 + 7；日区按日元原价`;
  L.push('', tail);
  return L.join('\n');
}

async function pushDigest(snap, newList, dropList, sinceSec, winSec) {
  let sharp = null;
  try { sharp = require('sharp'); } catch (e) { log('⚠️ 环境里没装 sharp，本轮只发文字'); }

  // 日区：上次播报之后的上新 + 改价（sinceSec 卡下界，同一张卡不会重播）
  const jp = await fetchJpFresh(winSec || 3600, sinceSec);
  const jpFresh = jp.fresh, jpDrops = jp.drops;
  JP_RATE = (jpFresh.length || jpDrops.length) ? await fetchJpyCny() : 0;

  const nShow = newList.slice(0, SHEET_MAX);
  const dShow = dropList.slice(0, SHEET_MAX);

  // 文件名形如 us-new-1120-1503.jpg，pruneImgs 靠这个后缀认时间
  const p2 = n => String(n).padStart(2, '0');
  const cnDate = new Date(Date.now() + 8 * 3600e3);
  const stamp = `${p2(cnDate.getUTCMonth() + 1)}${p2(cnDate.getUTCDate())}-${p2(cnDate.getUTCHours())}${p2(cnDate.getUTCMinutes())}`;
  const tmpDir = path.join(os.tmpdir(), 'us-notify');

  // 图上每格写什么价格：主行大字＝人民币（她 20 日强调「人民币最明显」），副行小字＝原币种价格
  const cny = n => {
    const v = Number(n) || 0;
    return '¥' + (Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : v.toFixed(1));
  };
  const usLabel = it => ({ p: cny(it.daiqie), s: usd2(it.price_usd) });
  // 改价图：主行人民币现价、副行美元现价（不标原价，她 18:24 定的）
  const usChgLabel = it => ({ p: cny(it.daiqie), s: usd2(it.price_usd) });
  // 日区图上的价格：主行大字＝人民币现价，副行小字＝日元现价（不标原价）
  const jpLabel = it => {
    const jpy = Number(it.price_jpy) || 0;
    const y = jpy ? `JP¥${jpy.toLocaleString('en-US')}` : '';
    return JP_RATE > 0 ? { p: cny(jpy * JP_RATE), s: y } : { p: y, s: '' };
  };

  const sheet = async (list, name, labeler) => {
    if (!sharp || !list.length) return '';
    const out = path.join(tmpDir, name);
    try {
      const made = await buildSheet(sharp, list.map(i => Object.assign({ u: i.thumb_url || i.img_url }, labeler(i))), out);
      if (!made) return '';
      // 本地预览用：只生成图不上传，方便看拼图效果
      if (process.env.US_SHEET_DRY === '1') { log('集合图已生成（本地预览，不上传）: ' + out); return ''; }
      const sha = await uploadImg(name, fs.readFileSync(out));
      return sha ? await resolveUrl(name, sha) : '';
    } catch (e) { log('⚠️ 集合图生成失败：' + e.message); return ''; }
  };

  /* 日区上新 + 改价合并成一条消息、一张图（日区一天也就几张，拆两条太碎）；
     条目上只写现价，靠段标题的「上新 N / 改价 M」区分。 */
  const jpAll = jpFresh.concat(jpDrops);
  const jpShow = jpAll.slice(0, SHEET_MAX);
  const jpImg = await sheet(jpShow, `jp-new-${stamp}.jpg`, jpLabel);
  const newImg = await sheet(nShow, `us-new-${stamp}.jpg`, usLabel);
  const dropImg = await sheet(dShow, `us-drop-${stamp}.jpg`, usChgLabel);

  // 顺序：日区在前（主力），然后美区上新、美区改价
  const parts = [];
  if (jpShow.length) {
    const jpLabelText = `🇯🇵 日区 上新 ${jpFresh.length} 张${jpDrops.length ? ` / 改价 ${jpDrops.length} 张` : ''}`;
    parts.push(...packCards(jpShow, jpLabelText, jpImg, jpAll.length - jpShow.length, jpCardLines));
  }
  if (nShow.length) parts.push(...packCards(nShow, `🇺🇸 美区上新 ${newList.length} 条`, newImg, newList.length - nShow.length, cardLines));
  if (dShow.length) {
    // 纯降价就叫「降价」，混了涨价就叫「改价」（她 11-20：变化也要播，不只有上新）
    const hasRise = dropList.some(i => (i.price_usd || 0) > (i.prev_price_usd || 0) + 0.009);
    const usLabelText = hasRise ? `🇺🇸 美区改价 ${dropList.length} 条` : `📉 美区降价 ${dropList.length} 条`;
    parts.push(...packCards(dShow, usLabelText, dropImg, 0, cardLines));
  }
  if (!parts.length) { log('日区/美区都没有上新、改价或降价，不发汇总'); return false; }

  const mds = parts.map(p => buildMd(p, snap));
  log('──────── 消息预览 ────────');
  mds.forEach((m, i) => { log(`—— 第 ${i + 1}/${mds.length} 条 ——`); console.log(m); });
  log('──────────────────────────');

  const title = `🃏 章昊小卡 日区${jpFresh.length}新${jpDrops.length ? '/' + jpDrops.length + '改价' : ''} 美区${newList.length}新${dropList.length ? '/' + dropList.length + '改价' : ''} · ${snap.at_cn}`;
  let ok = 0;
  for (let i = 0; i < mds.length; i++) {
    const t = mds.length > 1 ? `${title}（${i + 1}/${mds.length}）` : title;
    let sent = false;
    for (let a = 0; a < 3 && !sent; a++) {          // 钉钉偶发 errcode -1，隔几秒重发通常就过
      sent = await dingMd(t, mds[i]);
      if (!sent) await sleep(3000);
    }
    if (sent) ok++;
  }
  try { await pruneImgs(); } catch (e) { }
  return ok > 0;
}
