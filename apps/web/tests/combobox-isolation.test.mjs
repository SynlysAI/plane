import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const excluded = new Set(["node_modules", "build", "dist", ".react-router", ".next", ".turbo", "tests"]);

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && !excluded.has(entry.name)) yield* sourceFiles(filename);
    else if (entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith(".stories.tsx")) yield filename;
  }
}

function unsafePanels(filename, text) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const optionsTags = new Set();
  const inputTags = new Set();
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== "@headlessui/react") continue;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      const imported = specifier.propertyName?.text ?? specifier.name.text;
      if (imported === "Combobox") {
        optionsTags.add(`${specifier.name.text}.Options`);
        inputTags.add(`${specifier.name.text}.Input`);
      }
      if (imported === "ComboboxOptions") optionsTags.add(specifier.name.text);
      if (imported === "ComboboxInput") inputTags.add(specifier.name.text);
    }
  }
  const failures = [];
  function visit(node) {
    if (ts.isJsxElement(node) && optionsTags.has(node.openingElement.tagName.getText(source))) {
      let hasInput = false;
      function findInput(child) {
        if (
          (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) &&
          inputTags.has(child.tagName.getText(source))
        )
          hasInput = true;
        ts.forEachChild(child, findInput);
      }
      node.children.forEach(findInput);
      const nonModal = node.openingElement.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(source) === "modal" &&
          attribute.initializer &&
          ts.isJsxExpression(attribute.initializer) &&
          attribute.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword
      );
      if (hasInput && !nonModal) failures.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return failures;
}

it("keeps Headless UI panels with embedded search inputs non-modal across apps and shared packages", () => {
  const failures = [];
  for (const directory of ["apps", "packages"]) {
    for (const filename of sourceFiles(path.join(root, directory))) {
      const text = readFileSync(filename, "utf8");
      if (!text.includes("@headlessui/react")) continue;
      for (const line of unsafePanels(filename, text)) failures.push(`${path.relative(root, filename)}:${line}`);
    }
  }
  assert.deepEqual(failures, [], "Embedded Combobox.Input requires modal={false} to keep sibling options interactive");
});

it("detects unsafe aliased components without flagging other combobox libraries or external inputs", () => {
  const prefix = 'import { Combobox as Select } from "@headlessui/react";\n';
  assert.deepEqual(
    unsafePanels("fixture.tsx", `${prefix}<Select.Options><div><Select.Input /></div></Select.Options>`),
    [2]
  );
  assert.deepEqual(
    unsafePanels("fixture.tsx", `${prefix}<Select.Options modal={false}><Select.Input /></Select.Options>`),
    []
  );
  assert.deepEqual(unsafePanels("fixture.tsx", `${prefix}<Select><Select.Input /><Select.Options /></Select>`), []);
  assert.deepEqual(unsafePanels("fixture.tsx", "<Select.Options><Select.Input /></Select.Options>"), []);
});
