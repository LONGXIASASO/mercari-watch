// 在 GitHub runner 上跑的探测矩阵：韩站接口到底还在不在、搬去哪了。
// 本地走代理且被降级成 HTTP/1.1，测不出真相，所以只能在 runner 上打。
const https = require('https');
const http2 = require('http2');

const UA_BROWSER = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const UA_APP = 'PocaMarket/2.7.4 (iPhone; iOS 18.0)';
const Q = encodeURIComponent('장하오');

const HOSTS = ['phocamarket.com', 'api.phocamarket.com', 'api.pocamarket.com', 'pocamarket.com'];
const PATHS = [
  '/',
  '/card/v3/search?q=' + Q,
  '/card/gb/v2/search?q=' + Q,
  '/card/kr/v2/search?q=' + Q,
  '/card/v2/search?q=' + Q,
  '/card/v1/522924',
];

function headers(ua) {
  return {
    'User-Agent': ua,
    Accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'POCA-DISPLAY-LANGUAGE': 'ko',
    Referer: 'https://pocamarket.com/',
  };
}

function viaHttp1(host, path, ua) {
  return new Promise(res => {
    const r = https.request({ host, path, method: 'GET', timeout: 15000, headers: headers(ua) }, s => {
      let d = '';
      s.setEncoding('utf8');
      s.on('data', c => { d += c; });
      s.on('end', () => res({ s: s.statusCode, len: d.length, d }));
    });
    r.on('error', e => res({ s: 0, len: 0, d: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); res({ s: -1, len: 0, d: 'timeout' }); });
    r.end();
  });
}

function viaHttp2(host, path, ua) {
  return new Promise(res => {
    let done = false;
    const fin = v => { if (!done) { done = true; res(v); } };
    let c;
    try { c = http2.connect('https://' + host, { timeout: 15000 }); } catch (e) { return fin({ s: 0, len: 0, d: 'connect-fail' }); }
    c.on('error', e => { fin({ s: 0, len: 0, d: e.code || e.message }); try { c.destroy(); } catch (x) {} });
    const req = c.request({ ':path': path, ':method': 'GET', ...headers(ua) });
    let st = 0, d = '';
    req.setEncoding('utf8');
    req.on('response', h => { st = h[':status']; });
    req.on('data', x => { d += x; });
    req.on('end', () => { fin({ s: st, len: d.length, d }); try { c.close(); } catch (x) {} });
    req.on('error', e => { fin({ s: 0, len: 0, d: e.code || e.message }); try { c.destroy(); } catch (x) {} });
    req.end();
  });
}

const brief = d => String(d || '').replace(/\s+/g, ' ').slice(0, 56);

(async () => {
  console.log('================ 探测矩阵 ================');
  for (const host of HOSTS) {
    console.log('\n### ' + host);
    for (const path of PATHS) {
      for (const [tag, fn] of [['h1br', viaHttp1], ['h2br', viaHttp2]]) {
        const x = await fn(host, path, UA_BROWSER);
        const ok = x.s === 200 && x.len > 300 ? '✅' : '  ';
        console.log(`${ok} ${tag} ${path.slice(0, 34).padEnd(36)} ${String(x.s).padStart(4)} ${String(x.len).padStart(6)} | ${brief(x.d)}`);
        await new Promise(z => setTimeout(z, 130));
      }
    }
  }

  console.log('\n================ 只看 app UA 的两条主路径 ================');
  for (const host of ['phocamarket.com', 'api.phocamarket.com', 'api.pocamarket.com']) {
    for (const path of ['/card/v3/search?q=' + Q, '/card/gb/v2/search?q=' + Q]) {
      for (const [tag, fn] of [['h1', viaHttp1], ['h2', viaHttp2]]) {
        const x = await fn(host, path, UA_APP);
        console.log(`${x.s === 200 && x.len > 300 ? '✅' : '  '} app-${tag} ${(host + path).slice(0, 52).padEnd(54)} ${x.s} ${x.len} | ${brief(x.d)}`);
        await new Promise(z => setTimeout(z, 130));
      }
    }
  }
  console.log('\n探测结束');
})();
