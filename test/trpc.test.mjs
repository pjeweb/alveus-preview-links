import assert from "node:assert/strict";
import { test } from "node:test";
import { affectedRoutes, selectLinks } from "../src/routes.mjs";

const config = { sourceRoot: "apps/website/src/", pagesRoot: "apps/website/src/pages/", maxLinks: 6, dynamicExamples: {} };
const root = config.sourceRoot;

function fixture() {
  return new Map(Object.entries({
    "server/trpc/trpc.ts": `export const router = t.router;
export const publicProcedure = t.procedure;`,
    "server/trpc/router/_app.ts": `import { router } from "../trpc";
import { twitchRouter as channels } from "./admin/twitch";
import { usersRouter } from "./admin/users";
export const appRouter = router({ adminTwitch: channels, adminUsersRouter: usersRouter });
export type AppRouter = typeof appRouter;`,
    "server/trpc/router/admin/twitch.ts": `import { router, publicProcedure } from "../../trpc";
import { listChannels as load, editChannel } from "@/server/db";
import { getUser } from "@/server/api";
export const twitchRouter = router({
  getChannels: publicProcedure.query(() => load()),
  editChannel: publicProcedure.mutation(() => editChannel()),
  createChannel: publicProcedure.mutation(() => getUser()),
});`,
    "server/trpc/router/admin/users.ts": `import { router, publicProcedure } from "../../trpc";
export const usersRouter = router({
  getUsers: publicProcedure.query(() => {
    return { roles: true };
  }),
  assignRole: publicProcedure.mutation(() => true),
});`,
    "server/db/index.ts": `export { getChannels as listChannels, editChannel } from "./channels.js";`,
    "server/db/channels.ts": `function omitTokens() {
  return { tokens: false };
}
export function getChannels() {
  return omitTokens();
}
export function editChannel() {
  return true;
}
export function refreshChannels() {
  return "background only";
}`,
    "server/api.ts": `import { getAppToken } from "./oauth";
export function getUser() { return getAppToken(); }`,
    "server/oauth.ts": `export function getAppToken() {
  console.info("obtained access token");
  return "token";
}`,
    "utils/trpc.ts": `import type { AppRouter } from "@/server/trpc/router/_app";
export const trpc = createTRPCNext<AppRouter>({});`,
    "components/Channels.tsx": `import { trpc as api } from "@/utils/trpc";
export const Channels = () => api.adminTwitch.getChannels.useQuery();`,
    "pages/admin/twitch/index.tsx": `import { Channels } from "@/components/Channels";`,
    "pages/admin/twitch/create.tsx": `import { trpc } from "@/utils/trpc";
trpc.adminTwitch.createChannel.useMutation();`,
    "pages/admin/twitch/edit.tsx": `import { trpc } from "@/utils/trpc";
trpc.adminTwitch.editChannel.useMutation();`,
    "pages/admin/users.tsx": `import { trpc } from "@/utils/trpc";
trpc.adminUsersRouter.getUsers.useQuery();`,
    "pages/admin/roles.tsx": `import { trpc } from "@/utils/trpc";
trpc.adminUsersRouter.assignRole.useMutation();`,
    "pages/_app.tsx": `import { trpc } from "@/utils/trpc"; export default trpc.withTRPC(App);`,
    "pages/about.tsx": `import { trpc } from "@/utils/trpc";`,
  }).map(([file, source]) => [root + file, source]));
}

function changed(sources, file, text, deletion = false) {
  const filename = root + file;
  const line = sources.get(filename).split("\n").findIndex((value) => value.includes(text)) + 1;
  assert.ok(line, `Missing fixture text: ${text}`);
  return { filename, patch: `@@ -${line},${deletion ? 2 : 1} +${line},1 @@\n-old\n${deletion ? " " : "+"}${sources.get(filename).split("\n")[line - 1]}` };
}

function paths(sources, changes) {
  return selectLinks(affectedRoutes(sources, changes, config), sources, changes, config).map((link) => link.path).sort();
}

