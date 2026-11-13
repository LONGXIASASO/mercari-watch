/**
 * 订阅 → Xray 配置（只做兜底出口用，2026-11-13）
 *
 * 用途：机房直连和 Cloudflare 中转都不通时，在 runner 上起一个 Xray，
 *      出口走用户机场的**韩国**节点，再用 POCA_PROXY 把抓取指过去。
 *
 * 为什么自己转、不直接喂订阅给客户端：
 *   她给的是 Shadowrocket 版订阅（base64 包 vmess://），mihomo/xray 都不直接吃。
 *   这里做最小解析：vmess / trojan / vless 三种主流协议，其余跳过并打印。
 *
 * 用法：
 *   POCA_SUB_URL='https://...' node _sub2xray.js --out /tmp/xray.json
 *   （订阅链接走环境变量或 --url，**绝不写进任何提交的文件**）
 *
 * 输出：
 *   Xray 配置 JSON，每个可用节点一个本地 http 入口：7891 + i
 *   stderr/日志只打印节点名和协议，**不打印 uuid/密码**
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SUB = String(process.env.POCA_SUB_URL || argOf('url', '')).trim();
const OUT = argOf('out', '/tmp/xray.json');
const PORT0 = Number(argOf('port', '7891'));
if (!SUB && !process.argv.includes('--file')) { console.error('缺少 POCA_SUB_URL'); process.exit(2); }

// ── 拉订阅：跟随重定向（她的订阅 302 到 www.shallmap.site），UA 用 Shadowrocket ──
function get(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向过多'));
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      host: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 20000,
      headers: {
        'User-Agent': 'Shadowrocket/2.2.31 (iPhone; iOS 18.0)',
        'Accept': '*/*',
      },
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return get(next, depth + 1).then(resolve, reject);
      }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('订阅超时')); });
    req.end();
  });
}

// base64 → 明文（订阅常见：整包 base64；也可能是明文 + 注释行）
function maybeB64(s) {
  const t = s.replace(/\s/g, '');
  if (t.includes('://')) return s;
  try {
    const dec = Buffer.from(t, 'base64').toString('utf8');
    if (dec.includes('://')) return dec;
  } catch (e) {}
  return s;
}

// ── 各协议 → Xray outbound ──
function vmessOut(uri) {
  const j = JSON.parse(Buffer.from(uri.slice(8), 'base64').toString('utf8'));
  const host = j.host || j.add;
  const net = j.net || 'tcp';
  const sec = (j.tls === 'tls' || j.tls === true) ? 'tls' : 'none';
  const ss = { network: net, security: sec };
  if (sec === 'tls') ss.tlsSettings = { serverName: j.sni || host, allowInsecure: false };
  if (net === 'ws') {
    ss.wsSettings = { path: j.path || '/', headers: { Host: host } };
  } else if (net === 'grpc') {
    ss.grpcSettings = { serviceName: j.path || '' };
  }
  return {
    name: j.ps || host,
    out: {
      protocol: 'vmess',
      settings: { vnext: [{ address: j.add, port: Number(j.port) || 443, users: [{ id: j.id, alterId: Number(j.aid) || 0, security: 'auto' }] }] },
      streamSettings: ss,
    },
  };
}
function trojanOut(uri) {
  const u = new URL(uri);
  const q = u.searchParams;
  const net = q.get('type') || 'tcp';
  const host = q.get('sni') || u.hostname;
  const ss = { network: net, security: 'tls', tlsSettings: { serverName: host, allowInsecure: false } };
  if (net === 'ws') ss.wsSettings = { path: q.get('path') || '/', headers: { Host: q.get('host') || host } };
  return {
    name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
    out: {
      protocol: 'trojan',
      settings: { servers: [{ address: u.hostname, port: Number(u.port) || 443, password: decodeURIComponent(u.username) }] },
      streamSettings: ss,
    },
  };
}
function vlessOut(uri) {
  const u = new URL(uri);
  const q = u.searchParams;
  const net = q.get('type') || 'tcp';
  const sec = q.get('security') || 'none';
  const host = q.get('sni') || q.get('host') || u.hostname;
  const ss = { network: net, security: sec };
  if (sec === 'tls') ss.tlsSettings = { serverName: host, allowInsecure: false };
  if (sec === 'reality') {
    ss.realitySettings = {
      serverName: q.get('sni') || u.hostname,
      fingerprint: q.get('fp') || 'chrome',
      publicKey: q.get('pbk') || '',
      shortId: q.get('sid') || '',
    };
  }
  if (net === 'ws') ss.wsSettings = { path: q.get('path') || '/', headers: { Host: q.get('host') || host } };
  else if (net === 'grpc') ss.grpcSettings = { serviceName: q.get('serviceName') || '' };
  return {
    name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
    out: {
      protocol: 'vless',
      settings: { vnext: [{ address: u.hostname, port: Number(u.port) || 443, users: [{ id: decodeURIComponent(u.username), encryption: 'none', flow: q.get('flow') || '' }] }] },
      streamSettings: ss,
    },
  };
}

