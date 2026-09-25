/*
 * Meta Graph API settings shared by the publisher, OAuth and (Phase 6) metrics. Every Meta call
 * goes through an injected fetch against these base URLs, so tests aim them at a fake Graph
 * server; nothing here reads the environment.
 */

export const META_GRAPH_DEFAULT_BASE_URL = "https://graph.facebook.com";
/** Facebook Reels uploads (`POST /video-upload/{version}/{video_id}` with a `file_url` header). */
export const META_RUPLOAD_DEFAULT_BASE_URL = "https://rupload.facebook.com";
/** The consent dialog (`/{version}/dialog/oauth`) lives on www, not on the Graph host. */
export const META_DIALOG_DEFAULT_BASE_URL = "https://www.facebook.com";
export const META_GRAPH_DEFAULT_VERSION = "v26.0";

export interface MetaConfig {
  /** META_APP_ID / META_APP_SECRET: null until the Meta app exists. */
  appId: string | null;
  appSecret: string | null;
  /** META_GRAPH_VERSION, e.g. "v26.0". */
  graphVersion: string;
  /** META_GRAPH_BASE_URL. */
  graphBaseUrl: string;
  ruploadBaseUrl: string;
  dialogBaseUrl: string;
}

/** Whether the Meta app's credentials are set (live publishing and OAuth need them). */
export function metaConfigured(config: Pick<MetaConfig, "appId" | "appSecret">): boolean {
  return Boolean(config.appId && config.appSecret);
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

/**
 * `{base}/{version}/{path}?{query}` on the Graph host (or another Meta base), e.g.
 * metaUrl(config.graphBaseUrl, config.graphVersion, "123/media", { fields: "id" }).
 */
export function metaUrl(
  baseUrl: string,
  version: string,
  path: string,
  query: Readonly<Record<string, string>> = {},
): string {
  const url = new URL(
    `${baseUrl.replace(/\/+$/, "")}/${trimSlashes(version)}/${trimSlashes(path)}`,
  );
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}
