/* Recover editable application code from the only surviving deployment.
 * Does not execute the downloaded bundle. React/router stay npm dependencies.
 * Original deployment remains byte-for-byte intact under deployed/.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const app = path.join(root, 'apps/web');
const requireApp = createRequire(path.join(app, 'package.json'));
let ts;
try { ts = requireApp('typescript'); }
catch { ts = require('C:/Users/GeJie/.codex/worktrees/13e7/ITN/src/front/node_modules/typescript'); }
const file = path.join(root, 'deployed/assets/index-Dla-aRwf.js');
const text = fs.readFileSync(file, 'utf8');
const host = ts.createCompilerHost({ allowJs: true });
const originalGet = host.getSourceFile;
host.getSourceFile = (name, version, ...rest) => name === file
  ? ts.createSourceFile(file, text, version, true, ts.ScriptKind.JS)
  : originalGet.call(host, name, version, ...rest);
const program = ts.createProgram([file], {allowJs: true, noResolve: true, target: ts.ScriptTarget.ESNext}, host);
const sf = program.getSourceFile(file);
const checker = program.getTypeChecker();
const imports = new Map(Object.entries({
  v: 'React', o: 'jsxRuntime', l0: 'ReactDOM', Eb: 'BrowserRouter',
  lb: 'Routes', xl: 'Route', Wi: 'useNavigate', Q0: 'useParams', zm: 'Link', Cb: 'NavLink',
}));
const rename = new Map(Object.entries({
  dn:'ProductLogo', Ub:'Navbar', Pb:'Hero', Wb:'Footer', l2:'OnboardingWizard',
  a2:'GeneratingPlan', ya:'AppNavigation', Bm:'LessonStartModal', Pv:'QuizFlow',
  xu:'Lecture', gu:'Presentation', t3:'CourseDetail', jx:'Bookmarks', Nx:'Courses',
  Sx:'LearningProgress', f3:'AIChat', h3:'ProfileEditor', b3:'Dashboard', y3:'Home', j3:'RecoveredApp',
}));
function topStatement(declaration) {
  let node = declaration;
  while (node?.parent && node.parent !== sf) node = node.parent;
  return node?.parent === sf ? node : null;
}
function globalSymbol(node) {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol?.declarations?.length) return null;
  const decl = symbol.declarations.find(d => topStatement(d));
  // Nested bindings are not module bindings, even if their owner is top-level.
  if (!decl) return null;
  let owner = decl.parent;
  while (owner && owner !== sf && !ts.isFunctionLike(owner) && !ts.isBlock(owner)) owner = owner.parent;
  if (owner !== sf) return null;
  return {symbol, statement: topStatement(decl)};
}
const selected = new Set();
const external = new Set();
function add(statement) {
  if (!statement || selected.has(statement)) return;
  selected.add(statement);
  function visit(node) {
    if (ts.isIdentifier(node)) {
      const info = globalSymbol(node);
      if (info && info.statement !== statement) {
        if (imports.has(node.text)) external.add(node.text);
        else add(info.statement);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(statement);
}
// ProductLogo starts the authored UI. Everything after it is application/UI code.
const first = sf.statements.findIndex(n => ts.isFunctionDeclaration(n) && n.name?.text === 'dn');
if (first < 0) throw new Error('Original application boundary not found');
for (const statement of sf.statements.slice(first)) {
  if (ts.isExpressionStatement(statement) && statement.getText(sf).includes('createRoot')) continue;
  add(statement);
}
const printer = ts.createPrinter({newLine: ts.NewLineKind.LineFeed});
const transformer = context => node => {
  function visit(n) {
    if (ts.isIdentifier(n)) {
      const info = globalSymbol(n);
      const next = info && (imports.get(n.text) || rename.get(n.text));
      if (next) return ts.factory.createIdentifier(next);
    }
    return ts.visitEachChild(n, visit, context);
  }
  return ts.visitNode(node, visit);
};
const body = [...selected].sort((a,b)=>a.pos-b.pos).map(n=> {
  const result=ts.transform(n,[transformer]);
  const out=printer.printNode(ts.EmitHint.Unspecified,result.transformed[0],sf);
  result.dispose(); return out;
}).join('\n\n');
const header = `// Recovered from the 2026-08-03 deployment, not the lost original TSX.\n`+
  `import * as React from 'react';\nimport * as jsxRuntime from 'react/jsx-runtime';\n`+
  `import {BrowserRouter,Routes,Route,useNavigate,useParams,Link,NavLink} from 'react-router-dom';\n`;
fs.mkdirSync(path.join(app,'src'),{recursive:true});
fs.writeFileSync(path.join(app,'src/RecoveredApp.jsx'),header+body+'\nexport default RecoveredApp;\n');
fs.copyFileSync(path.join(root,'deployed/assets/index-C3783eOR.css'),path.join(app,'src/styles.css'));
fs.cpSync(path.join(root,'deployed/courses'),path.join(app,'public/courses'),{recursive:true});
fs.writeFileSync(path.join(app,'src/main.jsx'),`import React from 'react';\nimport {createRoot} from 'react-dom/client';\nimport App from './RecoveredApp.jsx';\nimport './styles.css';\ncreateRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);\n`);
console.log(JSON.stringify({applicationStatements:sf.statements.length-first,selectedStatements:selected.size,bytes:body.length,external:[...external],retainedDependencyStatements:[...selected].filter(n=>n.pos<sf.statements[first].pos).map(n=>({start:n.pos,preview:n.getText(sf).slice(0,100)}))},null,2));
