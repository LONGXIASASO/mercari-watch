/**
 * Poca 韩版卡市 · 云端抓取（GitHub Actions 每 1 小时跑一次）
 * 纯 Node 内置模块，无第三方依赖。
 *
 * 流程：搜索全量（默认序）→ wish 排序全量 → 每卡挂单明细 → 与上一版对比算涨跌 → 写 data.json
 * 产物（推到 poca-data 分支，main 不动）：
 *   data.json   前端拉取的完整数据
 *   state.json  下次对比用的价格快照 + 价格变动记录
 *
 * ⚠️ 图片：云端没有本地 img 目录，img 字段统一给 'L'，前端拼 img/{id}.webp，
 *    加载失败再退 wsrv 代理（新卡首次没有本地图，只能走代理）。
 */
const https = require('https');
const http2 = require('http2');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
// ⚠️ 2026-11-11 站方又把韩国站接口挪回主站了：api.pocamarket.com → phocamarket.com
//    （2026-11-01 曾从 api.phocamarket.com 迁到 api.pocamarket.com，现在两个 api.* 全废）
//    实测 2026-11-11 10:55：
//      旧 api.phocamarket.com/card/*   → 404 空体（nginx 直接拒）
//      旧 api.pocamarket.com/card/v3/* → 404 1 字节（catch-all）
//      新 phocamarket.com/card/v3/search          → 200，字段与 11-02 版完全一致
//      新 phocamarket.com/card/v1/<id>/sell|buy|matching → 200（这三条 11-02 后"消失"的明细接口回来了）
//    只有 api.pocamarket.com/card/gb/v2/* 还是活的，但那是全球站：同一批卡、美元重新定价，
//    有 ~$5.6 价格地板，KRW/USD 比值散在 89~649，不能顶替韩元，别用。
//    主站无需鉴权，连发 20 次搜索 + 并发 12 明细全 200，无限速。
const HOST = 'phocamarket.com';

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const Q = process.env.POCA_Q || '장하오';
// 额外固定监控的卡：不在关键词搜索结果里，也要跟主列表一起抓、一起算涨跌、一起推送。
// 436791 = RICKY · NEVER SAY NEVER 메이크스타（2026-01-12 特典）
// ⚠️ 2026-11-02 改版后 v3 没有任何单卡接口（/card/v3/<id> 等全部 404），
//    只能「用卡名+成员当关键词再搜一遍，按 id 命中」。所以支持 `id:搜索词` 写法：
//    POCA_PIN="436791:MAKESTAR 리키"  →  主搜索没有就单独搜这个词
const PINS = String(process.env.POCA_PIN || '436791:MAKESTAR 리키')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(s => {
    const i = s.indexOf(':');
    return i > 0
      ? { id: s.slice(0, i).trim(), q: s.slice(i + 1).trim() }
      : { id: s, q: '' };
  });
const PIN_IDS = PINS.map(p => p.id);
const CONC = Number(process.env.POCA_CONC || 8);       // ⚠️ 搜索页并发超过 8 会被限速，16 实测反而慢一倍
// ⚠️ 2026-11-11：明细改成「按需」两阶段（先详情定 p，再只对有挂单/有成交的卡发明细），
//    阶段 2 每卡最多 2 个并发请求，worker=10 → 等效 20 并发。
//    站点有 IP 级限速：本地 15 分钟内 ~4000 请求就被整站 404 拉黑，别调大。
// ⚠️ 并发按传输层给：h2 单连接多路复用最省，但**并发太高会被站方按速率限**（返回 404 空体），
//    本地实测 20 并发跑到第 800 个请求就开始 404/1，降到 12 稳。http1 每请求新建连接用 10，
//    curl 每请求 spawn 一个进程用 16（实测 1.3s/批，不提并发整轮要 334s）。
//    （TRANSPORT 在下面才定义，这里必须用函数，调用时已经初始化好了）
const CONC_DETAIL = () => Number(process.env.POCA_CONC_DET
  || (TRANSPORT === 'h2' ? 12 : TRANSPORT === 'curl' ? 16 : 10));
// 价格变动记录（hist）保留策略：前端「近2日涨价/降价」按自然日回溯 2 天，
// 所以云端至少留 3 天（含窗口外 1 个基准点），单卡最多 HIST_MAX 个点控制体积。
const HIST_MAX = 100;
const HIST_KEEP_DAYS = 3;
// 永久价格档案：单卡封顶的点数（按当前节奏约 8 次/小时全站摊，500 点足够好几年）
const ARCH_MAX = 500;
// 详情页每个「记录」区块最多下发多少条（再多就靠区块内滚动看，不下发省体积）
const REC_MAX = 40;

// ── 明细永久档案 darc.json（2026-11-11 新增）──
// 站方的 /card/v1/<id>/sell|matching 每次只回最新 5 条（服务端硬截断，next 恒为 null），
// 光靠当轮快照，一有新挂单/新成交就把更早的挤掉了。所以每轮把拿到的行并进一份只增不减的档案，
// 越过 5 条上限把历史攒起来（和价格档案 pchg.json 同一套思路）。
// 去重键 = 价格 + 完整时间戳（同价同秒不可能并存两条）。
// 上限 80 条/卡/类：实际单卡很少能攒到，主要是防极端热门卡把档案撑爆。
const DARC_MAX = 80;
// 前端每个明细区块最多下发多少条
const REC_D_MAX = 60;

// 把本轮抓到的明细行并进档案（只增不减），返回新增条数
// ⚠️ 日期必须归一化成同一种格式再存：接口给的是 "2026-11-03T06:41:12"，
//    而老档案（detcarry）只到日 "2026-11-03"。两种混着放，字符串排序会把
//    "11-03 09:30:00"（空格）排到 "11-03T06:41"（T）前面，顺序就乱了。
//    统一成 T 分隔；只到日的保持原样（它就是只知道日）。
const normDate = d => String(d || '').trim().replace(' ', 'T');

// 展示前去重：老档案只到日、接口到秒，同一天同一价格会并存两条
// （"11-03" 和 "11-03T06:41:12" 其实是同一笔挂单）。以精确记录为准，把只到日的那条挡掉。
// 只影响下发，darc.json 里两个原样都留着。
function dedupeCoarse(rows) {
  const exact = new Set();
  for (const e of rows) {
    const d = String(e[1]);
    if (d.length > 10) exact.add(`${e[0]}|${d.slice(0, 10)}`);
  }
  if (!exact.size) return rows;
  return rows.filter(e => {
    const d = String(e[1]);
    return d.length > 10 || !exact.has(`${e[0]}|${d.slice(0, 10)}`);
  });
}

// 截断时优先保住「当前在挂」的（第三位 1）：挂了很久没人买的单，create_date 可能很早，
// 攒满 60 条后按时间从尾部截会把这条正主挤掉，用户就看不到「现在还有人挂 ₩X」了。
function capKeepNow(rows, max) {
  if (rows.length <= max) return rows;
  const isNow = e => e[2] === 1;
  const nowRows = rows.filter(isNow);
  const rest = rows.filter(e => !isNow(e));
  const keep = new Set(nowRows);
  for (const e of rest.slice(-Math.max(0, max - nowRows.length))) keep.add(e);
  return rows.filter(e => keep.has(e));       // 保持原时间顺序
}

