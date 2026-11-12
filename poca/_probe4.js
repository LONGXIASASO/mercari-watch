// probe4：搞清 runner 上「App UA 也 404」到底是 UA 还是 IP/并发被拦。
// 关键动作：①冷启动单发 ②打印响应头看是谁在回 ③连发 20 个看是否触发拦截 ④退避后再打一次
const http2 = require('http2');
const https = require('https');

const UA_APP = 'PocaMarket/2.7.4 (iPhone; iOS 18.0)';
const UA_WEB = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const P = '/card/v3/search?q=' + encodeURIComponent('장하오');
const HOST = 'phocamarket.com';

function h2get(path, ua, extra = {}) {
  return new Promise(res => {
    let c;
    try { c = http2.connect('https://' + HOST, { timeout: 15000 }); } catch (e) { return res({ s: 0, len: 0, h: {}, d: '' }); }
    let st = 0, d = '', hd = {};
    c.on('error', () => res({ s: 0, len: 0, h: {}, d: '' }));
    const rq = c.request({
      ':method': 'GET', ':path': path,
      'user-agent': ua, accept: 'application/json',
      'accept-language': 'ko-KR,ko;q=0.9', 'poca-display-language': 'ko',
      referer: 'https://pocamarket.com/', ...extra,
    });
    rq.on('response', h => { st = h[':status']; hd = h; });
    rq.setEncoding('utf8');
    rq.on('data', x => { d += x; });
    rq.on('end', () => { try { c.close(); } catch (e) {} res({ s: st, len: d.length, h: hd, d }); });
    rq.on('error', () => { try { c.destroy(); } catch (e) {} res({ s: 0, len: 0, h: {}, d: '' }); });
    rq.end();
  });
}

function h1get(path, ua) {
  return new Promise(res => {
    const r = https.request({ host: HOST, path, method: 'GET', timeout: 15000, headers: { 'User-Agent': ua, Accept: 'application/json' } }, s => {
      let d = '';
      s.setEncoding('utf8');
      s.on('data', c => { d += c; });
      s.on('end', () => res({ s: s.statusCode, len: d.length, h: s.headers, d }));
    });
    r.on('error', () => res({ s: 0, len: 0, h: {}, d: '' }));
    r.on('timeout', () => { r.destroy(); res({ s: -1, len: 0, h: {}, d: '' }); });
    r.end();
  });
}

const show = (tag, x) => {
  const h = x.h || {};
  const keys = ['server', 'date', 'content-type', 'x-cache', 'via', 'x-vercel-id', 'cf-ray', 'x-served-by', 'x-amz-cf-id', 'content-length'];
  const pick = keys.filter(k => h[k] !== undefined).map(k => k + '=' + h[k]).join(' ');
  console.log(`${x.s === 200 ? '✅' : '  '} ${tag.padEnd(24)} ${String(x.s).padStart(4)} ${String(x.len).padStart(6)} | ${pick}`);
};

(async () => {
  console.log('--- ① 冷启动单发 ---');
  const a = await h2get(P, UA_APP); show('h2 appUA', a);
  if (a.s !== 200) console.log('      body:', String(a.d).slice(0, 80));
  const b = await h2get(P, UA_WEB); show('h2 webUA', b);

  console.log('--- ② 两种 Accept ---');
  show('appUA accept=*/*', await h2get(P, UA_APP, { accept: '*/*' }));
  show('appUA 长 Accept', await h2get(P, UA_APP, { accept: 'application/json, text/plain, */*' }));

  console.log('--- ③ 连发 20 个（看是否并发触发拦截）---');
  const burst = await Promise.all(Array.from({ length: 20 }, () => h2get(P, UA_APP)));
  const tally = {};
  burst.forEach(x => { tally[x.s] = (tally[x.s] || 0) + 1; });
  console.log('     结果分布:', JSON.stringify(tally));
  show('burst 后 h1 appUA', await h1get(P, UA_APP));

  console.log('--- ④ 退避 45s 后再打 ---');
  await new Promise(z => setTimeout(z, 45000));
  show('h2 appUA (45s后)', await h2get(P, UA_APP));
  show('h1 appUA (45s后)', await h1get(P, UA_APP));
  console.log('--- 结束 ---');
})();
