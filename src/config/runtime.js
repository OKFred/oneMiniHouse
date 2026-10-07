// These values are embedded in client bundles. Never put credentials here or in VITE_* variables.
const env = import.meta.env;

export const runtimeConfig = Object.freeze({
    apiBaseUrl: (env.VITE_API_BASE_URL || "").replace(/\/$/, ""),
    tcpHost: env.VITE_TCP_HOST || "",
    tcpPort: Number(env.VITE_TCP_PORT || 8899),
});

export function apiUrl(path) {
    if (!runtimeConfig.apiBaseUrl) return "";
    return `${runtimeConfig.apiBaseUrl}/${path.replace(/^\//, "")}`;
}
