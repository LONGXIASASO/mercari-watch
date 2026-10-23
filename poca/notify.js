/**
 * Poca 卡市 · 降价推送到钉钉群机器人
 *
 * 用法：node notify.js [--dry] [--force]
 *   --dry    只打印消息，不真的发送（本地调试用）
 *   --force  忽略「跌破上次推送价」的限制，本轮所有降价都推
 *
 * 环境变量：
 *   DINGTALK_WEBHOOK  机器人 webhook（含 access_token），必须
 *   DINGTALK_SECRET   加签密钥（SEC 开头）；机器人安全设置选的是「自定义关键词」则留空
 *   POCA_SITE         跳转站点，默认线上卡市
 *   POCA_NOTIFY_MAX   一条消息最多列几张卡，默认 8
 *   POCA_AT_MOBILES   要 @ 的手机号，逗号分隔（可选）
 *
 * 推送口径：
 *   只推「降价」，涨价与上新不推。
 *   同一张卡在同一个价位反复波动不重复推 —— 只有当价格「跌破上一次推送时告诉你的价」
 *   才会再推一次，避免一轮一条、一天几十条刷屏。
 *   星标卡（stars.json 里有记录的）单独排在最上面。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const WEBHOOK = (process.env.DINGTALK_WEBHOOK || '').trim();
const SECRET = (process.env.DINGTALK_SECRET || '').trim();
const SITE = (process.env.POCA_SITE || 'https://mercari-card-watch.app.workbuddy.host/poca/?sharecode=L2A6N4ATZQ').trim();
const MAX_LIST = Number(process.env.POCA_NOTIFY_MAX || 8);
const AT_MOBILES = (process.env.POCA_AT_MOBILES || '').split(',').map(s => s.trim()).filter(Boolean);
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

// 人民币换算：与页面默认档位一致（匹配用 0715-韩1、速切用 0715-速切1）
const CNY_M = x => (x + 2000) / 195 + 6;
const CNY_Q = x => x / 196 + 4.5;

const won = n => '₩' + Number(n || 0).toLocaleString('en-US');
const yuan = v => '¥' + (Math.round(v * 100) / 100).toFixed(2);
const pct = (from, to) => {
  const d = (from - to) / from * 100;
  return (d >= 10 ? d.toFixed(0) : d.toFixed(1)) + '%';
};
const pad2 = n => String(n).padStart(2, '0');
const nowCn = () => {
  const d = new Date(Date.now() + 8 * 3600e3);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
};

function readJson(f, dflt) {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8')); } catch (e) { return dflt; }
}

/* ---------------- 钉钉发送 ---------------- */

function signedUrl(webhook, secret) {
  if (!secret) return webhook;
  const ts = Date.now();
  const sign = crypto.createHmac('sha256', secret).update(ts + '\n' + secret).digest('base64');
  return webhook + (webhook.includes('?') ? '&' : '?') + 'timestamp=' + ts + '&sign=' + encodeURIComponent(sign);
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(url);
    const req = https.request({
      host: u.hostname, path: u.pathname + u.search, method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length },
    }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, json: { errmsg: d.slice(0, 200) } }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(buf);
    req.end();
  });
}

/* ---------------- 主流程 ---------------- */

