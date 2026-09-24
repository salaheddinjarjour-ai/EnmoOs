import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every page renders client data from the API, so the default (no incremental cache) is enough.
export default defineCloudflareConfig();
