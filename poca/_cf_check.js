/**
 * Cloudflare 中转验证 · 本机跑
 * 用法：node _cf_check.js https://xxx.workers.dev <KEY>
 *
 * 验证四件事：
 *   1. Worker 出口能否拿到韩站路由（/__probe）
 *   2. 搜索接口经中转是否 200 且是完整 JSON
 *   3. 单卡详情接口是否 200
 *   4. 20 并发会不会被站方按速率限（返回 404 空体/1~2 字节）
 */
const https = require('https');
const http2 = require('http2');

const BASE = (process.argv[2] || '').replace(/\/+$/, '');
const KEY = process.argv[3] || '';
if (!BASE) { console.log('用法：node _cf_check.js https://xxx.workers.dev <KEY>'); process.exit(1); }

const hostOf = u => new URL(u).host;
const pathOf = u => { const x = new URL(u); return x.pathname + x.search; };

function get(url, withKey = true, timeout = 25000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = https.request({
      host: hostOf(url), path: pathOf(url), method: 'GET', timeout,
      headers: Object.assign({ 'accept': 'application/json' },
        withKey ? { 'x-poca-key': KEY } : {}),
    }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ s: res.statusCode, d, ms: Date.now() - t0 }));
    });
    req.on('error', e => resolve({ s: 0, d: '', err: String(e.message), ms: Date.now() - t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ s: -1, d: '', err: 'timeout', ms: Date.now() - t0 }); });
    req.end();
  });
}

(async () => {
  console.log('中转：' + BASE + '\n');

  // 1) 自检
  const pr = await get(BASE + '/__probe', false);
  console.log('── 1. 出口自检 ──');
  let probe = null;
  try { probe = JSON.parse(pr.d); } catch (e) {}
  if (!probe) {
    console.log('  ✗ 没拿到 JSON（status ' + pr.s + '）：' + (pr.d || pr.err || '').slice(0, 120));
    process.exit(1);
  }
  console.log('  verdict=' + probe.verdict + '  colo=' + probe.colo + '  country=' + probe.country + '  asn=' + probe.asn);
  for (const t of probe.tests || []) {
    console.log('  ' + (t.status === 200 ? '✅' : '❌') + ' ' + t.path +
      '  status=' + (t.status || t.error) + '  len=' + t.len +
      '  lang=' + (t.lang || '-') + '  cur=' + (t.cur || '-') + '  ' + t.ms + 'ms');
    if (t.status !== 200) console.log('      body: ' + (t.head || ''));
  }
  if (probe.verdict !== 'PASS') {
    console.log('\n❌ 这个出口也不通，方案作废（别浪费时间调下游了）');
    process.exit(2);
  }

  // 2) 搜索
  console.log('\n── 2. 搜索经中转 ──');
  const q = encodeURIComponent('장하오');
  const s1 = await get(BASE + '/card/v3/search?q=' + q);
  let list = [];
  try { list = (JSON.parse(s1.d).data || []).map(x => x.id).filter(Boolean); } catch (e) {}
  console.log('  status=' + s1.s + '  ' + s1.ms + 'ms  bytes=' + s1.d.length + '  ids=' + list.length);
  if (s1.s !== 200 || !list.length) { console.log('  ✗ 搜索不通：' + s1.d.slice(0, 160)); process.exit(3); }

  // 3) 详情
  console.log('\n── 3. 单卡详情经中转 ──');
  for (const id of list.slice(0, 3)) {
    const r = await get(BASE + '/card/v1/' + id);
    let ok = false;
    try { ok = !!(JSON.parse(r.d).data); } catch (e) {}
    console.log('  ' + (ok ? '✅' : '❌') + ' /card/v1/' + id + '  status=' + r.s + '  ' + r.ms + 'ms  bytes=' + r.d.length);
  }

  // 4) 并发压力
  console.log('\n── 4. 20 并发 × 40 个请求（查限速）──');
  const ids = list.slice(0, 40);
  const t0 = Date.now();
  let ok = 0, bad = 0; const bads = [];
  let i = 0;
  await Promise.all(Array.from({ length: 20 }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      const r = await get(BASE + '/card/v1/' + id);
      if (r.s === 200) ok++; else { bad++; bads.push(r.s + '/' + r.d.length); }
    }
  }));
  const dur = (Date.now() - t0) / 1000;
  console.log('  成功 ' + ok + ' / 失败 ' + bad + '  用时 ' + dur.toFixed(1) + 's  ≈ ' + (ok / dur).toFixed(1) + ' req/s');
  if (bads.length) console.log('  失败样本：' + bads.slice(0, 8).join(' '));

  console.log('\n' + (bad === 0 ? '✅ 全通，可以做下一步（改 poca.js + 调频率）' : '⚠️ 有失败，先看是不是限速'));
})();
