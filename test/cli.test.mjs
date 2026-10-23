import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const bot = fileURLToPath(new URL("../src/bot.mjs", import.meta.url));
const prefix = "repos/alveusgg/alveusgg";

test("CLI posting, deduplication, stale heads, and safe migration to an app identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "preview-bot-test-"));
  try {
    const repo = path.join(directory, "repo");
    await mkdir(path.join(repo, "apps/website/src/pages"), { recursive: true });
    await writeFile(path.join(repo, "apps/website/src/pages/about.tsx"), "export default function Page() {}\n");
    const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init", "--quiet"]); git(["add", "."]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
    const sha = git(["rev-parse", "HEAD"]).trim();
    const statePath = path.join(directory, "state.json");
    let state = { sha, deployment: 1, comments: [], writes: [], reads: [], headReads: 0 };
    await writeFile(statePath, JSON.stringify(state));
    const fake = path.join(directory, "gh");
    await writeFile(fake, `#!/usr/bin/env node
      const fs = require('node:fs');
      const state = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, 'utf8'));
      const endpoint = process.argv[3];
      const method = process.argv[process.argv.indexOf('--method') + 1];
      const prefix = ${JSON.stringify(prefix)};
      let result;
      if (method === 'DELETE') {
        state.writes.push({endpoint, method});
        const id = Number(endpoint.split('/').pop());
        state.comments = state.comments.filter(comment => comment.id !== id);
      } else if (method !== 'GET') {
        const body = JSON.parse(fs.readFileSync(0, 'utf8'));
        state.writes.push({endpoint, method, body});
        const id = method === 'PATCH' ? Number(endpoint.split('/').pop()) : (state.nextId ?? 42);
        if (method === 'POST') state.nextId = id + 1;
        const comment = {id, user: {login: state.appLogin || 'test-user'}, body: body.body, html_url: 'https://github.com/example/comment/' + id};
        state.comments = state.comments.filter(existing => existing.id !== id).concat(comment); result = comment;
      } else {
        state.reads.push(endpoint);
        if (endpoint === 'user') {
          if (state.appLogin) throw new Error('Installation tokens cannot use /user');
          result = {login: 'test-user'};
        }
        else if (endpoint === prefix + '/pulls/2468') {
          state.headReads++;
          const head = state.stale && state.headReads > 1 ? 'b'.repeat(40) : state.sha;
          result = {number: 2468, state: 'open', title: 'About page', user: {login:'someone-else'}, head: {sha:head}};
        } else if (endpoint.includes('/deployments?')) {
          result = state.deploymentSha && endpoint.includes('sha=' + state.sha) ? []
            : [{id:state.deployment, sha:state.deploymentSha || state.sha, creator:{login:'vercel[bot]'}, production_environment:false, environment:'Preview'}];
        } else if (endpoint.includes('/statuses?')) {
          state.statusReads = (state.statusReads || 0) + 1;
          result = [{state:'success', environment_url:state.raceOrigin && state.statusReads > 1
            ? state.raceOrigin : state.origin || 'https://alveusgg-website-example-alveus.vercel.app'}];
        } else if (endpoint.includes('/git/commits/')) result = {sha:state.sha, parents:[{sha:state.deploymentSha}]};
        else if (endpoint.includes('/compare/')) result = {status:'ahead', base_commit:{sha:state.deploymentSha, parents:[]},
          merge_base_commit:{sha:state.deploymentSha}, files:[{filename:'apps/website/__tests__/about.test.ts'}]};
        else if (endpoint.includes('/comments?')) result = state.comments;
        else if (endpoint.endsWith('/files?per_page=100')) result = state.changes || [{filename:'apps/website/src/pages/about.tsx', patch:'+ changed'}];
        else throw new Error('Unexpected mock endpoint: ' + endpoint);
      }
      fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(state));
      if (method !== 'DELETE') process.stdout.write(JSON.stringify(process.argv.includes('--slurp') ? [result] : result));
    `);
    await chmod(fake, 0o755);
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, GH_FIXTURE: statePath, OPENAI_API_KEY: "", PR_AUTHOR: "",
      PREVIEW_BOT_LOGIN: "", PREVIEW_LEGACY_LOGIN: "" };
    const run = (extra = [], overrides = {}) => execFileSync(process.execPath, [bot, "--pr", "2468", "--repo-dir", repo, "--no-ai", ...extra],
      { env: { ...env, ...overrides }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const read = async () => JSON.parse(await readFile(statePath, "utf8"));
    assert.match(run(), /dry run/);
    assert.equal((await read()).writes.length, 0);
    run(["--write"]);
    state = await read();
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].method, "POST");
    assert.match(state.writes[0].body.body, /\/about/);
    run(["--write"]);
    state = await read();
    assert.equal(state.writes.length, 1, "Unchanged deployments must not post again");
    state.deployment = 2;
    await writeFile(statePath, JSON.stringify(state));
    run(["--write"]);
    state = await read();
    assert.equal(state.writes.length, 2);
    assert.equal(state.writes[1].method, "PATCH");
    assert.equal(state.writes[1].endpoint, `${prefix}/issues/comments/42`);
    state.stale = true; state.headReads = 0;
    await writeFile(statePath, JSON.stringify(state));
    run(["--write", "--force"]);
    assert.equal((await read()).writes.length, 2, "A superseded PR head must not post");

    // Moving to an app needs a new author, not an edit of the personal comment.
    state = await read();
    state.stale = false; state.headReads = 0; state.reads = [];
    state.appLogin = "preview-example[bot]";
    state.comments.push({ id: 99, user: { login: "unrelated-user" }, body: "<!-- alveus-preview-links -->\nKeep this" });
    state.comments.push({ id: 100, user: { login: "test-user" }, body: "Ordinary discussion: keep this" });
    await writeFile(statePath, JSON.stringify(state));
    const appEnv = { PREVIEW_BOT_LOGIN: state.appLogin, PREVIEW_LEGACY_LOGIN: "test-user" };
    run(["--write"], appEnv);
    state = await read();
    assert.ok(!state.reads.includes("user"), "App authentication must not call /user");
    assert.equal(state.writes[2].method, "POST");
    assert.equal(state.writes[3].method, "DELETE");
    assert.equal(state.writes[3].endpoint, `${prefix}/issues/comments/42`);
    assert.deepEqual(state.comments.map(comment => comment.id).sort((a, b) => a - b), [43, 99, 100]);
    assert.equal(state.comments.find(comment => comment.id === 43).user.login, state.appLogin);

    // If a cleanup attempt failed after posting, the next run retries cleanup
    // without creating another app comment or deleting ordinary discussion.
    state.comments.push({ id: 101, user: { login: "test-user" }, body: "<!-- alveus-preview-links -->\nOld automation" });
    await writeFile(statePath, JSON.stringify(state));
    run(["--write"], appEnv);
    state = await read();
    assert.equal(state.writes.length, 5);
    assert.equal(state.writes[4].method, "DELETE");
    assert.deepEqual(state.comments.map(comment => comment.id).sort((a, b) => a - b), [43, 99, 100]);

    // A corrected analysis with no supported pages removes the app's obsolete
    // automation comment, preserving ordinary discussion and other authors.
    state.comments.push({ id: 102, user: { login: state.appLogin }, body: "Ordinary app discussion: keep this" });
    state.changes = [{ filename: "apps/website/src/server/utils/encryption.ts" }];
    state.stale = true; state.headReads = 0;
    await writeFile(statePath, JSON.stringify(state));
    run(["--write", "--force"], appEnv);
    assert.equal((await read()).writes.length, 5, "A superseded head must not delete a comment");
    state = await read(); state.stale = false; state.headReads = 0;
    await writeFile(statePath, JSON.stringify(state));
    run(["--write", "--force"], appEnv);
    state = await read();
    assert.equal(state.writes.length, 6);
    assert.equal(state.writes[5].method, "DELETE");
    assert.equal(state.writes[5].endpoint, `${prefix}/issues/comments/43`);
    assert.deepEqual(state.comments.map(comment => comment.id).sort((a, b) => a - b), [99, 100, 102]);

    // Vercel can reuse a GitHub deployment ID when a redeploy changes its URL.
    state.changes = [{ filename: "apps/website/src/pages/about.tsx" }];
    await writeFile(statePath, JSON.stringify(state));
    run(["--write"], appEnv);
    state = await read();
    const writesBeforeRedeploy = state.writes.length;
    state.origin = "https://alveusgg-website-redeployed-alveus.vercel.app";
    await writeFile(statePath, JSON.stringify(state));
    run(["--write"], appEnv);
    state = await read();
    assert.equal(state.writes.length, writesBeforeRedeploy + 1, "A new URL on the same deployment ID must refresh the comment");
    assert.equal(state.writes.at(-1).method, "PATCH");
    assert.ok(state.writes.at(-1).body.body.includes(state.origin));

    // Reusing an ancestor must identify the actual deployed commit and dedupe.
    state.deploymentSha = "c".repeat(40);
    await writeFile(statePath, JSON.stringify(state));
    run(["--write"], appEnv);
    state = await read();
    assert.equal(state.writes.length, writesBeforeRedeploy + 2);
    assert.match(state.writes.at(-1).body.body, /Deployment built from `ccccccc`/);
    run(["--write"], appEnv);
    assert.equal((await read()).writes.length, state.writes.length, "Equivalent previews must dedupe like exact-head previews");

    // A redeploy during analysis invalidates the selected preview, even when
    // the head and GitHub deployment ID have not changed.
    state.raceOrigin = "https://alveusgg-website-newer-alveus.vercel.app";
    state.statusReads = 0;
    await writeFile(statePath, JSON.stringify(state));
    run(["--write", "--force"], appEnv);
    assert.equal((await read()).writes.length, state.writes.length, "A superseded deployment URL must not post");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
