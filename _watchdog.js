/* 队列看门狗（由 .github/workflows/_watchdog.yml 每 15 分钟调用一次）

   为什么需要它 —— 2026-10-30 真实事故：
   GitHub 那边偶发「任务已经排队，但迟迟不分配机器」。而两个抓取工作流都配了
   concurrency（同一组只允许 1 个在跑 + 1 个排队），于是：
     一个卡在 queued 的 run 永远占着名额
       → 后面的 run 全部只能 pending
         → 再来一轮就把更早的 pending 取消掉
           → 抓取彻底停摆，页面上「最后抓取时间」定格，一卡就是一小时。
   当时数据停在 16:39，直到手动取消那两个 queued 的 run 才恢复。

   本脚本做三件事：
     ① 把「排队超过 STUCK_MIN 分钟还没分到机器」的 run 取消掉，把名额让出来
     ② 如果数据文件已经 STALE_MIN 分钟没更新、且当前没有任何在跑/排队的 run，补触发一轮
     ③ 连续失败 / 数据长期陈旧 → 推钉钉告警；恢复正常 → 推恢复通知
        （2026-11-01 Poca 换 API 域名，抓取静默挂了 8 小时 40 分才被发现，
          ① ② 全程在跑但救不回来 —— 缺的就是这一条。）

   ⚠️ 告警去重靠 main 分支的 watchdog_state.json：
      只在「进入故障」「恢复正常」这两个瞬间各推一条，不会每 15 分钟刷屏。
*/
const crypto = require('crypto');
const https = require('https');

const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.REPO;
const STUCK_MIN = Number(process.env.STUCK_MIN || 15);
const STALE_MIN = Number(process.env.STALE_MIN || 25);

/* ── 告警参数 ── */
const DING_WEBHOOK = (process.env.DINGTALK_WEBHOOK || '').trim();
const DING_SECRET = (process.env.DINGTALK_SECRET || '').trim();
const ALERT_AT = (process.env.ALERT_AT_MOBILES || '').split(',').map(s => s.trim()).filter(Boolean);
// 连续失败几轮开始告警（3 轮 ≈ 30 分钟）。兜底至少 1，否则配成 0 会让正常状态也告警。
const ALERT_AFTER = Math.max(1, Number(process.env.ALERT_AFTER || 3));
const STALE_ALERT = Number(process.env.STALE_ALERT || 60);  // 数据陈旧多少分钟算「调度停摆」
const STATE_PATH = 'watchdog_state.json';

const H = {
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'mercari-watchdog',
  'Content-Type': 'application/json',
};

const SITE = 'https://mercari-card-watch.app.workbuddy.host';
const WFS = [
  {
    file: 'watch.yml', name: '煤炉', snap: 'mw.json', ref: 'main',
    link: SITE + '/?sharecode=L2A6N4ATZQ',
  },
  {
    file: 'poca.yml', name: '卡市', snap: 'data.json', ref: 'poca-data',
    link: SITE + '/poca/?sharecode=L2A6N4ATZQ',
  },
];

async function api(path, opt = {}) {
  const r = await fetch('https://api.github.com/repos/' + REPO + path, { headers: H, ...opt });
  const txt = await r.text();
  if (!r.ok) throw new Error(path + ' → HTTP ' + r.status + ' ' + txt.slice(0, 160));
  // ⚠️ cancel 返回 202、dispatch 返回 204，两者都是空响应体。
  // 直接 r.json() 会抛 "Unexpected end of JSON input" —— 明明取消成功了，
  // 却记成出错、exit 1、整轮标红，看着像看门狗自己挂了。
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

// 快照文件的「数据时间」；读不出时间字段返回 { age: -1 }（本轮不判，也不补触发）
async function snapInfo(wf) {
  // 用 raw media type 直接拿原文：contents API 的 base64 版对 **超过 1MB** 的文件
  // 会返回空 content（encoding: none），这里就会 JSON 解析失败。
  // 卡市 data.json 现在已 500KB+，卡数再涨就会踩线，所以提前换成 raw。
  const r = await fetch(
    'https://api.github.com/repos/' + REPO + '/contents/' + wf.snap +
    '?ref=' + wf.ref + '&t=' + Date.now(),
    { headers: { ...H, Accept: 'application/vnd.github.raw' } }
  );
  if (!r.ok) throw new Error(wf.snap + '@' + wf.ref + ' → HTTP ' + r.status);
  const o = JSON.parse(await r.text());
  const t = Date.parse(o.at || 0);
  if (!t) return { age: -1, at: '' };
  return { age: Math.round((Date.now() - t) / 60000), at: o.at };
}

/* ── 连续失败计数 ──
   从最新一轮往回数。正在跑 / 排队的跳过（不打断计数），
   主动取消（cancelled）和跳过（skipped）既不算失败也不打断 ——
   否则看门狗自己 cancel 掉一个卡死的 run，就会把连败计数意外清零。 */
function countConsecFail(runs) {
  let n = 0;
  const nums = [];
  let firstAt = null;
  for (const x of runs) {
    if (x.status !== 'completed') continue;
    if (x.conclusion === 'success') break;
    if (x.conclusion === 'cancelled' || x.conclusion === 'skipped') continue;
    n++;
    nums.push('#' + x.run_number);
    firstAt = x.created_at;   // 循环是倒序，最后一次赋值就是最早那次
  }
  return { n, nums: nums.slice(0, 5), firstAt };
}

/* ── 时间格式化（一律北京） ── */
const cnTs = iso => {
  const t = Date.parse(iso);
  if (!t) return '未知';
  const d = new Date(t + 8 * 3600e3);
  const p = n => String(n).padStart(2, '0');
  return p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
};
const spanText = mins => {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60), r = m % 60;
  return h + ' 小时' + (r ? ' ' + r + ' 分钟' : '');
};

