import path from "node:path";
import fastifyStatic, { type SendOptions } from "@fastify/static";
import { isValidStorageKey, LocalStorage, mimeTypeForKey } from "@enmo/providers";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { LOCAL_FILES_PATH } from "../config";
import { notFound } from "../lib/errors";
import type { RouteModule } from "../types";

/*
 * GET|HEAD /files/<key> (DESIGN §E "realtime and files", §F "Storage"): the STORAGE_DRIVER=local
 * files, at the URLs LocalStorage.publicUrl hands out. routes/index.ts mounts this module
 * unversioned under LOCAL_FILES_PATH, and only for the local driver; in production R2 serves the
 * same keys from its public bucket.
 *
 * Public on purpose, exactly like that bucket: <img> tags on the web origin and Meta/TikTok's
 * servers fetch these URLs without a session. That is safe because a key names one file and is
 * unguessable (clients/<cuid>/assets/<cuid>.<ext>), and nothing here lists a directory, so a URL is
 * only known to whoever was shown the asset.
 *
 * Nothing reaches the filesystem unless the URL spells a valid storage key byte for byte (see
 * keyOf), which rules out traversal, absolute paths, dotfiles (LocalStorage's temp files) and
 * directories. @fastify/static streams the file with Range, ETag and conditional-GET support;
 * it is registered with serve: false because its own routes would carry no access rule.
 */

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const SEND_OPTIONS = {
  // A key is written once per Asset row (a regenerate is a new row), so its bytes never change.
  maxAge: ONE_YEAR_MS,
  immutable: true,
  // A key names a file: a directory is never indexed or listed, and dotfiles are never served.
  index: false,
  dotfiles: "deny",
  // Set from the key in setFileHeaders, the same mapping Storage stored the file under.
  contentType: false,
} as const satisfies SendOptions;

const FileParams = z.object({ "*": z.string() });

/**
 * The storage key a /files URL names, or null. The raw path must be exactly LOCAL_FILES_PATH/<key>
 * for a valid key. Keys only use [A-Za-z0-9._-] and "/", so they never need percent-encoding: any
 * other spelling (%2e%2e, %2F, %00, double encoding, a trailing slash the router forgave) is
 * refused whatever the router decoded it to.
 */
function keyOf(url: string, param: string): string | null {
  const pathname = url.split("?", 1)[0];
  if (pathname !== `${LOCAL_FILES_PATH}/${param}`) return null;
  return isValidStorageKey(param) ? param : null;
}

/**
 * Headers for a file actually sent; a 404 keeps the security plugin's no-store, since the file may
 * still be written (a render in flight). CORS for the web origin comes from that plugin too.
 */
function setFileHeaders(reply: FastifyReply, filePath: string): void {
  // The web app (another origin) and any embedder may load these images, as they would from R2.
  void reply.header("cross-origin-resource-policy", "cross-origin");
  if (reply.statusCode !== 304) {
    void reply.header("content-type", mimeTypeForKey(path.basename(filePath)));
  }
}

export const filesRoutes: RouteModule = async (app) => {
  const { deps } = app;
  // The directory deps.storage writes to: an injected LocalStorage (tests) keeps its own.
  const root =
    deps.storage instanceof LocalStorage
      ? deps.storage.root
      : path.resolve(deps.config.STORAGE_LOCAL_DIR);

  await app.register(fastifyStatic, { serve: false, setHeaders: setFileHeaders });

  // A missing file answers like an invalid key, and never reveals which of the two it was.
  app.setNotFoundHandler(() => {
    throw notFound("File");
  });

  app.get("/*", { config: { public: true }, schema: { params: FileParams } }, (request, reply) => {
    const key = keyOf(request.url, request.params["*"]);
    if (key === null) throw notFound("File");
    return reply.sendFile(key, root, SEND_OPTIONS);
  });
};
