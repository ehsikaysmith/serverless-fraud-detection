# CDK version (optional)

The same infrastructure as `../infrastructure/template.yaml`, as an AWS CDK app. Use it if you
want to keep building your infrastructure in TypeScript. If you don't, ignore this folder:
`../scripts/deploy.sh` deploys the CloudFormation template directly.

```bash
cd ..
npm install && npm run build      # bundles the Lambda code into build/
cd cdk
npm install
npx cdk bootstrap                 # once per account and region (creates the CDKToolkit stack)
npx cdk diff
npx cdk deploy
```

- Deploy with **either** this folder **or** `scripts/deploy.sh` under the same stack name, not both
  alternately, or each will try to undo the other's changes.
- `cdk bootstrap` creates a small CDKToolkit stack (an S3 bucket, an ECR repository and IAM roles).
- Pick one source of truth once you start changing things: edit `lib/stack.ts` and stop using the
  template, or the other way round.
