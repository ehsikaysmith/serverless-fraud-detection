// Compares the CDK app's synthesized template with infrastructure/template.yaml.
//   node cdk/compare-cdk.mjs infrastructure/template.yaml cdk/cdk.out/<stack>.template.json
// CDK-only additions (bootstrap parameter and rule, CDKMetadata, aws:cdk:path) are ignored, and
// Lambda Code is compared as "local build folder" vs "CDK asset".
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const [cfnPath, cdkPath] = process.argv.slice(2);
const cfn = parse(readFileSync(cfnPath, 'utf8'));
const cdk = JSON.parse(readFileSync(cdkPath, 'utf8'));
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const problems = [];
const a = cfn.Resources ?? {};
const b = Object.fromEntries(Object.entries(cdk.Resources ?? {}).filter(([, r]) => r.Type !== 'AWS::CDK::Metadata'));
for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
  if (!a[id] || !b[id]) { problems.push(id + ': only in ' + (a[id] ? 'the template' : 'the CDK app')); continue; }
  const pa = structuredClone(a[id].Properties ?? {});
  const pb = structuredClone(b[id].Properties ?? {});
  if (a[id].Type === 'AWS::Lambda::Function') {
    if (!(typeof pa.Code === 'string' && pa.Code.startsWith('../build/'))) problems.push(id + ': template Code should be a ../build/ folder');
    if (!(pb.Code && pb.Code.S3Bucket && pb.Code.S3Key)) problems.push(id + ': CDK Code should be an asset');
    delete pa.Code; delete pb.Code;
  }
  if (a[id].Type !== b[id].Type || JSON.stringify(sorted(pa)) !== JSON.stringify(sorted(pb))) problems.push(id + ': differs');
}
const outA = JSON.stringify(sorted(cfn.Outputs ?? {}));
const outB = JSON.stringify(sorted(Object.fromEntries(Object.entries(cdk.Outputs ?? {}).map(([k, v]) => [k, { Value: v.Value }]))));
if (outA !== outB) problems.push('Outputs differ');
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('CDK app matches the template: ' + Object.keys(a).length + ' resources');
