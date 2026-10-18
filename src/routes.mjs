import path from "node:path/posix";

const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".json"];

export function pageRoute(file, pagesRoot) {
  if (!file.startsWith(pagesRoot) || !/\.[jt]sx?$/.test(file)) return null;
  const relative = file.slice(pagesRoot.length).replace(/\.[jt]sx?$/, "");
  if (/^(?:api|auth|oauth)(?:\/|$)/.test(relative)) return null;
  if (/(?:^|\/)_/.test(relative) || /^(?:404|500|unauthorized)$/.test(relative)) return null;
  return `/${relative.replace(/(?:^|\/)index$/, "")}`;
}

// Deliberately static: no imports or other code from a PR are executed.
export function imports(source) {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\(\s*)["']([^"']+)["']/g)]
    .map((match) => match[1]);
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
    for (const specifier of imports(source)) {
      const dependency = resolveImport(file, specifier, sources, config.sourceRoot);
      if (!dependency) continue;
      if (!reverse.has(dependency)) reverse.set(dependency, new Set());
      reverse.get(dependency).add(file);
    }
  }
  const distances = new Map();
  const queue = [];
  for (const change of changes) {
    for (const file of [change.filename, change.previous_filename].filter(Boolean)) {
      if (!distances.has(file)) { distances.set(file, 0); queue.push(file); }
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index];
    for (const importer of reverse.get(file) ?? []) {
      if (distances.has(importer)) continue;
      distances.set(importer, distances.get(file) + 1);
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
    candidates.push({ route, file, distance, direct: distance === 0,
      reason: distance === 0 ? "Page changed directly" : global && !distances.has(file)
        ? "Shared application layout changed" : "Imports changed code or assets" });
  }
  return candidates.sort((a, b) => a.distance - b.distance || a.route.localeCompare(b.route));
}

function defaultLink(candidate, config) {
  const sample = config.dynamicExamples[candidate.route];
  if (candidate.route.includes("[") && !sample) return null;
  return { route: candidate.route, path: sample ?? candidate.route, query: [], label: sample ?? candidate.route, reason: candidate.reason };
}

// A small, source-checked Alveus adapter. General pages use import tracing;
// the overlay benefits from explicit layouts and date-independent theme URLs.
export function overlayLinks(sources, changes, candidates, config) {
  const candidate = candidates.find((item) => item.route === "/stream/overlay");
  if (!candidate) return [];
  const source = sources.get(candidate.file);
  const relevant = changes.filter((change) => /(?:stream|overlay)/i.test(change.filename));
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
  if (!theme) return [make(`Stream overlay (${layout})`, { layout }, "Preview the camera border")];
  const links = [
    make(`Stream overlay — ${theme} (${layout})`, { layout, theme }, "Force the changed theme, independent of the date"),
    make(`Stream overlay — scheduled theme (${layout})`, { layout, theme: "auto" }, "Check automatic event and seasonal selection"),
  ];
  if (layouts.includes("4cam") && layout !== "4cam") links.push(make("Stream overlay — 4-camera fallback",
    { layout: "4cam", theme }, "Check the existing border when this layout has no event artwork"));
  return links;
}

export function selectLinks(candidates, sources, changes, config) {
  const links = overlayLinks(sources, changes, candidates, config);
  const chosenRoutes = new Set(links.map((link) => link.path));
  // Directly changed pages first, then a sample from each affected area.
  const areas = new Set(links.map((link) => link.path.split("/")[1] || "/"));
  for (const candidate of candidates) {
    if (links.length >= config.maxLinks) break;
    if (chosenRoutes.has(candidate.route)) continue;
    const area = candidate.route.split("/")[1] || "/";
    if (!candidate.direct && areas.has(area)) continue;
    const link = defaultLink(candidate, config);
    if (!link) continue;
    links.push(link); chosenRoutes.add(candidate.route); areas.add(area);
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
    const candidate = candidates.find((item) => item.route === link.path || config.dynamicExamples[item.route] === link.path);
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

export function renderComment({ marker, sha, origin, links, candidates, ai, truncated }) {
  const represented = new Set(links.map((link) => link.path));
  const omitted = candidates.filter((candidate) => !represented.has(candidate.route) &&
    !links.some((link) => link.route === candidate.route));
  return [marker, "### 🤖 Automated preview links", "",
    "Generated automatically by [Alveus Preview Links](https://github.com/pjeweb/alveus-preview-links) after a successful Vercel deployment.", "",
    `Preview for commit \`${sha.slice(0, 7)}\` · [Deployment](${origin})`, "",
    ...links.map((link) => `- [${plain(link.label)}](${linkUrl(origin, link)}) — ${plain(link.reason)}${link.path.startsWith("/admin") ? " (requires admin access)" : ""}`),
    "", omitted.length ? `Showing a sample from ${candidates.length} potentially affected page routes; ${omitted.length} others are omitted or need real record IDs.` : "",
    truncated ? "The changed-file list was truncated by GitHub; additional pages may be affected." : "",
    links.some((link) => link.path === "/stream/overlay") ? "Overlay previews work best at 1920×1080." : "", "",
    `${ai ? "AI-assisted suggestions" : "Suggestions from static imports and source-checked preview rules"}; runtime, data-driven, and external-package dependencies may affect additional pages.`,
    "This automated comment is updated in place for subsequent successful deployments.",
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