/* ── 钉钉 ── */
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
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ errmsg: String(d).slice(0, 120) }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('钉钉请求超时')); });
    req.write(buf);
    req.end();
  });
}

async function ding(title, text) {
  const body = text + (ALERT_AT.length ? '\n\n' + ALERT_AT.map(m => '@' + m).join(' ') : '');
  if (!DING_WEBHOOK) {
    console.log('   ⚠️ 没配 DINGTALK_WEBHOOK，告警只打印不发送');
    console.log('   ┌─ ' + title);
    console.log(body.split('\n').map(l => '   │ ' + l).join('\n'));
    console.log('   └─');
    return false;
  }
  try {
    const r = await postJson(signedUrl(DING_WEBHOOK, DING_SECRET), {
      msgtype: 'markdown',
      markdown: { title, text: body },
      at: { atMobiles: ALERT_AT, isAtAll: false },
    });
    if (r.errcode === 0) { console.log('   ✅ 钉钉已推送：' + title); return true; }
    console.log('   ❌ 钉钉发送失败：' + r.errcode + ' ' + r.errmsg);
    return false;
  } catch (e) {
    console.log('   ❌ 钉钉异常：' + e.message);
    return false;
  }
}

/* ── 告警状态（存 main 的 watchdog_state.json） ── */
let stateSha = null;

