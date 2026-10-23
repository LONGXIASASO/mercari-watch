/**
 * 煤炉小卡监控 · 云端抓取器（GitHub Actions 专用）
 *
 * 与 mercari_watch\ 的本机版区别：
 *  - 不走代理（Actions 服务器本身在海外，能直连 jp.mercari.com）
 *  - 商品图下载到本仓库 imgs/，页面用 jsDelivr 分发，手机不开梯子也能看
 *  - 状态存在 state.json 里并随仓库提交，保证跨轮次时间窗连续
 *
 * 用法: node run.js [--hours 24] [--dry]
 */
const fs = require('fs');
const path = require('path');
const { toCn } = require('./translate.js');

// 云端优先用完整版 puppeteer（自带匹配版本的 Chromium，不会和系统 Chrome 打架）
let puppeteer, FULL = false;
try { puppeteer = require('puppeteer'); FULL = true; }
catch (e) { puppeteer = require('puppeteer-core'); }

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
// 本机调试时可以临时用环境变量塞代理，云端不需要（留空即可）
if (process.env.WATCH_PROXY) CFG.proxy = process.env.WATCH_PROXY;
const STATE_PATH = path.join(ROOT, 'state.json');
const IMG_DIR = path.join(ROOT, 'imgs');
const RAW_PATH = path.join(ROOT, '_raw.json');

const DRY = process.argv.includes('--dry');
const argOf = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[watch]', ...a);
const nowTs = () => Math.floor(Date.now() / 1000);
// 煤炉的「最新順」实际按更新时间排（created 可能是几年前），所以一切以 updated 为准
const itemTs = it => Number(it.updated) || Number(it.created) || 0;

// ---------------------------------------------------------------- 浏览器
function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch (e) { } }
  throw new Error('找不到 Chrome/Chromium，请设 CHROME_PATH');
}

function resolveExe() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (FULL) {
    try {
      const p = puppeteer.executablePath();
      if (p && fs.existsSync(p)) return p;
    } catch (e) { }
  }
  return findBrowser();
}

async function launch(useProxy) {
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-gpu',
    '--window-size=1400,1000',
    '--lang=ja-JP'
  ];
  if (useProxy && CFG.proxy) args.push('--proxy-server=' + CFG.proxy);
  return puppeteer.launch({ executablePath: resolveExe(), headless: true, args });
}

// ---------------------------------------------------------------- 状态
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (e) { return { runs: 0, last_run: 0, items: {} }; }
}
function saveState(s) {
  // items 只留 30 天内，避免文件无限长大
  const keep = nowTs() - 30 * 86400;
  const items = {};
  for (const k of Object.keys(s.items || {})) if ((s.items[k] || 0) >= keep) items[k] = s.items[k];
  s.items = items;
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 1), 'utf8');
}

// ---------------------------------------------------------------- 抓取
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function searchOne(browser, q, label, bag, cutoff, scrolls, ua, allTime, status, isSold) {
  const page = await browser.newPage();
  await page.setUserAgent(ua);
  await page.setViewport({ width: 1400, height: 1000 });

  let hits = 0;
  page.on('response', async (res) => {
    if (!res.url().includes('v2/entities:search')) return;
    try {
      const j = await res.json();
      if (!j || !Array.isArray(j.items)) return;
      hits++;
      for (const it of j.items) {
        if (!it || !it.id) continue;
        const exist = bag.get(it.id);
        if (exist) {
          // 已被别的词抓到：如果这次是「不限时间」的词，补个标记，让它不被时间窗丢掉
          if (allTime && !exist._allTime) { exist._allTime = true; exist._q = label; }
          if (isSold) exist._sold = true;
          continue;
        }
        it._q = label;
        it._allTime = !!allTime;
        it._sold = !!isSold;
        bag.set(it.id, it);
      }
    } catch (e) { }
  });

  // status 只有两个有效值：on_sale（在售） / sold_out（已卖出，含取引中）
  const url = 'https://jp.mercari.com/search?keyword=' + encodeURIComponent(q.q) +
    '&status=' + (status || 'on_sale') + '&sort=created_time&order=desc';

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4500);

    for (let s = 0; s < scrolls; s++) {
      let minTs = Infinity, mine = 0;
      for (const it of bag.values()) {
        if (it._q !== label) continue;
        mine++;
        const c = itemTs(it);
        if (c > 0 && c < minTs) minTs = c;
      }
      if (mine > 0 && minTs < cutoff) { log('  已翻到时间窗外，停止滚动'); break; }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(2200);
    }

    if (hits === 0) {
      // 一点接口响应都没有 = 被煤炉挡了（某些机房 IP 会被拦，换个 region 就好）
      // 把现场打出来，免得每次只看到「没抓到」三个字还得猜
      try {
        const diag = await page.evaluate(() => ({
          t: document.title,
          u: location.href.slice(0, 120),
          n: document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 160) : '',
          cards: document.querySelectorAll('[data-testid="item-grid"], li, article').length
        }));
        log('  页面诊断: title="' + diag.t + '" 卡片元素=' + diag.cards);
        log('  页面文字: ' + diag.n);
      } catch (e) { }
      log('  未捕获到接口，重载重试');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(6000);
    }
    const mineN = [...bag.values()].filter(x => x._q === label).length;
    log('  ' + label + ' 抓到 ' + mineN + ' 条（累计 ' + bag.size + '，接口 ' + hits + ' 次）');
    return hits > 0;
  } finally {
    await page.close().catch(() => { });
  }
}

