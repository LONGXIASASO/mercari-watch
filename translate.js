/**
 * 商品名 日文 → 中文
 * 术语词典优先（比机器翻译准，小卡标题几乎全是固定术语），
 * 词典没覆盖的部分保留原文，不影响阅读。
 */
const fs = require('fs');
const path = require('path');

const DICT = JSON.parse(fs.readFileSync(path.join(__dirname, 'dict_ja_zh.json'), 'utf8'));
const KEYS = Object.keys(DICT)
  .filter(k => !k.startsWith('_') && DICT[k])
  .sort((a, b) => b.length - a.length);   // 长词优先，避免「トレカ」抢了「トレカケース」

function toCn(s) {
  if (!s) return '';
  let out = String(s);
  for (const k of KEYS) {
    if (out.indexOf(k) > -1) out = out.split(k).join(DICT[k]);
  }
  return out.replace(/[ \u3000]+/g, ' ').trim();
}

// 词典覆盖率：命中字符数 / 总字符数（用来判断要不要再走机器翻译兜底）
function coverRate(s) {
  if (!s) return 1;
  let n = 0;
  for (const k of KEYS) {
    let idx = 0;
    while ((idx = s.indexOf(k, idx)) > -1) { n += k.length; idx += k.length; }
  }
  return Math.min(1, n / s.length);
}

module.exports = { toCn, coverRate };
