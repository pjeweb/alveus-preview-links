import assert from "node:assert/strict";
import { test } from "node:test";
import { affectedRoutes, concretePaths, deploymentOrigin, imports, linkUrl, pageRoute, previewCandidates, renderComment,
  selectLinks, validateAiLinks } from "../src/routes.mjs";
import { findOwnedComment } from "../src/bot.mjs";
import { suggestLinks } from "../src/ai.mjs";

const config = { sourceRoot: "apps/website/src/", pagesRoot: "apps/website/src/pages/", maxLinks: 6, dynamicExamples: {} };
const root = config.sourceRoot;
const origin = "https://alveusgg-website-example-alveus.vercel.app";
const sources = new Map([
  [root + "pages/stream/overlay.tsx", `import { theme } from "@/data/stream-themes.js";
    import artwork from "@/assets/stream/border-6cam-wolf-week.webm";
    const layouts = ["fullscreen", "4cam", "6cam"];
    const value = query.theme; const layout = query.layout;`],
  [root + "data/stream-themes.js", `export const theme = { theme: "wolf-week" };`],
  [root + "components/Box.tsx", `import { theme } from "../data/stream-themes.js";`],
  [root + "components/index.ts", `export { Box } from "./Box";`],
  [root + "pages/about.tsx", `import { Box } from "@/components";`],
  [root + "pages/ambassadors/[ambassadorName].tsx", `import { Box } from "@/components";`],
  [root + "pages/unaffected.tsx", `export default function Page() {}`],
]);
const changes = [{ filename: root + "data/stream-themes.js", patch: '+ const theme = "wolf-week";' },
  { filename: root + "assets/stream/border-6cam-wolf-week.webm" },
  { filename: root + "pages/stream/overlay.tsx", patch: '+ import border from "border-6cam-wolf-week.webm";' }];

test("maps only navigable Pages Router files to routes", () => {
  assert.equal(pageRoute(config.pagesRoot + "index.tsx", config.pagesRoot), "/");
  assert.equal(pageRoute(config.pagesRoot + "about/index.tsx", config.pagesRoot), "/about");
  assert.equal(pageRoute(config.pagesRoot + "auth/signin.tsx", config.pagesRoot), "/auth/signin");
  assert.equal(pageRoute(config.pagesRoot + "auth/signin/index.tsx", config.pagesRoot), "/auth/signin");
  for (const file of ["api/cron.ts", "_app.tsx", "404.tsx", "auth/signout.tsx", "auth/callback.tsx",
    "auth/signin/callback.tsx", "oauth/authorize.tsx"]) {
    assert.equal(pageRoute(config.pagesRoot + file, config.pagesRoot), null);
  }
});

test("sign-in changes produce preview links without including authentication actions", () => {
  const form = root + "components/SignInForm.tsx";
  const signin = config.pagesRoot + "auth/signin.tsx";
  const actions = ["auth/signout.tsx", "auth/callback.tsx", "oauth/authorize.tsx", "api/auth/[...nextauth].ts"];
  const graph = new Map([
    [form, ""],
    [signin, `import Form from "@/components/SignInForm"; import "@/server/auth";`],
    [root + "server/auth.ts", ""],
    ...actions.map((file) => [config.pagesRoot + file, `import Form from "@/components/SignInForm";`]),
    [config.pagesRoot + "about.tsx", ""],
  ]);
  for (const filename of [signin, form]) {
    const diff = [{ filename }];
    const candidates = affectedRoutes(graph, diff, config);
    assert.deepEqual(candidates.map((candidate) => candidate.route), ["/auth/signin"]);
    const links = selectLinks(candidates, graph, diff, config);
    assert.deepEqual(links.map((link) => linkUrl(origin, link)), [`${origin}/auth/signin`]);
  }
  for (const filename of [root + "server/auth.ts", ...actions.map((file) => config.pagesRoot + file)]) {
    assert.deepEqual(affectedRoutes(graph, [{ filename }], config), []);
  }
});

