#!/usr/bin/env node

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const MARKDOWN_HEADER = [
  "symbol",
  "defined_in",
  "runtime",
  "test",
  "barrel",
  "route",
  "i18n_dynamic",
  "classification",
  "suggested_action",
];

const COMPAT_CONTRACTS = new Map([
  ["RESEARCH_WORKFLOW_STAGE_DEFINITIONS", "测试固定 13 阶段不变量，属于展示层契约"],
  ["RESEARCH_NODE_STATUS_PRIORITY", "测试当前节点选择规则"],
  ["resolveChainTab", "测试旧 Tab query 兼容映射"],
  ["createIdempotencyKey", "测试 HTTP/IP 下 Web Crypto 降级，仍承担兼容责任"],
  ["researchStatusVariant", "测试状态字典映射"],
  ["resolveMainPiName", "测试平台配置展示"],
  ["Image", "Next.js Image 兼容层，服务历史依赖导入"],
  ["Script", "Next.js Script 兼容层，服务历史依赖导入"],
  ["useParams", "Next.js Router API 兼容层，服务历史依赖导入"],
  ["usePathname", "Next.js Router API 兼容层，服务历史依赖导入"],
  ["useRouter", "Next.js Router API 兼容层，服务历史依赖导入"],
  ["useSearchParams", "Next.js Router API 兼容层，服务历史依赖导入"],
]);

const BUSINESS_REQUIRED = new Map([
  ["LegacyResearchRedirect", "科研旧路由统一转发和深链兼容"],
  ["ResearchChainKnowledgePanel", "历史 Chain KB 与团队 KB 双路径仍处于迁移期"],
  ["TResearchKnowledgeBase", "历史 Chain KB 与团队 KB 双路径契约"],
  ["TResearchKnowledgeCandidate", "历史 Chain KB 与团队 KB 双路径契约"],
  ["TResearchKnowledgeRequestState", "历史 Chain KB 与团队 KB 双路径契约"],
  ["TResearchKnowledgeScope", "历史 Chain KB 与团队 KB 双路径契约"],
  ["ADMIN_ROLES", "包含 MAIN_PI 历史身份标签，不能因低引用移除"],
  ["redirectRoutes", "集中保留 Next.js 历史重定向配置"],
]);

const FRAMEWORK_ROUTE_EXPORTS = new Set([
  "action",
  "clientAction",
  "clientLoader",
  "Component",
  "ErrorBoundary",
  "HydrateFallback",
  "Layout",
  "handle",
  "headers",
  "links",
  "loader",
  "meta",
  "shouldRevalidate",
]);

const EXCLUDE_SEGMENTS = new Set(["node_modules", "dist", "build", ".turbo"]);
const EXCLUDE_SUFFIXES = [".tsbuildinfo", ".map"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs"]);

/**
 * Parse supported CLI options.
 *
 * Args:
 *   argv: Argument strings without the executable and script path.
 *
 * Returns:
 *   Output format, optional baseline path and optional output path.
 */
export function parseArguments(argv) {
  const options = { format: "markdown", compare: undefined, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--format") {
      index += 1;
      options.format = argv[index];
    } else if (value === "--compare") {
      index += 1;
      options.compare = argv[index];
    } else if (value === "--out") {
      index += 1;
      options.out = argv[index];
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  if (!["markdown", "json"].includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}. Use markdown or json.`);
  }
  if (["format", "compare", "out"].some((key) => options[key] === undefined && key === "format")) {
    throw new Error("Missing option value.");
  }
  return options;
}

/**
 * Check whether a scanned path is excluded by the fixed audit rules.
 *
 * Args:
 *   path: Absolute or relative source path.
 *
 * Returns:
 *   True when the path is a generated or dependency artifact.
 */
export function isExcludedPath(path) {
  const normalized = normalize(path);
  if (EXCLUDE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  return normalized.split(/[\\/]+/).some((segment) => EXCLUDE_SEGMENTS.has(segment));
}

/**
 * Convert a camel-case, snake-case or screaming-snake symbol to words.
 *
 * Args:
 *   symbol: Exported symbol name.
 *
 * Returns:
 *   Lower-case semantic words.
 */
function symbolWords(symbol) {
  return symbol
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Determine whether a dynamic i18n key can cover copy related to a symbol.
 *
 * Args:
 *   symbol: Exported symbol name.
 *   keys: Flattened i18n keys.
 *
 * Returns:
 *   True when a matching key prefix exists.
 */
export function hasDynamicI18nPrefix(symbol, keys) {
  const words = symbolWords(symbol);
  while (words.length && ["labels", "label", "key", "keys", "texts", "text"].includes(words.at(-1))) {
    words.pop();
  }
  if (!words.length) return false;
  const prefixes = [words.join("."), words.join("_"), words.join("")];
  return keys.some((key) =>
    prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`) || key.startsWith(`${prefix}_`))
  );
}

