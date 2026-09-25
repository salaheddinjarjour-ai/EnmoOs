import type { StorageDriver } from "@enmo/shared";
import { LocalStorage } from "./local";
import { R2Storage, type R2Config } from "./r2";
import type { Storage } from "./types";

export { LocalStorage, type LocalStorageOptions } from "./local";
export {
  R2_CACHE_CONTROL,
  R2Storage,
  r2Endpoint,
  type R2Client,
  type R2Config,
  type R2StorageOptions,
} from "./r2";

export interface StorageConfig {
  /** STORAGE_DRIVER. */
  driver: StorageDriver;
  /**
   * The base every public URL starts with: PUBLIC_ASSET_BASE_URL for local (default
   * `${API_PUBLIC_URL}/files`), R2_PUBLIC_BASE_URL for r2 (default https://assets.enmo.marketing).
   */
  publicBaseUrl: string;
  /** STORAGE_LOCAL_DIR; read only by the local driver. */
  localDir: string;
  /** R2_*; read only by the r2 driver. */
  r2: R2Config;
}

/**
 * The Storage for STORAGE_DRIVER. Construction does no I/O and never throws: every API and worker
 * process builds one at boot.
 */
export function createStorage(config: StorageConfig): Storage {
  switch (config.driver) {
    case "local":
      return new LocalStorage({ dir: config.localDir, publicBaseUrl: config.publicBaseUrl });
    case "r2":
      return new R2Storage({ ...config.r2, publicBaseUrl: config.publicBaseUrl });
  }
}
