/*
 * Service Worker - AgroFer Trader
 * ================================
 * Duas estratégias de cache (spec do PWA, item 2):
 *
 * a) Cache-first para arquivos estáticos (JS, fontes, imagens, logo e,
 *    com prioridade, todos os arquivos da calculadora de break-even) -
 *    servidos do cache assim que existem nele, sem esperar a rede. A
 *    calculadora também é revalidada em segundo plano a cada visita
 *    online (stale-while-revalidate), pra não ficar presa num preço
 *    antigo indefinidamente enquanto o service worker não for
 *    atualizado de novo.
 *
 * b) Network-first com fallback pro cache nas páginas de cotação (home
 *    e páginas de commodity) e nos arquivos dados/*.json que elas usam -
 *    tenta a rede primeiro; se falhar, serve a última cópia salva e
 *    injeta um marcador na página (window.__AGROFER_OFFLINE_EM__) pra
 *    ela mostrar o aviso "Dados offline" (ver assets/offline-banner.js).
 *
 * Versionamento: mude CACHE_VERSION sempre que publicar uma mudança de
 * código (não precisa mudar só porque os dados do dia mudaram - isso o
 * bot diário já atualiza sozinho, via network-first). Mudar este
 * arquivo faz o navegador enxergar o service worker como diferente,
 * instalar a nova versão e, na ativação, apagar os caches antigos (ver
 * evento "activate"), em vez de servir arquivo velho pra sempre.
 */

const CACHE_VERSION = "v3";
const STATIC_CACHE = `agrofer-estatico-${CACHE_VERSION}`;
const PAGES_CACHE = `agrofer-paginas-${CACHE_VERSION}`;
const CACHES_ATUAIS = [STATIC_CACHE, PAGES_CACHE];

const SCOPE_PATH = new URL(self.registration.scope).pathname;

// Arquivos essenciais pré-carregados na instalação - sobretudo a
// calculadora de break-even (prioridade do PWA, item 3), pra funcionar
// offline mesmo que o usuário nunca tenha aberto essa página antes.
// Se algum destes falhar (ex.: CDN de terceiro fora do ar no momento),
// a instalação não é abortada - só aquele arquivo fica de fora até ser
// cacheado depois, na primeira visita normal (ver cacheFirst abaixo).
const PRECACHE_URLS = [
  "manifest.json",
  "assets/android-chrome-192x192.png",
  "assets/android-chrome-512x512.png",
  "assets/icon-maskable-192x192.png",
  "assets/icon-maskable-512x512.png",
  "assets/favicon-16x16.png",
  "assets/favicon-32x32.png",
  "assets/apple-touch-icon.png",
  "assets/logo.png",
  "assets/logo-nav.jpg",
  "assets/calculadora.js",
  "assets/calculadora-core.js",
  "assets/calculadora-outros-modos.js",
  "assets/interatividade.js",
  "assets/offline-banner.js",
  "assets/install-prompt.js",
  "assets/update-banner.js",
  "calculadora/",
  "calculadora/outros-modos/",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js",
].map((caminho) => new URL(caminho, self.registration.scope).toString());

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((erro) => {
            console.warn("[SW] Falha ao pré-cachear", url, erro);
          })
        )
      )
    )
  );
});

// Nunca ativa a versão nova sozinho (sem isso, o navegador só troca de
// service worker quando todas as abas do site forem fechadas). Espera
// o usuário tocar no aviso "Nova versão disponível" (ver
// assets/update-banner.js) pra não trocar o app debaixo dele no meio
// do uso - item 5 da spec do PWA.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((nomes) =>
      Promise.all(
        nomes
          .filter((nome) => nome.startsWith("agrofer-") && !CACHES_ATUAIS.includes(nome))
          .map((nome) => caches.delete(nome))
      )
    )
  );
});

function caminhoRelativoAoSite(pathname) {
  return pathname.startsWith(SCOPE_PATH) ? pathname.slice(SCOPE_PATH.length) : pathname;
}

