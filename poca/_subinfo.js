/** 临时：查机场订阅的流量用量（只输出数字，绝不打印订阅链接本身） */
const SUB = (process.env.SUB || '').trim();

const gb = x => (x / 1024 ** 3);

(async () => {
  if (!SUB) { console.log('❌ 没配置 POCA_SUB_URL'); return; }
  console.log('订阅串长度：' + SUB.length);
  let r;
  try {
    r = await fetch(SUB, { headers: { 'User-Agent': 'Shadowrocket/2.2.20 CFNetwork/1490 Darwin/23.1.0' } });
  } catch (e) { console.log('❌ 请求失败：' + e.message); return; }

  const body = await r.text();
  console.log('HTTP ' + r.status + ' | 订阅体 ' + body.length + ' 字符');
  const raw = r.headers.get('subscription-userinfo') || '';
  console.log('subscription-userinfo: ' + (raw || '（响应头里没有）'));

  const d = {};
  for (const kv of raw.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) d[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
  }
  const num = n => { const v = Number(d[n]); return Number.isFinite(v) ? v : 0; };
  const up = num('upload'), dn = num('download'), tot = num('total'), exp = num('expire');

  console.log('---');
  console.log(`已用：${gb(up + dn).toFixed(2)} GB（上传 ${gb(up).toFixed(2)} / 下载 ${gb(dn).toFixed(2)}）`);
  if (tot > 0) {
    const used = up + dn;
    console.log(`总量：${gb(tot).toFixed(2)} GB | 剩余：${gb(Math.max(0, tot - used)).toFixed(2)} GB | 使用率：${(used / tot * 100).toFixed(1)}%`);
  } else {
    console.log('总量：未提供（可能是不限量套餐，或响应头格式不同）');
  }
  if (exp > 0) {
    const t = new Date(exp * 1000 + 8 * 3600e3);
    const leftDays = (exp * 1000 - Date.now()) / 86400e3;
    console.log(`到期：${t.toISOString().slice(0, 16).replace('T', ' ')}（北京时间）| 还剩 ${leftDays.toFixed(1)} 天`);
  } else {
    console.log('到期：未提供');
  }
})();
