import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { affectedRoutes, linkUrl, overlayLinks, previewCandidates, renderComment, selectLinks } from "./routes.mjs";
import { suggestLinks } from "./ai.mjs";
import { deploymentKey, latestDeployment } from "./deployments.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const marker = "<!-- alveus-preview-links -->";

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    timeout: 180000, stdio: ["pipe", "pipe", "pipe"], ...options });
}

function gh(endpoint, { method = "GET", body, paginate = false } = {}) {
  const args = ["api", endpoint, "--method", method];
  if (paginate) args.push("--paginate", "--slurp");
  if (body) args.push("--input", "-");
  const output = run("gh", args, body ? { input: JSON.stringify(body) } : {});
  const result = output.trim() ? JSON.parse(output) : null;
  return paginate ? result.flat() : result;
}

export async function readSources(directory, sourceRoot) {
  if (await realpath(path.join(directory, sourceRoot)) !== path.resolve(directory, sourceRoot)) {
    throw new Error("Source root must not traverse symlinks");
  }
  const sources = new Map();
  async function visit(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/\.(?:[cm]?[jt]sx?|css|json)$/.test(file) && (await lstat(path.join(directory, file))).size < 200000) {
        sources.set(file, await readFile(path.join(directory, file), "utf8"));
      }
    }
  }
  await visit(sourceRoot);
  return sources;
}

async function checkoutSources(config, sha) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "preview-links-"));
  try {
    const git = (args, options) => run("git", ["-c", "core.hooksPath=/dev/null", "-C", directory, ...args], options);
    git(["init", "--quiet"]);
    git(["remote", "add", "origin", `https://github.com/${config.repository}.git`]);
    git(["fetch", "--quiet", "--depth=1", "--filter=blob:none", "origin", sha]);
    // Fetch only small source files, excluding media. Never install or run PR code.
    git(["sparse-checkout", "set", "--no-cone", "--stdin"], {
      input: ["ts", "tsx", "js", "jsx", "mjs", "css", "json"]
        .map((extension) => `/${config.sourceRoot}**/*.${extension}`).join("\n") + "\n",
    });
    git(["checkout", "--quiet", "--detach", sha]);
    return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export function findOwnedComment(comments, login) {
  return comments.find((comment) => comment.user.login === login && comment.body.startsWith(marker));
}

function removeLegacyComments(repository, comments, login, legacyLogin) {
  if (!legacyLogin || !login?.endsWith("[bot]")) return;
  for (const comment of comments) {
    if (comment.user.login !== legacyLogin || !comment.body.startsWith(marker)) continue;
    gh(`repos/${repository}/issues/comments/${comment.id}`, { method: "DELETE" });
    console.error(`Removed superseded personal automation comment ${comment.html_url ?? comment.id}`);
  }
}

async function stillCurrent(config, pr, deployment) {
  const current = gh(`repos/${config.repository}/pulls/${pr.number}`);
  if (current.state !== "open" || current.head.sha !== pr.head.sha) return false;
  const latest = await latestDeployment(config, current.head.sha, gh);
  return latest !== null && deploymentKey(latest) === deploymentKey(deployment);
}

async function removeUnneededComment(config, pr, deployment, existing) {
  if (!existing) return;
  if (!await stillCurrent(config, pr, deployment)) {
    console.error(`#${pr.number}: changed during analysis; retry cleanup on next run`); return;
  }
  gh(`repos/${config.repository}/issues/comments/${existing.id}`, { method: "DELETE" });
  console.error(`#${pr.number}: removed preview comment without supported page links`);
}

function validateConfig(config) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository)) throw new Error("Invalid repository");
  if (!Number.isInteger(config.maxLinks) || config.maxLinks < 1 || config.maxLinks > 20) throw new Error("maxLinks must be 1–20");
  if (!/^[\w-]+-$/.test(config.deploymentHostPrefix)) throw new Error("Set an exact Vercel project host prefix ending in '-'");
  for (const key of ["sourceRoot", "pagesRoot"]) {
    if (!/^(?:[\w-]+\/)+$/.test(config[key])) throw new Error(`Invalid ${key}`);
  }
  if (!config.pagesRoot.startsWith(config.sourceRoot)) throw new Error("pagesRoot must be within sourceRoot");
  if (!config.dynamicExamples || typeof config.dynamicExamples !== "object") throw new Error("Invalid dynamicExamples");
  if (!Array.isArray(config.deploymentIgnoredPaths ?? []) || (config.deploymentIgnoredPaths ?? []).some((prefix) =>
    typeof prefix !== "string" || !/^(?:[\w.-]+\/)+$/.test(prefix) || prefix.split("/").some((part) => part === "." || part === "..") ||
    prefix.startsWith(config.sourceRoot) || config.sourceRoot.startsWith(prefix))) throw new Error("Invalid deploymentIgnoredPaths");
}

