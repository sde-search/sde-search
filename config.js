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

    // --- Кэш GET-запросов ---
    window._apiCache = new Map();
    const CACHE_TTL = {
        '/api/players':        5 * 60 * 1000,
        '/api/status':         30 * 1000,
        '/api/matrix':         10 * 60 * 1000,
        'default':             60 * 1000
    };

    function cacheKey(resource) {
        return resource.replace(/\/+$/, '');
    }

    function getCached(key) {
        // Отсекаем query-параметры для поиска в CACHE_TTL
        const baseKey = key.split('?')[0];
        const entry = window._apiCache.get(key);
        if (!entry) return null;
        const ttl = CACHE_TTL[baseKey] || CACHE_TTL['default'];
        if (Date.now() - entry.timestamp > ttl) {
            window._apiCache.delete(key);
            return null;
        }
        // Клонируем response, т.к. .json()/text() потребляет тело
        return entry.data.clone();
    }

    function setCached(key, data) {
        window._apiCache.set(key, { data, timestamp: Date.now() });
    }

    // --- Лог переключений ---
    window._apiSwitchLog = [];

    function _logSwitch(from, to, reason, resource) {
        const entry = {
            time: new Date().toISOString(),
            from: from,
            to: to,
            reason: reason,
            resource: resource
        };
        window._apiSwitchLog.push(entry);
        console.warn('[SDE SWITCH] ' + from + '→' + to + ': ' + reason + ' (' + resource + ')');
        if (window._apiSwitchLog.length > 200) window._apiSwitchLog.shift();
    }

    // === Прогрев соединения: подогреваем DNS + TLS + CORS preflight
    // Вызывается из index.html (checkAuth() и onload) перед unlockInterface(),
    // чтобы параллельные запросы в init() не спотыкались о cold-start + CORS preflight.
    window.warmupAPIConnection = function() {
        try {
            const token = sessionStorage.getItem('authToken');
            if (!token) return;
            // Прогреваем основные пути — каждый вызывает свой CORS preflight (OPTIONS)
            const paths = ['/api/status', '/api/players'];
            paths.forEach(function(p) {
                const c = new AbortController();
                setTimeout(function() { c.abort(); }, 10000);
                fetch(DEFAULT_API + p, {
                    headers: { 'Authorization': 'Basic ' + token, 'ngrok-skip-browser-warning': 'true' },
                    signal: c.signal,
                    mode: 'cors'
                }).catch(function() {});
            });
        } catch(_) {}
    };

    // --- fallbackFetch: ВСЕГДА DEFAULT ПЕРВЫМ ---
    //
    // Логика:
    // 1. Пробуем DEFAULT (8с таймаут — холодный старт с CORS preflight требует времени)
    // 2. Если DEFAULT не ответил — пробуем BACKUP (5с таймаут)
    // 3. Если DEFAULT ответил — возвращаем, сбрасываем флаг на false
    // 4. Если BACKUP ответил — возвращаем, ставим флаг на true
    // 5. Если оба не ответили — ошибка
    // Флаг API_USE_BACKUP влияет ТОЛЬКО на отображение в статус-панели,
    // НЕ на порядок запросов.
    //
    window.fallbackFetch = async function(resource, config) {
        if (!config) config = {};

        // Кэш
        if (!config.method || config.method === 'GET') {
            if (!config.noCache) {
                const ck = cacheKey(resource);
                const cached = getCached(ck);
                if (cached) return cached;
            }
        }

        // Всегда пробуем DEFAULT первым (8с — холодный старт с CORS preflight)
        let defaultResult = null;
        let defaultError = null;

        try {
            const fetchConfig = { ...config };
            if (!fetchConfig.headers) fetchConfig.headers = {};
            const controller = new AbortController();
            const timeout = setTimeout(function() { controller.abort(); }, 8000);
            const res = await fetch(DEFAULT_API + resource, { ...fetchConfig, signal: controller.signal });
            clearTimeout(timeout);
            defaultResult = res;
        } catch(e) {
            defaultError = e;
        }

        // DEFAULT ответил успешно?
        if (defaultResult && defaultResult.ok) {
            if (window.API_USE_BACKUP) {
                _logSwitch('BACKUP', 'DEFAULT', 'recovered', resource);
                window.API_USE_BACKUP = false;
            }
            if (!config.noCache && (!config.method || config.method === 'GET')) {
                var ck = cacheKey(resource);
                setCached(ck, defaultResult.clone());
            }
            return defaultResult;
        }

        // DEFAULT не ответил — пробуем BACKUP
        try {
            const fetchConfig = { ...config };
            if (!fetchConfig.headers) fetchConfig.headers = {};
            // ngrok browser-warning header
            fetchConfig.headers['ngrok-skip-browser-warning'] = 'true';

            const controller = new AbortController();
            const timeout = setTimeout(function() { controller.abort(); }, 5000);
            const res = await fetch(BACKUP_API + resource, { ...fetchConfig, signal: controller.signal });
            clearTimeout(timeout);

            // BACKUP ответил? переключаемся
            if (res.ok) {
                if (!window.API_USE_BACKUP) {
                    _logSwitch('DEFAULT', 'BACKUP', 'down: ' + ((defaultError && defaultError.message) || 'HTTP ' + (defaultResult ? defaultResult.status : '?')), resource);
                    window.API_USE_BACKUP = true;
                }
                if (!config.noCache && (!config.method || config.method === 'GET')) {
                    var ck = cacheKey(resource);
                    setCached(ck, res.clone());
                }
                return res;
            }

            // BACKUP тоже не ок — оба упали
            _logSwitch('DEFAULT', 'BACKUP', 'both_down: DEFAULT=' + ((defaultError && defaultError.message) || 'HTTP ' + (defaultResult ? defaultResult.status : '?')) + ' BACKUP=HTTP ' + res.status, resource);
            throw new Error("API недоступен (основной и резервный)");
        } catch(e) {
            if (e.message && e.message.indexOf('API недоступен') >= 0) throw e;
            _logSwitch('DEFAULT', 'BACKUP', 'both_down: DEFAULT=' + ((defaultError && defaultError.message) || '?') + ' BACKUP=' + e.message, resource);
            throw new Error("API недоступен (основной и резервный)");
        }
    };
})();