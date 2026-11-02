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
// ⚠️ 2026-11-01 站方把 API 域名换了：api.phocamarket.com → api.pocamarket.com（少一个 h）。
//    旧域名现在所有 /card/v1/* 一律 404（响应体为空、text/plain，是 nginx 直接拒的），
//    未匹配路径则回落到前端 HTML。同期 phocamarket.com 整站改成「引导下载 App」的落地页，
//    app.phocamarket.com/<码> 也会 302 去 Google Play。
//    路径和返回结构完全没变，只换了主机名。
const HOST = 'api.pocamarket.com';

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
      if (page === 0) throw new Error('首页抓取失败，接口可能变更');
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

// ── 每卡挂单明细 ──
// ⚠️ 2026-11-02 改版后，旧的 /card/v1/<id>/sell|buy|matching 三个端点全部下线，
//    v3 也没有对应的明细端点（/card/v3/<id>、/sell、/buy、/matching 均 404）。
//    新站的挂单明细只在网页端详情接口里（/apis/card/gb/v2/<id> 的 seller_shop），
//    但那是 Vercel 反爬域名、且字段结构与旧版不同，暂不接入。
//    这里保留函数壳，返回空对象：det[id] 仍有图片(u)和价格历史(h)，只是少了 s/b/m 分布。
async function fetchDetails(ids) {
  return {};
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
  await Promise.all(Array.from({ length: CONC_DETAIL }, worker));
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
    //    求购(wished_sells 全空)、最近成交、速切成交：v3 不再提供 → 走 carry 保底，见上方注释。
    const p = num(r.transaction_sell_price);                  // 匹配：最低卖价
    const q = num(r.offer_price);                             // 速切：最低卖价
    // 实时值：v3 目前恒为 0。将来若站方恢复这几个字段，把对应变量改成读接口即可，
    // 下面的保底逻辑会自动让位（实时值优先）。
    const liveB = 0, liveMp = 0, liveT = 0;
    const hold = carry.d[r.id] || null;
    const b = liveB || (hold ? num(hold[0]) : 0);              // 最高求购
    const mp = liveMp || (hold ? num(hold[1]) : 0);            // 最近匹配成交
    const t = liveT || (hold ? num(hold[2]) : 0);              // 速切最近成交
    const fromCarry = (b > 0 && !liveB) || (mp > 0 && !liveMp) || (t > 0 && !liveT);
    const stock = r.is_stocked ? 1 : 0;                       // 新版只给布尔「有无在售」

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
  // 保底值跟着 state.json 走，下一轮接着用（carry.json 只是首次种子，不参与更新）
  if (Object.keys(carryNext).length) nextState.carry = { at: carryAt, d: carryNext };
  if (prevState.pushed && Object.keys(prevState.pushed).length) nextState.pushed = prevState.pushed;
  fs.writeFileSync(statePath, JSON.stringify(nextState), 'utf8');

  const kb = f => (fs.statSync(path.join(HERE, f)).size / 1024).toFixed(0);
  console.log(`✅ data.json ${kb('data.json')}KB · state.json ${kb('state.json')}KB`);
  console.log(`   ${items.length} 张 | 有 1:1 ${out.stats.p} | 有速购 ${out.stats.q} | 跌价 ${nDown} | 上新 ${nFresh} | 新增价格记录 ${histAdded} 点`);
  console.log(`   求购 ${items.filter(x => x.b > 0).length} 张 | 最近成交 ${items.filter(x => x.mp > 0).length} 张 | 速切成交 ${items.filter(x => x.t > 0).length} 张（保底值，最后确认 ${carryAt || '无'}）`);
  console.log(`   耗时 ${out.elapsed}s`);
})().catch(e => { console.error('❌ 抓取失败：', e.message); process.exit(1); });