function mergeDarc(map, id, key, rows) {
  if (!rows || !rows.length) return 0;
  const rec = map[id] || (map[id] = {});
  const arr = rec[key] || (rec[key] = []);
  const has = new Set(arr.map(e => `${e[0]}|${e[1]}`));
  let n = 0;
  for (const r of rows) {
    const price = Number(r[0]) || 0;
    const date = normDate(r[1]);
    if (!(price > 0) || !date) continue;
    const k = `${price}|${date}`;
    if (has.has(k)) continue;
    arr.push([price, date]);
    has.add(k);
    n++;
  }
  if (n) {
    arr.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    if (arr.length > DARC_MAX) arr.splice(0, arr.length - DARC_MAX);
  }
  return n;
}

// 把价格档案里某一列抽成「只在变化时留一条」的记录序列 [[价, 时间], ...]
// idx=1 是匹配价，idx=2 是速切价
function seriesOf(arc, idx, max) {
  const out = [];
  let prev = null;
  for (const e of arc || []) {
    const v = Number(e[idx]) || 0;
    if (v === prev) continue;      // 没变就不记
    prev = v;
    out.push([v, String(e[0])]);
  }
  return out.slice(-max);          // 只留最近的 max 条
}

// 最高求购的真实观测：pchg 第 5 位（2026-11-11 起才写入），0 = 当时没人求购，跳过不记
function seriesOfBuy(arc, max) {
  const out = [];
  let prev = null;
  for (const e of arc || []) {
    const v = Number(e[4]) || 0;
    if (v <= 0 || v === prev) continue;
    prev = v;
    out.push([v, String(e[0])]);
  }
  return out.slice(-max);
}

// ── 历史推算 ────────────────────────────────────────────────────────────
// 改版后接口不再给「求购 / 成交」，但改版前攒下的卖家挂单(s)和历史成交(m)还在
// detcarry.json 里。用它们反推改版前的匹配价走势，供详情页「匹配价记录」补前半段。
//
// 精度实测 86.1%（拿 524 个真实观测点比对）：反推值 = 截至某日、仍存活挂单里的最低价。
// 已知偏差：便宜的挂单早被买走、不在 s 里，所以反推值系统性偏高约 10%。
// 因此历史段一律打 '~' 标记，前端用灰色显示并注明是推算值。
const WK = 86400000;
// 该日期所在周的周一（YYYY-MM-DD）
function isoWeek(dd) {
  const t = new Date(dd + 'T00:00:00Z');
  const w = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - w);
  return t.toISOString().slice(0, 10);
}
// 回弹过滤：A → B → A 且首尾相隔 ≤span 天，说明 B 是一日噪声（挂单反复上下架），删掉
function debounceSeq(arr, span) {
  const a = arr.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < a.length - 1; i++) {
      if (a[i - 1].p === a[i + 1].p) {
        const gap = (new Date(a[i + 1].day) - new Date(a[i - 1].day)) / WK;
        if (gap <= span) { a.splice(i, 1); changed = true; break; }
      }
    }
  }
  return a;
}
// 把一堆 [价格, 日期] 聚合成走势：同日取极值 → 按周分桶取极值 → 回弹过滤 → 只在变化时留一条
// pickMax=false 走最低价（匹配价语义），true 走最高价（求购语义）
function trimSeries(rows, pickMax) {
  const byDay = {};
  for (const e of rows || []) {
    const p = Number(e[0]) || 0;
    if (p <= 0) continue;
    const day = String(e[1]).slice(0, 10);
    if (!(day in byDay) || (pickMax ? p > byDay[day] : p < byDay[day])) byDay[day] = p;
  }
  const pts = Object.keys(byDay).map(day => ({ day, p: byDay[day] }));
  if (!pts.length) return [];
  // 按 ISO 周分桶：一周内的多笔只留一个极值，这样既压掉同源噪声，又不会吞掉跨周的真实变动
  const bucket = {};
  for (const x of pts) {
    const k = isoWeek(x.day);
    if (!(k in bucket) || (pickMax ? x.p > bucket[k].p : x.p < bucket[k].p)) bucket[k] = x;
  }
  const arr = debounceSeq(Object.values(bucket).sort((a, b) => a.day.localeCompare(b.day)), 30);
  const out = [];
  let prev = null;
  for (const x of arr) {
    if (x.p === prev) continue;
    prev = x.p;
    out.push([x.p, x.day]);
  }
  return out;
}
// 卖家挂单 → 反推序列：按上架日排序，最低价被刷新时才是一条新记录
function ordersToSeries(s) {
  const rows = (s || []).slice().sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const out = [];
  let min = null;
  for (const e of rows) {
    const p = Number(e[0]) || 0;
    if (p <= 0) continue;
    if (min === null || p < min) { min = p; out.push([p, String(e[1]).slice(0, 10)]); }
  }
  return out;
}

const TZ = 8 * 3600e3; // 北京时间

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SKIP_WISH = process.argv.includes('--skip-wish'); // 收藏排名变化慢，可降频
const MIN_GAP_MIN = Number(argOf('min-gap', '0'));      // 距上次成功不足这么多分钟就跳过

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 传输层（2026-11-11 事故后改成可切换，三档：h2 → http1 → curl）──
// 🚨 事故现场：#2277~#2282 连续 6 轮「首页抓取失败」，每轮第一个请求 0.6 秒内就挂。
//    根因（Actions 上跑的传输层矩阵，脚本见 poca/_diag2.js）：同一台 runner、同一个出口 IP、
//    同一套 header 打同一个 URL ——
//      curl（实测 HTTP/2）                        → 200，7642 字节 ✅
//      node http1 默认 / family4 / Connection:close / 最小 header / 固定两个后端 IP
//                                                 → 全是 404/39 {"success":false,"message":"NOT_FOUND"}
//      node http2（ALPN h2）                       → 200，7348 字节 ✅
//    ⇒ 站方 nginx 把 HTTP/1.1 的请求转给了没有 /card/v3 路由的旧后端，HTTP/2 才走对。
//    不是接口变更、不是 IP 被墙、不是限速 —— 改 HOST 永远修不好。
//    所以主传输换成 **http2**（顺带白赚多路复用：不用每请求新建连接，比原来的 http1 还快），
//    拿不到就降级 http1，再不行降级 curl。POCA_HTTP=h2|http1|curl 可强制。
let TRANSPORT = ['h2', 'http1', 'curl'].includes(process.env.POCA_HTTP) ? process.env.POCA_HTTP : 'h2';
let H2_RECONNECT = 0;
let RATE_BACKOFF = 0;   // 疑似「被限速」的退避次数，成功一次就清零