export async function main() {
  const { values } = parseArgs({ options: {
    config: { type: "string", default: path.join(root, "config.json") },
    pr: { type: "string" }, write: { type: "boolean", default: false },
    force: { type: "boolean", default: false }, "no-ai": { type: "boolean", default: false },
    "repo-dir": { type: "string" },
  } });
  const config = JSON.parse(await readFile(values.config, "utf8"));
  // Empty author deliberately means all authors.
  if (process.env.PR_AUTHOR !== undefined) config.author = process.env.PR_AUTHOR;
  validateConfig(config);
  if (values.pr && !/^[1-9]\d*$/.test(values.pr)) throw new Error("--pr must be a positive integer");
  const botLogin = process.env.PREVIEW_BOT_LOGIN;
  const legacyLogin = process.env.PREVIEW_LEGACY_LOGIN;
  if (botLogin && !/^[a-z\d-]+\[bot\]$/i.test(botLogin)) throw new Error("Invalid PREVIEW_BOT_LOGIN");
  if (legacyLogin && !/^[a-z\d-]+$/i.test(legacyLogin)) throw new Error("Invalid PREVIEW_LEGACY_LOGIN");
  // Installation tokens have no /user identity. The pinned token action supplies
  // its authenticated app slug, from which the workflow derives the bot login.
  const login = values.write ? botLogin || gh("user").login : null;
  const fingerprint = createHash("sha256").update(JSON.stringify(config))
    .update(String(!values["no-ai"] && Boolean(process.env.OPENAI_API_KEY)))
    .update(values["no-ai"] ? "no-ai" : process.env.OPENAI_MODEL ?? "no-model")
    .update(process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .update(await readFile(new URL("./routes.mjs", import.meta.url)))
    .update(await readFile(new URL("./trpc.mjs", import.meta.url)))
    .update(await readFile(new URL("./deployments.mjs", import.meta.url)))
    .update(await readFile(new URL("../package.json", import.meta.url)))
    .update(await readFile(new URL("./ai.mjs", import.meta.url)))
    .digest("hex").slice(0, 16);
  const prs = values.pr ? [gh(`repos/${config.repository}/pulls/${values.pr}`)]
    : gh(`repos/${config.repository}/pulls?state=open&per_page=100`, { paginate: true });
  const selected = prs.filter((pr) => pr.state === "open" && (!config.author || pr.user.login === config.author));
  let failed = false;
  for (const pr of selected) {
    let checkout;
    try {
      const deployment = await latestDeployment(config, pr.head.sha, gh);
      if (!deployment) { console.error(`#${pr.number}: waiting for a successful preview matching the current head`); continue; }
      if (deployment.sha !== pr.head.sha) console.error(`#${pr.number}: reusing preview built from ${deployment.sha.slice(0, 7)}; application files match`);
      const state = `<!-- state:${pr.head.sha}:${deploymentKey(deployment)}:${fingerprint} -->`;
      const comments = values.write ? gh(`repos/${config.repository}/issues/${pr.number}/comments?per_page=100`, { paginate: true }) : [];
      const existing = findOwnedComment(comments, login);
      if (!values.force && existing?.body.includes(state)) {
        removeLegacyComments(config.repository, comments, login, legacyLogin);
        console.error(`#${pr.number}: already current`); continue;
      }
      const changes = gh(`repos/${config.repository}/pulls/${pr.number}/files?per_page=100`, { paginate: true });
      if (!changes.some((change) => [change.filename, change.previous_filename]
        .some((file) => file?.startsWith(config.sourceRoot)))) {
        if (values.write) await removeUnneededComment(config, pr, deployment, existing);
        console.error(`#${pr.number}: no website source changes to trace`); continue;
      }
      let directory;
      if (values["repo-dir"]) {
        directory = path.resolve(values["repo-dir"]);
        const head = run("git", ["-C", directory, "rev-parse", "HEAD"]).trim();
        if (head !== pr.head.sha) throw new Error("--repo-dir must be checked out at the PR head; local edits must be absent");
        if (run("git", ["-C", directory, "status", "--porcelain", "--", config.sourceRoot]).trim()) throw new Error("--repo-dir has local source edits");
      } else {
        checkout = await checkoutSources(config, pr.head.sha);
        directory = checkout.directory;
      }
      const sources = await readSources(directory, config.sourceRoot);
      const candidates = previewCandidates(affectedRoutes(sources, changes, config), config);
      let links = selectLinks(candidates, sources, changes, config);
      let ai = false;
      if (candidates.length && !values["no-ai"]) {
        try {
          const suggested = await suggestLinks({ pr, changes, candidates, sources, config, origin: deployment.origin });
          if (suggested) {
            const seen = new Set();
            links = [...overlayLinks(sources, changes, candidates, config), ...suggested].filter((link) => {
              const url = linkUrl(deployment.origin, link);
              if (seen.has(url)) return false;
              seen.add(url); return true;
            }).slice(0, config.maxLinks);
            ai = true;
          }
        } catch (error) { console.error(`#${pr.number}: ${error.message}; using static suggestions`); }
      }
      if (!links.length) {
        if (values.write) await removeUnneededComment(config, pr, deployment, existing);
        console.error(`#${pr.number}: no concrete affected page links found`); continue;
      }
      const body = renderComment({ marker: `${marker}\n${state}`, sha: pr.head.sha, deploymentSha: deployment.sha, origin: deployment.origin,
        links, candidates, ai, title: pr.title, truncated: changes.length >= 3000 || changes.length < pr.changed_files });
      if (!values.write) { console.log(`# PR ${pr.number} — dry run\n\n${body}`); continue; }
      // Avoid posting links for a superseded head or deployment after slow analysis.
      if (!await stillCurrent(config, pr, deployment)) {
        console.error(`#${pr.number}: changed during analysis; retry on next run`); continue;
      }
      const result = existing ? gh(`repos/${config.repository}/issues/comments/${existing.id}`, { method: "PATCH", body: { body } })
        : gh(`repos/${config.repository}/issues/${pr.number}/comments`, { method: "POST", body: { body } });
      if (result.user?.login !== login) throw new Error("Comment author differs from the configured identity; legacy comments were preserved");
      console.error(`#${pr.number}: ${existing ? "updated" : "created"} ${result.html_url}`);
      // Old marked personal comments are removed only after the app has posted
      // successfully. Retrying an unchanged bot comment also retries cleanup.
      removeLegacyComments(config.repository, comments, login, legacyLogin);
    } catch (error) {
      // execFile errors include arguments but no token, since authentication is via gh's environment.
      console.error(`#${pr.number}: ${error.message}`); failed = true;
    } finally { await checkout?.cleanup(); }
  }
  if (failed) process.exitCode = 1;
  if (!selected.length) console.error("No open PRs match the configured author");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
