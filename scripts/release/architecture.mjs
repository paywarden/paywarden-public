import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { root, git } from './common.mjs';

const violations = [];
for (const file of git('ls-files', 'src', 'dashboard/src', 'checkout/src').split('\n').filter(file => /\.tsx?$/.test(file))) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const dependency = node.moduleSpecifier.text;
      if ((file.startsWith('src/config/') && /\.\.\/(services|api)\//.test(dependency)) ||
          (file.startsWith('src/utils/') && /\.\.\/(services|api|db)\//.test(dependency)) ||
          (/^(dashboard|checkout)\/src\//.test(file) && /\.\.\/src\//.test(dependency))) violations.push(file + ': invalid layer dependency');
    }
    if (!file.includes('/__tests__/') && ts.isPropertySignature(node) && node.type && node.name &&
        /^(amount|amountExpected|amountReceived|amountPayable|price|fee)$/.test(node.name.getText(source))) {
      // The RPC boundary accepts native sun values as number|string and verifies them before use.
      const rawNativeDto = file === 'src/services/chain-transactions.ts' && node.questionToken && node.type.getText(source) === 'number | string';
      if (!rawNativeDto && /\bnumber\b/.test(node.type.getText(source))) violations.push(file + ': domain amount must be a string');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
if (violations.length) throw new Error(violations.join('\n'));
console.log('Architecture check passed');