async function readState() {
  const r = await fetch(
    'https://api.github.com/repos/' + REPO + '/contents/' + STATE_PATH + '?ref=main&t=' + Date.now(),
    { headers: H }
  );
  if (r.status === 404) { stateSha = null; return {}; }
  if (!r.ok) { console.log('   ⚠️ 读告警状态失败 HTTP ' + r.status); return {}; }
  const j = await r.json();
  stateSha = j.sha;
  try { return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')); } catch { return {}; }
}

async function writeState(obj) {
  const body = {
    message: '看门狗：更新告警状态 [skip ci]',
    content: Buffer.from(JSON.stringify(obj, null, 1)).toString('base64'),
    branch: 'main',
  };
  if (stateSha) body.sha = stateSha;
  const r = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + STATE_PATH, {
    method: 'PUT',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.log('   ⚠️ 写告警状态失败 HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
}

/* ── 三种消息 ── */
const msgFail = (wf, cf, age, at) =>
  '### 🚨 ' + wf.name + '抓取连续失败 ' + cf.n + ' 轮\n\n' +
  '**数据停在**：' + cnTs(at) + '（已' + spanText(age) + '没更新）\n\n' +
  '**失败轮次**：' + (cf.nums.length ? cf.nums.join(' ') : '（最新一轮）') + '\n\n' +
  '**看板**：[打开' + wf.name + '](' + wf.link + ')\n\n' +
  '> 常见原因：站方接口变更、反爬拦截、机房 IP 被墙。\n' +
  '> [点这里看失败日志](https://github.com/' + REPO + '/actions/workflows/' + wf.file + ')\n\n' +
  '修好后会自动发恢复通知。';

const msgStale = (wf, age, at) =>
  '### ⚠️ ' + wf.name + '数据 ' + spanText(age) + '没更新\n\n' +
  '**数据停在**：' + cnTs(at) + '\n\n' +
  '**看板**：[打开' + wf.name + '](' + wf.link + ')\n\n' +
  '> 没有任何任务在跑、也没在排队，说明**调度本身停了**（不是抓取失败）。\n' +
  '> 看门狗已尝试补触发一轮。若这条反复收到，多半是 cron-job.org 的定时器挂了。';

const msgRecover = (wf, at, sinceTs) =>
  '### ✅ ' + wf.name + '抓取已恢复\n\n' +
  '**数据已更新到**：' + cnTs(at) + '\n\n' +
  (sinceTs ? '**这次故障从**：' + cnTs(sinceTs) + ' 起（约 ' + spanText((Date.now() - Date.parse(sinceTs)) / 60000) + '）\n\n' : '') +
  '**看板**：[打开' + wf.name + '](' + wf.link + ')';

/* ── 主流程 ── */
(async () => {
  // 自检：只发一条明确标注「测试」的消息，验证钉钉通道是否通，不碰任何 run / 数据 / 状态。
  // 触发方式：workflow_dispatch 时勾上 selftest。
  if (process.argv.includes('--selftest')) {
    console.log('自检模式：发一条测试告警');
    const ok = await ding('【自检】抓取告警通道测试',
      '### 🔔 告警通道自检\n\n' +
      '收到这条说明**抓取失败告警能正常发到群里**。\n\n' +
      '这是手动点的自检消息，**不是真的出故障**，可以忽略。\n\n' +
      '> 真出事时你会收到「🚨 抓取连续失败 N 轮」和修好后的「✅ 已恢复」。');
    process.exit(ok ? 0 : 1);
  }

  let fail = 0;
  const state = await readState();
  let stateChanged = false;

  for (const wf of WFS) {
    try {
      const runs = (await api('/actions/workflows/' + wf.file + '/runs?per_page=20')).workflow_runs || [];

      // ① 清理卡在排队、迟迟分不到机器的
      const stuck = runs.filter(x =>
        (x.status === 'queued' || x.status === 'pending') &&
        Date.now() - Date.parse(x.created_at) > STUCK_MIN * 60000
      );
      for (const x of stuck) {
        await api('/actions/runs/' + x.id + '/cancel', { method: 'POST' });
        console.log(wf.name + ' 取消卡住的 #' + x.run_number + '（' + x.status + '，已等 ' +
          Math.round((Date.now() - Date.parse(x.created_at)) / 60000) + ' 分钟）');
      }
      if (!stuck.length) console.log(wf.name + ' 队列干净（无需清理）');

      // 清理后重新看一眼，别在有任务要跑的时候又插一轮
      const now = (await api('/actions/workflows/' + wf.file + '/runs?per_page=5')).workflow_runs || [];
      const active = now.filter(x => x.status !== 'completed');
      const { age, at } = await snapInfo(wf);
      const cf = countConsecFail(runs);

      if (age < 0) {
        // 读不出时间字段就什么都别做 —— 否则会退化成「每 15 分钟无脑补触发一轮」，
        // 白白多烧一轮机器时间，还会和正常调度撞车。
        console.log(wf.name + ' 快照 ' + wf.snap + ' 里读不到 at 时间字段，本轮跳过判断');
        continue;
      }

      console.log(wf.name + ' 数据 ' + age + ' 分钟前' +
        (active.length ? '，有 ' + active.length + ' 个任务在跑/排队' : '，正常') +
        (cf.n ? '｜连续失败 ' + cf.n + ' 轮' : ''));

      // ② 太旧且没人跑 → 补触发一轮
      let dispatched = false;
      if (age > STALE_MIN && !active.length) {
        await api('/actions/workflows/' + wf.file + '/dispatches', {
          method: 'POST',
          body: JSON.stringify({ ref: 'main' }),
        });
        dispatched = true;
        console.log(wf.name + ' 数据已 ' + age + ' 分钟没更新，补触发一轮');
      }

      // ③ 告警判定
      const want = cf.n >= ALERT_AFTER ? 'fail'
        : (age >= STALE_ALERT && !active.length ? 'stale' : null);
      const prev = state[wf.file] || {};

      if (want && prev.alerted !== want) {
        const ok = want === 'fail'
          ? await ding(wf.name + '抓取失败告警', msgFail(wf, cf, age, at))
          : await ding(wf.name + '数据停更告警', msgStale(wf, age, at));
        // 只有推成功才记账，否则下一轮会重试（钉钉临时抽风不至于把告警吞掉）
        if (ok) {
          state[wf.file] = { alerted: want, since: new Date().toISOString(), at, age, fails: cf.n };
          stateChanged = true;
        }
      } else if (!want && prev.alerted) {
        const ok = await ding(wf.name + '抓取恢复通知', msgRecover(wf, at, prev.since));
        if (ok) {
          state[wf.file] = { alerted: null, recovered: new Date().toISOString(), at };
          stateChanged = true;
        }
      } else if (want) {
        console.log(wf.name + ' 仍是 ' + want + ' 状态（' + (prev.alerted === want ? '已告警过，不重复推' : '-') + '）');
      }
    } catch (e) {
      fail++;
      console.log(wf.name + ' 出错：' + e.message);
    }
  }

  if (stateChanged) await writeState(state);
  process.exit(fail ? 1 : 0);
})();
