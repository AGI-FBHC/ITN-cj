// Parse literal teaching metadata without executing the downloaded JavaScript.
const fs=require('node:fs'),path=require('node:path');
const ts=require('../apps/web/node_modules/typescript');
const root=path.resolve(__dirname,'..');
const sf=ts.createSourceFile('deployed.js',fs.readFileSync(path.join(root,'deployed/assets/index-Dla-aRwf.js'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function literal(n){
  if(ts.isStringLiteralLike(n))return n.text;
  if(ts.isNumericLiteral(n))return Number(n.text);
  if(n.kind===ts.SyntaxKind.TrueKeyword)return true;
  if(n.kind===ts.SyntaxKind.FalseKeyword)return false;
  if(n.kind===ts.SyntaxKind.NullKeyword)return null;
  if(ts.isPrefixUnaryExpression(n)&&n.operator===ts.SyntaxKind.ExclamationToken)return !literal(n.operand);
  if(ts.isArrayLiteralExpression(n))return n.elements.map(literal);
  if(ts.isObjectLiteralExpression(n))return Object.fromEntries(n.properties.map(p=>{
    if(!ts.isPropertyAssignment(p))throw Error('Non-literal property');
    return[p.name.text,literal(p.initializer)];
  }));
  throw Error('Refusing non-literal source: '+n.getText(sf).slice(0,60));
}
const vars={};
for(const statement of sf.statements)if(ts.isVariableStatement(statement))for(const d of statement.declarationList.declarations)if(['$t','lm'].includes(d.name.getText(sf)))vars[d.name.getText(sf)]=literal(d.initializer);
const result={courses:vars.$t.map(c=>({...c,chapters:c.chapters.map(ch=>({...ch,done:false}))})),courseFacts:vars.lm};
fs.mkdirSync(path.join(root,'fixtures'),{recursive:true});
fs.writeFileSync(path.join(root,'fixtures/course-catalog.json'),JSON.stringify(result,null,2)+'\n');
console.log('Recovered literal catalog:',result.courses.length,'courses');
