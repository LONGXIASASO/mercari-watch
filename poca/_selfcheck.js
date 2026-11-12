// 出口自检：一出事就能在日志里看清是哪一层坏了。
// 教训（2026-11-12）：之前用 curl 打自检，curl 自己也是 404，把「Node 版本被分流」误判成 IP 被挡。
// 所以自检必须**用和抓取完全相同的客户端（node）**，只切变量（UA）。
const http2 = require('http2');
const https = require('https');

const HOST = 'phocamarket.com';
const SEARCH = '/card/v3/search?q=' + encodeURIComponent('장하오');
const UA_APP = 'PocaMarket/2.7.4 (iPhone; iOS 18.0)';
const UA_WEB = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

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

function egressIp() {
  return new Promise(res => {
    https.get('https://api.ipify.org', { timeout: 12000 }, r => {
      let d = ''; r.setEncoding('utf8');
      r.on('data', c => { d += c; });
      r.on('end', () => res(d.trim()));
    }).on('error', () => res('?'));
  });
}

(async () => {
  const ip = await egressIp();
  const a = await h2(SEARCH, UA_APP);
  const b = await h2(SEARCH, UA_WEB);
  console.log('node ' + process.version + ' | 出口 IP ' + ip + ' | TLS ' + process.versions.openssl);
  console.log(`App UA  ${a.s} ${a.len}   ${a.s === 200 ? '✅' : '❌'}`);
  console.log(`网 UA   ${b.s} ${b.len}   ${b.s === 404 ? '✅（正常，本来就是给 App 用的）' : '⚠️'}`);
  console.log('===== 判读 =====');
  if (a.s === 200) {
    console.log('✅ 通路正常，应用 UA 能拿到数据');
  } else if (a.s === 404 && a.len === 39) {
    console.log('❌ 404/39 NOT_FOUND = 被分流到「没有该路由」的后端。按 2026-11-12 的结论，');
    console.log('   先查 Node 主版本（20 会被 404、22 正常），再查 UA，最后才怀疑 IP。');
  } else if (a.s === 404 && a.len <= 2) {
    console.log('⚠️ 404 空体 = 大概率被按速率限速，等几分钟再试');
  } else if (a.s === 0) {
    console.log('❌ 连不上（DNS/TLS/超时），查出口网络');
  }
})();
