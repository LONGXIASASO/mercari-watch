// 临时探针 v2：验证 GitHub Actions 机房能否直连 api.pocamarket.com 的新接口
const https = require('https');
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

function get(host, path) {
  return new Promise(resolve => {
    const req = https.request({ host, path, method: 'GET', timeout: 25000, headers: {
      'User-Agent': UA, Accept: 'application/json',
      'Accept-Language': 'ko-KR,ko;q=0.9', 'POCA-DISPLAY-LANGUAGE': 'ko',
      Referer: 'https://pocamarket.com/',
    } }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ s: res.statusCode, d, h: res.headers }));
    });
    req.on('error', e => resolve({ s: 0, d: '', err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ s: -1, d: '', err: 'timeout' }); });
    req.end();
  });
}

(async () => {
  const q = encodeURIComponent('장하오');
  console.log('== 1) 搜索首页');
  const r1 = await get('api.pocamarket.com', '/card/gb/v2/search?q=' + q);
  console.log('   status=' + r1.s + ' len=' + r1.d.length + (r1.err ? ' err=' + r1.err : ''));
  if (r1.s === 200 && r1.d.trim().startsWith('{')) {
    const j = JSON.parse(r1.d);
    const d = j.data;
    console.log('   count=' + d.count + ' next_page=' + d.next_page + ' n=' + d.results.length);
    console.log('   首条: id=' + d.results[0].id + ' price=' + d.results[0].price
      + ' cur=' + d.results[0].display_currency + ' localized=' + d.results[0].discounted_price_localized);
    console.log('   字段: ' + Object.keys(d.results[0]).join(', '));
  } else {
    console.log('   返回: ' + r1.d.slice(0, 200).replace(/\s+/g, ' '));
  }

  console.log('== 2) 第 3 页');
  const r2 = await get('api.pocamarket.com', '/card/gb/v2/search?q=' + q + '&page=3');
  if (r2.s === 200) {
    const j = JSON.parse(r2.d);
    console.log('   count=' + j.data.count + ' next=' + j.data.next_page + ' 首条id=' + j.data.results[0].id);
  } else console.log('   status=' + r2.s);

  console.log('== 3) 单卡详情');
  const r3 = await get('api.pocamarket.com', '/card/gb/v2/520290');
  if (r3.s === 200) {
    const res = JSON.parse(r3.d).data.result;
    console.log('   ' + res.id + ' | ' + res.name + ' | stock=' + res.stock + ' wish=' + res.wish_count
      + ' price=' + JSON.stringify(res.price));
  } else console.log('   status=' + r3.s);

  console.log('== 4) 抓 5 页耗时测试');
  const t0 = Date.now();
  let ok = 0;
  for (let pg = 1; pg <= 5; pg++) {
    const r = await get('api.pocamarket.com', '/card/gb/v2/search?q=' + q + '&page=' + pg);
    if (r.s === 200) ok++;
    await new Promise(r2 => setTimeout(r2, 300));
  }
  console.log('   5 页成功 ' + ok + ' / 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  console.log('== 探针 v2 结束');
})().catch(e => { console.error('探针异常:', e.message); process.exit(1); });