// ── HTTP/2 ──
// 单连接多路复用；一条 session 上开太多并发流会被服务端 RST（ENHANCE_YOUR_CALM），
// 并发仍由 CONC / CONC_DETAIL 控制，这里只管「断了自动重连」。
let H2 = null;
function h2Session() {
  if (H2 && !H2.destroyed && !H2.closed) return H2;
  const s = http2.connect('https://' + HOST);
  s.on('error', () => {});
  s.on('goaway', () => { try { s.close(); } catch (e) {} if (H2 === s) H2 = null; });
  s.on('close', () => { if (H2 === s) H2 = null; });
  s.unref(); // 别让 http2 session 吊住进程
  H2 = s;
  return s;
}
function rawGetH2(p, timeout = 25000) {
  return new Promise(resolve => {
    let done = false, rq = null;
    const fin = o => { if (done) return; done = true; clearTimeout(timer); resolve(o); };
    const timer = setTimeout(() => { try { rq && rq.close(); } catch (e) {} fin({ s: -1, d: '' }); }, timeout);
    try {
      rq = h2Session().request({
        ':method': 'GET', ':path': p,
        'user-agent': UA, accept: 'application/json',
        'accept-language': 'ko-KR,ko;q=0.9',
        'poca-display-language': 'ko',
        referer: 'https://pocamarket.com/',
      });
    } catch (e) { return fin({ s: 0, d: '' }); }
    let st = 0, d = '';
    rq.on('response', h => { st = h[':status'] || 0; });
    rq.setEncoding('utf8');
    rq.on('data', c => { d += c; if (d.length > 4e6) { try { rq.close(); } catch (e) {} } });
    rq.on('end', () => fin({ s: st, d }));
    rq.on('error', () => fin({ s: 0, d: '' }));
    rq.end();
  });
}

const CURL_ARGS = p => [
  '-sS', '-m', '25', '--connect-timeout', '15',
  '-H', 'User-Agent: ' + UA,
  '-H', 'Accept: application/json',
  '-H', 'Accept-Language: ko-KR,ko;q=0.9',
  '-H', 'POCA-DISPLAY-LANGUAGE: ko',
  '-H', 'Referer: https://pocamarket.com/',
  '-w', '\n__CODE__%{http_code}',
  'https://' + HOST + p,
];
function rawGetCurl(p) {
  return new Promise(resolve => {
    execFile('curl', CURL_ARGS(p), { maxBuffer: 24 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (err) return resolve({ s: err.code === 28 ? -1 : 0, d: '' });
      const s = String(stdout || '');
      const i = s.lastIndexOf('\n__CODE__');
      if (i < 0) return resolve({ s: 0, d: '' });
      resolve({ s: Number(s.slice(i + 9)) || 0, d: s.slice(0, i) });
    });
  });
}
function rawGetNode(p, timeout = 25000) {
  return new Promise(resolve => {
    const req = https.request({
      host: HOST, path: p, method: 'GET', timeout,
      headers: {
        'User-Agent': UA, 'Accept': 'application/json',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'POCA-DISPLAY-LANGUAGE': 'ko', 'Referer': 'https://pocamarket.com/',
      },
    }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; if (d.length > 4e6) req.destroy(); });
      res.on('end', () => resolve({ s: res.statusCode, d }));
    });
    req.on('error', () => resolve({ s: 0, d: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ s: -1, d: '' }); });
    req.end();
  });
}
function rawGet(p, timeout = 25000) {
  if (TRANSPORT === 'h2') return rawGetH2(p, timeout);
  if (TRANSPORT === 'curl') return rawGetCurl(p);
  return rawGetNode(p, timeout);
}
async function getJson(p, tries = 4) {
  const seen = [];
  for (let i = 0; i < tries; i++) {
    const r = await rawGet(p);
    seen.push(r.s + '/' + (r.d || '').length + (r.d && r.d.length < 60 ? '[' + (r.d || '').replace(/\s/g, ' ') + ']' : ''));
    if (r.s === 200 && r.d && r.d.trim().startsWith('{')) { try { const j = JSON.parse(r.d); RATE_BACKOFF = 0; return j; } catch (e) {} }
    // ⚠️ 404 也重试：站方多套后端轮询，404 只说明「这次命中的那套没有这条路由」，
    //    以前直接 return null 等于一次 404 就整轮报废 —— 这正是连挂 6 轮的最后一环。
    await sleep(400 * (i + 1));
  }
  // 全部失败 → 先分清是「被限速」还是「链路不对」，两者处置完全不同：
  //   404 空体 / 1~2 字节  = IP 被按速率限了（本地实测 20 并发跑到第 800 个请求就这样），
  //                          换传输层没用，只能退避等待，等完还是原来那条路；
  //   404 39 字节 NOT_FOUND = 命中了没有该路由的后端（h2 下不该出现），才需要降传输层。
  const why = p.split('?')[0] + '（' + seen.join(',') + '）';
  const slim = seen.map(x => x.split('[')[0]);
  const rateLimited = slim.every(x => x === '404/0' || x === '404/1' || x === '404/2' || x === '429/0');
  if (rateLimited && RATE_BACKOFF < 3) {
    RATE_BACKOFF++;
    const wait = 1500 * Math.pow(2, RATE_BACKOFF - 1); // 1.5s → 3s → 6s
    console.log('  ⏳ 疑似站方限速（' + slim[0] + ' 空体），等 ' + wait + 'ms 再试：' + p.split('?')[0]);
    await sleep(wait);
    return getJson(p, tries);
  }
  if (TRANSPORT === 'h2' && H2_RECONNECT < 2) {
    H2_RECONNECT++;
    H2 = null;
    console.log('  ⚠️ h2 连续 ' + tries + ' 次拿不到 ' + why + '，重建连接后重试（第 ' + H2_RECONNECT + ' 次）');
    return getJson(p, tries);
  }
  if (TRANSPORT === 'h2') {
    TRANSPORT = 'http1';
    console.log('  ⚠️ h2 重建后仍失败 ' + why + '，传输层降级为 http1 重试');
    return getJson(p, tries);
  }
  if (TRANSPORT === 'http1') {
    TRANSPORT = 'curl';
    console.log('  ⚠️ http1 连续 ' + tries + ' 次拿不到 ' + why + '，传输层降级为 curl 重试');
    return getJson(p, tries);
  }
  global.LASTGET = p.split('?')[0] + ' → ' + seen.join(',');
  return null;
}

const num = v => { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; };
const d10 = s => (typeof s === 'string' && s.length >= 10 ? s.slice(0, 10) : '');
const regDate = u => {
  const m = /photocard[_a-z]*\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(u || '');
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
};
const stamp = (() => {
  const d = new Date(Date.now() + TZ);
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + 'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
})();

