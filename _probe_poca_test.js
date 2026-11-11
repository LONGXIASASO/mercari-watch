// 临时探针：验证 GitHub Actions 机房能否穿过 pocamarket.com 的 Vercel challenge
const puppeteer = require('puppeteer');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const p = await b.newPage();
  await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  await p.setViewport({ width: 1280, height: 900 });

  console.log('== 1) 纯 https 直连（模拟现有 poca.js 的方式）');
  const direct = await p.evaluate(async () => {
    try {
      const r = await fetch('https://pocamarket.com/apis/card/gb/v2/search?q=' + encodeURIComponent('장하오'));
      const t = await r.text();
      return { s: r.status, len: t.length, head: t.slice(0, 120) };
    } catch (e) { return { err: e.message }; }
  });
  console.log('   直连结果:', JSON.stringify(direct));

  console.log('== 2) 打开页面，让 challenge 跑完');
  await p.goto('https://pocamarket.com/zh-cn/search', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(15000);
  console.log('   最终 URL:', p.url());
  console.log('   标题:', await p.title());

  console.log('== 3) 同源 fetch 搜索接口');
  const api = await p.evaluate(async () => {
    const r = await fetch('/apis/card/gb/v2/search?q=' + encodeURIComponent('장하오'), {
      credentials: 'include', headers: { Accept: 'application/json' },
    });
    const t = await r.text();
    let out = { s: r.status, len: t.length };
    if (t.trim().startsWith('{')) {
      const j = JSON.parse(t);
      if (j.data && j.data.results) {
        out.count = j.data.count;
        out.n = j.data.results.length;
        out.first = {
          id: j.data.results[0].id,
          name: j.data.results[0].name_en,
          price: j.data.results[0].price,
          cur: j.data.results[0].display_currency,
        };
      } else out.body = JSON.stringify(j).slice(0, 200);
    } else out.head = t.slice(0, 150);
    return out;
  });
  console.log('   接口结果:', JSON.stringify(api));

  console.log('== 4) 页面渲染出的卡片数');
  const dom = await p.evaluate(() => {
    const t = document.body.innerText || '';
    return { hasUSD: /USD/.test(t), cardText: t.split('\n').filter(l => /USD/.test(l)).slice(0, 3) };
  });
  console.log('   ', JSON.stringify(dom));

  await b.close();
  console.log('== 探针结束');
})().catch(e => { console.error('探针异常:', e.message); process.exit(1); });