test("follows assets, relative imports, barrels, dynamic imports and TS .js aliases", () => {
  const result = affectedRoutes(sources, changes, config);
  assert.equal(result[0].route, "/stream/overlay");
  assert.ok(result.some((item) => item.route === "/about"));
  assert.ok(!result.some((item) => item.route === "/unaffected"));
  const assetOnly = affectedRoutes(sources, changes.slice(1, 2), config);
  assert.deepEqual(assetOnly.map((item) => item.route), ["/stream/overlay"]);
  assert.deepEqual(imports(`import("@/async"); const x = require('./legacy'); import "./style.css";`),
    ["@/async", "./legacy", "./style.css"]);
  const aliasSources = new Map([[root + "pages/test.tsx", `import x from "../foo.js";`], [root + "foo.ts", ""]]);
  assert.equal(affectedRoutes(aliasSources, [{ filename: root + "foo.ts" }], config)[0].route, "/test");
});

test("shared app changes affect every page, with directly changed pages first", () => {
  const withApp = new Map(sources);
  withApp.set(config.pagesRoot + "_app.tsx", `import "@/data/stream-themes.js";`);
  const candidates = affectedRoutes(withApp, changes, config);
  assert.ok(candidates.some((item) => item.route === "/unaffected"));
  assert.equal(candidates[0].route, "/stream/overlay");
});

test("produces forced theme, automatic schedule and fallback URLs without AI", () => {
  const candidates = affectedRoutes(sources, changes, config);
  const links = selectLinks(candidates, sources, changes, config);
  assert.equal(linkUrl(origin, links[0]), `${origin}/stream/overlay?layout=6cam&theme=wolf-week`);
  assert.equal(linkUrl(origin, links[1]), `${origin}/stream/overlay?layout=6cam&theme=auto`);
  assert.equal(linkUrl(origin, links[2]), `${origin}/stream/overlay?layout=4cam&theme=wolf-week`);
  assert.ok(links.every((link) => !link.path.includes("[")));
  assert.ok(links.length <= config.maxLinks);
});

test("caps broad changes and chooses more than one site area", () => {
  const many = new Map(Array.from({ length: 30 }, (_, i) => [config.pagesRoot + `area${i}/index.tsx`, ""]));
  many.set(config.pagesRoot + "_app.tsx", "");
  const candidates = affectedRoutes(many, [{ filename: config.pagesRoot + "_app.tsx" }], config);
  const links = selectLinks(candidates, many, [], config);
  assert.equal(links.length, 3);
  assert.equal(new Set(links.map((link) => link.path)).size, 3);
  const pages = ["about/a", "about/b", "about/c", "about/d", "ambassadors", "animal-quest", "contact", "donate"];
  const direct = new Map(pages.map((page) => [config.pagesRoot + `${page}.tsx`, ""]));
  const diff = [...direct.keys()].map((filename) => ({ filename }));
  const sample = selectLinks(affectedRoutes(direct, diff, config), direct, diff, config);
  assert.equal(sample.length, 6);
  assert.equal(new Set(sample.map((link) => link.path.split("/")[1])).size, 5);
});

test("ignores type-only edges and keeps page exports from spreading into navigation", () => {
  assert.deepEqual(imports(`import type { A } from "@/server/router";
    export type { B } from "./types";
    import { type C, type D } from "./only-types";
    export { type E } from "./more-types";
    import { type F, realValue } from "./runtime";
    export { realValue } from "./barrel";`), ["./runtime", "./barrel"]);
  const graph = new Map([
    [root + "components/RenameStep.tsx", ""],
    [root + "pages/rename.tsx", `import Step from "@/components/RenameStep";`],
    [root + "data/navigation.ts", `import type { Props } from "@/pages/rename";
      export { getStaticProps } from "@/pages/rename";`],
    [root + "pages/_app.tsx", `import "@/data/navigation";`],
    [root + "pages/about.tsx", ""],
  ]);
  assert.deepEqual(affectedRoutes(graph, [{ filename: root + "components/RenameStep.tsx" }], config)
    .map((candidate) => candidate.route), ["/rename"]);
});

