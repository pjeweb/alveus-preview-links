import { deploymentOrigin } from "./routes.mjs";

export function deploymentKey(deployment) {
  return `${deployment.id}:${deployment.sha}:${deployment.origin}`;
}

async function successfulDeployment(config, sha, api) {
  const deployments = await api(`repos/${config.repository}/deployments?sha=${sha}&per_page=100`, { paginate: true });
  for (const deployment of deployments) {
    if (deployment.sha !== sha || deployment.creator?.login !== config.deploymentCreator || deployment.production_environment ||
        !/^preview(?:\b|$)/i.test(deployment.environment)) continue;
    const statuses = await api(`repos/${config.repository}/deployments/${deployment.id}/statuses?per_page=1`);
    const status = statuses[0];
    if (status?.state !== "success" || !status.environment_url) continue;
    try {
      return { id: deployment.id, sha, origin: deploymentOrigin(status.environment_url, config.deploymentHostPrefix) };
    } catch { /* A different Vercel project in the same repository. */ }
  }
  return null;
}

function equivalentFiles(comparison, sha, ignoredPaths) {
  if (comparison.status !== "ahead" || comparison.base_commit?.sha !== sha || comparison.merge_base_commit?.sha !== sha) return false;
  // GitHub caps comparison file lists at 300, so never treat a potentially
  // truncated diff as proof that only excluded files changed.
  if (!Array.isArray(comparison.files) || comparison.files.length >= 300) return false;
  return comparison.files.every((file) => {
    if (typeof file.filename !== "string" || (file.status === "renamed" && typeof file.previous_filename !== "string")) return false;
    return [file.filename, file.previous_filename].filter((name) => name !== undefined)
      .every((name) => typeof name === "string" && ignoredPaths.some((prefix) => name.startsWith(prefix)));
  });
}

export async function latestDeployment(config, sha, api) {
  const exact = await successfulDeployment(config, sha, api);
  if (exact) return exact;
  const commit = await api(`repos/${config.repository}/git/commits/${sha}`);
  if (commit.sha !== sha) return null;
  let ancestor = commit.parents?.[0]?.sha;
  // A bounded first-parent walk handles empty/test-only follow-ups, including
  // fork PRs. Stop at the first application change instead of guessing which
  // branch alias or historical deployment happens to serve the latest code.
  for (let depth = 0; ancestor && depth < 20; depth++) {
    const comparison = await api(`repos/${config.repository}/compare/${ancestor}...${sha}`);
    if (!equivalentFiles(comparison, ancestor, config.deploymentIgnoredPaths ?? [])) return null;
    const deployment = await successfulDeployment(config, ancestor, api);
    if (deployment) return deployment;
    ancestor = comparison.base_commit.parents?.[0]?.sha;
  }
  return null;
}