// ── 全量搜索分页（v3 游标式） ──
// ⚠️ v3 没有 count、没有 sort、也没有 page=数字；分页只认 page=<上一页返回的 next_page>，
//    传别的参数名一律 400 VALIDATION_ERROR（服务端有参数白名单）。
//    每页固定 16 条，1019 条约 64 页，串行约 45 秒；游标必须严格串行，不能并发。
async function fetchAll() {
  const all = [];
  const seen = new Set();
  let cursor = null, page = 0, failed = 0;
  while (page < 200) {
    const qs = cursor ? '&page=' + encodeURIComponent(cursor) : '';
    const j = await getJson(`/card/v3/search?q=${encodeURIComponent(Q)}${qs}`);
    if (!j || !Array.isArray(j.results)) {
      if (page === 0) throw new Error('首页抓取失败，接口可能变更｜' + (global.LASTGET || '无请求记录'));
      if (++failed > 3) throw new Error(`搜索翻页连续失败 ${failed} 次，放弃本次`);
      continue;
    }
    page++;
    let added = 0;
    for (const x of j.results) {
      if (x && x.id && !seen.has(x.id)) { seen.add(x.id); all.push(x); added++; }
    }
    if (page % 16 === 0) console.log(`  搜索第 ${page} 页，累计 ${all.length} 条`);
    // next_page 为空 / 本页全是重复 → 到底了
    if (!j.next_page || !j.results.length || added === 0) break;
    cursor = j.next_page;
  }
  return { count: all.length, list: all, pages: page, failed };
}

// ── 每卡详情：最高求购 / 最近成交 / 速切库存 ──
// 2026-11-11 挖到的权威源：GET /card/v1/<id>（韩站主机 phocamarket.com 的单卡详情，字段沿用旧版命名）
//   get_highest_buy_price            → 最高求购        （v3 搜索完全没有）
//   get_matching_price               → 最近匹配成交    （v3 搜索完全没有）
//   get_collection_transaction_price → 速切最近成交    （v3 搜索完全没有）
//   get_collection_count             → 速切库存件数    （v3 搜索只给 is_stocked 布尔，所以页面之前只显示「库 1」）
//
// 同一时点比对 1020 张：get_lowest_sell_price / get_collection_lowest_sell_offer_price
//   与 v3 的 transaction_sell_price / offer_price **100% 一致**，有货判定也 1020/1020 —— 同源同池，可放心混用。
// 代价：每卡 1 次请求（约 1034 次/轮，16 并发实测 20 秒），比旧版 sell+buy+matching 三次省 2/3。
//
// ⚠️ /card/v1/<id>/sell 的 count 不能当库存：抽 60 张在售卡，34 张返回 0（那是「匹配挂单」池，不是速切库存），
//    且历史挂单 >5 条的卡现在一律只回 5 条（服务端硬截断）。库存只认 get_collection_count。
// 明细行：[价格, 完整时间]（保留到秒，前端 md() 会显示成「11-09 22:24」）
// 每次最多只回 5 条（服务端硬截断，next 恒为 null），所以 max 给 20 只是个上限保险。
const rowsOf = (o, max) => (o && Array.isArray(o.results))
  ? o.results
      .map(x => [Number(x.price) || 0, String(x.create_date || '').slice(0, 19)])
      .filter(x => x[0] > 0)
      .slice(0, max)
  : [];

// ── 单卡详情 + 按需明细（2026-11-11 减重版） ──
// 实测分组命中率（120 张样本，验证「能不能按库存跳过明细」）：
//   stock=0 的卡 → 42% 仍有挂单、48% 仍有成交  ⇒ **不能按速切库存跳过**（两个池子不同）
//   匹配最低卖价 p=0 → 有挂单 0/57 = **0%**     ⇒ p 是挂单明细的**完美判据**，跳过零损失
//   p=0 但仍有成交的 46%                        ⇒ 成交明细不能用 p 判
//   stock=0 且 p=0 且 b=0（最冷）→ 挂单/成交/求购 全 0
// 所以分两阶段：先拿详情（p/st/b 都在这），再按需发明细请求，省掉约 19% 的请求。
async function fetchDetails(ids) {
  const out = {};
  const pOf = {};                     // id → 匹配最低卖价，仅用于决定抓不抓明细，不落盘
  let next = 0, fails = 0, done = 0;

  // 阶段 1：单卡详情（1 请求/卡，并发回到 16）
  async function w1() {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      const id = ids[i];
      const j = await getJson(`/card/v1/${id}`, 2);
      if (!j || !j.id) { fails++; }
      else {
        const rec = {};
        const b = num(j.get_highest_buy_price);
        const mp = num(j.get_matching_price);
        const t = num(j.get_collection_transaction_price);
        if (b > 0) rec.b = b;
        if (mp > 0) rec.mp = mp;
        if (t > 0) rec.t = t;
        // 库存单独存：0 也是有效值（真的没货），不能用 num() 的 >0 过滤
        const st = j.get_collection_count;
        if (st !== null && st !== undefined && isFinite(Number(st))) rec.st = Math.max(0, Number(st));
        if (Object.keys(rec).length) out[id] = rec;
        pOf[id] = num(j.get_lowest_sell_price);
      }
      if (++done % 250 === 0) console.log(`  单卡详情 ${done}/${ids.length} 失败 ${fails}`);
    }
  }
  await Promise.all(Array.from({ length: 16 }, w1));
  if (fails > ids.length * 0.3) throw new Error(`单卡详情失败 ${fails}/${ids.length}，放弃本次`);

  // 阶段 2：按需抓明细
  //   挂单 sell   → 只在 p>0 时抓（没人挂单时必定空，实测 0% 命中）
  //   成交 matching → 只在「p>0 或 有库存 或 有人求购」时抓（三者全 0 的冷门卡实测无成交）
  const jobs = [];
  for (const id of Object.keys(out)) {
    const r = out[id];
    const p = pOf[id] || 0;
    const wantSell = p > 0;
    const wantMatch = p > 0 || (r.st || 0) > 0 || (r.b || 0) > 0;
    if (wantSell || wantMatch) jobs.push({ id, wantSell, wantMatch });
  }
  let jn = 0, jdone = 0, jfails = 0;
  async function w2() {
    for (;;) {
      const i = jn++;
      if (i >= jobs.length) return;
      const { id, wantSell, wantMatch } = jobs[i];
      const [sel, mat] = await Promise.all([
        wantSell ? getJson(`/card/v1/${id}/sell`) : null,
        wantMatch ? getJson(`/card/v1/${id}/matching`) : null,
      ]);
      if (wantSell && sel === null && wantMatch && mat === null) jfails++;
      const ds = rowsOf(sel, 20), dm = rowsOf(mat, 20);
      // 只取有价的，空数组不落盘
      if (ds.length) out[id].ds = ds;
      if (dm.length) out[id].dm = dm;
      if (++jdone % 250 === 0) console.log(`  明细 ${jdone}/${jobs.length} 失败 ${jfails}`);
    }
  }
  await Promise.all(Array.from({ length: CONC_DETAIL() }, w2));
  const nSell = jobs.filter(j => j.wantSell).length, nMat = jobs.filter(j => j.wantMatch).length;
  console.log(`  按需明细：挂单 ${nSell} 张 / 成交 ${nMat} 张（跳过 ${ids.length - nSell} 张挂单、${ids.length - nMat} 张成交），失败 ${jfails}`);
  return out;
}