test("backend/env changes do not imply that every tRPC consumer needs a preview", () => {
  const graph = new Map([
    [root + "server/router.ts", `import "@/env/index.js";`],
    [root + "env/index.js", ""],
    [root + "utils/trpc.ts", `import { router } from "@/server/router";`],
    [root + "pages/_app.tsx", `import "@/utils/trpc";`],
    [root + "pages/about.tsx", `import "@/utils/trpc";`],
  ]);
  assert.deepEqual(affectedRoutes(graph, [
    { filename: root + "server/router.ts" }, { filename: root + "env/index.js" },
  ], config), []);
});

test("presets UI links only its four changed pages, without an unrelated overlay", () => {
  const pages = ["about/tech/index", "about/tech/commands", "about/tech/presets", "admin/presets"];
  const graph = new Map(sources);
  for (const page of pages) graph.set(root + `pages/${page}.tsx`, "");
  graph.set(root + "pages/_app.tsx", `import "@/server/trpc/router/stream";`);
  graph.set(root + "server/trpc/router/stream.ts", "");
  const diff = pages.map((page) => ({ filename: root + `pages/${page}.tsx` }))
    .concat({ filename: root + "server/trpc/router/stream.ts", patch: "+ preset endpoint" });
  const links = selectLinks(affectedRoutes(graph, diff, config), graph, diff, config);
  assert.deepEqual(links.map((link) => link.path), ["/about/tech", "/about/tech/commands", "/about/tech/presets", "/admin/presets"]);
  const one = diff.slice(1, 2);
  assert.deepEqual(selectLinks(affectedRoutes(graph, one, config), graph, one, config).map((link) => link.path), ["/about/tech/commands"]);
});

test("pixel rename PRs resolve both real mural IDs from their static-path catalogue", () => {
  const index = root + "pages/institute/pixels/[mural]/index.tsx";
  const rename = root + "pages/institute/pixels/[mural]/rename.tsx";
  const graph = new Map([
    [root + "data/murals.ts", `const murals = {
      one: { name: "Braces { in text }", grid: { rows: 50 } },
      two: { type: "live" },
    }; export default murals;`],
    [index, `import murals, { type MuralId, isMuralId } from "@/data/murals";
      export const getStaticPaths = () => ({ paths: typeSafeObjectKeys(murals).map((key) => ({
        params: { mural: camelToKebab(key) },
      })) });`],
    [rename, `import type { Props } from "./index";
      export { getStaticPaths, getStaticProps } from "./index";`],
    [root + "pages/about.tsx", ""],
  ]);
  const diff = [{ filename: rename }];
  const candidates = affectedRoutes(graph, diff, config);
  const links = selectLinks(candidates, graph, diff, config);
  assert.deepEqual(links.map((link) => link.path), ["/institute/pixels/one/rename", "/institute/pixels/two/rename"]);
  const aiLink = { ...links[1] };
  assert.equal(validateAiLinks([aiLink], candidates, graph, config, origin)[0].path, aiLink.path);
  assert.throws(() => validateAiLinks([{ ...aiLink, path: "/institute/pixels/invented/rename" }], candidates, graph, config, origin));
  graph.set(rename, "export default function Page() {}");
  assert.deepEqual(concretePaths(candidates[0], graph, config), [], "Must verify the page actually uses these static paths");
});

