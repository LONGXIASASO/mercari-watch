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
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const HOST = 'api.phocamarket.com';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const Q = process.env.POCA_Q || '장하오';
const CONC = Number(process.env.POCA_CONC || 8);       // ⚠️ 搜索页并发超过 8 会被限速，16 实测反而慢一倍
const CONC_DETAIL = Number(process.env.POCA_CONC_DET || 16); // 明细接口单条很轻，16 并发没问题
// 价格变动记录（hist）保留策略：前端「近2日涨价/降价」按自然日回溯 2 天，
// 所以云端至少留 3 天（含窗口外 1 个基准点），单卡最多 HIST_MAX 个点控制体积。
const HIST_MAX = 100;
const HIST_KEEP_DAYS = 3;
const TZ = 8 * 3600e3; // 北京时间

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SKIP_WISH = process.argv.includes('--skip-wish'); // 收藏排名变化慢，可降频
const MIN_GAP_MIN = Number(argOf('min-gap', '0'));      // 距上次成功不足这么多分钟就跳过

const sleep = ms => new Promise(r => setTimeout(r, ms));

function rawGet(p, timeout = 25000) {
  return new Promise(resolve => {
    const req = https.request({
      host: HOST, path: p, method: 'GET', timeout,
      headers: {
        'User-Agent': UA, 'Accept': 'application/json',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'POCA-DISPLAY-LANGUAGE': 'ko', 'Referer': 'https://phocamarket.com/',
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
async function getJson(p, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await rawGet(p);
    if (r.s === 200 && r.d && r.d.trim().startsWith('{')) { try { return JSON.parse(r.d); } catch (e) {} }
    if (r.s === 404) return null;
    await sleep(400 * (i + 1));
  }
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

// ── 全量搜索分页 ──
async function fetchAll(sort) {
  const sq = sort ? '&sort=' + sort : '';
  const first = await getJson(`/card/v1/search?q=${encodeURIComponent(Q)}&page=1${sq}`);
  if (!first || !first.results) throw new Error('首页抓取失败，接口可能变更');
  const count = first.count;
  const pages = Math.min(Math.ceil(count / 8), 300);
  const buf = new Array(pages + 1);
  buf[1] = first;
  let next = 2, failed = 0, done = 1;
  async function worker() {
    for (;;) {
      const p = next++;
      if (p > pages) return;
      const j = await getJson(`/card/v1/search?q=${encodeURIComponent(Q)}&page=${p}${sq}`);
      if (j && j.results) buf[p] = j; else failed++;
      if (++done % 40 === 0) console.log(`  搜索${sort ? '(' + sort + ')' : ''} ${done}/${pages} 失败 ${failed}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  if (failed > pages * 0.15) throw new Error(`搜索失败页 ${failed}/${pages}，超过 15%，放弃本次`);
  const all = [];
  for (let p = 1; p <= pages; p++) if (buf[p] && buf[p].results) all.push(...buf[p].results);
  const map = new Map();
  for (const r of all) map.set(r.id, r);
  return { count, list: [...map.values()], failed };
}

// ── 每卡挂单明细 ──
async function fetchDetails(ids) {
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
  await Promise.all(Array.from({ length: CONC_DETAIL }, worker));
  if (fails > ids.length * 0.3) throw new Error(`明细失败 ${fails}/${ids.length}，放弃本次`);
  return out;
}

const IMG = () => 'L';

(async () => {
  const t0 = Date.now();

  // 上一次的状态（价格快照 + 变动记录）
  const statePath = path.join(HERE, 'state.json');
  let prevState = { at: null, snap: {}, hist: {} };
  if (fs.existsSync(statePath)) {
    try { prevState = Object.assign(prevState, JSON.parse(fs.readFileSync(statePath, 'utf8'))); } catch (e) {}
  }
  if (MIN_GAP_MIN > 0 && prevState.at) {
    const gap = (Date.now() - new Date(prevState.at).getTime()) / 60000;
    if (gap < MIN_GAP_MIN) {
      console.log(`距上次成功 ${gap.toFixed(1)} 分钟 < ${MIN_GAP_MIN}，本轮跳过`);
      process.exit(0);
    }
  }

  console.log(`[${stamp}] 开始抓取 "${Q}"，并发 ${CONC}`);

  // 1) 搜索（默认序 = 实时交易顺）
  const main = await fetchAll('');
  console.log(`搜索完成 ${main.list.length}/${main.count} 条，${Math.round((Date.now() - t0) / 1000)}s`);

  // 2) 收藏排名（变化慢，6 小时内直接用缓存，省一半抓取时间）
  let wishRank = new Map();
  const wishCachePath = path.join(HERE, 'wish.json');
  let wishAge = 1e9;
  if (fs.existsSync(wishCachePath)) {
    try {
      const c = JSON.parse(fs.readFileSync(wishCachePath, 'utf8'));
      wishRank = new Map(c.rank || []);
      wishAge = (Date.now() - new Date(c.at).getTime()) / 60000;
    } catch (e) {}
  }
  if (!SKIP_WISH && wishAge > 360) {
    const w = await fetchAll('wish');
    wishRank = new Map();
    (w.list || []).forEach((r, i) => wishRank.set(r.id, i + 1));
    fs.writeFileSync(wishCachePath, JSON.stringify({ at: new Date().toISOString(), rank: [...wishRank] }), 'utf8');
    console.log(`收藏排名完成 ${wishRank.size} 条，累计 ${Math.round((Date.now() - t0) / 1000)}s`);
  } else {
    console.log(`收藏排名沿用缓存（${Math.round(wishAge)} 分钟前，${wishRank.size} 条）`);
  }

  // 3) 明细
  const ids = main.list.map(r => r.id);
  const detail = await fetchDetails(ids);
  console.log(`明细完成 ${Object.keys(detail).length}/${ids.length} 张，累计 ${Math.round((Date.now() - t0) / 1000)}s`);

  // 4) 组装
  const prevSnap = prevState.snap || {};
  const hist = prevState.hist || {};
  const liveIds = new Set(ids.map(String));
  const items = [];
  let nDown = 0, nFresh = 0, histAdded = 0;

  for (const r of main.list) {
    const p = num(r.get_lowest_sell_price);                  // 匹配：1:1 卖单最低价（= /sell 端点最低）
    const q = num(r.get_collection_lowest_sell_offer_price);  // 速切：빠른구매 寄售库存最低价
    const b = num(r.get_highest_buy_price);                   // 最高求购：구매 희망가（= /buy 端点最高）
    const mp = num(r.get_matching_price);                     // 最近匹配成交：최근 매칭가（= /matching 端点最新一条）
    const t = num(r.get_collection_transaction_price);         // 速切最近成交：컬렉션 거래가
    const stock = num(r.get_collection_count);

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

    // 价格变动记录（只在变化时追加）
    const cur = [p, q, t];
    let arr = hist[r.id] || [];
    const last = arr[arr.length - 1];
    if (!last || Number(last[1]) !== cur[0] || Number(last[2]) !== cur[1] || Number(last[3]) !== cur[2]) {
      arr.push([stamp, cur[0], cur[1], cur[2]]);
      if (arr.length > HIST_MAX) arr = arr.slice(-HIST_MAX);
      hist[r.id] = arr;
      histAdded++;
    }

    items.push({
      id: r.id,
      n: r.name_en || r.name || '',
      nk: r.name || '',
      g: (r.group && (r.group.name_en || r.group.name)) || '',
      gk: (r.group && r.group.name) || '',
      m: (r.member && (r.member.name_en || r.member.name)) || '',
      mk: (r.member && r.member.name) || '',
      kind: (r.kind && (r.kind.name_en || r.kind.name)) || '',
      img: IMG(),
      p, q, b, mp, t, stock,
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

  // 5) 明细 + 历史合并（同名 det 结构，前端直接用）
  const det = {};
  for (const r of main.list) {
    const rec = {};
    if (r.image) rec.u = String(r.image).replace('https://d1sut5kn3lwnf7.cloudfront.net', '');
    const d = detail[r.id];
    if (d) { if (d.s) rec.s = d.s; if (d.b) rec.b = d.b; if (d.m) rec.m = d.m; }
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
  if (prevState.pushed && Object.keys(prevState.pushed).length) nextState.pushed = prevState.pushed;
  fs.writeFileSync(statePath, JSON.stringify(nextState), 'utf8');

  const kb = f => (fs.statSync(path.join(HERE, f)).size / 1024).toFixed(0);
  console.log(`✅ data.json ${kb('data.json')}KB · state.json ${kb('state.json')}KB`);
  console.log(`   ${items.length} 张 | 有 1:1 ${out.stats.p} | 有速购 ${out.stats.q} | 跌价 ${nDown} | 上新 ${nFresh} | 新增价格记录 ${histAdded} 点`);
  console.log(`   耗时 ${out.elapsed}s`);
})().catch(e => { console.error('❌ 抓取失败：', e.message); process.exit(1); });
