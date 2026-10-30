// Service worker do Revenda+: deixa o app funcionar 100% offline.
// Para publicar uma nova versão, mude VERSION: os usuários verão o aviso "Há uma nova versão do app".

const VERSION = 'v2.0.0';
const CACHE = `revenda-plus-${VERSION}`;

const ASSETS = [
    './',
    'index.html',
    'manifest.webmanifest',
    'favicon.ico',
    'css/styles.css',
    'js/theme-init.js',
    'js/main.js',
    'js/utils.js',
    'js/store.js',
    'js/dom.js',
    'js/views.js',
    'js/charts.js',
    'js/exporter.js',
    'js/backup.js',
    'js/pwa.js',
    'js/config.js',
    'js/auth.js',
    'js/auth-ui.js',
    'js/account.js',
    'js/sync.js',
    'js/legacy.js',
    'vendor/chart.umd.js',
    'vendor/exceljs.min.js',
    'vendor/supabase.js',
    'icons/favicon.svg',
    'icons/favicon-16.png',
    'icons/favicon-32.png',
    'icons/apple-touch-icon.png',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon-maskable-192.png',
    'icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) =>
            // cache: 'reload' ignora o cache HTTP do navegador e baixa a versão nova de verdade
            cache.addAll(ASSETS.map((path) => new Request(path, { cache: 'reload' })))
        )
    );
    // Não chama skipWaiting aqui: a pessoa decide quando atualizar (mensagem SKIP_WAITING).
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((k) => k.startsWith('revenda-plus-') && k !== CACHE).map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    if (new URL(request.url).origin !== self.location.origin) return;
    event.respondWith(staleWhileRevalidate(event));
});

// Responde na hora com o que está no cache e atualiza o cache em segundo plano.
async function staleWhileRevalidate(event) {
    const request = event.request;
    const isNavigation = request.mode === 'navigate';
    const cache = await caches.open(CACHE);

    const cached = (await cache.match(request, { ignoreSearch: true }))
        || (isNavigation ? await cache.match('index.html') : undefined);

    const refresh = fetch(request)
        .then((response) => {
            if (response && response.status === 200 && response.type === 'basic') {
                cache.put(isNavigation ? 'index.html' : request, response.clone());
            }
            return response;
        })
        .catch(() => null);

    if (cached) {
        event.waitUntil(refresh);
        return cached;
    }

    const response = await refresh;
    if (response) return response;
    return new Response('Sem conexão e este conteúdo ainda não está salvo no aparelho.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
}
