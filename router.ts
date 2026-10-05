import { createRouter, publicQuery } from "./middleware";
import { sourcesRouter } from "./routers/sources";
import { checkRouter } from "./routers/check";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  sources: sourcesRouter,
  check: checkRouter,
});

export type AppRouter = typeof appRouter;
