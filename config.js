(function () {
    const DEFAULT_API = "https://sde.domedome.crazedns.ru";
    const BACKUP_API  = "https://brewery-anyone-calibrate.ngrok-free.dev";

    function getOverride() {
        try {
            const url = new URL(window.location.href);
            const fromQuery = url.searchParams.get("api");
            if (fromQuery) {
                try { localStorage.setItem("apiBaseUrl", fromQuery); } catch (_) {}
                return fromQuery.replace(/\/+$/, "");
            }
        } catch (_) {}
        try {
            const stored = localStorage.getItem("apiBaseUrl");
            if (stored) return stored.replace(/\/+$/, "");
        } catch (_) {}
        return null;
    }

    window.API_BASE_URL = getOverride() || DEFAULT_API;
    window.BACKUP_API_BASE_URL = BACKUP_API;
    window.API_USE_BACKUP = false;

    // Простой кэш для GET-запросов: url → { data, timestamp }
    window._apiCache = new Map();
    const CACHE_TTL = {
        '/api/players':        5 * 60 * 1000,  // 5 минут
        '/api/status':         30 * 1000,       // 30 секунд
        '/api/matrix':         10 * 60 * 1000,  // 10 минут
        'default':             60 * 1000        // 1 минута по умолчанию
    };

    function cacheKey(resource) {
        // Нормализуем: убираем хвостовой слеш и параметры для кэша
        return resource.split('?')[0].replace(/\/+$/, '');
    }

    function getCached(key) {
        const entry = window._apiCache.get(key);
        if (!entry) return null;
        const ttl = CACHE_TTL[key] || CACHE_TTL['default'];
        if (Date.now() - entry.timestamp > ttl) {
            window._apiCache.delete(key);
            return null;
        }
        return entry.data;
    }

    function setCached(key, data) {
        window._apiCache.set(key, { data, timestamp: Date.now() });
    }

    // fallbackFetch: параллельный пробник с быстрым таймаутом
    window.fallbackFetch = async function(resource, config) {
        if (!config) config = {};

        // Кэш: смотрим только для GET, без флага noCache
        if (!config.method || config.method === 'GET') {
            if (!config.noCache) {
                const ck = cacheKey(resource);
                const cached = getCached(ck);
                if (cached) return cached;
            }
        }

        const urls = window.API_USE_BACKUP
            ? [BACKUP_API + resource, DEFAULT_API + resource]
            : [DEFAULT_API + resource, BACKUP_API + resource];

        // Таймауты: DEFAULT — 5с, BACKUP — 4с (быстрее, т.к. резерв)
        const timeouts = window.API_USE_BACKUP ? [4000, 5000] : [5000, 4000];

        // Проба последовательная (так проще контролировать CORS),
        // но с сокращёнными таймаутами
        for (let i = 0; i < urls.length; i++) {
            try {
                const fetchConfig = { ...config };
                if (!fetchConfig.headers) fetchConfig.headers = {};

                if (urls[i].indexOf('ngrok-free.dev') !== -1 || urls[i].indexOf('brewery-anyone') !== -1) {
                    fetchConfig.headers['ngrok-skip-browser-warning'] = 'true';
                }

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), timeouts[i]);
                const res = await fetch(urls[i], { ...fetchConfig, signal: controller.signal });
                clearTimeout(timeout);

                if (res.ok) {
                    if (i === 1) {
                        window.API_USE_BACKUP = (urls[0] !== DEFAULT_API + resource);
                    }
                    // Кэшируем успешный ответ
                    if (!config.noCache && (!config.method || config.method === 'GET')) {
                        const ck = cacheKey(resource);
                        setCached(ck, res.clone());
                    }
                    return res;
                }
            } catch(_) {}
        }
        throw new Error("API недоступен (основной и резервный)");
    };
})();