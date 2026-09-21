/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as auth from "../auth.js";
import type * as backfill from "../backfill.js";
import type * as cleanup from "../cleanup.js";
import type * as crons from "../crons.js";
import type * as email from "../email.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as importer from "../importer.js";
import type * as integrations from "../integrations.js";
import type * as jobs from "../jobs.js";
import type * as lib_accounts from "../lib/accounts.js";
import type * as lib_collect from "../lib/collect.js";
import type * as lib_contracts from "../lib/contracts.js";
import type * as lib_handoff from "../lib/handoff.js";
import type * as lib_results from "../lib/results.js";
import type * as lib_search from "../lib/search.js";
import type * as lib_serviceAuth from "../lib/serviceAuth.js";
import type * as lib_xmd from "../lib/xmd.js";
import type * as library from "../library.js";
import type * as limits from "../limits.js";
import type * as publication from "../publication.js";
import type * as search from "../search.js";
import type * as summary from "../summary.js";
import type * as worker from "../worker.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  auth: typeof auth;
  backfill: typeof backfill;
  cleanup: typeof cleanup;
  crons: typeof crons;
  email: typeof email;
  health: typeof health;
  http: typeof http;
  importer: typeof importer;
  integrations: typeof integrations;
  jobs: typeof jobs;
  "lib/accounts": typeof lib_accounts;
  "lib/collect": typeof lib_collect;
  "lib/contracts": typeof lib_contracts;
  "lib/handoff": typeof lib_handoff;
  "lib/results": typeof lib_results;
  "lib/search": typeof lib_search;
  "lib/serviceAuth": typeof lib_serviceAuth;
  "lib/xmd": typeof lib_xmd;
  library: typeof library;
  limits: typeof limits;
  publication: typeof publication;
  search: typeof search;
  summary: typeof summary;
  worker: typeof worker;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  firecrawl: import("@firecrawl/firecrawl-convex/_generated/component.js").ComponentApi<"firecrawl">;
  agentmail: import("@agentmail/convex/_generated/component.js").ComponentApi<"agentmail">;
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
