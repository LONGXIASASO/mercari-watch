/**
 * 传输层诊断矩阵（跑在 GitHub runner 上）
 * 目的：搞清同一个 URL 为什么 curl 200 / node 404，能不能把 node 修好换回快传输。
 * 结论写入日志，continue-on-error，不影响抓取。
 */
const https = require('https');
const http2 = require('http2');

const HOST = 'phocamarket.com';
const P = '/card/v3/search?q=' + encodeURIComponent('장하오');
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const HDR = {
  'User-Agent': UA, Accept: 'application/json',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'POCA-DISPLAY-LANGUAGE': 'ko', Referer: 'https://pocamarket.com/',
};

function h1(extra = {}, ip) {
  return new Promise(res => {
    const o = { host: ip || HOST, path: P, method: 'GET', timeout: 20000, headers: { ...HDR, ...extra } };
    if (ip) { o.servername = HOST; o.headers.Host = HOST; }
    const r = https.request(o, rs => {
      let d = '';
      rs.setEncoding('utf8');
      rs.on('data', c => { d += c; });
      rs.on('end', () => res({ s: rs.statusCode, len: d.length, ip: rs.socket && rs.socket.remoteAddress, head: d.slice(0, 45) }));
    });
    r.on('error', e => res({ s: 0, err: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); res({ s: -1, err: 'timeout' }); });
    r.end();
  });
}

function h2req() {
  return new Promise(res => {
    let c, done = false;
    const fin = o => { if (!done) { done = true; res(o); } };
    try { c = http2.connect('https://' + HOST); } catch (e) { return fin({ s: 0, err: 'connect ' + e.message }); }
    c.on('error', e => fin({ s: 0, err: 'h2 ' + (e.code || e.message) }));
    c.on('connect', () => {
      const rq = c.request({
        ':method': 'GET', ':path': P,
        'user-agent': UA, accept: 'application/json',
        'accept-language': 'ko-KR,ko;q=0.9', 'poca-display-language': 'ko',
        referer: 'https://pocamarket.com/',
      });
      let d = '', st = 0;
      rq.on('response', h => { st = h[':status']; });
      rq.setEncoding('utf8');
      rq.on('data', x => { d += x; });
      rq.on('end', () => { fin({ s: st, len: d.length, alpn: c.alpnProtocol, head: d.slice(0, 45) }); c.close(); });
      rq.on('error', e => fin({ s: 0, err: 'req ' + (e.code || e.message) }));
      rq.end();
    });
  });
}

const show = r => r.s + (r.len !== undefined ? '/' + r.len : '') + (r.alpn ? ' alpn=' + r.alpn : '')
  + (r.ip ? ' @' + r.ip : '') + (r.s !== 200 ? ' [' + (r.head || r.err || '') + ']' : '');

(async () => {
  console.log('node', process.version);
  const cases = [
    ['http1 默认', () => h1()],
    ['http1 family=4', () => h1({}, null)],
    ['http1 Connection:close', () => h1({ Connection: 'close' })],
    ['http1 最小header', () => new Promise(res => {
      const r = https.request({ host: HOST, path: P, method: 'GET', timeout: 20000, headers: { Host: HOST } }, rs => {
        let d = ''; rs.setEncoding('utf8'); rs.on('data', c => { d += c; });
        rs.on('end', () => res({ s: rs.statusCode, len: d.length, ip: rs.socket && rs.socket.remoteAddress, head: d.slice(0, 45) }));
      });
      r.on('error', e => res({ s: 0, err: e.code || e.message })); r.on('timeout', () => { r.destroy(); res({ s: -1, err: 'to' }); }); r.end();
    })],
    ['http1 固定IP 52.79.215.134', () => h1({}, '52.79.215.134')],
    ['http1 固定IP 15.165.183.28', () => h1({}, '15.165.183.28')],
    ['http2 (ALPN h2)', () => h2req()],
  ];
  for (const [name, fn] of cases) {
    const out = [];
    for (let i = 0; i < 2; i++) { out.push(show(await fn())); await new Promise(z => setTimeout(z, 200)); }
    console.log(('  ' + name).padEnd(30), out.join(' | '));
  }
})();
