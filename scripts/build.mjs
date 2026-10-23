import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root, {
  noEmit: false, declaration: true, rewriteRelativeImportExtensions: true,
  rootDir: root, outDir: path.join(root, 'dist'),
});
const program = ts.createProgram(config.fileNames.filter(file => file.startsWith(path.join(root, 'src') + path.sep)), config.options);
const runtimeFile = ts.readConfigFile(path.join(root, 'tsconfig.runtime.json'), ts.sys.readFile);
if (runtimeFile.error) throw new Error(ts.flattenDiagnosticMessageText(runtimeFile.error.messageText, ' '));
const runtimeConfig = ts.parseJsonConfigFileContent(runtimeFile.config, ts.sys, root);
const runtimeProgram = ts.createProgram(runtimeConfig.fileNames, runtimeConfig.options);
const diagnostics = [...config.errors, ...runtimeConfig.errors, ...ts.getPreEmitDiagnostics(program), ...ts.getPreEmitDiagnostics(runtimeProgram)];
const emitted = diagnostics.length ? undefined : program.emit();
if (diagnostics.length || emitted?.emitSkipped || emitted?.diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext([...diagnostics, ...(emitted?.diagnostics ?? [])], {
    getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
  })); process.exitCode = 1;
} else {
  const source = path.join(root, 'src', 'runtime'), target = path.join(root, 'dist', 'src', 'runtime');
  await fs.mkdir(target, { recursive: true });
  for (const name of await fs.readdir(source)) {
    if (!name.endsWith('.mjs')) continue;
    const text = await fs.readFile(path.join(source, name), 'utf8');
    // Node does not strip TypeScript inside installed node_modules: all published imports target emitted JS.
    await fs.writeFile(path.join(target, name), text.replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2'));
  }
  console.log('Built executable JS and declaration files in dist/.');
}