// 抓取前先确认代理能用，省得白跑几分钟
async function preflight() {
  if (!CFG.proxy) return true;            // 云端服务器直连，不需要代理
  let browser;
  try {
    browser = await launch(true);
    const page = await browser.newPage();
    await page.goto('https://jp.mercari.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    return true;
  } catch (e) {
    return false;
  } finally {
    if (browser) await browser.close().catch(() => { });
  }
}

async function grab(hours, scrolls) {
  const browser = await launch(!!CFG.proxy);
  let ua = WIN_UA;
  try {
    const v = await browser.version();
    const m = v.match(/Chrome\/([\d.]+)/);
    // 即使跑在 Linux 服务器上也报 Windows UA，减少被区别对待的可能
    if (m) ua = WIN_UA.replace('131.0.0.0', m[1]);
  } catch (e) { }
  log('浏览器 UA:', ua);

  const bag = new Map();        // 在售
  const soldBag = new Map();    // 已卖出（status=sold_out）
  const errors = [];
  const queries = (CFG.queries || []).filter(q => q.on !== false);
  const cutoff = nowTs() - Math.round(hours * 3600);
  const wantSold = CFG.include_sold !== false;

  for (const q of queries) {
    const label = q.label || q.q;
    const allTime = q.all_time === true;
    const c = allTime ? 0 : cutoff;                                  // 精确词不限上架时间，一路滚到底
    const sc = allTime ? Math.round(CFG.scrolls_all || 10) : scrolls;
    log('---- 搜索:', q.q, allTime ? '(不限上架时间)' : '');

    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      try {
        ok = await searchOne(browser, q, label, bag, c, sc, ua, allTime, 'on_sale', false);
        if (!ok) log('  没拿到接口响应（第 ' + attempt + ' 次）');
      } catch (e) {
        log('  失败（第 ' + attempt + ' 次）:', e.message);
      }
      if (!ok && attempt < 2) { log('  3 秒后重试'); await sleep(3000); }
    }
    if (!ok) errors.push(label + ': 没抓到');

    // 已卖出的一轮：煤炉搜索的 status=sold_out 会返回「取引中 / 完売」的商品，
    // 返回的 updated 就是卖出时间，所以近 2 天卖掉的都能捞回来
    if (wantSold) {
      const sc2 = Math.round(CFG.sold_scrolls || 3);
      let ok2 = false;
      for (let attempt = 1; attempt <= 2 && !ok2; attempt++) {
        try {
          ok2 = await searchOne(browser, q, label, soldBag, c, sc2, ua, allTime, 'sold_out', true);
          if (!ok2) log('  已售没拿到接口响应（第 ' + attempt + ' 次）');
        } catch (e) {
          log('  已售搜索失败:', e.message);
        }
        if (!ok2 && attempt < 2) await sleep(2500);
      }
      // 已售这轮抓失败不算致命，只记一笔，不影响在售结果
      if (!ok2) log('  ⚠ 已售这轮没抓到，本轮跳过已售更新');
    }
    await sleep(1200);
  }

  await browser.close();
  return { bag, soldBag, errors, ua };
}

