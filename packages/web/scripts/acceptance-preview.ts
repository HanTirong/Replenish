import { createServer, request as proxyRequest, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SqliteDatabase } from "../../api/src/db.ts";
import { createApiServer } from "../../api/src/http.ts";
import { HouseholdApp } from "../../api/src/service.ts";

export type ScenarioId = "normal" | "slow" | "lost" | "background";
const DEFINITIONS: { id: ScenarioId; name: string; instructions: string }[] = [
  { id: "normal", name: "正常操作与撤销", instructions: "发送“以后每顿少喂10g”，看 75g → 65g、每天 150g → 130g，再撤销。独立重置后发送“明天晚饭不喂”，确认记录成功且补货日期不变。" },
  { id: "slow", name: "慢请求", instructions: "发送相同的减量指令。代理会延迟聊天请求，观察处理中提示、重复发送保护；也可关闭等待视图，再用 View request 回去。" },
  { id: "lost", name: "保存成功但响应丢失", instructions: "本场景第一次聊天会先在服务器保存，再模拟连接中断。点 Check latest status，或直接刷新页面，确认找回原结果，仍是 65g，不会再减到 55g。" },
  { id: "background", name: "网页关闭后的后台检查", instructions: "打开计划详情记下检查时间，关闭产品标签页，等一个本地检查周期，再从入口打开。记录应更新；打开页面本身不会触发检查。" },
];
function url(server: Server) { return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
async function listen(server: Server, port = 0) {
  // Automatic OS allocation can return a browser-blocked port (observed: 5061).
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off("error", onError); reject(error); };
        server.once("error", onError);
        server.listen(port || randomInt(49152, 65536), "127.0.0.1", () => { server.off("error", onError); resolve(); });
      });
      return;
    } catch (error) { if (port || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; }
  }
  throw new Error("No local acceptance port is available.");
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
function json(response: ServerResponse, value: unknown, status = 200) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }

export async function startAcceptance(options: { port?: number; root?: string; slowMs?: number; intervalMs?: number } = {}) {
  const root = path.resolve(options.root ?? `data/acceptance/runs/${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const intervalMs = options.intervalMs ?? 15_000, slowMs = options.slowMs ?? 6000;
  const started = Date.now(), baseline = Date.parse("2026-11-01T08:01:00Z");
  const servers: Server[] = [], timers: ReturnType<typeof setInterval>[] = [];
  const cases = [] as { id: ScenarioId; name: string; instructions: string; url: string; app: HouseholdApp;
    stats: { chatPosts: number; undoPosts: number; dropped: number; delayed: number; inflight: number }; reset(): void }[];
  try {
    for (const definition of DEFINITIONS) {
      const db = new SqliteDatabase(path.join(root, `${definition.id}.sqlite`));
      const app = new HouseholdApp({ db, env: { PAYMENT_PROVIDER: "mock" }, timeZone: "UTC",
        clock: () => new Date(baseline + Date.now() - started), sku: "RC-SMALL-8", priceCents: 7299,
        payments: { query: async () => "not_found", charge: async () => ({ paymentId: `LOCAL-PREVIEW-${randomUUID()}` }) },
        vault: { hasPaymentToken: () => false },
      });
      app.configureScheduler(intervalMs);
      const tick = () => { void app.runScheduledCheck().catch(() => undefined); };
      tick(); timers.push(setInterval(tick, intervalMs));
      const upstream = createApiServer(app, { webRoot: path.resolve("packages/web/dist") });
      servers.push(upstream); await listen(upstream);
      const stats = { chatPosts: 0, undoPosts: 0, dropped: 0, delayed: 0, inflight: 0 };
      let dropNext = definition.id === "lost";
      const preview = createServer((request, response) => {
        const target = new URL(request.url ?? "/", url(upstream));
        if (target.origin !== url(upstream)) { json(response, { error: "Only the local preview is available." }, 403); return; }
        const chat = request.method === "POST" && target.pathname === "/v1/chat";
        if (chat) stats.chatPosts++;
        if (request.method === "POST" && target.pathname === "/v1/feeding/undo") stats.undoPosts++;
        const drop = chat && dropNext;
        if (drop) dropNext = false;
        const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET");
        if (mutation) { stats.inflight++; response.once("close", () => { stats.inflight--; }); }
        const forward = () => {
          if (response.destroyed) return;
          const proxy = proxyRequest(target, { method: request.method, headers: { ...request.headers, host: target.host } }, incoming => {
            incoming.on("error", () => response.destroy());
            if (drop) {
              incoming.resume(); incoming.once("end", () => {
                stats.dropped++;
                // An empty connection close lets Chrome transparently replay the POST. Deliver partial
                // JSON first, then interrupt its body so the visible outcome is genuinely unconfirmed.
                response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
                response.flushHeaders(); response.write('{"localPreviewInterrupted":');
                setTimeout(() => response.destroy(), 60);
              }); return;
            }
            const fresh = target.searchParams.get("__acceptanceFresh") === "1" && incoming.headers["content-type"]?.includes("text/html");
            if (fresh) {
              const chunks: Buffer[] = [];
              incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
              incoming.on("end", () => {
                // Only the local harness adds this explicit fresh-session bootstrap. A reload keeps recovery data.
                const script = `<script>sessionStorage.removeItem('replenish.pending-operation.v1');const previewUrl=new URL(location.href);previewUrl.searchParams.delete('__acceptanceFresh');history.replaceState(null,'',previewUrl.pathname+previewUrl.search+previewUrl.hash);</script>`;
                const html = Buffer.concat(chunks).toString("utf8").replace("</head>", `${script}</head>`);
                response.writeHead(incoming.statusCode ?? 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(html);
              });
            } else { response.writeHead(incoming.statusCode ?? 502, { ...incoming.headers, "cache-control": "no-store" }); incoming.pipe(response); }
          });
          proxy.on("error", () => { if (!response.headersSent) json(response, { error: "Local preview is temporarily unavailable." }, 502); else response.destroy(); });
          request.pipe(proxy);
        };
        if (chat && definition.id === "slow") { stats.delayed++; setTimeout(forward, slowMs); } else forward();
      });
      servers.push(preview); await listen(preview);
      cases.push({ ...definition, app, url: url(preview), stats, reset() {
        if (stats.inflight) throw new Error("An operation is still pending. Wait for it to settle before resetting.");
        app.resetDemo(); stats.chatPosts = 0; stats.undoPosts = 0; stats.dropped = 0; stats.delayed = 0; dropNext = definition.id === "lost";
      } });
    }
    const launcher = createServer((request, response) => {
      const target = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && target.pathname === "/__acceptance/state") {
        json(response, { intervalMs, slowMs, cases: cases.map(item => ({ id: item.id, url: item.url, stats: item.stats, home: item.app.home() })) }); return;
      }
      if (request.method === "POST" && target.pathname === "/__acceptance/reset") {
        if (request.headers.origin && request.headers.origin !== url(launcher)) { json(response, { error: "Use the local acceptance page." }, 403); return; }
        const item = cases.find(item => item.id === target.searchParams.get("case"));
        if (!item) { json(response, { error: "Unknown scenario." }, 404); return; }
        try { item.reset(); json(response, { ok: true }); } catch { json(response, { error: "还有操作尚未结束，暂不重置。请先等待或核对结果。" }, 409); }
        return;
      }
      if (request.method !== "GET" || target.pathname !== "/") { json(response, { error: "Not found" }, 404); return; }
      const cards = cases.map(item => `<section><h2>${item.name}</h2><p>${item.instructions}</p><a href="${item.url}/?__acceptanceFresh=1" target="_blank" rel="noopener">打开本场景</a> <button data-case="${item.id}">重置本场景数据</button><p role="status" id="status-${item.id}"></p></section>`).join("");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Replenish 本地验收</title><style>body{margin:0;background:#F6F3EE;color:#1C1B19;font:16px/1.6 system-ui,sans-serif}main{max-width:850px;margin:32px auto;padding:0 24px}h1{font-size:28px}h2{font-size:20px}section{background:#fff;border:1px solid #E3DDD3;border-radius:24px;padding:20px;margin:16px 0}a,button{font:inherit;color:#1F6B63}button{border:1px solid #E3DDD3;background:#fff;border-radius:20px;padding:6px 14px;margin-left:8px;cursor:pointer}small{color:#5E5A54}</style><main><h1>Replenish 本地验收</h1><p>四组场景各自使用独立 SQLite 数据。支付为模拟；AI 使用本地规则；不连接 Telegram、PayPal、真实商店或线上数据库。</p><p>测试时间从 2026-11-01 08:01 UTC 开始，按真实秒数前进；本地每 ${intervalMs / 1000} 秒检查一次。慢请求延迟 ${slowMs / 1000} 秒。线上默认周期和配置不变。</p><p>每组从每顿 75g、每天 150g、估算余粮 1200g 开始。需要重做时先重置，再点击“打开本场景”；刷新当前产品页会保留未确认请求，供恢复测试。仅在本机可访问。</p>${cards}<p>体验时请判断：是否知道请求正在处理；是否看懂实际变化；是否知道下一步该不该自己操作。此入口属于本地验收工具，产品页面保持原样。</p><small>重启命令：corepack pnpm preview:acceptance。关闭整个浏览器会话后，不保证保留该标签页的待确认操作。</small></main><script>for(const button of document.querySelectorAll('button[data-case]'))button.addEventListener('click',async()=>{button.disabled=true;const status=document.getElementById('status-'+button.dataset.case);try{const response=await fetch('/__acceptance/reset?case='+button.dataset.case,{method:'POST'});const value=await response.json();status.textContent=response.ok?'已重置。请重新点击打开本场景。':value.error}catch{status.textContent='未确认是否重置，请重新核对。'}finally{button.disabled=false}})</script></html>`);
    });
    servers.push(launcher); await listen(launcher, options.port ?? 0);
    const manifest = { launcherUrl: url(launcher), processId: process.pid, root, intervalMs, slowMs,
      cases: cases.map(({ id, name, url }) => ({ id, name, url })) };
    writeFileSync(path.join(root, "preview.json"), JSON.stringify(manifest, null, 2));
    return { ...manifest, cases, close: async () => { for (const timer of timers) clearInterval(timer); await Promise.all(servers.map(close)); } };
  } catch (error) { for (const timer of timers) clearInterval(timer); await Promise.all(servers.map(close)); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portOption = process.argv.find(value => value.startsWith("--port="));
  const port = portOption ? Number(portOption.slice(7)) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error("Choose a valid local preview port.");
  const preview = await startAcceptance({ port });
  mkdirSync("data/acceptance", { recursive: true });
  writeFileSync("data/acceptance/current.json", JSON.stringify({ launcherUrl: preview.launcherUrl, processId: process.pid, root: preview.root,
    intervalMs: preview.intervalMs, cases: preview.cases.map(({ id, name, url }) => ({ id, name, url })) }, null, 2));
  console.log(`LOCAL_ACCEPTANCE_READY ${preview.launcherUrl}`);
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true; await preview.close(); process.exit(0); };
  process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
}