test("local data changes select their nearest pages rather than the shared navigation shell", () => {
  const graph = new Map([
    [root + "data/catalogue.ts", ""],
    [root + "pages/feature.tsx", `import "@/data/catalogue";`],
    [root + "components/Nav.tsx", `import "@/data/catalogue";`],
    [root + "pages/_app.tsx", `import "@/components/Nav";`],
    [root + "pages/about.tsx", ""],
  ]);
  const diff = [{ filename: root + "data/catalogue.ts" }];
  const candidates = previewCandidates(affectedRoutes(graph, diff, config), config);
  assert.deepEqual(candidates.map((candidate) => candidate.route), ["/feature"]);
  assert.equal(selectLinks(candidates, graph, diff, config).length, 1);
});

test("accepts only the intended Vercel project's HTTPS origin", () => {
  assert.equal(deploymentOrigin(origin, "alveusgg-website-"), origin);
  for (const value of ["http://alveusgg-website-example.vercel.app", "https://other.vercel.app", "https://alveusgg-website-x.vercel.app.evil.test", `${origin}/foo`, `https://user:pass@${new URL(origin).hostname}`]) {
    assert.throws(() => deploymentOrigin(value, "alveusgg-website-"));
  }
  for (const value of ["//evil.test", "/\\evil.test", "/../api", "/%2e%2e/api", "/ambassadors/[name]"]) {
    assert.throws(() => linkUrl(origin, { path: value, query: [] }));
  }
});

test("rejects hallucinated AI routes, query keys, query values, and domains", () => {
  const candidates = affectedRoutes(sources, changes, config);
  const good = { path: "/stream/overlay", label: "Overlay", reason: "Check artwork", query: [{ key: "theme", value: "wolf-week" }] };
  assert.deepEqual(validateAiLinks([good], candidates, sources, config, origin), [{ ...good, route: good.path }]);
  for (const bad of [{ ...good, path: "/invented" }, { ...good, path: "https://evil.test" },
    { ...good, query: [{ key: "redirect", value: "https://evil.test" }] },
    { ...good, query: [{ key: "theme", value: "invented" }] }]) {
    assert.throws(() => validateAiLinks([bad], candidates, sources, config, origin));
  }
});

test("updates only the current account's own marked comment", () => {
  const comments = [
    { id: 1, user: { login: "other" }, body: "<!-- alveus-preview-links -->" },
    { id: 2, user: { login: "pjeweb" }, body: "Ordinary discussion" },
    { id: 3, user: { login: "pjeweb" }, body: "<!-- alveus-preview-links -->\nPreview" },
  ];
  assert.equal(findOwnedComment(comments, "pjeweb").id, 3);
  const text = renderComment({ marker: "marker", sha: "a".repeat(40), origin, links: [
    { path: "/about", query: [], label: "@everyone [click](bad)", reason: "<script>" },
  ], candidates: [], ai: false });
  assert.ok(!text.includes("@everyone"));
  assert.ok(!text.includes("<script>"));
});

test("AI is opt-in and uses structured Responses output with bounded input", async () => {
  const context = { pr: { title: "test" }, changes, candidates: affectedRoutes(sources, changes, config), sources, config, origin };
  assert.equal(await suggestLinks(context, {}, () => { throw new Error("Must not call"); }), null);
  let request;
  const fetcher = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ status: "completed", output: [{ content: [
      { type: "output_text", text: JSON.stringify({ links: [{ path: "/about", query: [], label: "About", reason: "Check component" }] }) },
    ] }] }) };
  };
  const links = await suggestLinks(context, { OPENAI_API_KEY: "fake-test-key", OPENAI_MODEL: "chosen-model" }, fetcher);
  assert.equal(links[0].path, "/about");
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.model, "chosen-model");
  const empty = await suggestLinks(context, { OPENAI_API_KEY: "fake-test-key", OPENAI_MODEL: "chosen-model" },
    async () => ({ ok: true, json: async () => ({ status: "completed", output: [{ content: [
      { type: "output_text", text: '{"links":[]}' },
    ] }] }) }));
  assert.deepEqual(empty, [], "A supported empty answer must suppress suggestions rather than trigger static fallback");
});
