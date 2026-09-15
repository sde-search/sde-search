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

    window.fallbackFetch = async function(resource, config) {
        if (!config) config = {};
        const urls = window.API_USE_BACKUP
            ? [BACKUP_API + resource, DEFAULT_API + resource]
            : [DEFAULT_API + resource, BACKUP_API + resource];

        for (let i = 0; i < urls.length; i++) {
            try {
                const fetchConfig = { ...config };
                if (!fetchConfig.headers) fetchConfig.headers = {};
                // ngrok free tier blocks non-browser requests without this header
                if (urls[i].startsWith(BACKUP_API)) {
                    fetchConfig.headers['ngrok-skip-browser-warning'] = 'true';
                }
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 8000);
                const res = await fetch(urls[i], { ...fetchConfig, signal: controller.signal });
                clearTimeout(timeout);
                if (res.ok) {
                    if (i === 1) window.API_USE_BACKUP = (urls[0] !== DEFAULT_API + resource);
                    return res;
                }
            } catch(_) {}
        }
        throw new Error("API недоступен (основной и резервный)");
    };
})();
