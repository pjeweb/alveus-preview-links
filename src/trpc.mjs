import ts from "typescript";

// Only local source is visible to the compiler. No tsconfig, plugins, package
// resolution, diagnostics, emits, or code from the PR are loaded or executed.
function sourceProgram(sources, resolve) {
  const files = new Map([...sources].filter(([file]) => /\.[cm]?[jt]sx?$/.test(file))
    .map(([file, source]) => [file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)]));
  const normalize = (file) => file.replace(/^\/+/, "");
  return ts.createProgram([...files.keys()], {
    noLib: true, noEmit: true, allowJs: true, jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext,
  }, {
    getSourceFile: (file) => files.get(normalize(file)),
    fileExists: (file) => files.has(normalize(file)),
    readFile: (file) => sources.get(normalize(file)),
    getDefaultLibFileName: () => "lib.d.ts",
    getCurrentDirectory: () => "/",
    getCanonicalFileName: normalize,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    writeFile: () => { throw new Error("Source analysis must not emit files"); },
    resolveModuleNames: (names, containingFile) => names.map((name) => {
      const file = resolve(normalize(containingFile), name);
      return files.has(file) ? { resolvedFileName: file, extension: file.slice(file.lastIndexOf(".")) } : undefined;
    }),
  });
}

function changedLines(patch) {
  if (!patch) return null;
  const lines = new Set();
  let current;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { current = Number(hunk[1]); continue; }
    if (current === undefined) continue;
    if (line.startsWith("-")) lines.add(current);
    else if (line.startsWith("+")) { lines.add(current); current++; }
    else if (line.startsWith(" ")) current++;
  }
  return lines;
}

function touches(node, lines) {
  if (!lines) return true;
  const source = node.getSourceFile();
  const start = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const end = source.getLineAndCharacterOfPosition(node.end - 1).line + 1;
  return [...lines].some((line) => line >= start && line <= end);
}

function runtimeWalk(node, visit) {
  if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
  visit(node);
  ts.forEachChild(node, (child) => runtimeWalk(child, visit));
}

function propertyName(node) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
}

