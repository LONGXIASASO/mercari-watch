/**
 * Poca 卡市 · 降价推送到钉钉群机器人
 *
 * 用法：node notify.js [--dry] [--force]
 *   --dry    只打印消息 + 生成本地预览图，不真的发送
 *   --force  忽略「跌破上次推送价」的限制，本轮所有降价都推
 *
 * 环境变量：
 *   DINGTALK_WEBHOOK  机器人 webhook（含 access_token），必须
 *   DINGTALK_SECRET   加签密钥（SEC 开头）
 *   POCA_SITE         跳转站点，默认线上卡市
 *   POCA_NOTIFY_MAX   一条消息最多列几张卡，默认 20
 *   POCA_AT_MOBILES   要 @ 的手机号，逗号分隔（可选）
 *
 * 推送口径：
 *   只推「降价」，涨价与上新不推。
 *   同一张卡在同一个价位反复波动不重复推 —— 只有当价格「跌破上一次推送时告诉你的价」
 *   才会再推一次，避免一轮一条、一天几十条刷屏。
 *
 * 消息排版（务求简洁）：
 *   ① 顶部一行：打开卡市看板
 *   ② 星标降价卡拼成一张集合图、非星标拼一张，图上带序号
 *   ③ 一卡一行：序号 + 卡名（超长截断）+ 人民币从多少到多少，点卡名跳该卡详情
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const WEBHOOK = (process.env.DINGTALK_WEBHOOK || '').trim();
const SECRET = (process.env.DINGTALK_SECRET || '').trim();
const SITE = (process.env.POCA_SITE || 'https://mercari-card-watch.app.workbuddy.host/poca/?sharecode=L2A6N4ATZQ').trim();
const MAX_LIST = Number(process.env.POCA_NOTIFY_MAX || 30);
// 测试用：POCA_NOTIFY_TAG=测试消息 时标题里会带上这个标签，免得群里误会
const TAG = (process.env.POCA_NOTIFY_TAG || '').trim();
const AT_MOBILES = (process.env.POCA_AT_MOBILES || '').split(',').map(s => s.trim()).filter(Boolean);
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

const REPO = 'LONGXIASASO/mercari-watch';
const BRANCH_IMG = 'poca-data';
const CDN = 'https://d1sut5kn3lwnf7.cloudfront.net';

// 人民币换算：与页面默认档位一致（匹配用 0715-韩1、速切用 0715-速切1）
const CNY_M = x => (x + 2000) / 195 + 6;
const CNY_Q = x => x / 197 + 4.5;

/* ---------------- 小工具 ---------------- */

const yuan = v => {
  const s = (Math.round(v * 100) / 100).toFixed(2).replace(/(\.\d)0$/, '$1').replace(/\.00$/, '');
  return '¥' + s;
};
const won = n => '₩' + Number(n || 0).toLocaleString('en-US');
const pad2 = n => String(n).padStart(2, '0');
const cnNow = () => new Date(Date.now() + 8 * 3600e3);
const nowCn = () => {
  const d = cnNow();
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
};
const stampCn = () => {
  const d = cnNow();
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
};
// state.hist 里的时间戳形如「2026-10-23T14:02」，是北京时间、不带时区后缀。
// ⚠️ 千万别用 Date.parse：GitHub runner 是 UTC，会当成 UTC 解析，整整差 8 小时。
const cnEpoch = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 8 * 3600e3;
};
// 降价的「时间」= state.hist 里该卡最后一条记录（当前价从什么时候开始）
const chgAt = (hist, id) => {
  const a = hist && hist[id];
  return a && a.length ? cnEpoch(a[a.length - 1][0]) : 0;
};
// 卡名互相高度相似（一大堆都以「Sequence 01: Curiosity 」开头），区别都在尾巴上，
// 所以超长名按词从尾部收，收成「…OLIVE YOUNG LUCKY DRAW」这样才认得出来。
function trimName(s, max = 22) {
  // ⚠️ 卡名里常带 [ ] ，直接塞进 [名字](链接) 会把 markdown 解析搞坏 → 换全角
  const t = String(s || '').replace(/\s+/g, ' ').replace(/\[/g, '［').replace(/\]/g, '］').trim();
  if (t.length <= max) return t;
  const words = t.split(' ');
  let out = '';
  for (let i = words.length - 1; i >= 0; i--) {
    const cand = out ? words[i] + ' ' + out : words[i];
    if (cand.length > max) break;
    out = cand;
  }
  if (!out) return t.slice(0, max - 1) + '…';
  return '…' + out;
}
const withLabel = list => list.map(h => Object.assign({}, h, { label: trimName(h.name) }));