/**
 * Flatten a nested i18n JSON object into stable translation keys.
 *
 * Args:
 *   value: Parsed JSON value.
 *   prefix: Current key prefix.
 *
 * Returns:
 *   Flat key list.
 */
function flattenI18nKeys(value, prefix = "") {
  if (typeof value !== "object" || value === null) return [prefix].filter(Boolean);
  return Object.entries(value).flatMap(([key, child]) => flattenI18nKeys(child, prefix ? `${prefix}.${key}` : key));
}

/**
 * Determine whether an AST node has an export modifier.
 *
 * Args:
 *   node: TypeScript AST node.
 *
 * Returns:
 *   True when the declaration is directly exported.
 */
function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

/**
 * Determine whether a declaration is the module default export.
 *
 * Args:
 *   node: TypeScript declaration node.
 *
 * Returns:
 *   True when the export modifiers contain the default keyword.
 */
function hasDefaultModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

/**
 * Collect identifiers declared by a variable binding.
 *
 * Args:
 *   name: Variable binding node.
 *
 * Returns:
 *   Identifier names declared by the binding.
 */
function declarationNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isArrayBindingPattern(name) || ts.isObjectBindingPattern(name)) {
    return name.elements.flatMap((element) => (ts.isBindingElement(element) ? declarationNames(element.name) : []));
  }
  return [];
}

/**
 * Mark same-name function or class expressions inside an exported declaration.
 *
 * Args:
 *   node: Initializer AST node.
 *   symbol: Exported symbol name.
 *   declarationNameNodes: Node identity set to update.
 */
function markNestedDeclarationNames(node, symbol, declarationNameNodes) {
  if (!node) return;
  if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name?.text === symbol) {
    declarationNameNodes.add(node.name);
  }
  ts.forEachChild(node, (child) => markNestedDeclarationNames(child, symbol, declarationNameNodes));
}

/**
 * Find the first named function or class expression in an export assignment.
 *
 * Args:
 *   expression: Default export expression.
 *
 * Returns:
 *   The local symbol name, or undefined for anonymous expressions.
 */