test("server response changes link both admin screens despite different component distances", () => {
  const sources = fixture();
  const changes = [
    changed(sources, "server/db/channels.ts", "return omitTokens"),
    changed(sources, "server/trpc/router/admin/users.ts", "roles: true", true),
    changed(sources, "server/oauth.ts", "console.info"),
  ];
  assert.deepEqual(paths(sources, changes), ["/admin/twitch", "/admin/users"]);
  const candidates = affectedRoutes(sources, changes, config);
  assert.match(candidates.find((candidate) => candidate.route === "/admin/twitch").reason, /adminTwitch\.getChannels/);
});

test("a procedure edit does not select other procedures in the same router", () => {
  const sources = fixture();
  assert.deepEqual(paths(sources, [changed(sources, "server/trpc/router/admin/twitch.ts", "getChannels:")]), ["/admin/twitch"]);
  assert.deepEqual(paths(sources, [changed(sources, "server/trpc/router/admin/users.ts", "roles: true")]), ["/admin/users"]);
});

test("edits to a runtime import affect only procedures using that binding", () => {
  const sources = fixture();
  sources.set(root + "server/trpc/router/admin/twitch.ts", `import { router, publicProcedure } from "../../trpc";
import {
  listChannels as load,
  editChannel,
} from "@/server/db";
export const twitchRouter = router({
  getChannels: publicProcedure.query(() => load()),
  editChannel: publicProcedure.mutation(() => editChannel()),
});`);
  assert.deepEqual(paths(sources, [changed(sources, "server/trpc/router/admin/twitch.ts", "listChannels as load")]), ["/admin/twitch"]);
});

test("helper tracing follows local calls, aliased imports and barrel exports", () => {
  const sources = fixture();
  assert.deepEqual(paths(sources, [changed(sources, "server/db/channels.ts", "tokens: false")]), ["/admin/twitch"]);
  assert.deepEqual(paths(sources, [changed(sources, "server/db/channels.ts", '"background only"')]), []);
  assert.deepEqual(paths(sources, [changed(sources, "server/oauth.ts", "console.info")]), ["/admin/twitch/create"]);
});

test("an omitted patch considers the file's runtime symbols without widening to the entire router", () => {
  const sources = fixture();
  assert.deepEqual(paths(sources, [{ filename: root + "server/db/channels.ts" }]), ["/admin/twitch", "/admin/twitch/edit"]);
});

test("shared tRPC plumbing and type-only dependencies do not imply page changes", () => {
  const sources = fixture();
  sources.set(root + "server/types.ts", "export type Metadata = { value: string };");
  sources.set(root + "server/env.ts", "export const config = {};");
  sources.set(root + "server/trpc/router/admin/users.ts", `import type { Metadata } from "@/server/types";
import { router, publicProcedure } from "../../trpc";
export const usersRouter = router({ getUsers: publicProcedure.query((): Metadata => ({ value: "" })) });`);
  for (const file of ["server/trpc/trpc.ts", "server/trpc/router/_app.ts", "server/types.ts", "server/env.ts"]) {
    assert.deepEqual(paths(sources, [{ filename: root + file }]), [], file);
  }
});

test("client references require a registered procedure and a real runtime client call", () => {
  const sources = fixture();
  sources.set(root + "pages/fake.tsx", `import { trpc } from "@/utils/trpc";
const text = "trpc.adminTwitch.getChannels.useQuery()";
// trpc.adminTwitch.getChannels.useQuery();
type Info = typeof trpc.adminTwitch.getChannels;
function shadow(trpc) { return trpc.adminTwitch.getChannels.useQuery(); }
trpc.adminTwitch.missingProcedure.useQuery();`);
  const changes = [changed(sources, "server/db/channels.ts", "return omitTokens")];
  assert.deepEqual(paths(sources, changes), ["/admin/twitch"]);
  sources.delete(root + "server/trpc/router/_app.ts");
  assert.deepEqual(paths(sources, changes), []);
});

test("nested router registration and namespace client imports preserve procedure paths", () => {
  const sources = fixture();
  sources.set(root + "server/trpc/router/_app.ts", `import { router } from "../trpc";
import { twitchRouter } from "./admin/twitch";
export const appRouter = router({ admin: router({ twitchRouter }) });`);
  sources.set(root + "components/Channels.tsx", `import * as api from "@/utils/trpc";
api.trpc.admin.twitchRouter.getChannels.useQuery();`);
  assert.deepEqual(paths(sources, [changed(sources, "server/db/channels.ts", "return omitTokens")]), ["/admin/twitch"]);
});
