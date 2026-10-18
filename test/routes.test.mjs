import assert from "node:assert/strict";
import { test } from "node:test";
import { affectedRoutes, deploymentOrigin, imports, linkUrl, pageRoute, renderComment,
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
  for (const file of ["api/cron.ts", "_app.tsx", "404.tsx", "auth/signout.tsx", "oauth/authorize.tsx"]) {
    assert.equal(pageRoute(config.pagesRoot + file, config.pagesRoot), null);
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
  assert.equal(links.length, 6);
  assert.equal(new Set(links.map((link) => link.path)).size, 6);
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
});