// ---------------------------------------------------------------- 过滤
function hitRules(name) {
  const n = (name || '').toLowerCase();
  const ban = (CFG.must_not || []).filter(w => w && n.includes(w.toLowerCase()));
  if (ban.length) return false;
  const any = (CFG.must_any || []).filter(w => w && n.includes(w.toLowerCase()));
  return (CFG.must_any || []).length === 0 ? true : any.length > 0;
}

// ---------------------------------------------------------------- 图片
async function downloadImg(url, dest, ua) {
  // 必须带超时：Node 的 fetch 不走系统代理，本机调试时可能连不上而无限等待
  const res = await fetch(url, {
    headers: { 'User-Agent': ua, 'Referer': 'https://jp.mercari.com/' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 200) throw new Error('文件过小');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

const imgExt = u => {
  const m = (u || '').split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i);
  return m ? m[1].toLowerCase() : 'jpg';
};

// 煤炉给的缩略图很小，换成中图再存，页面才不会糊
function midUrl(url) {
  if (!url) return '';
  if (url.indexOf('mercari-shops-static.com') > -1) return url.replace('/-/small/', '/-/medium/');
  const m = url.match(/static\.mercdn\.net\/thumb\/item\/(?:webp|jpg|jpeg|png)\/([^?]+)/);
  if (m) return 'https://static.mercdn.net/c!/w=600,f=webp/thumb/photos/' + m[1];
  return url;
}

// ---------------------------------------------------------------- 推送云端
/* 单次尝试：开一个 push.html，把本批商品 + 本轮统计写进云库 */
async function pushOnce(payload, liveIds, doSync, windowDays) {
  const url = (CFG.cloud && CFG.cloud.push_url) || '';
  const browser = await launch(false);
  try {
    const page = await browser.newPage();
    const logs = [];
    page.on('console', m => logs.push(m.text()));
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction('window.__ready === true', { timeout: 25000 }).catch(() => { });
    if (!await page.evaluate(() => !!window.__ready)) {
      log('push 页面 SDK 未就绪:', logs.slice(-3).join(' | '));
      return false;
    }

    const res = await page.evaluate(async (p, ids, sync, wd) => {
      const r = await window.__push(p);
      if (!r.ok) return r;
      if (!sync) return Object.assign({}, r, { syncSkipped: true });
      const s = await window.__sync({ liveIds: ids, windowDays: wd });
      return Object.assign({}, r, { sync: s });
    }, payload, liveIds || [], !!doSync, windowDays || 2);

    log('云端写入结果:', JSON.stringify(res).slice(0, 320));
    return !!res.ok;
  } catch (e) {
    log('云端推送异常:', e.message);
    return false;
  } finally {
    await browser.close();
  }
}

async function pushCloud(payload, liveIds, doSync, windowDays) {
  const url = (CFG.cloud && CFG.cloud.push_url) || '';
  if (!CFG.cloud || !CFG.cloud.enabled || !url) { log('云端推送未启用，跳过'); return false; }

  /* ⚠️ 平台后端会偶发瞬时失败：10-23 实测 items / run 步骤随机报 `{"ok":false,"error":""}`
     （错误信息是空的，前缀发失败，不是数据问题）。
     以前一次失败就放弃 → mw_runs 少一行 → 页面顶部「最后抓取」卡在旧时间不动。
     现在重试 3 次，每次换一个干净的浏览器上下文重来。 */
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ok = await pushOnce(payload, liveIds, doSync, windowDays);
    if (ok) return true;
    if (attempt < 3) {
      log('⚠ 云端推送第 ' + attempt + ' 次失败，' + (attempt * 4) + ' 秒后重试');
      await sleep(attempt * 4000);
    }
  }
  log('✗ 云端推送连续 3 次失败');
  return false;
}

// ---------------------------------------------------------------- 主流程
(async () => {
  fs.mkdirSync(IMG_DIR, { recursive: true });

  const state = loadState();
  const first = !(state.runs > 0);
  const forcedHours = parseFloat(argOf('hours', '0'));

  // 定时器每 20 分钟醒一次，但只有「距上次成功抓取超过 min_gap_minutes」才真去抓。
  // 好处：某个机房 IP 被煤炉挡了，20 分钟后换个 runner 还能自己重试，
  // 不会一等就是一小时；成功之后后面的几次直接秒退，不浪费额度。
  // ⚠️ 这里不能用 `CFG.min_gap_minutes || 45`：0 在 JS 里是假值，会把「关闭节流」变回 45。
  const minGapVal = CFG.min_gap_minutes;
  const minGap = Math.round(
    (minGapVal === undefined || minGapVal === null || minGapVal === '' ? 45 : Number(minGapVal)) * 60
  );
  const sinceOk = state.last_run ? (nowTs() - state.last_run) : Infinity;
  if (minGap > 0 && !forcedHours && state.runs > 0 && sinceOk < minGap) {
    log('距上次成功抓取 ' + Math.round(sinceOk / 60) + ' 分钟，未到 ' + Math.round(minGap / 60) + ' 分钟间隔，本轮跳过');
    process.exit(0);
  }

  let hours = forcedHours || (first ? (CFG.first_hours || 24) : (CFG.report_hours || 1));
  if (!first && !forcedHours && state.last_run) {
    const gap = (nowTs() - state.last_run) / 3600;
    hours = Math.max(hours, Math.min(gap, 168));
  }
  hours = Math.round(hours * 100) / 100;
  const cutoff = nowTs() - hours * 3600;
  const scrolls = Math.round(hours <= 24 ? (CFG.scrolls || 4) : (CFG.scrolls_big || 8));
  log('时间窗: 近 ' + hours + ' 小时（' + (first ? '首轮' : '常规') + '），滚动 ' + scrolls + ' 次');

  // 0) 代理预检：代理不通就直接报清楚，别让人猜
  log('检查代理：' + (CFG.proxy || '（云端直连，不需要代理）'));
  if (!await preflight()) {
    log('');
    log('✗ 代理连不上：' + CFG.proxy);
    log('  多半是梯子节点断了。请切换一个节点后再跑。');
    log('  排查顺序：1) 梯子客户端是否在运行  2) 换个节点试试  3) 端口是不是 7890');
    process.exit(2);
  }
  log('代理正常');

  // 1) 抓
  const { bag, soldBag, errors, ua } = await grab(hours, scrolls);
  const all = [...bag.values()];
  const allSold = [...soldBag.values()];
  log('原始抓回 ' + all.length + ' 条在售 / ' + allSold.length + ' 条已售');

  // 2) 过滤：按「更新时间」算时间窗 —— 老商品只要最近改过价/描述，一样会进来
  //    block_ids 里的商品直接丢（多艺人套装这类混进来的，按 ID 拉黑最准）
  const blocked = new Set(CFG.block_ids || []);
  // block_sellers：按卖家 ID 整店拉黑（假货店等）。煤炉搜索接口每条形如 sellerId="465709858"
  const blockedSellers = new Set((CFG.block_sellers || []).map(String));
  const hitSeller = it => blockedSellers.size > 0 && blockedSellers.has(String(it.sellerId));
  const bySeller = all.concat(allSold).filter(hitSeller).length;
  if (bySeller) log('拉黑卖家命中 ' + bySeller + ' 条，全部丢弃');
  const keep = it => !blocked.has(it.id) && !hitSeller(it) && hitRules(it.name);
  const matched = all.filter(keep);
  const inWin = matched.filter(it => itemTs(it) >= cutoff);
  inWin.sort((a, b) => itemTs(b) - itemTs(a));
  const oldOnes = inWin.filter(it => (Number(it.created) || 0) < cutoff).length;

  // 已售：同样按 updated（＝卖出时间）算时间窗；已经在售列表里的不重复算
  const matchedSold = allSold.filter(it => keep(it) && !bag.has(it.id));
  const soldIn = matchedSold.filter(it => itemTs(it) >= cutoff);
  soldIn.sort((a, b) => itemTs(b) - itemTs(a));

  log('命中规则 ' + matched.length + ' 条在售，收下 ' + inWin.length + ' 条（其中老商品近期有更新的 ' + oldOnes + ' 条）'
    + '；已售命中 ' + matchedSold.length + ' 条，收下 ' + soldIn.length + ' 条');

  // 3) 下载图片（转存到仓库，供 jsDelivr 分发）
  const repo = process.env.GITHUB_REPOSITORY || CFG.img_repo || '';
  const cdnBase = repo ? 'https://fastly.jsdelivr.net/gh/' + repo + '@main/imgs/' : '';
  const maxImg = Math.round(CFG.imgs_max_per_run || 250);
  // 本机调试时配了代理，而 Node 的 fetch 不走代理，下不了图 —— 交给页面直接取煤炉中图
  const canDownload = !CFG.proxy && CFG.download_imgs !== false;
  let imgOk = 0, imgFail = 0;
  const imgMap = {};

  if (!canDownload) log('跳过图片转存（本机有代理 / config 关了），页面会直接取煤炉中图');

  for (const it of inWin.concat(soldIn).slice(0, maxImg)) {
    // 已经有图（不管什么扩展名）就直接复用，避免重复下载
    let have = null;
    for (const e of ['webp', 'jpg', 'jpeg', 'png', 'gif']) {
      const f = it.id + '.' + e;
      if (fs.existsSync(path.join(IMG_DIR, f))) { have = f; break; }
    }
    if (have) {
      imgMap[it.id] = cdnBase ? cdnBase + have : '';
      continue;
    }
    if (!canDownload) continue;

    const src = midUrl((it.thumbnails && it.thumbnails[0]) ||
      (it.photos && it.photos[0] && it.photos[0].uri) || '');
    if (!src) continue;

    const ext = imgExt(src);
    const fn = it.id + '.' + ext;
    try {
      await downloadImg(src, path.join(IMG_DIR, fn), ua);
      imgOk++;
      imgMap[it.id] = cdnBase ? cdnBase + fn : '';
    } catch (e) {
      imgFail++;
    }
  }
  log('图片: 新下载 ' + imgOk + ' 张，失败 ' + imgFail + ' 张，共 ' + Object.keys(imgMap).length + ' 张有本地图');

  // 4) 组 payload
  /* list_ts = 页面排序用的时间。
     在售商品每轮跟着「更新时间」走；已售商品**故意不传这个字段**，
     让库里保留它卖出前最后一次在售时的值 —— 这样商品卖掉时位置不动，
     不会因为 updated 变成「卖出时刻」而冲到列表最上面（用户 10-22 反馈）。
     push.html 的 __push 会按有没有 list_ts 分两批写，缺字段不会清空已有值。 */
  const toRow = (it, sold) => {
    const row = {
      id: it.id,
      name: (it.name || '').slice(0, 500),
      name_cn: toCn(it.name || ''),
      price_jpy: Number(it.price) || 0,
      created_ts: Number(it.created) || 0,
      updated_ts: itemTs(it),
      cond_id: it.itemConditionId == null ? null : Number(it.itemConditionId),
      thumb_url: (it.thumbnails && it.thumbnails[0]) || '',
      img_url: imgMap[it.id] || '',
      query_label: it._q || '',
      sold: !!sold
    };
    if (!sold) {
      row.list_ts = itemTs(it);
      /* last_seen = 本轮搜到它的时刻，供 push.html 的 __sync 判断已售用。
         之前是「连续 2 轮没搜到就判已售」，容错窗口 = 2 × 抓取间隔，
         间隔改成 10 分钟后就只剩 20 分钟，热门词翻页浮动很容易误标。
         改成按时间算（45 分钟内没再出现才判售），以后再改抓取频率不用动逻辑。 */
      row.last_seen = new Date().toISOString();
    }
    return row;
  };
  const items = inWin.map(it => toRow(it, false)).concat(soldIn.map(it => toRow(it, true)));

  const payload = {
    items,
    run: {
      win_hours: hours,
      fetched: all.length + allSold.length,
      matched: matched.length + matchedSold.length,
      fresh: items.length,
      note: (DRY ? '[dry] ' : '') + (errors.length ? errors.join('; ').slice(0, 300) : null)
    }
  };

  fs.writeFileSync(RAW_PATH, JSON.stringify({ fetched_at: nowTs(), hours, errors, items }, null, 1), 'utf8');

  // 5) 推云端 + 售出状态同步
  // 本轮只要有一个词抓失败，就不做售出判定 —— 免得把「没翻到」的商品误标成已售
  const canSync = errors.length === 0;
  let pushed = false;
  if (!DRY && (items.length || canSync)) {
    pushed = await pushCloud(payload, all.map(x => x.id), canSync, Number(CFG.retain_days) || 2);
  } else if (!DRY) {
    log('本轮抓取有异常，跳过推送与售出判定');
  } else if (!items.length) {
    log('本轮无窗内商品');
  }

  // 6) 清理过期图（按「首次入库时间」算，所以更早上架的老商品也能留住图）
  //    本轮一条没抓到时绝不动图片：那时 inWin 是空的，imgMap 也空，
  //    照常清理会把所有图和状态全删掉（踩过：一次失败就删了 65 张）
  const fetchedOk = all.length > 0 || allSold.length > 0;
  const keepHours = 24 * Math.max(2, Number(CFG.img_keep_days) || 7);
  const keepAfter = nowTs() - keepHours * 3600;
  let removed = 0;
  const hasHistory = Object.keys(state.items || {}).length > 0;
  if (!DRY && hasHistory && fetchedOk) {
    for (const fn of fs.readdirSync(IMG_DIR)) {
      if (fn === '.gitkeep') continue;
      const id = fn.replace(/\.[^.]+$/, '');
      const ts = state.items[id];
      // 只有「明确知道它已经过期」才删。没有记录的（老版本留下的、或状态里漏记的）
      // 一律保留 —— 曾经因为 sold 那批没记进 state，一次就误删了 58 张图，
      // 数据库里 img_url 还指着这些文件，页面直接破图
      if (ts && ts < keepAfter) {
        if (!imgMap[id]) { try { fs.unlinkSync(path.join(IMG_DIR, fn)); removed++; } catch (e) { } }
      }
    }
  } else if (!fetchedOk) {
    log('本轮没抓到数据，跳过图片清理');
  }

  // 7) 更新状态（dry 模式不改，免得影响正式轮次的时间窗）
  if (!DRY) {
    state.runs = (state.runs || 0) + 1;
    /* 抓到数据 ≠ 数据已经落到用户面前。
       云端写库失败时（如 10-22 域名 DNS 失效导致 push.html 打不开），
       如果照常推进 last_run，漏掉的那一段就再也不会被放大补回来。
       所以要求「抓到 + 真的写进云库」才推进；云端推送本身没启用则不拦。 */
    const cloudOn = !!(CFG.cloud && CFG.cloud.enabled && CFG.cloud.push_url);
    const landed = fetchedOk && (pushed || !cloudOn);
    if (landed) {
      state.last_run = nowTs();
    } else if (fetchedOk) {
      log('⚠ 本轮抓到数据但没写进云库 → 不推进 last_run，下次自动放大时间窗补回');
    }
    state.items = state.items || {};
    // 已售商品也要记一笔，否则它们的图下一轮会被当成「无记录」删掉
    for (const it of inWin.concat(soldIn)) {
      // 只记第一次见到的时间，别每轮刷新，否则图片永远清不掉
      if (!state.items[it.id]) state.items[it.id] = nowTs();
    }
    saveState(state);
  }

  log('完成：窗内 ' + items.length + ' 条，推送' + (pushed ? '成功' : '未执行') + '，清理旧图 ' + removed + ' 张');
  if (errors.length) log('异常:', errors.join(' | '));

  // 一条都没抓到：多半是这轮的机房 IP 被煤炉挡了。不标红（否则每次都给你发失败邮件），
  // 只是不推进时间窗，20 分钟后换台机器自动重试，下一轮会把这段补回来
  if (!fetchedOk) {
    log('⚠ 本轮一条都没抓到（多半是这台机器 IP 被煤炉挡了），等下一轮重试');
    process.exit(0);
  }
})().catch(e => {
  console.error('[watch] 致命错误:', e.stack || e.message);
  process.exit(1);
});