function defaultExpressionName(expression) {
  let current = expression;
  while (current) {
    if ((ts.isFunctionExpression(current) || ts.isClassExpression(current)) && current.name) {
      return current.name.text;
    }
    if (ts.isCallExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Extract a dynamic import call from a variable initializer.
 *
 * Args:
 *   initializer: Variable declaration initializer.
 *
 * Returns:
 *   The dynamic import call, or undefined.
 */
function dynamicImportCall(initializer) {
  let current = initializer;
  while (current) {
    if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword) return current;
    if (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Resolve a TypeScript module specifier against the audit source map.
 *
 * Args:
 *   specifier: Import or export module text.
 *   importerPath: Absolute importing file path.
 *   sourcePaths: All source paths available to the audit.
 *   projectRoot: Repository or fixture root.
 *
 * Returns:
 *   The resolved source path, or undefined for external modules.
 */
function resolveModuleSpecifier(specifier, importerPath, sourcePaths, projectRoot) {
  let candidate;
  if (specifier.startsWith("@/")) {
    candidate = resolve(projectRoot, "apps/web/core", specifier.slice(2));
  } else if (specifier === "@plane/constants") {
    candidate = resolve(projectRoot, "packages/constants/src/index.ts");
  } else if (specifier.startsWith("@plane/constants/")) {
    candidate = resolve(projectRoot, "packages/constants/src", specifier.slice("@plane/constants/".length));
  } else if (specifier.startsWith("@plane/")) {
    return undefined;
  } else if (specifier.startsWith(".")) {
    candidate = resolve(dirname(importerPath), specifier);
  } else {
    return undefined;
  }

  const candidates = [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.mjs`,
    join(candidate, "index.ts"),
    join(candidate, "index.tsx"),
  ].map(normalize);
  return candidates.find((path) => sourcePaths.has(path));
}

/**
 * Determine the audit role of a source path.
 *
 * Args:
 *   path: Normalized source path.
 *
 * Returns:
 *   Runtime/test/barrel/route role flags.
 */
function pathRoles(path) {
  const normalized = normalize(path).replaceAll("\\", "/");
  const isTest = normalized.includes("/apps/web/tests/");
  const isRuntime = !isTest && (normalized.includes("/apps/web/app/") || normalized.includes("/apps/web/core/"));
  const isBarrel = /\/index\.(ts|tsx)$/.test(normalized);
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  const isRoute =
    normalized.includes("/apps/web/app/routes/") ||
    normalized.endsWith("/app/routes/core.ts") ||
    normalized.endsWith("/apps/web/app/root.tsx") ||
    normalized.endsWith("/apps/web/app/not-found.tsx") ||
    /^(page|layout|route)(\.(client|server))?\.(ts|tsx)$/.test(fileName);
  return { isTest, isRuntime, isBarrel, isRoute };
}

/**
 * Create a TypeScript source file with the right language variant.
 *
 * Args:
 *   path: Source path.
 *   text: Source text.
 *
 * Returns:
 *   A parsed TypeScript source file.
 */
function parseSourceFile(path, text) {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS
  );
}

/**
 * Collect definitions and references from an in-memory source map.
 *
 * Args:
 *   sources: Mapping from absolute source path to source text or JSON text.
 *   options: Project root used for path aliases.
 *
 * Returns:
 *   A deterministic audit result with every exported research-related symbol.
 */
export function analyzeSourceTexts(sources, options = {}) {
  const projectRoot = normalize(options.projectRoot ?? process.cwd());
  const includedEntries = Object.entries(sources)
    .map(([path, text]) => [normalize(path), text])
    .filter(([path]) => !isExcludedPath(path))
    .toSorted(([left], [right]) => left.localeCompare(right));
  const sourcePaths = new Set(includedEntries.map(([path]) => path));
  const definitionPaths = new Set((options.definitionPaths ?? includedEntries.map(([path]) => path)).map(normalize));
  const parsedFiles = new Map();
  const i18nKeys = [];

  for (const [path, text] of includedEntries) {
    if (path.endsWith(".json")) {
      try {
        i18nKeys.push(...flattenI18nKeys(JSON.parse(text)));
      } catch {
        // Invalid locale fixtures are ignored; real scanning reads checked-in JSON.
      }
      continue;
    }
    if (path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".mjs")) {
      parsedFiles.set(path, parseSourceFile(path, text));
    }
  }

  const definitions = new Map();
  const localDeclarations = new Map();
  const definitionNameNodes = new Set();
  const moduleDefaultNames = new Map();

  /**
   * Register a definition and its local declaration.
   *
   * Args:
   *   symbol: Exported symbol name.
   *   path: Definition path.
   *   isDefault: Whether this is a module default export.
   */
  function addDefinition(symbol, path, isDefault = false) {
    if (!definitionPaths.has(path)) return;
    const id = `${symbol}\0${path}`;
    const definition = {
      id,
      symbol,
      path,
      isDefault,
      runtime: 0,
      test: 0,
      barrel: 0,
      route: 0,
      internal: 0,
    };
    definitions.set(id, definition);
    const declarations = localDeclarations.get(path) ?? new Map();
    declarations.set(symbol, id);
    localDeclarations.set(path, declarations);
    if (isDefault) moduleDefaultNames.set(path, id);
  }

  /**
   * Resolve an exported name through local declarations and re-export chains.
   *
   * Args:
   *   path: Module source path.
   *   exportedName: Requested export name.
   *   seen: Paths already visited while following barrels.
   *
   * Returns:
   *   Definition ID, or undefined when the module does not export the name.
   */
  function resolveExportId(path, exportedName, seen = new Set()) {
    if (seen.has(path)) return undefined;
    seen.add(path);
    if (exportedName === "default") {
      const defaultId = moduleDefaultNames.get(path);
      if (defaultId) return defaultId;
    }
    const directId = definitions.get(`${exportedName}\0${path}`)?.id;
    if (directId) return directId;

    const sourceFile = parsedFiles.get(path);
    if (!sourceFile) return undefined;
    let resolved;
    const visit = (node) => {
      if (resolved) return;
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const specifier of node.exportClause.elements) {
          const sourceName = specifier.propertyName?.text ?? specifier.name.text;
          if (specifier.name.text !== exportedName) continue;
          if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            const targetPath = resolveModuleSpecifier(node.moduleSpecifier.text, path, sourcePaths, projectRoot);
            resolved = targetPath ? resolveExportId(targetPath, sourceName, seen) : undefined;
          } else {
            resolved = definitions.get(`${sourceName}\0${path}`)?.id;
          }
          return;
        }
      } else if (
        ts.isExportDeclaration(node) &&
        !node.exportClause &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const targetPath = resolveModuleSpecifier(node.moduleSpecifier.text, path, sourcePaths, projectRoot);
        if (targetPath) resolved = resolveExportId(targetPath, exportedName, seen);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return resolved;
  }

  for (const [path, sourceFile] of parsedFiles) {
    const visit = (node) => {
      if (ts.isVariableStatement(node) && hasExportModifier(node)) {
        for (const declaration of node.declarationList.declarations) {
          for (const name of declarationNames(declaration.name)) {
            addDefinition(name, path);
            definitionNameNodes.add(declaration.name);
            markNestedDeclarationNames(declaration.initializer, name, definitionNameNodes);
          }
        }
      } else if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isInterfaceDeclaration(node)) &&
        node.name
      ) {
        if (hasExportModifier(node)) addDefinition(node.name.text, path, hasDefaultModifier(node));
        const declarations = localDeclarations.get(path) ?? new Map();
        declarations.set(node.name.text, definitions.get(`${node.name.text}\0${path}`)?.id);
        localDeclarations.set(path, declarations);
        definitionNameNodes.add(node.name);
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const declarations = localDeclarations.get(path) ?? new Map();
        if (!declarations.has(node.name.text)) declarations.set(node.name.text, null);
        localDeclarations.set(path, declarations);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  for (const [path, sourceFile] of parsedFiles) {
    const visit = (node) => {
      if (ts.isExportAssignment(node) && !node.isExportEquals) {
        if (ts.isIdentifier(node.expression)) {
          const declarations = localDeclarations.get(path);
          const symbol = node.expression.text;
          if (!declarations?.has(symbol)) return;
          addDefinition(symbol, path, true);
          definitionNameNodes.add(node.expression);
        } else {
          const symbol = defaultExpressionName(node.expression);
          if (symbol) addDefinition(symbol, path, true);
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const references = new Map();

  /**
   * Increment one reference dimension.
   *
   * Args:
   *   definitionId: Definition identifier.
   *   kind: runtime, test, barrel, route or internal.
   */
  function addReference(definitionId, kind) {
    const definition = definitions.get(definitionId);
    if (!definition) return;
    definition[kind] += 1;
    if (!references.has(definitionId)) references.set(definitionId, new Set());
    references.get(definitionId).add(kind);
  }

  for (const [path, sourceFile] of parsedFiles) {
    const roles = pathRoles(path);
    const localAliases = new Map();
    const namespaceImports = new Map();
    const visitImportsAndExports = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const call = dynamicImportCall(node.initializer);
        const argument = call?.arguments[0];
        if (call && argument && ts.isStringLiteral(argument)) {
          const targetPath = resolveModuleSpecifier(argument.text, path, sourcePaths, projectRoot);
          if (targetPath) {
            if (ts.isIdentifier(node.name)) {
              namespaceImports.set(node.name.text, targetPath);
            } else {
              for (const name of declarationNames(node.name)) {
                localAliases.set(name, resolveExportId(targetPath, name));
              }
            }
          }
        }
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const targetPath = resolveModuleSpecifier(node.moduleSpecifier.text, path, sourcePaths, projectRoot);
        if (!targetPath || !node.importClause) return;
        const clause = node.importClause;
        if (clause.name) localAliases.set(clause.name.text, moduleDefaultNames.get(targetPath));
        if (!clause.namedBindings) return;
        if (ts.isNamespaceImport(clause.namedBindings)) {
          namespaceImports.set(clause.namedBindings.name.text, targetPath);
          return;
        }
        for (const specifier of clause.namedBindings.elements) {
          const exportedName = specifier.propertyName?.text ?? specifier.name.text;
          const definitionId = resolveExportId(targetPath, exportedName);
          localAliases.set(specifier.name.text, definitionId);
        }
        return;
      }
      if (
        ts.isExportDeclaration(node) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const targetPath = resolveModuleSpecifier(node.moduleSpecifier.text, path, sourcePaths, projectRoot);
        if (!targetPath) return;
        for (const specifier of node.exportClause.elements) {
          const exportedName = specifier.propertyName?.text ?? specifier.name.text;
          const definitionId =
            exportedName === "default"
              ? moduleDefaultNames.get(targetPath)
              : definitions.get(`${exportedName}\0${targetPath}`)?.id;
          if (definitionId) addReference(definitionId, "barrel");
        }
      }
      ts.forEachChild(node, visitImportsAndExports);
    };
    visitImportsAndExports(sourceFile);

    const isInsideModuleDeclaration = (node) => {
      let current = node.parent;
      while (current && !ts.isSourceFile(current)) {
        if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
        current = current.parent;
      }
      return false;
    };

    const visitIdentifiers = (node) => {
      const insideModuleDeclaration = isInsideModuleDeclaration(node);
      if (!insideModuleDeclaration) ts.forEachChild(node, visitIdentifiers);
      if (!ts.isIdentifier(node) || definitionNameNodes.has(node) || insideModuleDeclaration) return;
      if (node.parent && ts.isBindingElement(node.parent) && node.parent.name === node) return;

      const targetFromAlias = localAliases.get(node.text);
      if (targetFromAlias) {
        const kind = roles.isTest ? "test" : roles.isRuntime ? "runtime" : "barrel";
        if (kind !== "barrel" || roles.isBarrel) addReference(targetFromAlias, kind);
        if (roles.isRoute) addReference(targetFromAlias, "route");
        return;
      }

      if (
        node.parent &&
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node &&
        ts.isIdentifier(node.parent.expression)
      ) {
        const namespacePath = namespaceImports.get(node.parent.expression.text);
        const definitionId = namespacePath ? definitions.get(`${node.text}\0${namespacePath}`)?.id : undefined;
        if (definitionId) {
          addReference(definitionId, roles.isTest ? "test" : "runtime");
          if (roles.isRoute) addReference(definitionId, "route");
          return;
        }
      }

      const selfDefinitionId = definitions.get(`${node.text}\0${path}`)?.id;
      if (selfDefinitionId) addReference(selfDefinitionId, "internal");
      ts.forEachChild(node, visitIdentifiers);
    };
    visitIdentifiers(sourceFile);
  }

  const results = [...definitions.values()]
    .toSorted((left, right) => left.path.localeCompare(right.path) || left.symbol.localeCompare(right.symbol))
    .map((definition) => {
      const dynamicI18n = hasDynamicI18nPrefix(definition.symbol, i18nKeys);
      const classification = classifyDefinition(definition, dynamicI18n);
      const suggestedAction = suggestedActionFor(classification, definition.symbol);
      return {
        symbol: definition.symbol,
        defined_in: relative(projectRoot, definition.path).replaceAll("\\", "/"),
        runtime: definition.runtime,
        test: definition.test,
        barrel: definition.barrel,
        route: definition.route,
        i18n_dynamic: dynamicI18n ? "yes" : "-",
        classification,
        suggested_action: suggestedAction,
      };
    });

  const summary = results.reduce(
    (accumulator, row) => {
      accumulator[row.classification] = (accumulator[row.classification] ?? 0) + 1;
      if (row.runtime === 0) accumulator.zero_runtime += 1;
      if (row.runtime === 0 && row.test > 0) accumulator.test_only_references += 1;
      return accumulator;
    },
    { zero_runtime: 0, test_only_references: 0 }
  );

  return {
    schema_version: "research-reference-audit.v1",
    scanned_files: includedEntries.length,
    summary,
    results,
  };
}

/**
 * Apply explicit retention policy before reference-count classification.
 *
 * Args:
 *   definition: Definition with counted references.
 *   dynamicI18n: Whether dynamic i18n keys cover the symbol.
 *
 * Returns:
 *   Stable classification name.
 */
function classifyDefinition(definition, dynamicI18n) {
  if (COMPAT_CONTRACTS.has(definition.symbol)) return "compat_contract_keep";
  if (BUSINESS_REQUIRED.has(definition.symbol)) return "business_required_keep";
  if (pathRoles(definition.path).isRoute && (definition.isDefault || FRAMEWORK_ROUTE_EXPORTS.has(definition.symbol))) {
    return "route_entry_keep";
  }
  if (definition.runtime > 0) return "runtime";
  if (definition.test > 0) return "test_only";
  if (dynamicI18n) return "i18n_dynamic";
  if (normalize(definition.path).replaceAll("\\", "/").includes("/packages/constants/src/")) {
    return "external_package_keep";
  }
  if (definition.barrel > 0) return "barrel_only";
  if (definition.internal > 0) return "internal";
  return "unused";
}

/**
 * Build a review action for a classification.
 *
 * Args:
 *   classification: Stable classification name.
 *
 * Returns:
 *   Human-readable action, including the reason for retained contracts.
 */
function suggestedActionFor(classification, symbol) {
  if (classification === "compat_contract_keep") {
    return `保留：${COMPAT_CONTRACTS.get(symbol)}`;
  }
  if (classification === "business_required_keep") {
    return `保留：${BUSINESS_REQUIRED.get(symbol)}`;
  }
  if (classification === "route_entry_keep") return "保留：React Router 文件约定入口";
  if (classification === "external_package_keep") return "保留：跨包导出需先确认 admin 等消费方";
  const actions = {
    runtime: "保留运行时引用",
    test_only: "复核测试契约；无兼容责任再删除或改为行为断言",
    i18n_dynamic: "保留动态文案入口",
    barrel_only: "确认消费者后移除无效 barrel 导出",
    internal: "取消 export，保留实现",
    unused: "进入 C1 删除候选",
  };
  return actions[classification];
}

/**
 * Compare current audit output with a recorded baseline.
 *
 * Args:
 *   current: Current audit result.
 *   baseline: Parsed baseline object or result array.
 *
 * Returns:
 *   Comparison rows and an ok flag; unresolved/new prevent a clean exit.
 */
export function compareAuditToBaseline(current, baseline) {
  const baselineRows = Array.isArray(baseline) ? baseline : baseline.results;
  const currentByKey = new Map(current.results.map((row) => [`${row.symbol}\0${row.defined_in}`, row]));
  let rows = [];

  for (const baselineRow of baselineRows) {
    const key = `${baselineRow.symbol}\0${baselineRow.defined_in}`;
    const currentRow = currentByKey.get(key);
    currentByKey.delete(key);
    if (!currentRow) {
      rows.push({ ...baselineRow, status: "removed" });
      continue;
    }
    if (baselineRow.runtime === 0 && currentRow.runtime > 0) {
      rows.push({ ...currentRow, status: "reused" });
      continue;
    }
    if (baselineRow.classification === "unused" && currentRow.classification === "unused") {
      rows.push({ ...currentRow, status: "unresolved" });
      continue;
    }
    rows.push({ ...currentRow, status: "unchanged" });
  }

  for (const currentRow of currentByKey.values()) {
    if (currentRow.classification === "unused") rows.push({ ...currentRow, status: "new" });
  }

  rows = rows.toSorted((left, right) => {
    const order = ["unresolved", "new", "reused", "removed", "unchanged"];
    return (
      order.indexOf(left.status) - order.indexOf(right.status) ||
      left.symbol.localeCompare(right.symbol) ||
      left.defined_in.localeCompare(right.defined_in)
    );
  });
  return {
    ok: !rows.some((row) => ["unresolved", "new"].includes(row.status)),
    rows,
  };
}

/**
 * Render a Markdown table.
 *
 * Args:
 *   headers: Column names.
 *   rows: String cell rows.
 *
 * Returns:
 *   Markdown table text.
 */
/**
 * Render one Markdown table row.
 *
 * Args:
 *   cells: Cell values for the row.
 *
 * Returns:
 *   A single Markdown table row.
 */
function renderMarkdownRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

/**
 * Render a Markdown table.
 *
 * Args:
 *   headers: Column names.
 *   rows: String cell rows.
 *
 * Returns:
 *   Markdown table text.
 */
function markdownTable(headers, rows) {
  const render = renderMarkdownRow;
  return [render(headers), render(headers.map(() => "---")), ...rows.map(render)].join("\n");
}

/**
 * Render audit data as deterministic Markdown.
 *
 * Args:
 *   audit: Analyzed audit result.
 *
 * Returns:
 *   Markdown report text.
 */
export function formatAuditMarkdown(audit) {
  const allRows = audit.results.map((row) => MARKDOWN_HEADER.map((key) => String(row[key])));
  const sections = [
    ["零运行时引用", (row) => row.runtime === 0],
    ["仅测试引用", (row) => row.runtime === 0 && row.test > 0 && row.classification === "test_only"],
    ["兼容契约需保留", (row) => row.classification === "compat_contract_keep"],
    ["低引用但业务必须保留", (row) => row.classification === "business_required_keep"],
  ];
  let markdown = [
    "# Research reference audit",
    "",
    `- Scanned files: ${audit.scanned_files}`,
    `- Zero-runtime exports: ${audit.summary.zero_runtime}`,
    `- Runtime-zero with test references: ${audit.summary.test_only_references}`,
    "",
    "## 分类输出",
    "",
  ].join("\n");

  for (const [title, filter] of sections) {
    const rows = audit.results.filter(filter);
    markdown += `### ${title} (${rows.length})\n\n`;
    markdown += rows.length
      ? `${markdownTable(
          ["symbol", "defined_in", "classification", "suggested_action"],
          rows.map((row) => [row.symbol, row.defined_in, row.classification, row.suggested_action])
        )}\n\n`
      : "_None._\n\n";
  }

  markdown += "## 全量导出引用\n\n";
  markdown += `${markdownTable(MARKDOWN_HEADER, allRows)}\n`;
  return markdown;
}

/**
 * Render baseline comparison as deterministic Markdown.
 *
 * Args:
 *   comparison: Comparison result.
 *
 * Returns:
 *   Markdown comparison report.
 */
export function formatComparisonMarkdown(comparison) {
  const headers = [...MARKDOWN_HEADER, "status"];
  const rows = comparison.rows.map((row) => headers.map((header) => String(row[header] ?? "")));
  return [
    "# Research reference baseline comparison",
    "",
    comparison.ok ? "Status: PASS" : "Status: FAIL",
    "",
    markdownTable(headers, rows),
  ].join("\n");
}

/**
 * Recursively collect source and locale files under a root.
 *
 * Args:
 *   root: Directory to scan.
 *
 * Returns:
 *   Absolute file paths.
 */
async function collectFiles(root) {
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) return [root];
  const entries = await readdir(root, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => !isExcludedPath(join(root, entry.name)));
  const nestedFiles = await Promise.all(
    visibleEntries.filter((entry) => entry.isDirectory()).map((entry) => collectFiles(join(root, entry.name)))
  );
  return [
    ...nestedFiles.flat(),
    ...visibleEntries.filter((entry) => entry.isFile()).map((entry) => join(root, entry.name)),
  ];
}

/**
 * Discover only the fixed research audit scan roots.
 *
 * Args:
 *   projectRoot: Repository root.
 *
 * Returns:
 *   Absolute file paths after fixed exclusions.
 */
async function collectAuditFiles(projectRoot) {
  const roots = [
    resolve(projectRoot, "apps/web/core"),
    resolve(projectRoot, "apps/web/app"),
    resolve(projectRoot, "apps/web/tests"),
    resolve(projectRoot, "packages/constants/src"),
    resolve(projectRoot, "packages/i18n/src/locales/zh-CN/common.json"),
  ];
  const rootResults = await Promise.all(
    roots.map(async (root) => {
      const exists = await stat(root)
        .then(() => true)
        .catch(() => false);
      return exists ? collectFiles(root) : [];
    })
  );
  const files = rootResults.flat();
  return files.filter((path) => {
    if (isExcludedPath(path)) return false;
    return SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))) || path.endsWith("zh-CN/common.json");
  });
}

/**
 * Determine whether a path should contribute exported symbols to the report.
 *
 * Args:
 *   path: Absolute source path.
 *   projectRoot: Repository root.
 *
 * Returns:
 *   True for research modules and shared constants.
 */
function isDefinitionPath(path, projectRoot) {
  const normalized = normalize(path).replaceAll("\\", "/");
  return (
    normalized.startsWith(`${resolve(projectRoot, "apps/web/core/components/research").replaceAll("\\", "/")}/`) ||
    normalized.startsWith(`${resolve(projectRoot, "apps/web/core/services/research").replaceAll("\\", "/")}/`) ||
    normalized.startsWith(`${resolve(projectRoot, "packages/constants/src").replaceAll("\\", "/")}/`)
  );
}

/**
 * Derive the repository root from this script's checked-in location.
 *
 * Returns:
 *   Absolute repository root, independent of the caller's working directory.
 */
function scriptProjectRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/**
 * Run the CLI without writing unless --out is supplied.
 *
 * Returns:
 *   Process exit code: zero on success, one on comparison failure.
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const projectRoot = scriptProjectRoot();
  const paths = await collectAuditFiles(projectRoot);
  const sourceEntries = await Promise.all(paths.map(async (path) => [normalize(path), await readFile(path, "utf8")]));
  const sources = new Map(sourceEntries);
  const definitionPaths = paths.filter((path) => isDefinitionPath(path, projectRoot)).map(normalize);
  const audit = analyzeSourceTexts(Object.fromEntries(sources), { projectRoot, definitionPaths });

  let output;
  let exitCode = 0;
  if (options.compare) {
    const baselinePath = resolve(projectRoot, options.compare);
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    const comparison = compareAuditToBaseline(audit, baseline);
    exitCode = comparison.ok ? 0 : 1;
    output = options.format === "json" ? JSON.stringify(comparison, null, 2) : formatComparisonMarkdown(comparison);
  } else {
    output = options.format === "json" ? JSON.stringify(audit, null, 2) : formatAuditMarkdown(audit);
  }

  if (options.out) {
    const outputPath = resolve(projectRoot, options.out);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${output}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const exitCode = await main();
  process.exit(exitCode);
}
