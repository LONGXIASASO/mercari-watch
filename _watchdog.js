/* 队列看门狗（由 .github/workflows/_watchdog.yml 每 15 分钟调用一次）

   为什么需要它 —— 2026-10-30 真实事故：
   GitHub 那边偶发「任务已经排队，但迟迟不分配机器」。而两个抓取工作流都配了
   concurrency（同一组只允许 1 个在跑 + 1 个排队），于是：
     一个卡在 queued 的 run 永远占着名额
       → 后面的 run 全部只能 pending
         → 再来一轮就把更早的 pending 取消掉
           → 抓取彻底停摆，页面上「最后抓取时间」定格，一卡就是一小时。
   当时数据停在 16:39，直到手动取消那两个 queued 的 run 才恢复。

   本脚本做两件事：
     ① 把「排队超过 STUCK_MIN 分钟还没分到机器」的 run 取消掉，把名额让出来
     ② 如果数据文件已经 STALE_MIN 分钟没更新、且当前没有任何在跑/排队的 run，补触发一轮
*/
const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.REPO;
const STUCK_MIN = Number(process.env.STUCK_MIN || 15);
const STALE_MIN = Number(process.env.STALE_MIN || 25);

const H = {
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'mercari-watchdog',
  'Content-Type': 'application/json',
};

const WFS = [
  { file: 'watch.yml', name: '煤炉', snap: 'mw.json', ref: 'main' },
  { file: 'poca.yml', name: '卡市', snap: 'data.json', ref: 'poca-data' },
];

async function api(path, opt = {}) {
  const r = await fetch('https://api.github.com/repos/' + REPO + path, { headers: H, ...opt });
  if (!r.ok) throw new Error(path + ' → HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return r.status === 204 ? null : r.json();
}

// 快照文件的「数据时间」离现在多少分钟
async function snapAge(wf) {
  const f = await api('/contents/' + wf.snap + '?ref=' + wf.ref + '&t=' + Date.now());
  const o = JSON.parse(Buffer.from(f.content, 'base64').toString('utf8'));
  const t = Date.parse(o.at || 0);
  if (!t) return 99999;
  return Math.round((Date.now() - t) / 60000);
}

(async () => {
  let fail = 0;
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
      const age = await snapAge(wf);

      if (age > STALE_MIN && !active.length) {
        await api('/actions/workflows/' + wf.file + '/dispatches', {
          method: 'POST',
          body: JSON.stringify({ ref: 'main' }),
        });
        console.log(wf.name + ' 数据已 ' + age + ' 分钟没更新，补触发一轮');
      } else {
        console.log(wf.name + ' 数据 ' + age + ' 分钟前' + (active.length ? '，有 ' + active.length + ' 个任务在跑/排队' : '，正常'));
      }
    } catch (e) {
      fail++;
      console.log(wf.name + ' 出错：' + e.message);
    }
  }
  process.exit(fail ? 1 : 0);
})();
