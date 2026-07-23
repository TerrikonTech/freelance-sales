import { readFile } from 'node:fs/promises';

const admin = 'http://127.0.0.1:2019';
const routesUrl = `${admin}/config/apps/http/servers/srv0/routes/0/handle/0/routes`;
const configPath = process.env.CADDY_SALES_CONFIG || '/app/ops/caddy-sales.json';

async function hasSalesRoute() {
  const response = await fetch(routesUrl, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Caddy admin HTTP ${response.status}`);
  const routes = await response.json() as Array<{ match?: Array<{ path?: string[] }> }>;
  return routes.some((route) => route.match?.some((match) => match.path?.includes('/sales/*')));
}

async function ensureRoute() {
  if (await hasSalesRoute()) return;
  const config = await readFile(configPath);
  const response = await fetch(`${admin}/load`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: config,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Caddy load HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  console.log('Маршрут /sales восстановлен');
}

async function tick() {
  try {
    await ensureRoute();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
}

void tick();
setInterval(() => void tick(), 30_000);
