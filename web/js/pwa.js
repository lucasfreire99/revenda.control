// Instalação (PWA): service worker, botão "Instalar app" e aviso de atualização.

import { $, toast } from './dom.js';

let deferredPrompt = null;

const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const isIOS = () =>
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function whenLoaded(fn) {
    if (document.readyState === 'complete') fn();
    else window.addEventListener('load', fn, { once: true });
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    if (!secure) return; // service worker só funciona em HTTPS (ou localhost)

    // Se já havia um service worker no controle, uma troca de controlador significa "nova versão".
    // No primeiro acesso a troca é só a instalação inicial e NÃO deve recarregar a página.
    const hadController = Boolean(navigator.serviceWorker.controller);

    whenLoaded(async () => {
        try {
            const registration = await navigator.serviceWorker.register('sw.js');

            const offerUpdate = (worker) => toast('Há uma nova versão do app.', {
                actionLabel: 'Atualizar',
                duration: 20000,
                onAction: () => worker.postMessage({ type: 'SKIP_WAITING' })
            });

            if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);

            registration.addEventListener('updatefound', () => {
                const worker = registration.installing;
                worker?.addEventListener('statechange', () => {
                    if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
                });
            });

            let reloading = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (!hadController || reloading) return;
                reloading = true;
                location.reload();
            });

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') registration.update().catch(() => {});
            });
        } catch (err) {
            console.warn('Service worker não registrado:', err);
        }
    });
}

function setupInstall() {
    const button = $('installBtn');
    const status = $('installStatus');
    const iosHint = $('iosHint');

    if (isStandalone()) {
        button.hidden = true;
        iosHint.hidden = true;
        status.textContent = '✅ O app já está instalado e aberto em modo aplicativo.';
        return;
    }

    iosHint.hidden = !isIOS();

    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredPrompt = event;
        button.hidden = false;
    });

    button.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        deferredPrompt = null;
        button.hidden = true;
        if (outcome === 'accepted') toast('App instalado!');
    });

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        button.hidden = true;
        status.textContent = '✅ App instalado.';
    });
}

export function initPWA() {
    registerServiceWorker();
    setupInstall();
}
