/**
 * 卡市异常告警 —— 只在「数据真的停下来了」的时候发一条钉钉，不按每轮成败发。
 *
 * 为什么按「停更多久」而不是「本轮成没成功」：
 *   站方限速通常几分钟就自愈，按轮次告会每 10 分钟一条，纯噪音。
 *   但只要停更超过 40 分钟，就是真问题了，必须让你知道。
 *
 * 节流（每 10 分钟一轮，窗口取 6 分钟，正常情况下只命中 1 轮）：
 *   age < 40              → 不发
 *   age 40 ~ 45           → 发第一条
 *   age ≥ 60 且 age%60 < 6 → 每满一小时再提醒一次
 *   其余                   → 不发
 *
 * 环境变量（由 workflow 注入）：
 *   DINGTALK_WEBHOOK / DINGTALK_SECRET / POCA_AT_MOBILES
 *   GATE_OK      预检是否通过（'1' / '0'）
 *   GATE_REASON  预检失败原因：RATE_LIMIT / REGION / AUTH / NETWORK / UPSTREAM_5XX / BATCH / UNKNOWN
 *   GATE_DETAIL  预检细节：HTTP 码 · 体长 · 站方判定站点
 *   GATE_URGENT  '1' = 我们自己的代码坏了，不等阈值立即发
 *   JOB_STATUS   job.status；failure 且预检通过 = 抓取中途挂了
 *   SKIP         '1' = 本轮被 --min-gap 节流跳过（要配合 GATE_OK=='1' 才是正常节流）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const HERE = __dirname;
const WEBHOOK = (process.env.DINGTALK_WEBHOOK || '').trim();
const SECRET = (process.env.DINGTALK_SECRET || '').trim();
const AT = (process.env.POCA_AT_MOBILES || '').split(/[,\s]+/).filter(Boolean);
const GATE_OK = (process.env.GATE_OK || '').trim();
const REASON = (process.env.GATE_REASON || '').trim();
const DETAIL = (process.env.GATE_DETAIL || '').trim();
const URGENT = process.env.GATE_URGENT === '1';
const JOB = (process.env.JOB_STATUS || '').trim();

const AFTER = 40;      // 停更超过这个分钟数才吵
const FIRST_END = 46;  // 第一条的窗口右边界
const REPEAT_WIN = 6;  // 之后每满 60 分钟，开头这个窗口内再吵一次

const readJson = f => {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8')); } catch (e) { return null; }
};

const cnTime = v => {
  const t = typeof v === 'number' ? v : new Date(v).getTime();
  if (!t || isNaN(t)) return String(v || '?');
  return new Date(t + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
};

/* ---------------- 判断要不要发 ---------------- */

const fresh = readJson('data.json');
const prev = readJson('data.prev.json');
const SKIP = (process.env.SKIP || '').trim();

// 本轮成功落了新数据 → 后面涨跌推送会照顾到，这里不吵
if (GATE_OK === '1' && fresh && Array.isArray(fresh.items) && fresh.items.length) {
  console.log(`✅ 本轮成功（${fresh.items.length} 张，更新于 ${fresh.at_cn || cnTime(fresh.at)}），不告警`);
  process.exit(0);
}

// ⚠️ 节流跳过（cron-job.org 和 GitHub cron 撞在一起，距上次成功不足 5 分钟）是**正常现象**，
//    不是异常。预检失败时也会置 SKIP=1，所以必须同时看 GATE_OK=='1' 才能区分。
if (GATE_OK === '1' && SKIP === '1') {
  console.log('⏭ 本轮被 --min-gap 节流跳过（距上次成功不足阈值分钟），属于正常现象，不告警');
  process.exit(0);
}

// 预检没通过用预检的原因；预检通了但 job 挂了 = 抓取中途被拦
let reason = REASON;
if (!reason) reason = (JOB === 'failure') ? 'FETCH_FAIL' : 'UNKNOWN';

let ageMin = null, lastAt = '';
if (prev && prev.at) {
  const t = new Date(prev.at).getTime();
  if (!isNaN(t)) { ageMin = (Date.now() - t) / 60000; lastAt = cnTime(prev.at); }
}

console.log(`本轮未产出新数据｜原因 ${reason}${DETAIL ? '（' + DETAIL + '）' : ''}｜上次成功 ${lastAt || '未知'}｜已停更 ${ageMin === null ? '未知' : Math.round(ageMin) + ' 分钟'}`);

