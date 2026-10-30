// Executa antes da pintura da página para evitar "flash" de tema errado.
// Ordem de prioridade: escolha salva pelo usuário > preferência do sistema.
(function () {
    var theme = 'light';
    try {
        var saved = localStorage.getItem('theme');
        if (saved === 'dark' || saved === 'light') {
            theme = saved;
        } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            theme = 'dark';
        }
    } catch (e) {
        /* localStorage indisponível: segue com o tema claro */
    }
    document.documentElement.dataset.theme = theme;
})();