(async () => {
  const data = readJson('data.json', null);
  if (!data || !Array.isArray(data.items)) {
    console.log('⚠️ 没有 data.json，跳过推送');
    return;
  }
  const state = readJson('state.json', {});
  const starsFile = readJson('stars.json', { devices: {} });
  const snap = state.snap || {};
  const pushed = state.pushed || {};

  // 星标集合：stars.json 里每台设备各自一份，这里合成 { id: [设备昵称...] }
  const starMap = {};
  const devices = (starsFile && starsFile.devices) || {};
  Object.keys(devices).forEach(k => {
    const dev = devices[k] || {};
    const nm = dev.name || '未命名设备';
    (dev.ids || []).forEach(id => {
      const key = String(id);
      (starMap[key] = starMap[key] || []).push(nm);
    });
  });
  const nStar = Object.keys(starMap).length;
  if (nStar) console.log(`星标：${Object.keys(devices).length} 台设备，共 ${nStar} 张卡`);

  // 找降价：当前价 < 上次推送价（没有推送记录时退回上一轮快照，让上线后第一轮也有意义）
  const hits = [];
  for (const x of data.items) {
    const id = String(x.id);
    const base = pushed[id] || snap[id] || null;
    if (!base) continue;
    const bm = Number(base[0]) || 0;   // 上次的匹配价
    const bq = Number(base[1]) || 0;   // 上次的速切价
    const rows = [];
    if (x.p > 0 && bm > 0 && (FORCE ? x.p < bm : x.p < bm)) {
      rows.push({ label: '匹配', from: bm, to: x.p, pct: pct(bm, x.p), cny: yuan(CNY_M(x.p)) });
    }
    if (x.q > 0 && bq > 0 && (FORCE ? x.q < bq : x.q < bq)) {
      rows.push({ label: '速切', from: bq, to: x.q, pct: pct(bq, x.q), cny: yuan(CNY_Q(x.q)) });
    }
    if (!rows.length) continue;
    // 跌幅最大的那条拿来排序
    const worst = rows.reduce((a, b) => ((b.from - b.to) / b.from > (a.from - a.to) / a.from ? b : a));
    hits.push({
      id: x.id,
      name: x.n || x.nk || ('#' + x.id),
      kind: x.kind || '',
      rows,
      score: (worst.from - worst.to) / worst.from,
      stars: starMap[id] || null,
    });
  }

  if (!hits.length) {
    console.log(`✅ 本轮没有降价，不推送（已记录基准 ${Object.keys(pushed).length || Object.keys(snap).length} 张）`);
    // 没降价也要把基准补齐，否则下次基准还停在很早以前
    const next = Object.assign({}, pushed);
    for (const x of data.items) if (!next[x.id]) next[x.id] = [x.p, x.q];
    state.pushed = next;
    fs.writeFileSync(path.join(HERE, 'state.json'), JSON.stringify(state), 'utf8');
    return;
  }

  // 排序：星标优先 → 跌幅大优先
  hits.sort((a, b) => (b.stars ? 1 : 0) - (a.stars ? 1 : 0) || b.score - a.score);
  const starred = hits.filter(h => h.stars);
  const others = hits.filter(h => !h.stars);

  /* ---- 拼 markdown ---- */
  const link = id => SITE + (SITE.includes('#') ? '' : '#c=' + id);
  const block = h => {
    const head = `**${h.name}**` + (h.stars ? `　⭐ ${h.stars.join('/')} 星标` : '');
    const lines = h.rows.map(r => `${r.label} ${won(r.from)} → **${won(r.to)}**（↓${r.pct}，约 ${r.cny}）`);
    return `> ${head}\n> ${lines.join('\n> ')}\n> [打开卡市看详情](${link(h.id)})`;
  };

  let md = `### 🃏 卡市降价 · ${nowCn()}\n\n`;
  md += `> 本轮 **${hits.length}** 张降价（监控 ${data.items.length} 张）\n\n`;
  const show = hits.slice(0, MAX_LIST);
  const showStar = show.filter(h => h.stars);
  const showOther = show.filter(h => !h.stars);
  if (showStar.length) md += `**⭐ 星标卡降价 ${showStar.length} 张**\n\n` + showStar.map(block).join('\n\n') + '\n\n';
  if (showOther.length) md += `**其他降价 ${others.length} 张**\n\n` + showOther.map(block).join('\n\n') + '\n\n';
  if (hits.length > show.length) {
    md += `> 还有 **${hits.length - show.length}** 张没列出，打开卡市点「近2日降价」看全部\n> [打开卡市 · 近2日降价](${SITE})\n`;
  }

  console.log('──────── 消息预览 ────────');
  console.log(md);
  console.log('──────────────────────────');

  if (DRY) { console.log('（--dry 模式，未发送）'); return; }
  if (!WEBHOOK) {
    console.log('⚠️ 没配 DINGTALK_WEBHOOK，只打印不发送。把 webhook 配到仓库 Secrets 后即可生效');
    return;
  }

  const payload = {
    msgtype: 'markdown',
    markdown: { title: `卡市降价 ${hits.length} 张 · ${nowCn()}`, text: md },
  };
  if (AT_MOBILES.length) {
    payload.at = { atMobiles: AT_MOBILES, isAtAll: false };
    payload.markdown.text += '\n\n' + AT_MOBILES.map(m => '@' + m).join(' ');
  }

  let r;
  try {
    r = await postJson(signedUrl(WEBHOOK, SECRET), payload);
  } catch (e) {
    console.error('❌ 钉钉请求失败：' + e.message);
    process.exitCode = 0;   // 不影响抓取与发布
    return;
  }
  const code = r.json && r.json.errcode;
  if (r.status === 200 && code === 0) {
    console.log(`✅ 已推送 ${hits.length} 张降价`);
  } else {
    console.error(`❌ 钉钉返回异常：HTTP ${r.status} errcode=${code} ${r.json && r.json.errmsg}`);
    // 常见错误码提示
    const hint = {
      300001: 'access_token 不对，检查 webhook 是否复制完整',
      310000: '加签校验失败：检查 DINGTALK_SECRET，或机器人安全设置里是否勾了「加签」',
      130101: '发送太频繁，钉钉限流（每分钟 20 条）',
    }[code];
    if (hint) console.error('   → ' + hint);
    process.exitCode = 0;
    return;
  }

  // 只更新「真的告诉过她」的那些卡，被截断的下轮还会再推一次
  const next = Object.assign({}, pushed);
  for (const x of data.items) if (!next[x.id]) next[x.id] = [x.p, x.q];
  for (const h of show) {
    const x = data.items.find(i => i.id === h.id);
    if (!x) continue;
    const old = next[h.id] || [0, 0];
    next[h.id] = [
      x.p > 0 && x.p !== old[0] ? x.p : old[0],
      x.q > 0 && x.q !== old[1] ? x.q : old[1],
    ];
  }
  state.pushed = next;
  fs.writeFileSync(path.join(HERE, 'state.json'), JSON.stringify(state), 'utf8');
  console.log(`   已更新推送基准 ${Object.keys(next).length} 张`);
})().catch(e => { console.error('❌ notify 异常：', e.message); process.exitCode = 0; });
