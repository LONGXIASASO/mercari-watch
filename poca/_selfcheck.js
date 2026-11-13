// 出口自检：一出事就能在日志里看清是哪一层坏了。
// 教训（2026-11-12）：之前用 curl 打自检，curl 自己也是 404，把「Node 版本被分流」误判成 IP 被挡。
// 教训（2026-11-13）：结论又反了 —— 站方按**客户端 TLS 指纹**分流：
//   curl（Schannel / libcurl）→ 200，node 内置 http2（OpenSSL）→ 404/39。
//   所以自检必须**先看抓取实际用的那个客户端（curl）**；h2 只作对照打印，它的 404 是预期。
const http2 = require('http2');
const https = require('https');
const { execFile } = require('child_process');

const HOST = 'phocamarket.com';
const SEARCH = '/card/v3/search?q=' + encodeURIComponent('장하오');
const UA_APP = 'PocaMarket/2.7.4 (iPhone; iOS 18.0)';
const UA_WEB = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

// 抓取实际在用的客户端：curl
function viaCurl(ua) {
  return new Promise(res => {
    const args = [
      '-sS', '-m', '25', '--connect-timeout', '15',
      '-H', 'User-Agent: ' + ua,
      '-H', 'Accept: application/json',
      '-H', 'Accept-Language: ko-KR,ko;q=0.9',
      '-H', 'POCA-DISPLAY-LANGUAGE: ko',
      '-H', 'Referer: https://pocamarket.com/',
      '-w', '\n__CODE__%{http_code}',
      'https://' + HOST + SEARCH,
    ];
    execFile('curl', args, { maxBuffer: 24 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      const out = String(stdout || '');
      const m = /__CODE__(\d+)\s*$/.exec(out);
      // ⚠️ 必须 trim：-w 前缀有 \n，不 trim 会比实际多 1 字节（404/39 会显示成 40）
      const body = out.replace(/__CODE__\d+\s*$/, '').trim();
      res({ s: m ? Number(m[1]) : 0, len: Buffer.byteLength(body, 'utf8'), err: err ? (err.code || 'ERR') : '' });
    });
  });
}

// 对照：node 内置 http2（OpenSSL 指纹，预期被 404）
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
  const cApp = await viaCurl(UA_APP);
  const cWeb = await viaCurl(UA_WEB);
  const hApp = await h2(SEARCH, UA_APP);
  console.log(`node ${process.version} | ${process.platform}/${process.arch} | 出口 IP ${ip}`);
  console.log(`curl + App UA    ${cApp.s} ${cApp.len} 字节  ${cApp.s === 200 ? '✅' : '❌' + (cApp.err ? ' (' + cApp.err + ')' : '')}`);
  console.log(`curl + 网页 UA   ${cWeb.s} ${cWeb.len} 字节  ${cWeb.s === 404 ? '✅（预期，接口只给 App 用）' : cWeb.s === 200 ? '⚠️ 也 200' : '⚠️ ' + cWeb.s}`);
  console.log(`node h2 + App UA ${hApp.s} ${hApp.len} 字节  ${hApp.s === 200 ? '✅' : 'ℹ️ 404 是预期（指纹被拦），抓取已不用 h2'}`);
  console.log('===== 判读 =====');
  if (cApp.s === 200) {
    console.log('✅ 通路正常：curl 能拿到数据，与抓取用的客户端一致');
  } else if (cApp.s === 404 && cApp.len <= 60) {
    console.log('ℹ️ 直连 404/39 NOT_FOUND：本轮走的是 runner 的 Azure 出口，被站方地区分流（预期）。');
    console.log('   真正的通路看预检的三级探测结果，不要只看这一段。');
  } else if (cApp.s === 404) {
    console.log(`⚠️ 404 但响应 ${cApp.len} 字节，形态不像 NOT_FOUND，可能是限速/网关错误（等几分钟再看）`);
  } else if (cApp.s === 0) {
    console.log('❌ curl 连不上（DNS/TLS/超时），查出口网络；err=' + (cApp.err || '-'));
  } else {
    console.log(`⚠️ 非预期状态码 ${cApp.s}，响应 ${cApp.len} 字节`);
  }
})();
