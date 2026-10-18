import path from "node:path/posix";

const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".json"];

export function pageRoute(file, pagesRoot) {
  if (!file.startsWith(pagesRoot) || !/\.[jt]sx?$/.test(file)) return null;
  const relative = file.slice(pagesRoot.length).replace(/\.[jt]sx?$/, "");
  const route = relative.replace(/(?:^|\/)index$/, "");
  if (/^(?:api|auth|oauth)(?:\/|$)/.test(route) && route !== "auth/signin") return null;
  if (/(?:^|\/)_/.test(relative) || /^(?:404|500|unauthorized)$/.test(relative)) return null;
  return `/${route}`;
}

// Deliberately static: no imports or other code from a PR are executed.
export function imports(source) {
  const found = [];
  for (const match of source.matchAll(/\b(?:import|export)\s+([^;"']*?)\s+from\s*["']([^"']+)["']/g)) {
    const clause = match[1].trim();
    if (/^type\b/.test(clause)) continue;
    const names = clause.match(/^\{([\s\S]*)\}$/)?.[1].split(",").map((name) => name.trim()).filter(Boolean);
    if (names?.length && names.every((name) => /^type\s/.test(name))) continue;
    found.push({ index: match.index, value: match[2] });
  }
  for (const match of source.matchAll(/\b(?:import\s*|(?:import|require)\s*\(\s*)["']([^"']+)["']/g)) {
    found.push({ index: match.index, value: match[1] });
  }
  return found.sort((a, b) => a.index - b.index).map((match) => match.value);
}

function clientSource(file, config) {
  if (!file.startsWith(config.sourceRoot)) return false;
  // The sign-in screen is a navigable page, unlike authentication actions.
  if (pageRoute(file, config.pagesRoot) === "/auth/signin") return true;
  // Server/env/type plumbing connects most of the site without demonstrating
  // that a particular screen changed. Do not use it as an impact edge or seed.
  return !/^(?:server|env|types|app\/api|pages\/(?:api|auth|oauth))(?:\/|\.)/.test(file.slice(config.sourceRoot.length));
}

function resolveImport(file, specifier, sources, sourceRoot) {
  let base;
  if (specifier.startsWith("@/")) base = sourceRoot + specifier.slice(2);
  else if (specifier.startsWith(".")) base = path.normalize(path.join(path.dirname(file), specifier));
  else return null;
  const bases = /\.[jm]sx?$/.test(base) ? [base, base.replace(/\.[jm]sx?$/, "")] : [base];
  for (const candidate of bases) {
    for (const extension of extensions) {
      if (sources.has(candidate + extension)) return candidate + extension;
    }
    for (const extension of extensions.slice(1)) {
      if (sources.has(`${candidate}/index${extension}`)) return `${candidate}/index${extension}`;
    }
  }
  // Asset blobs are not downloaded, but imports still connect changes to pages.
  return base;
}

export function affectedRoutes(sources, changes, config) {
  const reverse = new Map();
  for (const [file, source] of sources) {
    if (!clientSource(file, config)) continue;
    for (const specifier of imports(source)) {
      const dependency = resolveImport(file, specifier, sources, config.sourceRoot);
      if (!dependency || !clientSource(dependency, config)) continue;
      if (!reverse.has(dependency)) reverse.set(dependency, new Set());
      reverse.get(dependency).add(file);
    }
  }
  const distances = new Map();
  const evidence = new Map();
  const queue = [];
  for (const change of changes) {
    for (const file of [change.filename, change.previous_filename].filter(Boolean)) {
      if (clientSource(file, config) && !distances.has(file)) {
        distances.set(file, 0); evidence.set(file, file); queue.push(file);
      }
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index];
    // A page is the destination of the trace. Following its exports back into
    // navigation/layout modules turns local changes into apparent site changes.
    if (pageRoute(file, config.pagesRoot) !== null) continue;
    for (const importer of reverse.get(file) ?? []) {
      if (distances.has(importer)) continue;
      distances.set(importer, distances.get(file) + 1);
      evidence.set(importer, evidence.get(file));
      queue.push(importer);
    }
  }
  // Next applies these files to every page without an explicit import edge.
  const global = ["_app.tsx", "_app.ts", "_document.tsx", "_document.ts"]
    .some((file) => distances.has(config.pagesRoot + file));
  const candidates = [];
  for (const [file] of sources) {
    const route = pageRoute(file, config.pagesRoot);
    if (route === null || (!distances.has(file) && !global)) continue;
    const distance = distances.get(file) ?? 20;
    candidates.push({ route, file, distance, direct: distance === 0, global: !distances.has(file), evidence: evidence.get(file),
      reason: distance === 0 ? "Page changed directly" : global && !distances.has(file)
        ? "Sample of the shared application change" : `Uses changed ${path.basename(evidence.get(file))}` });
  }
  return candidates.sort((a, b) => a.distance - b.distance || a.route.localeCompare(b.route));
}

// Extract only literal object keys without evaluating PR code. Strings and
// comments are masked so braces inside them cannot alter the nesting depth.
function objectKeys(source, name) {
  const masked = source.replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => " ".repeat(match.length));
  const start = new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\{`).exec(masked);
  if (!start) return [];
  let depth = 1;
  const keys = [];
  for (let i = start.index + start[0].length; i < masked.length && depth; i++) {
    if (depth === 1 && /\w/.test(masked[i]) && !/\w/.test(masked[i - 1])) {
      const key = /^([a-zA-Z]\w*)\s*:\s*\{/.exec(masked.slice(i));
      if (key) keys.push(key[1]);
    }
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") depth--;
  }
  return keys;
}

export function concretePaths(candidate, sources, config) {
  if (!candidate.route.includes("[")) return [candidate.route];
  if (config.dynamicExamples[candidate.route]) return [config.dynamicExamples[candidate.route]];
  // The pixel pages export the same finite getStaticPaths, backed by the mural
  // catalogue. Check that wiring at this PR head before substituting any IDs.
  if (!/^\/institute\/pixels\/\[mural\](?:\/rename)?$/.test(candidate.route)) return [];
  const indexFile = config.pagesRoot + "institute/pixels/[mural]/index.tsx";
  const index = sources.get(indexFile) ?? "";
  const page = sources.get(candidate.file) ?? "";
  if (candidate.file !== indexFile && !/export\s*\{[^}]*getStaticPaths[^}]*\}\s*from\s*["']\.\/index["']/.test(page)) return [];
  if (!/import\s+murals\s*(?:,\s*\{[^}]*\})?\s+from\s*["']@\/data\/murals["']/.test(index) ||
      !/getStaticPaths[\s\S]*typeSafeObjectKeys\(murals\)\.map/.test(index) ||
      !/params:\s*\{\s*mural:\s*camelToKebab\(key\)/.test(index)) return [];
  return objectKeys(sources.get(config.sourceRoot + "data/murals.ts") ?? "", "murals")
    .map((key) => candidate.route.replace("[mural]", key.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()));
}

export function previewCandidates(candidates, config) {
  const direct = candidates.filter((candidate) => candidate.direct);
  if (direct.length) return direct;
  // Prefer the changed UI's consumers over unrelated consumers of a utility
  // edited in the same PR. Then stop at the nearest pages, before navigation
  // can spread a local catalogue change through the application shell.
  const ui = candidates.filter((candidate) => candidate.evidence?.startsWith(config.sourceRoot) &&
    /^(?:components|hooks|assets|icons|styles)\//.test(candidate.evidence.slice(config.sourceRoot.length)));
  const pool = ui.length ? ui : candidates;
  const nearest = Math.min(...pool.map((candidate) => candidate.distance));
  return pool.filter((candidate) => candidate.distance === nearest);
}

// A small, source-checked Alveus adapter. General pages use import tracing;
// the overlay benefits from explicit layouts and date-independent theme URLs.
export function overlayLinks(sources, changes, candidates, config) {
  const candidate = candidates.find((item) => item.route === "/stream/overlay");
  if (!candidate) return [];
  const source = sources.get(candidate.file);
  const relevant = changes.filter((change) => change.filename === candidate.file ||
    new RegExp(`^${config.sourceRoot}(?:assets/stream/border-|data/stream-themes\\.|utils/stream-themes\\.)`).test(change.filename));
  if (!relevant.length) return [];
  const added = relevant.map((change) => (change.patch ?? "").split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++" )).join("\n")).join("\n");
  const layoutBlock = source.match(/const layouts\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  const layouts = [...layoutBlock.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  const layout = layouts.find((value) => value !== "fullscreen" && added.includes(`border-${value}`))
    ?? (layouts.includes("6cam") ? "6cam" : layouts.find((value) => value !== "fullscreen"));
  if (!layout) return [];
  const themeSource = sources.get(config.sourceRoot + "data/stream-themes.js") ?? "";
  const themes = [...new Set([...themeSource.matchAll(/theme:\s*["']([^"']+)["']/g)].map((match) => match[1]))];
  const theme = /query\.theme\b/.test(source) && themes.find((value) => added.includes(value));
  const make = (label, query, reason) => ({ path: candidate.route, label, query: Object.entries(query)
    .map(([key, value]) => ({ key, value })), reason });
  if (!theme) return [make(`Stream overlay (${layout})`, { layout }, "Check the changed overlay")];
  const links = [
    make(`Stream overlay — ${theme} (${layout})`, { layout, theme }, "Force the changed theme, independent of the date"),
    make(`Stream overlay — scheduled theme (${layout})`, { layout, theme: "auto" }, "Check automatic event and seasonal selection"),
  ];
  if (layouts.includes("4cam") && layout !== "4cam") links.push(make("Stream overlay — 4-camera fallback",
    { layout: "4cam", theme }, "Check the existing border when this layout has no event artwork"));
  return links;
}

export function selectLinks(candidates, sources, changes, config) {
  // Six is a ceiling, not a quota. When the diff names pages, don't pad the
  // list with weaker shared-dependency guesses.
  const pool = previewCandidates(candidates, config);
  const links = overlayLinks(sources, changes, pool, config);
  const chosenRoutes = new Set(links.map((link) => link.path));
  const limit = pool.every((candidate) => candidate.global) ? Math.min(3, config.maxLinks) : config.maxLinks;
  const areas = new Set(links.map((link) => link.path.split("/")[1] || "/"));
  const available = pool.filter((candidate) => !chosenRoutes.has(candidate.route) && concretePaths(candidate, sources, config).length);
  // Round-robin site areas for genuinely broad changes, public pages first.
  while (available.length && links.length < limit) {
    const publicFirst = available.filter((candidate) => !candidate.route.startsWith("/admin"));
    const choices = publicFirst.length ? publicFirst : available;
    const candidate = choices.find((item) => !areas.has(item.route.split("/")[1] || "/")) ?? choices[0];
    available.splice(available.indexOf(candidate), 1);
    for (const concrete of concretePaths(candidate, sources, config)) {
      if (links.length >= limit) break;
      links.push({ route: candidate.route, path: concrete, query: [], label: concrete, reason: candidate.reason });
    }
    areas.add(candidate.route.split("/")[1] || "/");
  }
  return links.slice(0, config.maxLinks);
}

export function deploymentOrigin(value, prefix) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !url.hostname.endsWith(".vercel.app") || !url.hostname.startsWith(prefix) ||
      url.pathname !== "/" || url.search || url.hash) throw new Error("Unexpected deployment URL");
  return url.origin;
}

export function linkUrl(origin, link) {
  if (!link.path.startsWith("/") || link.path.startsWith("//") || /[\\?#\[\]\s]/.test(link.path) ||
      /(?:^|\/)\.{1,2}(?:\/|$)/.test(link.path) || /%/i.test(link.path)) throw new Error("Invalid preview path");
  const url = new URL(link.path, origin);
  if (url.origin !== origin) throw new Error("Invalid preview origin");
  for (const { key, value } of link.query) {
    if (!/^[\w-]{1,64}$/.test(key) || typeof value !== "string" || value.length > 250) throw new Error("Invalid query parameter");
    url.searchParams.append(key, value);
  }
  return url.href.replace(/[()]/g, (character) => character === "(" ? "%28" : "%29");
}

export function validateAiLinks(links, candidates, sources, config, origin) {
  if (!Array.isArray(links)) throw new Error("Invalid model output");
  return links.slice(0, config.maxLinks).map((link) => {
    const candidate = candidates.find((item) => concretePaths(item, sources, config).includes(link.path));
    if (!candidate || typeof link.label !== "string" || typeof link.reason !== "string" ||
        !Array.isArray(link.query)) throw new Error("Model selected an unsupported page");
    const source = sources.get(candidate.file);
    const dependencies = new Set([candidate.file]);
    const queue = [candidate.file];
    for (let index = 0; index < queue.length && index < 40; index++) {
      for (const specifier of imports(sources.get(queue[index]) ?? "")) {
        const file = resolveImport(queue[index], specifier, sources, config.sourceRoot);
        if (file && sources.has(file) && !dependencies.has(file)) {
          dependencies.add(file); queue.push(file);
        }
      }
    }
    const evidence = [...dependencies].map((file) => sources.get(file)).join("\n");
    for (const { key, value } of link.query) {
      if (!/^[\w-]+$/.test(key) || !source.includes(`query.${key}`)) throw new Error("Model invented a query parameter");
      if (typeof value !== "string" || !/^[\w.,-]{1,100}$/.test(value) ||
          (!evidence.includes(`"${value}"`) && !evidence.includes(`'${value}'`))) throw new Error("Model invented a query value");
    }
    linkUrl(origin, link);
    return { ...link, route: candidate.route };
  });
}

function plain(value) {
  return String(value).replace(/[\r\n]+/g, " ").replace(/[@<>&\[\]()*_`|\\]/g, "").slice(0, 240);
}

export function renderComment({ marker, sha, origin, links, candidates, ai, truncated, title }) {
  const represented = new Set(links.map((link) => link.path));
  const omitted = candidates.filter((candidate) => !represented.has(candidate.route) &&
    !links.some((link) => link.route === candidate.route));
  return [marker, `### 🤖 Automated preview links${title ? `: ${plain(title)}` : ""}`, "",
    `Preview for commit \`${sha.slice(0, 7)}\` · [Deployment](${origin})`, "",
    ...links.map((link) => `- [${plain(link.label)}](${linkUrl(origin, link)}) — ${plain(link.reason)}${link.path.startsWith("/admin") ? " (requires admin access)" : ""}`),
    "", omitted.length ? `Showing ${candidates.length - omitted.length} of ${candidates.length} candidate page routes; others are omitted or need real record IDs.` : "",
    truncated ? "The changed-file list was truncated by GitHub; additional pages may be affected." : "",
    links.some((link) => link.path === "/stream/overlay") ? "Overlay previews work best at 1920×1080." : "", "",
    `${ai ? "AI-assisted suggestions" : "Links selected from changed pages and their nearest UI imports"}.`,
    "Generated by [Alveus Preview Links](https://github.com/pjeweb/alveus-preview-links) · Updated after successful deployments.",
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
