// probe6：怀疑「自检打了 / 首页」会把这个 IP 打进 404 上游（同一出口 IP 之后全 404）。
// 顺序：①搜索（应 200）②打 / 首页（必 404）③再搜索（看是否变 404）④等 20s 再搜索
const http2 = require('http2');
const UA_APP = 'PocaMarket/2.7.4 (iPhone; iOS 18.0)';
const UA_WEB = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const HOST = 'phocamarket.com';
const SEARCH = '/card/v3/search?q=' + encodeURIComponent('장하오');

function h2(path, ua) {
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

const p = (tag, x) => console.log(`${x.s === 200 ? '✅' : '  '} ${tag.padEnd(30)} ${x.s} ${x.len}`);

(async () => {
  p('① 搜索 appUA（基线）', await h2(SEARCH, UA_APP));
  p('② 首页 appUA（预期 404）', await h2('/', UA_APP));
  p('③ 搜索 appUA（打首页后）', await h2(SEARCH, UA_APP));
  p('④ 搜索 webUA（预期 404）', await h2(SEARCH, UA_WEB));
  p('⑤ 搜索 appUA（打 webUA 后）', await h2(SEARCH, UA_APP));
  await new Promise(z => setTimeout(z, 20000));
  p('⑥ 搜索 appUA（等 20s）', await h2(SEARCH, UA_APP));
})();