if (!URGENT) {
  if (ageMin === null) {
    console.log('没有上一轮记录可算停更时长，本轮不告警');
    process.exit(0);
  }
  const fire = ageMin >= AFTER && (ageMin < 60 ? ageMin < FIRST_END : (ageMin % 60) < REPEAT_WIN);
  if (!fire) {
    console.log(`停更 ${Math.round(ageMin)} 分钟，不在告警窗口内（<${AFTER} 分钟，或已经通知过了），本轮不发`);
    process.exit(0);
  }
}

/* ---------------- 文案 ---------------- */

const TXT = {
  RATE_LIMIT: ['站方限速',
    '出口被站方按速率限制了。这一类之前都会自己恢复（几分钟到十几分钟），一般不用管。\n' +
    '如果超过 1 小时还在挂，我就把批量并发从 2 降到 1（一轮 75 秒 → 约 100 秒），被限速的概率能减半。'],
  REGION: ['出口被判成国际站',
    'Cloudflare 出口也被归到国际站后端了（39 字节的 NOT_FOUND）。这一档降并发没用，需要换出口方案，你说一声我来处理。'],
  UPSTREAM_5XX: ['站方返回 5xx',
    '站方自己出故障了，等它恢复就行，我们这边不用动。'],
  NETWORK: ['中转连不上',
    '连不上 Cloudflare Worker，多半是网络抖动，通常下一轮自己就恢复了。'],
  AUTH: ['Worker 鉴权失败',
    '这是我们自己的代码问题（403 forbidden），不是站方拦的。需要检查 Cloudflare 里 Worker 的 KEYS 是不是被改成了非空。'],
  BATCH: ['批量端点异常',
    'Cloudflare Worker 的 /__batch 出问题了，可能要降批大小（POCA_BATCH 20 → 10）。'],
  FETCH_FAIL: ['抓取中途大片失败',
    '搜索或详情阶段失败率超过阈值，多半是跑到一半被限速了。下一轮通常自己恢复。'],
  UNKNOWN: ['原因不明',
    '预检和抓取都没给出明确信号，需要看这一轮的运行日志才能判断。'],
};
const [title, advice] = TXT[reason] || TXT.UNKNOWN;

const rounds = (ageMin === null) ? '' : `（约 ${Math.max(1, Math.round(ageMin / 10))} 轮）`;
const lines = [
  `### 🚨 卡市数据停更${ageMin === null ? '' : ' ' + Math.round(ageMin) + ' 分钟'}`,
  '',
  `**最后成功** ${lastAt || '未知'}（北京）`,
  `**停更时长** ${ageMin === null ? '未知' : Math.round(ageMin) + ' 分钟' + rounds}`,
  `**原因** ${title}`,
  DETAIL ? `**细节** ${DETAIL}` : null,
  '',
  advice,
  '',
  '> 页面还能打开，显示的是最后一次成功抓到的数据，不会变空。',
];
const body = lines.filter(x => x !== null).join('\n');

console.log('──────── 告警预览 ────────');
console.log(body);
console.log('──────────────────────────');

/* ---------------- 发送 ---------------- */

if (!WEBHOOK) {
  console.log('⚠️ 没配 DINGTALK_WEBHOOK，只打印不发送');
  process.exit(0);
}

function signedUrl(webhook, secret) {
  if (!secret) return webhook;
  const ts = Date.now();
  const sign = crypto.createHmac('sha256', secret).update(ts + '\n' + secret).digest('base64');
  return webhook + (webhook.includes('?') ? '&' : '?') + 'timestamp=' + ts + '&sign=' + encodeURIComponent(sign);
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');
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

(async () => {
  let text = body;
  if (AT.length) text += '\n\n' + AT.map(m => '@' + m).join(' ');
  const payload = { msgtype: 'markdown', markdown: { title: `🚨 卡市停更 · ${title}`, text } };
  if (AT.length) payload.at = { atMobiles: AT, isAtAll: false };

  for (let i = 0; i < 3; i++) {
    try {
      const r = await postJson(signedUrl(WEBHOOK, SECRET), payload);
      const code = r.json && r.json.errcode;
      if (r.status === 200 && code === 0) { console.log('✅ 告警已发到钉钉'); return; }
      console.log(`⚠️ 第 ${i + 1} 次发送失败 errcode=${code} ${(r.json && r.json.errmsg) || ''}`);
    } catch (e) {
      console.log(`⚠️ 第 ${i + 1} 次发送异常：` + e.message);
    }
    if (i < 2) await new Promise(z => setTimeout(z, 3000 * (i + 1)));
  }
  console.log('❌ 告警三次都没发出去');
})();
