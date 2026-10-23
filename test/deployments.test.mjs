import assert from "node:assert/strict";
import { test } from "node:test";
import { latestDeployment } from "../src/deployments.mjs";

const config = { repository: "alveusgg/alveusgg", deploymentCreator: "vercel[bot]",
  deploymentHostPrefix: "alveusgg-website-", deploymentIgnoredPaths: ["apps/website/__tests__/"] };
const prefix = `repos/${config.repository}`;
const head = "a".repeat(40);
const parent = "b".repeat(40);
const built = "c".repeat(40);
const origin = "https://alveusgg-website-redeployed-alveus.vercel.app";
const deployments = (sha) => `${prefix}/deployments?sha=${sha}&per_page=100`;
const comparison = (sha) => `${prefix}/compare/${sha}...${head}`;
const statuses = (id) => `${prefix}/deployments/${id}/statuses?per_page=1`;
const ready = (sha, id = 1) => ({ id, sha, creator: { login: config.deploymentCreator }, environment: "Preview", production_environment: false });
const compare = (sha, parents, files) => ({ status: "ahead", base_commit: { sha, parents: parents.map((sha) => ({ sha })) },
  merge_base_commit: { sha }, files });

function fixture() {
  const responses = new Map([
    [deployments(head), []],
    [`${prefix}/git/commits/${head}`, { sha: head, parents: [{ sha: parent }] }],
    [comparison(parent), compare(parent, [built], [])],
    [deployments(parent), [ready(parent, 2)]],
    [statuses(2), [{ state: "failure", description: "Canceled" }]],
    [comparison(built), compare(built, [], [{ filename: "apps/website/__tests__/give-an-hour.test.ts", status: "modified" }])],
    [deployments(built), [ready(built)]],
    [statuses(1), [{ state: "success", environment_url: origin },
      { state: "success", environment_url: "https://alveusgg-website-original-alveus.vercel.app" }]],
  ]);
  const calls = [];
  const api = async (endpoint) => {
    calls.push(endpoint);
    assert.ok(responses.has(endpoint), `Unexpected API request: ${endpoint}`);
    return responses.get(endpoint);
  };
  return { responses, calls, api };
}

test("ignored follow-ups reuse the newest successful ancestor preview after verifying test-only differences", async () => {
  const { api } = fixture();
  assert.deepEqual(await latestDeployment(config, head, api), { id: 1, sha: built, origin });
});

test("a successful exact-head preview takes precedence without searching history", async () => {
  const { api, responses, calls } = fixture();
  responses.set(deployments(head), [ready(head)]);
  assert.deepEqual(await latestDeployment(config, head, api), { id: 1, sha: head, origin });
  assert.ok(!calls.some((endpoint) => endpoint.includes("/compare/") || endpoint.includes("/git/commits/")));
});

test("empty commits need no path exclusions", async () => {
  const { api, responses } = fixture();
  responses.set(deployments(parent), [ready(parent)]);
  assert.deepEqual(await latestDeployment({ ...config, deploymentIgnoredPaths: [] }, head, api), { id: 1, sha: parent, origin });
});

test("runtime, dependency, build configuration and unapproved test changes prevent ancestor reuse", async () => {
  for (const file of [
    { filename: "apps/website/src/pages/show-and-tell/give-an-hour.tsx" },
    { filename: "pnpm-lock.yaml" },
    { filename: "apps/database/prisma/schema.prisma" },
    { filename: "apps/website/vercel.json" },
    { filename: "apps/website/__tests__-other/fixture.ts" },
    { filename: "apps/website/__tests__/moved.ts", previous_filename: "apps/website/src/runtime.ts", status: "renamed" },
    { filename: "apps/website/__tests__/moved.ts", status: "renamed" },
  ]) {
    const { api, responses, calls } = fixture();
    responses.set(comparison(parent), compare(parent, [built], [file]));
    assert.equal(await latestDeployment(config, head, api), null, file.filename);
    assert.ok(!calls.includes(deployments(parent)), "An unverified ancestor must not be selected");
  }
});

test("missing or potentially truncated comparison files do not prove equivalence", async () => {
  for (const files of [undefined, Array.from({ length: 300 }, (_, i) => ({ filename: `apps/website/__tests__/${i}.ts` }))]) {
    const { api, responses } = fixture();
    responses.set(comparison(parent), compare(parent, [built], files));
    assert.equal(await latestDeployment(config, head, api), null);
  }
});

test("comparison must prove that the chosen commit is an ancestor", async () => {
  for (const override of [{ status: "diverged" }, { merge_base_commit: { sha: built } }, { base_commit: { sha: built } }]) {
    const { api, responses } = fixture();
    responses.set(comparison(parent), { ...compare(parent, [built], []), ...override });
    assert.equal(await latestDeployment(config, head, api), null);
  }
});

test("only successful Vercel previews for the requested SHA and project are eligible", async () => {
  const { api, responses } = fixture();
  responses.set(deployments(head), [
    { ...ready(head, 3), production_environment: true },
    { ...ready(head, 4), creator: { login: "someone-else" } },
    { ...ready(head, 5), environment: "Production" },
    ready(parent, 6), ready(head, 7), ready(head, 8), ready(head),
  ]);
  responses.set(statuses(7), [{ state: "success", environment_url: "https://other-project-test.vercel.app" }]);
  responses.set(statuses(8), [{ state: "error" }, { state: "success", environment_url: origin }]);
  assert.deepEqual(await latestDeployment(config, head, api), { id: 1, sha: head, origin });
});

test("an ancestor's newest non-success status cannot be replaced by historical success", async () => {
  for (const state of ["failure", "error", "inactive", "pending", "in_progress", "queued"]) {
    const { api, responses } = fixture();
    responses.set(statuses(1), [{ state, environment_url: origin }, { state: "success", environment_url: origin }]);
    assert.equal(await latestDeployment(config, head, api), null, state);
  }
});

test("ancestry search stops before an unbounded history walk", async () => {
  const { api, responses } = fixture();
  const ancestors = Array.from({ length: 22 }, (_, i) => (i + 1).toString(16).padStart(40, "0"));
  responses.set(`${prefix}/git/commits/${head}`, { sha: head, parents: [{ sha: ancestors[0] }] });
  for (let i = 0; i < ancestors.length - 1; i++) {
    responses.set(comparison(ancestors[i]), compare(ancestors[i], [ancestors[i + 1]], []));
    responses.set(deployments(ancestors[i]), i === 20 ? [ready(ancestors[i])] : []);
  }
  assert.equal(await latestDeployment(config, head, api), null);
});