// 旧实现（留档，等站方恢复或找到新端点在接回来）
async function fetchDetailsLegacy(ids) {
  const out = {};
  let next = 0, fails = 0, done = 0;
  const rows = o => (o && Array.isArray(o.results))
    ? o.results.map(x => [Number(x.price) || 0, d10(x.create_date)]).filter(x => x[0] > 0).slice(0, 12)
    : [];
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      const id = ids[i];
      const [s, b, m] = await Promise.all([
        getJson(`/card/v1/${id}/sell`),
        getJson(`/card/v1/${id}/buy`),
        getJson(`/card/v1/${id}/matching`),
      ]);
      if (s === null && b === null && m === null) fails++;
      const rec = {};
      const rs = rows(s), rb = rows(b), rm = rows(m);
      if (rs.length) rec.s = rs;
      if (rb.length) rec.b = rb;
      if (rm.length) rec.m = rm;
      if (Object.keys(rec).length) out[id] = rec;
      if (++done % 200 === 0) console.log(`  明细 ${done}/${ids.length} 失败 ${fails}`);
    }
  }
  await Promise.all(Array.from({ length: CONC_DETAIL() }, worker));
  if (fails > ids.length * 0.3) throw new Error(`明细失败 ${fails}/${ids.length}，放弃本次`);
  return out;
}

// ── 固定监控卡补抓（接口字段与搜索结果同结构，可直接混进 main.list） ──
// 用关键词翻页找指定 id（v3 没单卡接口，只能这么捞）
async function searchOneById(q, id, maxPages = 10) {
  let cursor = null, page = 0;
  while (page < maxPages) {
    const qs = cursor ? '&page=' + encodeURIComponent(cursor) : '';
    const j = await getJson(`/card/v3/search?q=${encodeURIComponent(q)}${qs}`);
    if (!j || !Array.isArray(j.results)) return null;
    page++;
    const hit = j.results.find(x => x && String(x.id) === String(id));
    if (hit) return hit;
    if (!j.next_page || !j.results.length) return null;
    cursor = j.next_page;
  }
  return null;
}

// ── 固定监控卡补抓 ──
// v3 没有单卡接口，先看主搜索有没有，没有就用配置的搜索词再单独捞一遍。
async function fetchPinned(list) {
  if (!PINS.length) return [];
  const have = new Set(list.map(r => String(r.id)));
  const out = [];
  for (const pin of PINS) {
    if (have.has(String(pin.id))) continue;      // 搜索里已经带了就不重复加
    let c = null;
    if (pin.q) c = await searchOneById(pin.q, pin.id);
    if (c) {
      out.push(c);
      console.log(`  固定卡 ${pin.id} 已用「${pin.q}」搜到`);
    } else {
      console.log(`  ⚠️ 固定卡 ${pin.id} 拉取失败（没配搜索词或搜不到），本轮先跳过`);
    }
  }
  return out;
}

const IMG = () => 'L';

// v3 的 kind 是韩文（kind_name），前端 KIND 表用英文键，这里做一次转换。
// 映射按 kind_id 顺序实测确认：1 앨범 / 2 시즌그리팅 / 3 팬싸 / 4 팬미팅 / 5 팬클럽
//                                6 콘서트 / 7 MD / 8 콜라보 / 9 특전 / 10 기타
const KIND_KR2EN = {
  '앨범': 'Album',
  '시즌그리팅': "Season's greeting",
  '팬싸': 'Fan sign',
  '팬미팅': 'Fan meeting',
  '팬클럽': 'Fan club',
  '콘서트': 'Concert',
  'MD': 'MD',
  '콜라보': 'Collabo',
  '특전': 'Benefit',
  '기타': 'ETC',
};

