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

// ── 监控词：美区卖家写英文，拼写五花八门；中文/韩文也扫一遍（用户 11-20 指定）──
const KEYWORDS = [
  'zhanghao',
  'zhang hao',
  'hao zhang',
  '장하오',
  '章昊',
];

// 明显不是小卡的词（跟日区一样做一层兜底，避免整本专辑/海报刷屏）
const MUST_NOT = [/\balbum\b/i, /\bposter\b/i, /\bsealed\b/i];

// 标题必须带章昊相关词（美区很多卖家一条一条刷「别人的卡」，
// 搜索会把关键词匹配到描述里的也算进来，不卡标题会被刷屏）
const TITLE_MUST = process.env.US_TITLE_MUST === '0' ? null
  : /zhang\s*hao|zhanghao|jang\s*hao|haohao|hao\s*zhang|章昊|장하오/i;

const MAX_PER_KW = Number(process.env.US_MAX_PER_KW || 260);

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
    if (d.method) events.push(d);
  };
  const ready = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return { ws, send, events, ready };
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
  log(`  ${kw}：${pass.sec}s 过挑战，收 ${bag.size} 条`);
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

async function dingText(text) {
  const hook = process.env.DINGTALK_WEBHOOK;
  const secret = process.env.DINGTALK_SECRET;
  if (!hook) { log('未配置钉钉，跳过推送'); return false; }
  let url = hook;
  if (secret) { const s = dingSign(secret); url += `&timestamp=${s.ts}&sign=${s.sign}`; }
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
  });
  const j = await r.json().catch(() => ({}));
  log('钉钉推送:', r.status, j.errmsg || '');
  return r.ok && (j.errcode === 0);
}

const usd2 = n => '$' + (Number(n) || 0).toFixed(2);
const daiqie = (p, s) => ((Number(p) || 0) + (Number(s) || 0)) * 7.2 + 7;

// ---------------------------------------------------------------- 主流程
(async () => {
  const t0 = nowSec();
  let prev = { items: [], runs: [] };
  try {
    if (fs.existsSync(OUT)) prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (e) { log('旧快照读取失败，按空处理'); }
  const prevMap = new Map((prev.items || []).map(it => [it.id, it]));

  const env = await launch();
  let all = [];
  try {
    const kws = KW_ONLY ? [KW_ONLY] : KEYWORDS;
    for (const kw of kws) {
      const r = await searchOne(env, kw);
      r.items.forEach(it => { it.__kw = kw; all.push(it); });
      await sleep(1200);
    }

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
      if (TITLE_MUST && !TITLE_MUST.test(nm)) { droppedTitle++; return false; }
      if (it.status && !/^(on_sale|trading)$/.test(it.status)) return false;
      return true;
    });
    log(`抓到 ${before} 条，标题不含章昊丢掉 ${droppedTitle} 条，余 ${all.length} 条`);

    // 需要补运费的：新的 + 之前没拿到运费的
    const need = all.filter(it => {
      const p = prevMap.get(it.id);
      return !p || p.ship == null;
    }).map(it => it.id);
    log(`需补运费/卖家 ${need.length} 条`);

    const extra = await enrich(env, need.slice(0, 300));
    env.close();

    // 组装快照（字段名必须与页面一致：price_usd / ship_usd / created_ts / updated_ts）
    const items = [];
    const fresh = [];
    const dropped = [];
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
        ship_usd: ship,
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
      else if (p.price_usd && price < p.price_usd - 0.009) dropped.push(rec);
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
    runs.unshift({ ran_at: new Date(t0 * 1000).toISOString(), win_hours: HOURS, fetched: rawTotal, matched: all.length, fresh: fresh.length, dropped: dropped.length });

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
    log(`快照写出：${items.length} 条（新增 ${fresh.length}，降价 ${dropped.length}）→ ${OUT}`);

    // ── 钉钉：每小时汇总一次 ──
    const hourKey = new Date(t0 * 1000).toISOString().slice(0, 13); // UTC 小时桶
    const dg = snap.digest;
    if (dg.hour !== hourKey) {
      const newList = items.filter(i => i.first_seen >= t0 - 3600 && (i.first_seen === i.last_seen || i.first_seen > (dg.flushed_at || 0)));
      const dropList = dropped.filter(i => i.last_seen > (dg.flushed_at || 0));
      if (newList.length || dropList.length) {
        const lines = [];
        lines.push(`🃏 美区煤炉 · 章昊小卡（${snap.at_cn}）`);
        if (newList.length) {
          lines.push(`\n🆕 上新 ${newList.length} 条`);
          newList.slice(0, 12).forEach(i => {
            lines.push(`· ${i.name.slice(0, 46)}`);
            lines.push(`  ${usd2(i.price_usd)}${i.ship_usd != null ? ' + 运' + usd2(i.ship_usd) : ''} → 代切 ¥${i.daiqie}`);
            lines.push(`  https://www.mercari.com/us/item/${i.id}/`);
          });
          if (newList.length > 12) lines.push(`…还有 ${newList.length - 12} 条`);
        }
        if (dropList.length) {
          lines.push(`\n📉 降价 ${dropList.length} 条`);
          dropList.slice(0, 8).forEach(i => {
            lines.push(`· ${i.name.slice(0, 40)}  ${usd2(i.prev_price_usd)} → ${usd2(i.price_usd)}`);
            lines.push(`  https://www.mercari.com/us/item/${i.id}/`);
          });
        }
        await dingText(lines.join('\n'));
        dg.flushed_at = t0;
      }
      dg.hour = hourKey;
      snap.digest = dg;
      fs.writeFileSync(OUT, JSON.stringify(snap, null, 1));
    }
  } catch (e) {
    log('异常：', e.message);
    try { env.close(); } catch (x) { }
    process.exit(1);
  }
  log('完成，用时', ((nowSec() - t0) / 60).toFixed(1), '分钟');
})();
