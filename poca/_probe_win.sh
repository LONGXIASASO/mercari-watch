#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────
# Windows runner 客户端 / 出口矩阵诊断（一次性排障，不属于线上抓取链路）
#
# 背景：2026-11-13 13:10 起，同一个韩国节点（64.176.234.49）：
#        本机 Windows curl（Schannel） → 200
#        Actions Linux curl/h2/http1  → 404/39 NOT_FOUND
#       本机 node h2（OpenSSL）      → 404
#       ⇒ 怀疑站方按 TLS 指纹（JA3/JA4）分流，Schannel 放行、OpenSSL 拒绝。
#
# 本脚本在 windows-latest 上跑，用同一个节点把六种组合一次测完。
#
# 用法：POCA_SUB_URL='https://...' bash poca/_probe_win.sh
# ────────────────────────────────────────────────────────────────
set -u

SCH="/c/Windows/System32/curl.exe"     # Windows 自带 curl = Schannel
UA='PocaMarket/2.7.4 (iPhone; iOS 18.0)'
URL='https://phocamarket.com/card/v3/search?q=%EC%9E%A5%ED%95%98%EC%98%A4'
H=(-H "User-Agent: $UA" -H 'Accept: application/json'
   -H 'Accept-Language: ko-KR,ko;q=0.9' -H 'POCA-DISPLAY-LANGUAGE: ko'
   -H 'Referer: https://pocamarket.com/')

say() { echo; echo "=============== $* ==============="; }
body() { head -c 100 "/tmp/p_$1.bin" 2>/dev/null | tr -d '\r\n'; echo; }

# $1=标签  $2=CURL 可执行文件  $3...=额外参数（如 -x proxy）
pc() {
  local tag="$1" bin="$2"; shift 2
  local out
  out=$("$bin" -s -m 25 -o "/tmp/p_$tag.bin" -D "/tmp/p_$tag.hdr" \
        -w 'HTTP %{http_code}  %{size_download}B  %{time_total}s' \
        "$@" "${H[@]}" "$URL" 2>&1 | tail -1)
  printf '  %-22s %s\n' "[$tag]" "$out"
  printf '  %-22s body: %s\n' "" "$(body "$tag")"
  local ln
  ln=$(grep -i '^poca-display-language' "/tmp/p_$tag.hdr" 2>/dev/null | tr -d '\r')
  [ -n "$ln" ] && printf '  %-22s %s\n' "" "$ln"
}

say "环境"
uname -srm 2>/dev/null || true
echo "--- PATH 里的 curl（Git Bash 自带）"
echo "  $(which curl)"; curl --version 2>&1 | head -1
echo "--- Windows 系统 curl（Schannel）"
ls -la "$SCH" 2>/dev/null | head -1; "$SCH" --version 2>&1 | head -1
echo "--- node"; node -v

# ── 1. 直连（Azure 出口，预期被拦）────────────────────────────
say "① 直连 · Azure 出口"
pc direct_schannel "$SCH" --noproxy '*'
echo "  --- node h2 直连"
node poca/poca.js --probe 2>&1 | tail -2

# ── 2. 起 Xray，走韩国节点 ────────────────────────────────────
say "② 准备 Xray（订阅 → 韩国节点）"
"$SCH" -sSL -m 120 -o /tmp/xray.zip \
  https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip \
  -w '  xray.zip HTTP %{http_code}  %{size_download}B\n'
mkdir -p /tmp/xray && unzip -o -q /tmp/xray.zip -d /tmp/xray
echo "  xray: $(/tmp/xray/xray.exe version 2>&1 | head -1)"

node poca/_sub2xray.js --out /tmp/xray.json 2>&1 | tail -6
if [ ! -s /tmp/xray.json ]; then
  echo "❌ 订阅转配置失败，后面没法测"; exit 1
fi

/tmp/xray/xray.exe -c /tmp/xray.json > /tmp/xray.log 2>&1 &
XPID=$!
sleep 6
echo "  xray pid=$XPID  日志："
tail -6 /tmp/xray.log | sed 's/^/    /'
for P in 7891 7892 7893 7894; do
  (echo > /dev/tcp/127.0.0.1/$P) >/dev/null 2>&1 && echo "    端口 $P 就绪" || echo "    端口 $P 不通"
done

# ── 3. 隧道矩阵：同一个出口，换客户端 ────────────────────────
say "③ 隧道出口（韩国节点 :7891）· 换客户端"
pc sub_schannel  "$SCH" -x http://127.0.0.1:7891
pc sub_gitcurl   "$(which curl)" -x http://127.0.0.1:7891
echo "  --- node h2（POCA_HTTP=h2）"
POCA_HTTP=h2 POCA_PROXY=http://127.0.0.1:7891 node poca/poca.js --probe 2>&1 | tail -2
echo "  --- node spawn curl（POCA_HTTP=curl，实际调用 PATH 里的 curl）"
POCA_HTTP=curl POCA_PROXY=http://127.0.0.1:7891 node poca/poca.js --probe 2>&1 | tail -2

# ── 4. 结论 ──────────────────────────────────────────────────
say "结论"
for t in direct_schannel sub_schannel sub_gitcurl; do
  c=$(head -1 "/tmp/p_$t.hdr" 2>/dev/null | tr -d '\r')
  printf '  %-18s %s\n' "$t" "${c:-无响应}"
done
if grep -q 'HTTP/1.1 200\|HTTP/2 200' /tmp/p_sub_schannel.hdr 2>/dev/null; then
  echo "  ✅ Schannel + 韩国节点 = 200 → windows runner 这条路可行"
else
  echo "  ❌ Schannel + 韩国节点也不是 200 → windows runner 救不了，换方案"
fi

kill $XPID 2>/dev/null
exit 0
