import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const sessionsDir = resolve(testDir, '..');
const registryDir = join(sessionsDir, 'registry');

function registrySources(): string[] {
  return [
    join(sessionsDir, 'registry.ts'),
    ...readdirSync(registryDir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(registryDir, name)),
  ];
}

function importHasRuntimeBinding(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (!clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function exportHasRuntimeBinding(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return false;
  if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) return true;
  return statement.exportClause.elements.some((element) => !element.isTypeOnly);
}

function runtimeDependencies(file: string, knownFiles: Set<string>): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, false);
  const dependencies: string[] = [];

  for (const statement of source.statements) {
    let specifier: string | undefined;
    if (ts.isImportDeclaration(statement) && importHasRuntimeBinding(statement)) {
      specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
    } else if (ts.isExportDeclaration(statement) && exportHasRuntimeBinding(statement)) {
      specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    }
    if (!specifier?.startsWith('.')) continue;
    const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
    if (knownFiles.has(target)) dependencies.push(target);
  }

  return dependencies;
}

function findRuntimeCycle(graph: Map<string, string[]>): string[] | null {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  const visit = (file: string): string[] | null => {
    if (active.has(file)) {
      const start = stack.indexOf(file);
      return [...stack.slice(start), file];
    }
    if (visited.has(file)) return null;
    visited.add(file);
    active.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(file);
    return null;
  };

  for (const file of graph.keys()) {
    const cycle = visit(file);
    if (cycle) return cycle;
  }
  return null;
}

describe('session registry import graph', () => {
  it('keeps runtime dependencies acyclic', () => {
    const files = registrySources();
    const knownFiles = new Set(files);
    const graph = new Map(files.map((file) => [file, runtimeDependencies(file, knownFiles)]));
    const cycle = findRuntimeCycle(graph);

    expect(cycle && cycle.map((file) => file.slice(sessionsDir.length + 1))).toBeNull();
  });
});