function readJson(f, dflt) {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8')); } catch (e) { return dflt; }
}

function rawGet(url, timeout = 20000) {
  return new Promise((resolve) => {
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

/* ---------------- 缩略图 / 集合图 ---------------- */

async function fetchThumb(u) {
  if (!u) return null;
  const direct = await rawGet(CDN + u, 15000);
  if (direct.status === 200 && direct.buf.length > 2000) return direct.buf;
  // cloudfront 国内直连打不开 → 退 wsrv 代理（海外 runner 一般用不到这一步）
  const viaProxy = await rawGet('https://wsrv.nl/?url=' + encodeURIComponent(CDN + u) + '&w=360&output=jpg&q=80', 20000);
  if (viaProxy.status === 200 && viaProxy.buf.length > 2000) return viaProxy.buf;
  return null;
}

/**
 * 把一批卡拼成一张网格集合图，左上角带序号徽章。
 * 返回 false 表示没生成（sharp 不可用 / 没有卡）。
 */
async function buildSheet(sharp, list, outPath) {
  const PAD = 8, GAP = 6;
  const n = Math.min(list.length, 20);
  if (!n) return false;
  // 卡少的时候格子放大，免得手机上看成一小条
  const CW = n === 1 ? 220 : (n <= 3 ? 190 : 150);
  const CH = Math.round(CW * 4 / 3);
  const COLS = Math.min(5, n);
  const ROWS = Math.ceil(n / COLS);
  const W = COLS * CW + (COLS - 1) * GAP + PAD * 2;
  const H = ROWS * CH + (ROWS - 1) * GAP + PAD * 2;

  const layer = [];
  const badges = [];
  for (let i = 0; i < n; i++) {
    const c = i % COLS, r = Math.floor(i / COLS);
    const x = PAD + c * (CW + GAP), y = PAD + r * (CH + GAP);
    let tile = null;
    const buf = await fetchThumb(list[i].u);
    if (buf) {
      try {
        tile = await sharp(buf).resize(CW, CH, { fit: 'cover', position: 'centre' }).jpeg({ quality: 82 }).toBuffer();
      } catch (e) { tile = null; }
    }
    if (!tile) {
      tile = await sharp({ create: { width: CW, height: CH, channels: 3, background: '#ededed' } }).jpeg().toBuffer();
    }
    layer.push({ input: tile, left: x, top: y });
    const cx = x + 19, cy = y + 19;
    badges.push(
      `<circle cx="${cx}" cy="${cy}" r="15" fill="#DF3363"/>` +
      `<text x="${cx}" y="${cy + 6}" font-family="Arial, Helvetica, sans-serif" font-size="18" ` +
      `font-weight="bold" fill="#ffffff" text-anchor="middle">${i + 1}</text>`
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${badges.join('')}</svg>`;
  layer.push({ input: Buffer.from(svg), left: 0, top: 0 });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
    .composite(layer)
    .jpeg({ quality: 84 })
    .toFile(outPath);
  return true;
}

/* ---------------- 图片托管 ----------------
 * ⚠️ 别放 poca-data：那是每轮 force push 的单 commit 分支，
 *    下一轮要是没降价就不生成图，旧的会被一起冲掉（踩过：18:02 的图 18:10 就 404）。
 *    所以改放 main 的 poca/notify/，发出去的消息长期有效。
 * ⚠️ raw 国内直连打不开 → 主用 jsDelivr；wsrv 会把一次 404 缓存住，只当备用。
 */
const GH_TOKEN = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const GH_API = `https://api.github.com/repos/${REPO}/contents/`;
const IMG_DIR = 'poca/notify';
const IMG_KEEP_MS = 36 * 3600e3;

const ghHeaders = () => ({
  Authorization: 'Bearer ' + GH_TOKEN,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'poca-notify',
  'Content-Type': 'application/json',
});

async function uploadImg(file, buf) {
  if (!GH_TOKEN) { console.log('⚠️ 没给 GITHUB_TOKEN，本轮不发图'); return ''; }
  try {
    const r = await fetch(GH_API + IMG_DIR + '/' + file, {
      method: 'PUT', headers: ghHeaders(),
      body: JSON.stringify({ message: 'notify img ' + file, content: buf.toString('base64'), branch: 'main' }),
    });
    if (r.status !== 201 && r.status !== 200) {
      console.log(`⚠️ 上传集合图失败 ${file} HTTP ${r.status}`);
      return '';
    }
    // 返回 commit sha：jsDelivr 用 @main 会命中长缓存、新文件要等半天，
    // 用 @<sha> 能立刻拉到这个 commit 里的文件
    const j = await r.json();
    return (j && j.commit && j.commit.sha) ? j.commit.sha.slice(0, 10) : '';
  } catch (e) { console.log('⚠️ 上传集合图异常：' + e.message); return ''; }
}

// 上传后必须真的取到图才把 URL 写进消息，否则钉钉里就是一张破图
async function resolveUrl(file, sha) {
  const raw = `https://raw.githubusercontent.com/${REPO}/main/${IMG_DIR}/${file}`;
  const cands = [];
  // wsrv 主用（实测 1 秒内就回，且加 t= 能绕过它缓存过的 404）
  cands.push('https://wsrv.nl/?url=' + encodeURIComponent(raw) + '&output=jpg&q=85&t=' + Date.now());
  // jsDelivr 用 @<sha> 能立刻拿到新 commit 的文件，当兜底
  if (sha) cands.push(`https://cdn.jsdelivr.net/gh/${REPO}@${sha}/${IMG_DIR}/${file}`);
  for (const u of cands) {
    for (let i = 0; i < 6; i++) {
      const r = await rawGet(u, 20000);
      if (r.status === 200 && r.buf.length > 2000) return u;
      await new Promise(z => setTimeout(z, 2000));
    }
  }
  console.log('⚠️ 集合图 ' + file + ' 取不到，消息里就不放图了');
  return '';
}

async function publishImg(file, localPath) {
  const sha = await uploadImg(file, fs.readFileSync(localPath));
  if (!sha) return '';
  return resolveUrl(file, sha);
}

// main 上的图会一直堆，超过 36 小时的清掉
async function pruneImgs() {
  if (!GH_TOKEN) return;
  try {
    const r = await fetch(GH_API + IMG_DIR + '?ref=main', { headers: ghHeaders() });
    if (r.status !== 200) return;
    const list = await r.json();
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
    if (n) console.log(`   清理旧集合图 ${n} 张`);
  } catch (e) {}
}

/* ---------------- 钉钉发送 ---------------- */

function signedUrl(webhook, secret) {
  if (!secret) return webhook;
  const ts = Date.now();
  const sign = crypto.createHmac('sha256', secret).update(ts + '\n' + secret).digest('base64');
  return webhook + (webhook.includes('?') ? '&' : '?') + 'timestamp=' + ts + '&sign=' + encodeURIComponent(sign);
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(url);
    const req = https.request({
      host: u.hostname, path: u.pathname + u.search, method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length },
    }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, json: { errmsg: d.slice(0, 200) } }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(buf);
    req.end();
  });
}

/* ---------------- 主流程 ---------------- */

(async () => {
  const data = readJson('data.json', null);
  if (!data || !Array.isArray(data.items)) {
    console.log('⚠️ 没有 data.json，跳过推送');
    return;
  }
  const state = readJson('state.json', {});
  const starsFile = readJson('stars.json', { devices: {} });
  const snap = state.snap || {};
  const pushed = state.pushed || {};
  const det = data.det || {};

  // 星标集合：stars.json 里每台设备各自一份，这里合成 { id: [设备昵称...] }
  const starMap = {};
  const devices = (starsFile && starsFile.devices) || {};
  Object.keys(devices).forEach(k => {
    const dev = devices[k] || {};
    const nm = dev.name || '未命名设备';
    (dev.ids || []).forEach(id => {
      const key = String(id);
      (starMap[key] = starMap[key] || []).push(nm);
    });
  });
  const nStar = Object.keys(starMap).length;
  if (nStar) console.log(`星标：${Object.keys(devices).length} 台设备，共 ${nStar} 张卡`);

  /* ---- 找降价 ---- */
  // 口径：只报「本轮新增」的降价 —— 也就是还没通知过的。
  // 基准 pushed[id] = 上次成功通知后的价格，所以同一张卡同一档价只会报一次；
  // 上轮要是发送失败（基准没更新），这轮会补发，不会漏。
  const pushedRef = pushed;
  const hits = [];
  for (const x of data.items) {
    const id = String(x.id);
    const base = pushedRef[id] || snap[id] || null;
    if (!base) continue;
    const bm = Number(base[0]) || 0;
    const bq = Number(base[1]) || 0;
    const rows = [];
    if (x.p > 0 && bm > 0 && x.p < bm) {
      rows.push({ label: '匹配', from: bm, to: x.p, cny: yuan(CNY_M(x.p)) });
    }
    if (x.q > 0 && bq > 0 && x.q < bq) {
      rows.push({ label: '速切', from: bq, to: x.q, cny: yuan(CNY_Q(x.q)) });
    }
    if (!rows.length) continue;
    const worst = rows.reduce((a, b) => ((b.from - b.to) / b.from > (a.from - a.to) / a.from ? b : a));
    hits.push({
      id: x.id,
      name: x.n || x.nk || ('#' + x.id),
      rows,
      u: (det[id] && det[id].u) || '',
      score: (worst.from - worst.to) / worst.from,
      stars: starMap[id] || null,
      at: chgAt(state.hist, id),          // 这次降价是什么时候发生的，用于同跌幅时新的排前面
    });
  }

  const savePushed = () => {
    const next = Object.assign({}, pushed);
    for (const x of data.items) if (!next[x.id]) next[x.id] = [x.p, x.q];
    state.pushed = next;
    fs.writeFileSync(path.join(HERE, 'state.json'), JSON.stringify(state), 'utf8');
    return next;
  };

  if (!hits.length) {
    const next = savePushed();
    console.log(`✅ 本轮没有降价，不推送（已记录基准 ${Object.keys(next).length} 张）`);
    return;
  }

  // 排序：星标优先 → 跌幅大优先
  hits.sort((a, b) => (b.stars ? 1 : 0) - (a.stars ? 1 : 0) || b.score - a.score || b.at - a.at);
  const show = hits.slice(0, MAX_LIST);
  // 两组各自成图、各自从 1 编号；卡名先剥掉同组内的公共前缀，剩下的才是能区分的那截
  const showStar = withLabel(show.filter(h => h.stars));
  const showOther = withLabel(show.filter(h => !h.stars));

  /* ---- 拼集合图 ---- */
  let sharp = null;
  try { sharp = require('sharp'); } catch (e) {
    console.log('⚠️ 没装 sharp，本轮不附集合图（只发文字）');
  }
  const stamp = stampCn();
  const imgDir = path.join(HERE, 'notify');
  try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch (e) {}
  const starFile = `star-${stamp}.jpg`;
  const otherFile = `other-${stamp}.jpg`;
  let starUrl = '', otherUrl = '';
  if (sharp) {
    try {
      if (await buildSheet(sharp, showStar, path.join(imgDir, starFile))) {
        starUrl = await publishImg(starFile, path.join(imgDir, starFile));
      }
    } catch (e) { console.log('⚠️ 星标集合图失败：' + e.message); }
    try {
      if (await buildSheet(sharp, showOther, path.join(imgDir, otherFile))) {
        otherUrl = await publishImg(otherFile, path.join(imgDir, otherFile));
      }
    } catch (e) { console.log('⚠️ 其他集合图失败：' + e.message); }
    await pruneImgs();
  }

  /* ---- 拼 markdown ---- */
  const link = id => SITE + (SITE.includes('#') ? '' : '#c=' + id);
  // 一张卡：①「序号 + 卡名」（卡名可点，跳该卡）② 匹配一行 ③ 速切一行
  // ⚠️ 钉钉 markdown 里单个 \n 不换行，会被并成同一行（她反馈过「价格和链接同一行」）。
  //    必须留空行（\n\n）才算新段落，所以这里返回的是「带空行的行数组」。
  const cardBlock = (h, i) => {
    const a = [`**${i}**　[${h.label || trimName(h.name)}](${link(h.id)})`];
    for (const r of h.rows) {
      const from = yuan(r.label === '匹配' ? CNY_M(r.from) : CNY_Q(r.from));
      a.push('', `${r.label} ${from}→${r.cny}`);
    }
    return a;
  };

  // ⚠️ 钉钉 markdown 上限：实测总行数 ~29 行 / 字节 ~1900 都安全，30 行或 3300 字节就 errcode -1。
  //   她又要求「一卡三行、不许省略」，所以按行数+字节双约束装箱，切成多条消息发。
  const LINE_CAP = 18;    // 每条里「卡片区」能用的元素行数（头部 8 + 尾部 2 约 10 行）
  const BYTE_CAP = 1500;  // 每条正文的字节预算，留出余量
  const parts = [];

  function packGroup(list, label, img) {
    if (!list.length) return;
    const chunks = [];
    let cur = [], lines = 0, bytes = 0;
    list.forEach((h, i) => {
      const n = 1 + 2 * h.rows.length;            // 卡名 1 行 + 每个价 2 行（价格 + 前面的空行）
      const b = Buffer.byteLength(cardBlock(h, i + 1).join('\n'));
      const gap = cur.length ? 1 : 0;             // 卡与卡之间还要多一个空行
      const over = cur.length && (lines + gap + n > LINE_CAP || bytes + b > BYTE_CAP);
      if (over) { chunks.push(cur); cur = []; lines = 0; bytes = 0; }
      if (cur.length) { lines += 1; bytes += 2; }
      cur.push({ h, idx: i + 1 });                // 序号跟集合图上的红圈一致，跨段不重来
      lines += n;
      bytes += b;
    });
    if (cur.length) chunks.push(cur);
    chunks.forEach((c, i) => parts.push({
      label, img: i === 0 ? img : '', items: c, part: i + 1, of: chunks.length,
    }));
  }

  packGroup(showStar, `⭐ 星标 ${showStar.length} 张`, starUrl);
  packGroup(showOther, `其他 ${showOther.length} 张`, otherUrl);

  // 每条消息：标题 → 看板链接 → 分组名 → 集合图（只第一段带） → 卡片 → 页脚
  const buildMd = p => {
    const L = [`### 🃏 卡市${TAG ? ' · ' + TAG : ''} · ${nowCn()}`, ''];
    L.push(`[👉 打开卡市看板](${SITE})`, '');
    L.push(`**${p.label}**${p.of > 1 ? `（第 ${p.part}/${p.of} 段）` : ''}`, '');
    if (p.img) L.push(`![${p.label}](${p.img})`, '');
    p.items.forEach(({ h, idx }, k) => {
      if (k) L.push('');                          // 卡与卡之间空一行
      L.push(...cardBlock(h, idx));
    });
    L.push('', `> 监控 ${data.items.length} 张`);
    return L.join('\n');
  };
  const mds = parts.map(buildMd);

  console.log('──────── 消息预览 ────────');
  mds.forEach((m, i) => { console.log(`—— 第 ${i + 1}/${mds.length} 条 ——`); console.log(m); });
  console.log('──────────────────────────');
  if (DRY) {
    console.log(`（--dry 模式，未发送）共 ${mds.length} 条 | 集合图：${starUrl || '无'} / ${otherUrl || '无'}`);
    return;
  }
  if (!WEBHOOK) {
    console.log('⚠️ 没配 DINGTALK_WEBHOOK，只打印不发送');
    return;
  }

  // 发送回执写进 state.json（会随 poca-data 发布），出问题时能回查到底发没发出去
  const saveState = () => fs.writeFileSync(path.join(HERE, 'state.json'), JSON.stringify(state), 'utf8');

  const sent = [];
  let lastErr = '';
  for (let i = 0; i < mds.length; i++) {
    let text = mds[i];
    if (i === 0 && AT_MOBILES.length) text += '\n\n' + AT_MOBILES.map(m => '@' + m).join(' ');
    const title = `🃏 卡市 ${hits.length} 张${mds.length > 1 ? ` ${i + 1}/${mds.length}` : ''} · ${nowCn()}`;
    const payload = { msgtype: 'markdown', markdown: { title, text } };
    if (i === 0 && AT_MOBILES.length) payload.at = { atMobiles: AT_MOBILES, isAtAll: false };

    // ⚠️ 钉钉会偶发返回 errcode -1「system error」（同一条隔几秒重发通常就过），
    // 但也可能是这条太长 —— 所以每段都独立重试，别让一条失败拖垮整轮。
    let r = { status: 0, json: { errcode: -2, errmsg: '未发送' } };
    let attempt = 0;
    for (; attempt < 3; attempt++) {
      try {
        r = await postJson(signedUrl(WEBHOOK, SECRET), payload);
      } catch (e) {
        console.error(`❌ 第 ${i + 1} 条请求失败（第 ${attempt + 1} 次）：` + e.message);
        r = { status: 0, json: { errcode: -2, errmsg: e.message } };
      }
      const c = r.json && r.json.errcode;
      if (r.status === 200 && c === 0) break;
      if (attempt < 2) {
        console.log(`   ⏳ 第 ${i + 1} 条 errcode=${c} ${(r.json && r.json.errmsg) || ''}，${3 * (attempt + 1)} 秒后重试`);
        await new Promise(z => setTimeout(z, 3000 * (attempt + 1)));
      }
    }
    const code = r.json && r.json.errcode;
    if (r.status === 200 && code === 0) {
      sent.push(i + 1);
      console.log(`✅ 第 ${i + 1}/${mds.length} 条已推送（试了 ${attempt + 1} 次）`);
    } else {
      lastErr = `第 ${i + 1} 条 HTTP ${r.status} errcode=${code} ${(r.json && r.json.errmsg) || ''}`;
      console.error('❌ ' + lastErr);
    }
    if (i < mds.length - 1) await new Promise(z => setTimeout(z, 3000));
  }

  state.lastNotify = {
    at: new Date().toISOString(), n: hits.length, ids: show.map(h => h.id),
    segs: mds.length, sent: sent.length,
    imgs: [starUrl, otherUrl].filter(Boolean),
    ok: sent.length === mds.length, err: lastErr,
  };
  if (!sent.length) {
    saveState();
    process.exitCode = 0;
    return;
  }
  if (lastErr) {
    const hint = {
      300001: 'access_token 不对，检查 webhook 是否复制完整',
      310000: '加签校验失败：检查 DINGTALK_SECRET，或机器人安全设置里是否勾了「加签」',
      130101: '发送太频繁，钉钉限流（每分钟 20 条）',
    }[/errcode=(-?\d+)/.exec(lastErr) ? /errcode=(-?\d+)/.exec(lastErr)[1] : 0];
    if (hint) console.error('   → ' + hint);
  }

  // 只更新「真的告诉过她」的那些卡，被截断的下轮还会再推一次
  const next = Object.assign({}, pushed);
  for (const x of data.items) if (!next[x.id]) next[x.id] = [x.p, x.q];
  for (const h of show) {
    const x = data.items.find(i => i.id === h.id);
    if (!x) continue;
    const old = next[h.id] || [0, 0];
    next[h.id] = [
      x.p > 0 && x.p !== old[0] ? x.p : old[0],
      x.q > 0 && x.q !== old[1] ? x.q : old[1],
    ];
  }
  state.pushed = next;
  fs.writeFileSync(path.join(HERE, 'state.json'), JSON.stringify(state), 'utf8');
  console.log(`   已更新推送基准 ${Object.keys(next).length} 张`);})().catch(e => { console.error('❌ notify 异常：' + e.message); process.exitCode = 0; });
