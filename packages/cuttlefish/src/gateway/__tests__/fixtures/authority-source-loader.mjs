// Fresh-process tests execute the current source, independent of stale dist output.
import { registerHooks } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (fs.existsSync(source)) return { url: source.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText };
    return nextLoad(url, context);
  },
});
