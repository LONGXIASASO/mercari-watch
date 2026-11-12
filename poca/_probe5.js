// probe5：确认「App UA 也 404」是不是跟出口 IP 有关。
// 每次运行打印出口 IP + App UA / 浏览器 UA 各一次，连跑几次就能看出 IP 与成败的相关性。
const http2 = require('http2');
const https = require('https');

const UA_APP = 'PocaMarket/2.7.4 (iPhone; iOS 18.0)';
const UA_WEB = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const P = '/card/v3/search?q=' + encodeURIComponent('장하오');
const HOST = 'phocamarket.com';

function ip() {
  return new Promise(res => {
    https.get('https://api.ipify.org', { timeout: 12000 }, r => {
      let d = ''; r.setEncoding('utf8');
      r.on('data', c => { d += c; });
      r.on('end', () => res(d.trim()));
    }).on('error', () => res('?'));
  });
}

function h2get(path, ua) {
  return new Promise(res => {
    let c;
    try { c = http2.connect('https://' + HOST, { timeout: 15000 }); } catch (e) { return res({ s: 0, len: 0 }); }
    let st = 0, d = '';
    c.on('error', () => res({ s: 0, len: 0 }));
    const rq = c.request({
      ':method': 'GET', ':path': path,
      'user-agent': ua, accept: 'application/json',
      'accept-language': 'ko-KR,ko;q=0.9', 'poca-display-language': 'ko',
      referer: 'https://pocamarket.com/',
    });
    rq.on('response', h => { st = h[':status']; });
    rq.setEncoding('utf8');
    rq.on('data', x => { d += x; });
    rq.on('end', () => { try { c.close(); } catch (e) {} res({ s: st, len: d.length }); });
    rq.on('error', () => { try { c.destroy(); } catch (e) {} res({ s: 0, len: 0 }); });
    rq.end();
  });
}

(async () => {
  const egress = await ip();
  const a = await h2get(P, UA_APP);
  const b = await h2get(P, UA_WEB);
  const tag = a.s === 200 ? 'GOOD' : 'BAD ';
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${tag} ip=${egress.padEnd(16)} appUA=${a.s}/${a.len}  webUA=${b.s}/${b.len}`);
  // 再来一组，确认同 IP 内是否稳定
  const a2 = await h2get(P, UA_APP);
  console.log(`              复测 appUA=${a2.s}/${a2.len}  → ${a2.s === a.s ? '同 IP 内一致' : '同 IP 内不一致（上游多套）'}`);
})();
