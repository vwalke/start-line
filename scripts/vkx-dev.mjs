// Local round trip for boat-log uploads without Cloudflare: `npm run dev:vkx`.
// Starts the normal Vite dev server (vite.config.ts unchanged: its /api proxy still
// serves the RaceSense data) plus a plugin that answers /api/vkx/* with the real
// handlers (functions/_vkx.ts) over an in-memory R2 bucket (tests/r2mem.ts).
// Uploads are lost when the server stops.
//   --no-bucket      act as a site with no R2 binding (the "uploads unavailable" state)
//   --feed=fixture   check uploads against tests/fixtures/vkx/feed.json instead of
//                    teleapi (offline; covers USA 833 on Fri Sep 11 2026 only)
//   --port=5173      as vite's --port
//   --fake-finish="USA 833@2026-09-11T13:32:30Z"
//                    DEV ONLY, for screenshots: patch /api/regatta so the race with a gun in
//                    the 3 h before that time and no finishes gets this one finish, and so
//                    appears in the race picker (main lists only races with finishers; e.g.
//                    J/70 Worlds R7). The patched document lands in this origin's Cache
//                    Storage: clear the site data of localhost afterwards.
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === name || a.startsWith(`${name}=`));
const noBucket = !!flag('--no-bucket');
const fixtureFeed = flag('--feed')?.split('=')[1] === 'fixture';
const port = Number(flag('--port')?.split('=')[1] ?? 5173);
const fake = flag('--fake-finish')?.slice('--fake-finish='.length).split('@');
const UA = 'StartLine/1 (+https://walkeforward.com)';

/** The regatta document with the --fake-finish finish added (see above). */
async function patchedRegatta(event) {
  const res = await fetch(`https://racesense.vakaros.com/api/regatta?event=${encodeURIComponent(event)}`, { headers: { accept: 'application/json', 'user-agent': UA } });
  const body = await res.json();
  const [sail, iso] = fake;
  const at = Date.parse(iso);
  for (const rev of body.revisions ?? []) {
    for (const div of rev.doc?.divisions ?? []) {
      for (const race of div.races ?? []) {
        const gun = race.starts?.at(-1)?.startTime;
        if (!gun || race.finishes?.length || at < gun || at - gun > 3 * 3_600_000) continue;
        race.finishes = [{ sailNumber: sail, finishingTime: new Date(at).toISOString(), raceNumber: race.raceNumber }];
        console.log(`[vkx-mock] DEV: fake finish ${sail} at ${iso} added to ${div.name} race ${race.raceNumber}`);
      }
    }
  }
  return body;
}

function fixtureFetch() {
  const page = JSON.parse(readFileSync(new URL('../tests/fixtures/vkx/feed.json', import.meta.url), 'utf8'));
  const ts = page.Fields.indexOf('ts');
  return async (input) => {
    const u = new URL(String(input));
    const a = Number(u.searchParams.get('after'));
    const b = Number(u.searchParams.get('before'));
    const rows = page.Rows.filter((r) => r[ts] >= a && r[ts] <= b);
    return new Response(JSON.stringify({ Fields: page.Fields, Rows: rows }), { headers: { 'content-type': 'application/json' } });
  };
}

function vkxMock() {
  let bucket = null;
  return {
    name: 'recall-vkx-mock',
    apply: 'serve',
    configureServer(server) {
      // Runs before Vite's own middlewares, so /api/vkx/* never reaches the /api proxy.
      server.middlewares.use(async (req, res, next) => {
        if (fake && req.url?.startsWith('/api/regatta?')) {
          try {
            const body = await patchedRegatta(new URL(req.url, 'http://x').searchParams.get('event') ?? '');
            res.setHeader('content-type', 'application/json; charset=utf-8');
            return res.end(JSON.stringify(body));
          } catch (e) {
            return next(e);
          }
        }
        if (!req.url?.startsWith('/api/vkx/')) return next();
        try {
          const vkx = await server.ssrLoadModule('/functions/_vkx.ts');
          if (!bucket && !noBucket) bucket = new (await server.ssrLoadModule('/tests/r2mem.ts')).MemBucket();
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = chunks.length ? Buffer.concat(chunks) : undefined;
          const request = new Request(`http://localhost:${port}${req.url}`, {
            method: req.method,
            headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
            ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
          });
          const ctx = { request, env: noBucket ? {} : { VKX_BUCKET: bucket }, waitUntil: () => undefined };
          const deps = { cache: null, limiter: null, ...(fixtureFeed ? { fetch: fixtureFetch() } : {}) };
          const path = new URL(request.url).pathname;
          const route = {
            '/api/vkx/upload': req.method === 'POST' ? vkx.handleUpload : null,
            '/api/vkx/list': req.method === 'GET' ? vkx.handleList : null,
            '/api/vkx/data': req.method === 'GET' ? vkx.handleData : null,
            '/api/vkx/delete': req.method === 'POST' || req.method === 'DELETE' ? vkx.handleDelete : null,
          }[path];
          const out = route ? await route(ctx, deps) : vkx.methodNotAllowed('GET, POST');
          res.statusCode = out.status;
          out.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await out.arrayBuffer()));
          console.log(`[vkx-mock] ${req.method} ${path} → ${out.status}`);
        } catch (e) {
          next(e);
        }
      });
    },
  };
}

const server = await createServer({ plugins: [vkxMock()], server: { port } });
await server.listen();
server.printUrls();
console.log(`[vkx-mock] /api/vkx/* served locally (${noBucket ? 'NO bucket: uploads unavailable' : 'in-memory R2'}; feed check: ${fixtureFeed ? 'fixture' : 'teleapi'})`);
