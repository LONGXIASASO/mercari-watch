/** 临时：验证 GitHub windows runner 上 sharp 能否渲染中文（卡市拼图的价格条要用中文标签） */
const fs = require('fs');
const sharp = require('sharp');

const FONT = 'Microsoft YaHei, PingFang SC, Noto Sans CJK SC, DejaVu Sans, Arial, Helvetica, sans-serif';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

(async () => {
  // 跟 buildSheet 里完全一样的画法：白底矩形 + 两行文字
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="230">
    <rect width="640" height="230" fill="#ffffff"/>
    <text x="20" y="62" font-family="${FONT}" font-size="30" font-weight="bold" fill="#23262d">${esc('匹配 ¥21.38')}</text>
    <text x="20" y="100" font-family="${FONT}" font-size="20" fill="#df3363">${esc('速切 ¥17.19')}</text>
    <text x="20" y="160" font-family="${FONT}" font-size="26" fill="#23262d">${esc('中文测试：星标 / 新上架 / 降价')}</text>
    <text x="20" y="205" font-family="${FONT}" font-size="16" fill="#6b7280">${esc('ABCDEFG abcdefg 0123456789 ₩5,000 ¥42.9')}</text>
  </svg>`;
  const out = '_fonttest.jpg';
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(out);
  console.log('出图成功', fs.statSync(out).size, '字节');

  const TOK = (process.env.GITHUB_TOKEN || '').trim();
  if (!TOK) { console.log('⚠️ 没有 token，只出图不上传'); return; }
  const H = {
    Authorization: 'Bearer ' + TOK, Accept: 'application/vnd.github+json',
    'User-Agent': 'fonttest', 'Content-Type': 'application/json',
  };
  const API = 'https://api.github.com/repos/LONGXIASASO/mercari-watch/contents/poca/notify/_fonttest.jpg';
  let sha;
  const g = await fetch(API + '?ref=main', { headers: H });
  if (g.status === 200) sha = (await g.json()).sha;
  const r = await fetch(API, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ message: 'font test img', content: fs.readFileSync(out).toString('base64'), branch: 'main', ...(sha ? { sha } : {}) }),
  });
  console.log('上传 HTTP', r.status, (await r.text()).slice(0, 120));
})();
