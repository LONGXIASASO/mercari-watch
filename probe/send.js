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
const md = fs.readFileSync(file, 'utf8');

const signedUrl = () => {
  if (!SECRET) return WEBHOOK;
  const ts = Date.now();
  const sign = crypto.createHmac('sha256', SECRET).update(ts + '\n' + SECRET).digest('base64');
  return WEBHOOK + (WEBHOOK.includes('?') ? '&' : '?') + 'timestamp=' + ts + '&sign=' + encodeURIComponent(sign);
};

(async () => {
  const title = (md.match(/^###\s+(.*)$/m) || [, '钉钉测试'])[1].replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '');
  const body = { msgtype: 'markdown', markdown: { title, text: md } };
  console.log('消息', Buffer.byteLength(md), '字节 |', md.split('\n').length, '行');
  const r = await fetch(signedUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  console.log('钉钉返回', r.status, txt);
  try {
    const j = JSON.parse(txt);
    process.exitCode = j.errcode === 0 ? 0 : 1;
  } catch (e) { process.exitCode = 1; }
})();
