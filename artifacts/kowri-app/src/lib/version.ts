export function resolveAppVersion(): string {
  const fromEnv = import.meta.env.VITE_APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  return "dev";
}

export const APP_VERSION = resolveAppVersion();

export function appendVersionToUrl(url: string, version = APP_VERSION): string {
  if (!url) return url;
  const hasQuery = url.includes("?");
  const separator = hasQuery ? "&" : "?";
  return `${url}${separator}v=${encodeURIComponent(version)}`;
}

export function getUiVersionLabel(): string {
  return APP_VERSION === "dev" ? "dev-local" : APP_VERSION.slice(0, 12);
}
