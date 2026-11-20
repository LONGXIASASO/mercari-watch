/**
 * 美区煤炉探测（在 GitHub Actions 上跑）
 * 目的：确认「订阅的美国节点 + 真 Chrome（无自动化开关）+ CDP」能不能过 Cloudflare 并拿到商品
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROXY = String(process.env.US_PROXY || '').trim();
const PORT = Number(process.env.US_CDP_PORT || 9333);
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const KW = process.env.US_KW || 'zhanghao';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[probe]', ...a);

(async () => {
  log('代理:', PROXY || '(直连)', '| Chrome:', CHROME);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'us-chrome-'));
  const args = [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-dev-shm-usage', '--lang=en-US', '--window-size=1366,900',
  ];
  if (PROXY) args.push(`--proxy-server=${PROXY}`);
  args.push('about:blank');

  const child = spawn(CHROME, args, { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      ver = await r.json(); break;
    } catch (e) { }
  }
  if (!ver) { log('❌ 调试端口未就绪'); child.kill(); process.exit(1); }
  log('浏览器:', ver.Browser);

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const events = [];
  const send = (m, p = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = ev => {
    const d = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); return; }
    if (d.method) events.push(d);
  };
  const evalJs = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : null; };

  await send('Network.enable', { maxPostDataSize: 262144 });
  await send('Page.enable');

  const url = `https://www.mercari.com/search/?keyword=${encodeURIComponent(KW)}&sortBy=2`;
  log('打开:', url);
  await send('Page.navigate', { url });

  let passed = false, lastTitle = '';
  for (let t = 2; t <= 100; t += 2) {
    await sleep(2000);
    const s = await evalJs(`JSON.stringify({t:document.title.replace(/"/g,''),w:navigator.webdriver,n:document.querySelectorAll('[data-productid]').length})`);
    if (!s) continue;
    const o = JSON.parse(s);
    if (o.t !== lastTitle) { log(`[${t}s] webdriver=${o.w} cards=${o.n} title="${o.t.slice(0, 60)}"`); lastTitle = o.t; }
    if (!/moment|just a/i.test(o.t) && (o.n > 0 || /^Shop /i.test(o.t))) { passed = true; log(`[${t}s] ✅ 通过`); }
    if (passed && o.n > 0) { log(`[${t}s] 卡片已渲染 ${o.n} 个`); break; }
  }

  if (!passed) {
    fs.writeFileSync('/tmp/us_probe_result.json', JSON.stringify({ passed: false, title: lastTitle }, null, 1));
    log('❌ 未过挑战');
    ws.close(); child.kill(); process.exit(1);
  }

  // 等商品真正渲染出来
  for (let i = 0; i < 15; i++) {
    const n = await evalJs(`document.querySelectorAll('[data-productid]').length`);
    if (n > 0) { log('卡片数:', n); break; }
    await sleep(2000);
  }
  for (let i = 0; i < 2; i++) { await evalJs('window.scrollTo(0,document.body.scrollHeight);1'); await sleep(2200); }

  // 先看看这一轮到底打了哪些 api
  const apiCalls = events.filter(e => e.method === 'Network.responseReceived' && /\/v1\/api/.test(e.params.response.url))
    .map(e => e.params.response.url.replace('https://www.mercari.com/v1/api', '').slice(0, 120));
  log('API 调用种类:', [...new Set(apiCalls)].join(' | ') || '(无)');

  const bodies = events.filter(e => e.method === 'Network.responseReceived' && /searchFacetQuery|searchQuery/.test(e.params.response.url));
  let items = [];
  for (const b of bodies) {
    try {
      const r = await send('Network.getResponseBody', { requestId: b.params.requestId });
      const j = JSON.parse(r.body);
      const s = j && j.data && j.data.search;
      if (s && Array.isArray(s.itemsList)) items = items.concat(s.itemsList);
    } catch (e) { }
  }

  // 兜底：接口没抓到就直接读 DOM
  if (!items.length) {
    log('接口没抓到，改读 DOM');
    const dom = await evalJs(`JSON.stringify([...document.querySelectorAll('[data-productid]')].slice(0,12).map(el=>{
      const a=el.closest('a')||el; 
      return {id:el.getAttribute('data-productid'), href:a.getAttribute('href')||'', text:(el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,120)};
    }))`);
    log('DOM 抽样:', dom);
  }

  log('商品条数:', items.length);
  items.slice(0, 8).forEach(it => log(' ', it.id, '|', '$' + (it.price / 100).toFixed(2), '|', (it.name || '').slice(0, 50)));

  fs.writeFileSync('/tmp/us_probe_result.json', JSON.stringify({
    passed: true, n: items.length,
    sample: items.slice(0, 12).map(i => ({ id: i.id, name: i.name, price: i.price, created: i.created })),
  }, null, 1));

  ws.close(); child.kill();
})();