// Home e páginas de commodity (com ou sem barra final / index.html
// explícito) - preços físicos e futuros, sempre a versão mais nova
// possível.
function ehPaginaDeCotacao(pathname) {
  const rel = caminhoRelativoAoSite(pathname);
  if (rel === "" || rel === "index.html") return true;
  return /^commodities\/[^/]+\/(index\.html)?$/.test(rel);
}

// dados/AAAA-MM-DD.json e dados/historico.json - os números por trás
// das páginas de cotação e do painel de correlações.
function ehDadosJson(pathname) {
  return /^dados\/.*\.json$/.test(caminhoRelativoAoSite(pathname));
}

function ehArquivoDaCalculadora(pathname) {
  return /^calculadora\//.test(caminhoRelativoAoSite(pathname));
}

async function comCarimboDeData(resposta) {
  const headers = new Headers(resposta.headers);
  headers.set("sw-cached-at", new Date().toISOString());
  const corpo = await resposta.blob();
  return new Response(corpo, {
    status: resposta.status,
    statusText: resposta.statusText,
    headers,
  });
}

// Injeta window.__AGROFER_OFFLINE_EM__ na página servida do cache, pra
// assets/offline-banner.js saber que estes dados não são de agora e
// mostrar o aviso com a data/hora em que foram salvos.
async function marcarComoOffline(respostaCache) {
  const tipo = respostaCache.headers.get("content-type") || "";
  if (!tipo.includes("text/html")) return respostaCache;

  const salvoEm = respostaCache.headers.get("sw-cached-at") || "";
  const marcador = `<script>window.__AGROFER_OFFLINE_EM__=${JSON.stringify(salvoEm)};</script>`;
  const html = await respostaCache.text();
  const htmlMarcado = html.includes("</head>")
    ? html.replace("</head>", `${marcador}</head>`)
    : marcador + html;

  return new Response(htmlMarcado, {
    status: respostaCache.status,
    statusText: respostaCache.statusText,
    headers: respostaCache.headers,
  });
}

async function networkFirst(request) {
  const cache = await caches.open(PAGES_CACHE);
  try {
    // "no-store" pra não deixar o cache HTTP comum do navegador (que
    // pode considerar a resposta "fresca o bastante" por um tempo,
    // mesmo sem Cache-Control explícito) mascarar uma rede offline -
    // aqui o objetivo é sempre tentar a rede de verdade primeiro.
    const respostaRede = await fetch(request, { cache: "no-store" });
    if (respostaRede && respostaRede.ok) {
      cache.put(request, await comCarimboDeData(respostaRede.clone()));
    }
    return respostaRede;
  } catch (erro) {
    const respostaCache = await cache.match(request);
    if (respostaCache) return marcarComoOffline(respostaCache);
    throw erro;
  }
}

async function cacheFirst(request, revalidarEmSegundoPlano) {
  const cache = await caches.open(STATIC_CACHE);
  const respostaCache = await cache.match(request);

  const buscarERenovar = fetch(request)
    .then((respostaRede) => {
      if (respostaRede && (respostaRede.ok || respostaRede.type === "opaque")) {
        cache.put(request, respostaRede.clone());
      }
      return respostaRede;
    })
    .catch(() => null);

  if (respostaCache) {
    if (revalidarEmSegundoPlano) buscarERenovar.catch(() => {});
    return respostaCache;
  }

  const respostaRede = await buscarERenovar;
  if (respostaRede) return respostaRede;
  throw new Error("Sem cache e sem rede para " + request.url);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin && (ehPaginaDeCotacao(url.pathname) || ehDadosJson(url.pathname))) {
    event.respondWith(networkFirst(request));
    return;
  }

  const daCalculadora = url.origin === self.location.origin && ehArquivoDaCalculadora(url.pathname);
  event.respondWith(cacheFirst(request, daCalculadora));
});