// This adapter reads the site's actual router registration and client export;
// namespace names are never guessed from router filenames or PR prose.
export function trpcConsumers(sources, changes, config, resolve) {
  const serverRoot = config.sourceRoot + "server/";
  const appFile = serverRoot + "trpc/router/_app.ts";
  const changed = new Map(changes.filter((change) => change.filename.startsWith(serverRoot) && change.status !== "removed")
    .map((change) => [change.filename, changedLines(change.patch)]));
  if (!changed.size || !sources.has(appFile)) return [];
  const program = sourceProgram(sources, resolve);
  const checker = program.getTypeChecker();
  const referenceSymbol = (node) => node && ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : node && checker.getSymbolAtLocation(node);
  const symbolAt = (node) => {
    let symbol = referenceSymbol(node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  };
  const topVariables = (file) => (program.getSourceFile(file)?.statements ?? []).filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations]);
  const router = symbolAt(topVariables(serverRoot + "trpc/trpc.ts").find((node) => node.name.getText() === "router")?.name);
  const client = symbolAt(topVariables(config.sourceRoot + "utils/trpc.ts").find((node) => node.name.getText() === "trpc")?.name);
  if (!router || !client) return [];
  const routerObjects = new Set();
  const records = new Map();
  const procedures = new Map();
  const addRecord = (node) => {
    const symbol = symbolAt(node.name);
    if (!symbol) return;
    if (!records.has(symbol)) records.set(symbol, { nodes: [], dependencies: new Set(), changed: false });
    records.get(symbol).nodes.push(node);
    return symbol;
  };
  const register = (expression, prefix = [], seen = new Set()) => {
    if (!expression || seen.has(expression)) return;
    seen = new Set(seen).add(expression);
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
      const declaration = symbolAt(expression)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration)) register(declaration.initializer, prefix, seen);
      return;
    }
    if (!ts.isCallExpression(expression) || symbolAt(expression.expression) !== router) return;
    const object = expression.arguments[0];
    if (!object || !ts.isObjectLiteralExpression(object)) return;
    routerObjects.add(object);
    for (const property of object.properties) {
      const name = propertyName(property.name);
      if (!name || !(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))) continue;
      const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
      const parts = [...prefix, name];
      if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) &&
          ["query", "mutation", "subscription"].includes(value.expression.name.text)) {
        const symbol = addRecord(property);
        if (symbol) procedures.set(parts.join("."), symbol);
      } else register(value, parts, seen);
    }
  };
  register(topVariables(appFile).find((node) => node.name.getText() === "appRouter")?.initializer);
  if (!procedures.size) return [];

  for (const source of program.getSourceFiles()) {
    // The factory/context/root aggregate are plumbing, not evidence that every
    // procedure changed. Runtime helper symbols remain eligible independently.
    if (!source.fileName.startsWith(serverRoot) ||
        [appFile, serverRoot + "trpc/trpc.ts", serverRoot + "trpc/context.ts"].includes(source.fileName)) continue;
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const node of statement.declarationList.declarations) {
          if (ts.isIdentifier(node.name) && !routerObjects.has(node.initializer?.arguments?.[0])) addRecord(node);
        }
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
        addRecord(statement);
      }
    }
  }
  for (const [symbol, record] of records) {
    for (const node of record.nodes) {
      const file = node.getSourceFile().fileName;
      if (changed.has(file) && touches(node, changed.get(file))) record.changed = true;
      runtimeWalk(node, (child) => {
        if (!ts.isIdentifier(child)) return;
        const dependency = referenceSymbol(child);
        const resolved = dependency?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(dependency) : dependency;
        if (resolved && resolved !== symbol && records.has(resolved)) record.dependencies.add(resolved);
        // An edited runtime import can change a local symbol's behavior even
        // when its body is unchanged. Type-only references never reach here.
        for (const declaration of dependency?.declarations ?? []) {
          if (!ts.isImportSpecifier(declaration) && !ts.isImportClause(declaration) && !ts.isNamespaceImport(declaration)) continue;
          let imported = declaration;
          while (imported.parent && !ts.isImportDeclaration(imported)) imported = imported.parent;
          if (changed.has(file) && ts.isImportDeclaration(imported) &&
              (touches(declaration, changed.get(file)) || touches(imported.moduleSpecifier, changed.get(file)))) record.changed = true;
        }
      });
    }
  }
  const affected = new Map();
  for (const [procedure, symbol] of procedures) {
    const queue = [{ symbol, depth: 0 }];
    const seen = new Set();
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index];
      if (seen.has(item.symbol)) continue;
      seen.add(item.symbol);
      const record = records.get(item.symbol);
      if (record.changed) {
        affected.set(procedure, { procedure, depth: item.depth,
          evidence: record.nodes.find((node) => changed.has(node.getSourceFile().fileName))?.getSourceFile().fileName });
        break;
      }
      for (const dependency of record.dependencies) queue.push({ symbol: dependency, depth: item.depth + 1 });
    }
  }
  if (!affected.size) return [];
  const consumers = [];
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(config.sourceRoot) || source.fileName.startsWith(serverRoot)) continue;
    runtimeWalk(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) ||
          !/^use(?:Query|InfiniteQuery|Mutation|Subscription|SuspenseQuery|SuspenseInfiniteQuery)$/.test(node.expression.name.text)) return;
      let expression = node.expression.expression;
      const parts = [];
      while (expression && symbolAt(expression) !== client) {
        if (ts.isPropertyAccessExpression(expression)) {
          parts.unshift(expression.name.text); expression = expression.expression;
        } else if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
          parts.unshift(expression.argumentExpression.text); expression = expression.expression;
        } else return;
      }
      const match = affected.get(parts.join("."));
      if (expression && match) consumers.push({ file: source.fileName, ...match });
    });
  }
  return consumers.sort((a, b) => a.depth - b.depth || a.procedure.localeCompare(b.procedure));
}
