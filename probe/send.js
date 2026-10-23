/**
 * 探针：把 md.txt 原样发到钉钉群，只用来验证渲染效果 / 排查 errcode
 * 用法：node probe/send.js [文件]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WEBHOOK = (process.env.DINGTALK_WEBHOOK || '').trim();
const SECRET = (process.env.DINGTALK_SECRET || '').trim();
const file = process.argv[2] || path.join(__dirname, 'md.txt');
const raw = fs.readFileSync(file, 'utf8');
const parts = raw.split('---SEG---').map(x => x.trim()).filter(Boolean);

const signedUrl = () => {
  if (!SECRET) return WEBHOOK;
  const ts = Date.now();
  const sign = crypto.createHmac('sha256', SECRET).update(ts + '\n' + SECRET).digest('base64');
  return WEBHOOK + (WEBHOOK.includes('?') ? '&' : '?') + 'timestamp=' + ts + '&sign=' + encodeURIComponent(sign);
};

(async () => {
  for (let i = 0; i < parts.length; i++) {
    const md = parts[i];
    const title = (md.match(/^###\s+(.*)$/m) || [, '钉钉测试'])[1].replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '');
    const body = { msgtype: 'markdown', markdown: { title, text: md } };
    console.log('第 ' + (i + 1) + '/' + parts.length + ' 条：' + Buffer.byteLength(md) + ' 字节 | ' + md.split('\n').length + ' 行');
    // 跟 notify.js 一样重试 3 次：钉钉 -1 大多是偶发，不重试会误判成「格式有问题」
    let ok = false;
    for (let t = 0; t < 3 && !ok; t++) {
      const r = await fetch(signedUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
      });
      const txt = await r.text();
      let code = -999;
      try { code = JSON.parse(txt).errcode; } catch (e) {}
      console.log('   试 ' + (t + 1) + ' → ' + r.status + ' ' + txt);
      ok = r.status === 200 && code === 0;
      if (!ok) await new Promise(z => setTimeout(z, 3000 * (t + 1)));
    }
    if (!ok) process.exitCode = 1;
    if (i < parts.length - 1) await new Promise(z => setTimeout(z, 3000));
  }
})();