// 韩国优先：名字里带「韩 / 韩国 / KR / Korea / Seoul」的排前面
const isKR = n => /韩|韓國|韩国|首尔|首爾|\bKR\b|Korea|Seoul/i.test(n);

(async () => {
  // --file：从本地文件读订阅内容（排障/自测用，省得反复打订阅接口）
  const localFile = argOf('file', '');
  let r;
  if (localFile) { r = { code: 200, body: fs.readFileSync(localFile, 'utf8') }; }
  else {
    r = await get(SUB);
    if (r.code !== 200) { console.error(`订阅 HTTP ${r.code}`); process.exit(3); }
  }
  const text = maybeB64(r.body);
  // ⚠️ 别用「含 = 就跳过」过滤：vmess:// 的 base64 尾部常有 == 填充，会把所有节点一起扔掉。
  //    只丢订阅头部的 STATUS= / REMARKS= 这类全大写键值行。
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^[A-Z_]{3,}=/.test(s));
  const nodes = [];
  let skipped = 0;
  for (const l of lines) {
    try {
      if (l.startsWith('vmess://')) nodes.push(vmessOut(l));
      else if (l.startsWith('trojan://')) nodes.push(trojanOut(l));
      else if (l.startsWith('vless://')) nodes.push(vlessOut(l));
      else skipped++;
    } catch (e) { skipped++; }
  }
  if (!nodes.length) { console.error('订阅里没解析出可用节点'); process.exit(4); }
  // 韩国优先，其余按原序
  nodes.sort((a, b) => (isKR(b.name) ? 1 : 0) - (isKR(a.name) ? 1 : 0));

  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [], outbounds: [], routing: { domainStrategy: 'AsIs', rules: [] },
  };
  nodes.forEach((n, i) => {
    const port = PORT0 + i;
    const inTag = 'in' + i, outTag = 'out' + i;
    cfg.inbounds.push({ tag: inTag, listen: '127.0.0.1', port, protocol: 'http' });
    cfg.outbounds.push(Object.assign({ tag: outTag }, n.out));
    cfg.routing.rules.push({ type: 'field', inboundTag: [inTag], outboundTag: outTag });
    console.log(`  端口 ${port} ← ${n.name}（${n.out.protocol}${isKR(n.name) ? ' · 韩国优先' : ''}）`);
  });
  cfg.outbounds.push({ tag: 'direct', protocol: 'freedom' });
  fs.writeFileSync(OUT, JSON.stringify(cfg, null, 2));
  console.log(`✅ 已生成 ${OUT}：${nodes.length} 个节点，跳过 ${skipped} 行`);
})().catch(e => { console.error('失败：' + e.message); process.exit(1); });