(async () => {
  const t0 = Date.now();

  // 上一次的状态（价格快照 + 变动记录）
  const statePath = path.join(HERE, 'state.json');
  let prevState = { at: null, snap: {}, hist: {} };
  if (fs.existsSync(statePath)) {
    try { prevState = Object.assign(prevState, JSON.parse(fs.readFileSync(statePath, 'utf8'))); } catch (e) {}
  }
  // 「求购 / 最近成交 / 速切成交」保底值
  // ⚠️ 2026-11-02 站方改版后，v3 接口只给「最低卖价」，求购与成交记录端点（旧 /buy、/matching）
  //    全部下线，全球站 gb/v2/history 是另一个卖家池（同卡价格差 4 倍以上），不能拿来顶替。
  //    为了不让页面上的「最高求购」「最近匹配成交」两行凭空消失，这里沿用改版前最后一次抓到的
  //    真值：carry.json 是种子（改版前快照提炼），跑起来后存在 state.json 的 carry 里自我维护。
  //    沿用来的值会在 items 上打 cf=最后确认日期，前端可据此标注数据新旧。
  const carryPath = path.join(HERE, 'carry.json');
  let carry = (prevState.carry && prevState.carry.d) ? prevState.carry : null;
  if (!carry && fs.existsSync(carryPath)) {
    try {
      const seed = JSON.parse(fs.readFileSync(carryPath, 'utf8'));
      if (seed && seed.d) carry = { at: seed.at || '', d: seed.d };
    } catch (e) {
      console.log('carry.json 读取失败，跳过保底：' + e.message);
    }
  }
  if (!carry) carry = { at: '', d: {} };
  console.log(`保底数据 ${Object.keys(carry.d).length} 条（最后确认 ${carry.at || '无'}）`);

  // 详情弹窗的三段挂单明细（卖家挂单 / 买家求购 / 历史匹配成交）保底
  // 同样是 11-02 改版后接口不再提供的字段；这份是静态种子，从改版前本地快照汇总而来，
  // 不需要每轮更新（接口不恢复就不会有新数据），所以只从 carry 文件读、不进 state.json。
  const detCarryPath = path.join(HERE, 'detcarry.json');
  let detCarry = { at: '', d: {} };
  if (fs.existsSync(detCarryPath)) {
    try {
      const seed = JSON.parse(fs.readFileSync(detCarryPath, 'utf8'));
      if (seed && seed.d) detCarry = seed;
    } catch (e) {
      console.log('detcarry.json 读取失败，明细保底跳过：' + e.message);
    }
  }
  {
    const ids2 = Object.keys(detCarry.d);
    let nm2 = 0;
    for (const k of ids2) if (detCarry.d[k].m && detCarry.d[k].m.length) nm2++;
    console.log(`明细保底 ${ids2.length} 张卡（有成交 ${nm2} 张，最后确认 ${detCarry.at || '无'}）`);
  }

  if (MIN_GAP_MIN > 0 && prevState.at) {
    const gap = (Date.now() - new Date(prevState.at).getTime()) / 60000;
    if (gap < MIN_GAP_MIN) {
      console.log(`距上次成功 ${gap.toFixed(1)} 分钟 < ${MIN_GAP_MIN}，本轮跳过`);
      process.exit(0);
    }
  }

  console.log(`[${stamp}] 开始抓取 "${Q}"，并发 ${CONC}`);

  // 1) 搜索全量（v3 游标）
  const main = await fetchAll();
  console.log(`搜索完成 ${main.list.length} 条（${main.pages} 页，失败 ${main.failed}），${Math.round((Date.now() - t0) / 1000)}s`);

  // 1.5) 固定监控卡（例如短链分享过来的别的成员的卡）：搜索抓不到就单独补，混进同一份列表
  const pinned = await fetchPinned(main.list);
  if (pinned.length) {
    main.list.push(...pinned);
    console.log(`固定监控卡补入 ${pinned.length} 张：${pinned.map(x => x.id).join(', ')}，合计 ${main.list.length} 张`);
  }

  // 2) 收藏排名：v3 的结果里直接带 wish_count，按它降序就是收藏榜，
  //    不用像旧版那样再按 sort=wish 抓一遍全量（v3 的 sort 参数会 400）。
  let wishRank = new Map();
  {
    const sorted = [...main.list].sort((a, b) => num(b.wish_count) - num(a.wish_count));
    sorted.forEach((r, i) => wishRank.set(r.id, i + 1));
    console.log(`收藏排名完成 ${wishRank.size} 条（按 wish_count 自算）`);
  }

  // 3) 明细
  const ids = main.list.map(r => r.id);
  const detail = await fetchDetails(ids);
  console.log(`明细完成 ${Object.keys(detail).length}/${ids.length} 张，累计 ${Math.round((Date.now() - t0) / 1000)}s`);

  // 明细永久档案 darc.json：站方每轮只给最新 5 条，这里把历轮拿到的挂单/成交行攒起来。
  // 只增不减：读上一轮档案 → 并入本轮新行 → 原样写回，任何情况下都不清空已有记录。
  const darcPath = path.join(HERE, 'darc.json');
  let darc = {};
  if (fs.existsSync(darcPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(darcPath, 'utf8'));
      if (j && j.d) darc = j.d;
    } catch (e) {
      console.log('darc.json 读取失败（本轮只能从当轮 5 条起算）：' + e.message);
    }
  }
  const darcSeedS = Object.values(darc).reduce((s, v) => s + ((v.s || []).length), 0);
  const darcSeedM = Object.values(darc).reduce((s, v) => s + ((v.m || []).length), 0);
  let darcAddS = 0, darcAddM = 0;
  for (const [id, v] of Object.entries(detail)) {
    if (v.ds && v.ds.length) darcAddS += mergeDarc(darc, id, 's', v.ds);
    if (v.dm && v.dm.length) darcAddM += mergeDarc(darc, id, 'm', v.dm);
  }

  // 首次建档案时，把 11-01 改版前攒在 detcarry.json 里的历史明细并进来当底子
  // （挂单 867 条 / 成交 3431 条，只有日期没有时分，日期格式与接口一致，靠价格+日期去重）。
  // ⚠️ 只在「档案还是空的」时候做：老档案只到日，若每轮都并，会跟接口的精确到秒的记录
  //    重复成两条（同价同日不同键）。
  let darcSeeded = 0;
  if (!darcSeedS && !darcSeedM && detCarry && detCarry.d) {
    for (const [id, v] of Object.entries(detCarry.d)) {
      if (v && v.s && v.s.length) darcSeeded += mergeDarc(darc, id, 's', v.s);
      if (v && v.m && v.m.length) darcSeeded += mergeDarc(darc, id, 'm', v.m);
    }
    if (darcSeeded) console.log(`明细档案首次建立，并入 11-01 前的历史明细 ${darcSeeded} 条`);
  }

  // 永久价格档案 pchg.json（只记 p/q 变化，永不裁剪）
  // 首次运行时用 state.json 里现成的 hist 当种子，避免从零开始。
  const pchgPath = path.join(HERE, 'pchg.json');
  let pchg = {};
  if (fs.existsSync(pchgPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(pchgPath, 'utf8'));
      if (j && j.d) pchg = j.d;
    } catch (e) {
      console.log('pchg.json 读取失败，用 state.hist 当种子：' + e.message);
    }
  }
  if (!Object.keys(pchg).length && prevState.hist) {
    for (const [id, arr] of Object.entries(prevState.hist)) if (Array.isArray(arr) && arr.length) pchg[id] = arr.slice();
  }
  const archSeed = Object.keys(pchg).length;
  let archAdded = 0;

  // 历史种子：把改版前后几份本地快照里的「当时报价」并进来，
  // 这样详情页的匹配/速切价格记录能往前看到 10-23，不用从今天从零开始。
  // 种子是固定文件，靠时间戳去重，重复跑不会重复插。
  {
    const seedP = path.join(HERE, 'pchgseed.json');
    if (fs.existsSync(seedP)) {
      try {
        const sd = JSON.parse(fs.readFileSync(seedP, 'utf8'));
        let addedSeed = 0;
        for (const [id, pts] of Object.entries(sd.d || {})) {
          const arc = pchg[id] || (pchg[id] = []);
          const has = new Set(arc.map(e => String(e[0])));
          for (const pt of pts) {
            if (has.has(String(pt[0]))) continue;
            arc.push(pt);
            has.add(String(pt[0]));
            addedSeed++;
          }
          arc.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        }
        if (addedSeed) console.log(`历史价格种子并入 ${addedSeed} 个时间点`);
      } catch (e) {
        console.log('pchgseed.json 读取失败：' + e.message);
      }
    }
  }

  // 4) 组装
  const prevSnap = prevState.snap || {};
  const hist = prevState.hist || {};
  const liveIds = new Set(ids.map(String));
  const items = [];
  let nDown = 0, nFresh = 0, histAdded = 0;
  // 保底值的新一轮存档（只留本轮还在榜上的卡）
  const carryNext = {};
  let carryAt = carry.at || '';

  for (const r of main.list) {
    // ⚠️ 2026-11-02 v3 字段对照（拿旧快照逐张比对过，几乎是 1:1）：
    //    transaction_sell_price → 旧 get_lowest_sell_price   （匹配最低价，404 张有值，完全吻合）
    //    offer_price            → 旧 get_collection_lowest_sell_offer_price（速切最低价，769 张有值，完全吻合）
    //    求购(wished_sells 全空)、最近成交、速切成交：v3 不给 → 2026-11-11 起改由
    //    /card/v1/<id> 单卡详情实时提供（fetchDetails），只有接口失败时才回落 carry 保底。
    const p = num(r.transaction_sell_price);                  // 匹配：最低卖价
    const q = num(r.offer_price);                             // 速切：最低卖价
    // 实时值：来自 /card/v1/<id> 单卡详情（fetchDetails），拿不到才回落 carry 保底
    const dv = detail[r.id] || {};
    const liveB = num(dv.b), liveMp = num(dv.mp), liveT = num(dv.t);
    const hold = carry.d[r.id] || null;
    const b = liveB || (hold ? num(hold[0]) : 0);              // 最高求购
    const mp = liveMp || (hold ? num(hold[1]) : 0);            // 最近匹配成交
    const t = liveT || (hold ? num(hold[2]) : 0);              // 速切最近成交
    const fromCarry = (b > 0 && !liveB) || (mp > 0 && !liveMp) || (t > 0 && !liveT);
    // 库存：优先真实件数（get_collection_count），拿不到才回落 v3 的布尔
    const stock = (dv.st === undefined) ? (r.is_stocked ? 1 : 0) : dv.st;

    // 存档：本轮拿到的（实时或沿用）值留作下一轮的保底
    if (b > 0 || mp > 0 || t > 0) carryNext[r.id] = [b, mp, t];
    // 真有实时值时，把确认日期推到今天（当前 v3 不会触发，留着以防站方恢复字段）
    if (liveB > 0 || liveMp > 0 || liveT > 0) carryAt = stamp.slice(0, 10);

    const ps = prevSnap[r.id];
    let chg = null;
    if (ps) {
      const pm = num(ps[0]), pq = num(ps[1]);
      const hadPrice = pm > 0 || pq > 0, hasPrice = p > 0 || q > 0;
      if (!hadPrice && hasPrice) { chg = { type: 'new', m: { from: 0, to: p }, q: { from: 0, to: q } }; nFresh++; }
      else if (hadPrice && !hasPrice) { chg = { type: 'out', m: { from: pm, to: 0 }, q: { from: pq, to: 0 } }; }
      else {
        const downM = pm > 0 && p > 0 && p < pm, downQ = pq > 0 && q > 0 && q < pq;
        const upM = pm > 0 && p > 0 && p > pm, upQ = pq > 0 && q > 0 && q > pq;
        if (downM || downQ) { chg = { type: 'down', m: { from: pm, to: p }, q: { from: pq, to: q }, dm: downM, dq: downQ }; nDown++; }
        else if (upM || upQ) chg = { type: 'up', m: { from: pm, to: p }, q: { from: pq, to: q }, um: upM, uq: upQ };
      }
    }

    // 价格变动记录（只在变化时追加，只留近几天给页面用）
    const cur = [p, q, t];
    let arr = hist[r.id] || [];
    const last = arr[arr.length - 1];
    const isNewPoint = !last || Number(last[1]) !== cur[0] || Number(last[2]) !== cur[1] || Number(last[3]) !== cur[2];
    if (isNewPoint) {
      arr.push([stamp, cur[0], cur[1], cur[2]]);
      if (arr.length > HIST_MAX) arr = arr.slice(-HIST_MAX);
      hist[r.id] = arr;
      histAdded++;
    }
    // 永久档案：同一份点也进 pchg.json，永不裁剪
    // ⚠️ 页面只显示近 HIST_KEEP_DAYS 天，而 state.json 的 hist 会被裁掉，
    //    想要长历史就只能单独存档。成交接口下线后，这份价格史是唯一能长期积累的真数据。
    // 2026-11-11 起第 5 位存「最高求购」（0 = 没人求购），求购单独变化也记一条 ——
    //    否则求购只在卖价同时变动时才留痕，详情页的求购记录会大片断档。
    {
      const arc = pchg[r.id] || (pchg[r.id] = []);
      const la = arc[arc.length - 1];
      const laB = la ? (Number(la[4]) || 0) : -1;
      if (!la || Number(la[1]) !== cur[0] || Number(la[2]) !== cur[1] || laB !== b) {
        arc.push([stamp, cur[0], cur[1], cur[2], b]);
        if (arc.length > ARCH_MAX) arc.splice(0, arc.length - ARCH_MAX);
        archAdded++;
      }
    }

    items.push({
      id: r.id,
      // v3 只给韩文原名（name），没有 name_en；前端 n 为空时会回退到 nk，不影响显示
      n: r.name || '',
      nk: r.name || '',
      g: r.group_name || '',
      gk: r.group_name || '',
      m: r.member_name || '',
      mk: r.member_name || '',
      kind: KIND_KR2EN[r.kind_name] || r.kind_name || '',
      img: IMG(),
      p, q, b, mp, t, stock,
      // cf：b/mp/t 里若有沿用保底的值，这里是它们最后一次被确认到的日期（YYYY-MM-DD）
      ...(fromCarry ? { cf: carryAt } : {}),
      rd: regDate(r.image),
      rk: wishRank.get(r.id) || 0,
      chg,
    });
  }

  // 清理已下榜的卡的历史，控制体积
  for (const k of Object.keys(hist)) if (!liveIds.has(String(k))) delete hist[k];

  // 时间裁剪：只留最近 HIST_KEEP_DAYS 天的点（外加窗口前 1 个点当基准）
  // 前端「近2日涨跌」是自然日口径，多留 1 天余量，避免窗口边缘的点被删掉算不出涨跌
  {
    const n = new Date(Date.now() + TZ);
    const from = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) - TZ - HIST_KEEP_DAYS * 86400000;
    for (const k of Object.keys(hist)) {
      const arr = hist[k];
      if (!arr || !arr.length) { delete hist[k]; continue; }
      let keep = arr.filter(p => Date.parse(p[0] + '+08:00') >= from);
      if (keep.length < arr.length) {
        const idx = arr.indexOf(keep[0]);
        if (idx > 0) keep = [arr[idx - 1], ...keep];   // 补一个窗口外的基准点
      }
      if (!keep.length) keep = [arr[arr.length - 1]];
      hist[k] = keep.slice(-HIST_MAX);
    }
  }

  // 5) 详情页三段「记录」（前端 secList 直接渲染，格式 [价, 时间, 可选标记]）：
  //    hs = 匹配价格记录：前半段用改版前的挂单/成交反推（带 '~'），后半段是 10-23 起的真实观测
  //    hq = 速切价格记录：速切没有历史明细，只有真实观测
  //    hb = 最高求购记录：2026-11-11 起实时抓（get_highest_buy_price），前面接 11-01 前的推算段
  //    ⚠️ 真实观测一条都不删 —— 每 10 分钟抓一次、亲眼看到的变动全部保留，用户要看完整过程
  //    h  = 近 2 日涨跌要用的原始序列，别删
  const det = {};
  for (const r of main.list) {
    const rec = {};
    if (r.image) rec.u = String(r.image).replace('https://d1sut5kn3lwnf7.cloudfront.net', '');

    const dc = detCarry.d[r.id];
    const arc = pchg[r.id] || [];
    const realS = seriesOf(arc, 1, REC_MAX);     // 匹配价真实观测
    const realQ = seriesOf(arc, 2, REC_MAX);     // 速切价真实观测

    // 历史推算段只取「第一条真实观测之前」，两段不重叠、不打架
    let histS = [];
    if (dc && (dc.m || dc.s)) {
      histS = trimSeries([...(dc.m || []), ...ordersToSeries(dc.s)], false);
      if (realS.length) {
        const firstDay = String(realS[0][1]).slice(0, 10);
        histS = histS.filter(x => x[1] < firstDay);
        // 拼接处同价的话压掉历史段尾巴，避免连着两条同价
        if (histS.length && histS[histS.length - 1][0] === realS[0][0]) histS.pop();
      }
      histS = histS.map(x => [x[0], x[1], '~']);
    }
    const hs = [...histS, ...realS];
    if (hs.length) rec.hs = hs.slice(-REC_MAX);
    if (realQ.length) rec.hq = realQ;

    // 最高求购：2026-11-11 起从 /card/v1/<id> 的 get_highest_buy_price 实时抓（pchg 第 5 位），
    // 前面接 11-01 前攒下的推算段（带 '~'），两段同样以「第一条真实观测」为界，不重叠。
    const realB = seriesOfBuy(arc, REC_MAX);
    let histB = [];
    if (dc && dc.b && dc.b.length) {
      histB = trimSeries(dc.b, true);               // 求购看「最高价」
      if (realB.length) {
        const firstDay = String(realB[0][1]).slice(0, 10);
        histB = histB.filter(x => x[1] < firstDay);
        if (histB.length && histB[histB.length - 1][0] === realB[0][0]) histB.pop();
      }
      histB = histB.map(x => [x[0], x[1], '~']);
    }
    const hb = [...histB, ...realB];
    if (hb.length) {
      rec.hb = hb.slice(-REC_MAX);
      if (realB.length) rec.hbLive = 1;             // 有实测段 → 前端副标题改写「实时」
    }
    if (dc) rec.da = detCarry.at;

    // 明细两块（2026-11-11 接回）：ds = 卖家匹配挂单，dm = 匹配成交明细
    // 2026-11-11 12:xx 起改成「累积档案」：站方每轮只回最新 5 条，光看当轮会把更早的挤掉，
    // 所以下发的是 darc.json 里攒下的全量。挂单必须区分「本轮还在挂」和「往轮记录过的」——
    // 第三位 1 = 本轮接口仍返回（当前在挂），没有第三位 = 往轮攒的（可能已撤单或被新单挤出前 5）。
    // 成交是既成事实，不存在撤回，不用标记。
    const dvNow = detail[r.id];
    const nowSet = new Set((dvNow && dvNow.ds ? dvNow.ds : []).map(e => `${e[0]}|${e[1]}`));
    const arcD = darc[r.id];
    if (arcD && arcD.s && arcD.s.length) {
      const rows = arcD.s.map(e => nowSet.has(`${e[0]}|${e[1]}`) ? [e[0], e[1], 1] : [e[0], e[1]]);
      rec.ds = capKeepNow(dedupeCoarse(rows), REC_D_MAX);
    } else if (dvNow && dvNow.ds && dvNow.ds.length) {
      rec.ds = dvNow.ds;
    }
    if (arcD && arcD.m && arcD.m.length) {
      rec.dm = dedupeCoarse(arcD.m).slice(-REC_D_MAX);
    } else if (dvNow && dvNow.dm && dvNow.dm.length) {
      rec.dm = dvNow.dm;
    }

    const h = hist[r.id];
    if (h && h.length >= 2) rec.h = h;
    if (Object.keys(rec).length) det[r.id] = rec;
  }

  const out = {
    v: 2,
    keyword: Q,
    at: new Date().toISOString(),
    at_cn: stamp,
    total: main.count,
    fetched: items.length,
    elapsed: Math.round((Date.now() - t0) / 1000),
    stats: { p: items.filter(x => x.p > 0).length, q: items.filter(x => x.q > 0).length, down: nDown, fresh: nFresh },
    items,
    det,
  };
  fs.writeFileSync(path.join(HERE, 'data.json'), JSON.stringify(out), 'utf8');
  // ⚠️ pushed 是钉钉推送用的基准价（notify.js 维护），这里必须原样带过去，否则每轮首抓就把它冲掉
  const nextState = { at: out.at, snap: Object.fromEntries(items.map(x => [x.id, [x.p, x.q, x.t]])), hist };
  // 保底值跟着 state.json 走，下一轮接着用（carry.json 只是首次种子，不参与更新）
  if (Object.keys(carryNext).length) nextState.carry = { at: carryAt, d: carryNext };
  if (prevState.pushed && Object.keys(prevState.pushed).length) nextState.pushed = prevState.pushed;
  fs.writeFileSync(statePath, JSON.stringify(nextState), 'utf8');

  // 永久价格档案（poca-data 分支单独的 pchg.json，不进 state.json，免得越滚越大）
  fs.writeFileSync(pchgPath, JSON.stringify({ v: 1, at: out.at, at_cn: stamp, d: pchg }), 'utf8');

  // 永久明细档案（同上：单独文件，只增不减，越过站方「最多 5 条」的上限把历史攒起来）
  fs.writeFileSync(darcPath, JSON.stringify({ v: 1, at: out.at, at_cn: stamp, d: darc }), 'utf8');

  const kb = f => (fs.statSync(path.join(HERE, f)).size / 1024).toFixed(0);
  console.log(`✅ data.json ${kb('data.json')}KB · state.json ${kb('state.json')}KB · pchg.json ${kb('pchg.json')}KB · darc.json ${kb('darc.json')}KB`);
  {
    const totD = k => Object.values(darc).reduce((s, v) => s + ((v[k] || []).length), 0);
    console.log(`   明细档案 ${Object.keys(darc).length} 张卡 / 挂单 ${totD('s')} 条（本轮 +${darcAddS}，原 ${darcSeedS + darcSeeded}） / 成交 ${totD('m')} 条（本轮 +${darcAddM}，原 ${darcSeedM + darcSeeded}），永不裁剪`);
  }
  {
    let pts = 0;
    for (const k of Object.keys(pchg)) pts += (pchg[k] || []).length;
    console.log(`   价格档案 ${Object.keys(pchg).length} 张卡 / ${pts} 个点（种子 ${archSeed} 张，本轮新增 ${archAdded} 点，永不裁剪）`);
  }
  console.log(`   ${items.length} 张 | 有 1:1 ${out.stats.p} | 有速购 ${out.stats.q} | 跌价 ${nDown} | 上新 ${nFresh} | 新增价格记录 ${histAdded} 点`);
  console.log(`   求购 ${items.filter(x => x.b > 0).length} 张 | 最近成交 ${items.filter(x => x.mp > 0).length} 张 | 速切成交 ${items.filter(x => x.t > 0).length} 张 | 有库存 ${items.filter(x => x.stock > 0).length} 张（合计 ${items.reduce((s, x) => s + (x.stock || 0), 0)} 件）`);
  {
    const dv = Object.values(det);
    const tot = k => dv.reduce((s, x) => s + ((x[k] || []).length), 0);
    const est = dv.reduce((s, x) => s + ((x.hs || []).filter(e => e[2] === '~').length), 0);
    console.log(`   记录：匹配价 ${dv.filter(x => x.hs).length} 张(${tot('hs')} 条，其中推算 ${est} 条) | 速切价 ${dv.filter(x => x.hq).length} 张(${tot('hq')} 条) | 最高求购 ${dv.filter(x => x.hb).length} 张(${tot('hb')} 条，其中实时 ${dv.filter(x => x.hbLive).length} 张)`);
  }
  console.log(`   耗时 ${out.elapsed}s`);
})().catch(e => { console.error('❌ 抓取失败：', e.message); process.exit(1); });
