#!/usr/bin/env node
/**
 * CDK app entry point.
 *
 * Configuration comes from CDK context (`-c key=value` or cdk.context.json)
 * rather than environment variables, so that a deployment is reproducible from
 * the command line a reviewer can copy out of the README:
 *
 *   npx cdk deploy --all \
 *     -c connectInstanceArn=arn:aws:connect:us-east-1:123456789012:instance/abc \
 *     -c claimPhoneNumber=true \
 *     -c alarmEmail=you@example.com
 *
 * The Connect stack is conditional on `connectInstanceArn` so that the core and
 * web stacks deploy cleanly in an account with no Connect instance at all.
 */
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VanityCoreStack } from '../lib/vanity-core-stack';
import { VanityConnectStack } from '../lib/vanity-connect-stack';
import { VanityWebStack } from '../lib/vanity-web-stack';

const app = new cdk.App();

/** Read a context value as a boolean. CLI context arrives as a string. */
function boolContext(key: string, fallback: boolean): boolean {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  return String(raw).toLowerCase() === 'true';
}

function intContext(key: string, fallback: number): number {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Context value "${key}" must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/** Like intContext, but absent means "do not set this at all". */
function optionalIntContext(key: string): number | undefined {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null || raw === '') return undefined;
  return intContext(key, 0);
}

const connectInstanceArn: string | undefined = app.node.tryGetContext('connectInstanceArn');
const alarmEmail: string | undefined = app.node.tryGetContext('alarmEmail');
const prefix: string = app.node.tryGetContext('stackPrefix') ?? 'Vanity';
const deployWebApp = boolContext('deployWebApp', true);
const claimPhoneNumber = boolContext('claimPhoneNumber', false);
const destroyDataOnDelete = boolContext('destroyDataOnDelete', true);
const recentShardCount = intContext('recentShardCount', 1);
const retentionDays = intContext('retentionDays', 90);

// Fall back to the ambient CLI credentials. Being explicit about the account and
// region (rather than leaving them undefined) means the synthesised template is
// environment-specific, which is what lets CDK make correct decisions about
// things like availability zones and CloudFront edge behaviour.
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const core = new VanityCoreStack(app, `${prefix}CoreStack`, {
  env,
  description: 'Vanity number IVR: DynamoDB table, contact-flow Lambda, alarms.',
  recentShardCount,
  retentionDays,
  alarmEmail,
  destroyDataOnDelete,
});

if (connectInstanceArn) {
  if (!/^arn:aws[a-z-]*:connect:[a-z0-9-]+:\d{12}:instance\/[0-9a-f-]+$/.test(connectInstanceArn)) {
    // Fail at synth with a useful message rather than at deploy with a
    // CloudFormation error 90 seconds in.
    throw new Error(
      `connectInstanceArn does not look like a Connect instance ARN: "${connectInstanceArn}"\n` +
        'Expected: arn:aws:connect:<region>:<account>:instance/<instance-id>',
    );
  }

  new VanityConnectStack(app, `${prefix}ConnectStack`, {
    env,
    description: 'Vanity number IVR: contact flow, Lambda association, phone number.',
    connectInstanceArn,
    vanityFunction: core.vanityFunction,
    claimPhoneNumber,
    phoneNumberType: app.node.tryGetContext('phoneNumberType') ?? 'TOLL_FREE',
    phoneNumberCountryCode: app.node.tryGetContext('phoneNumberCountryCode') ?? 'US',
  });
} else {
  // Not an error: the core stack is useful on its own, and this is the first
  // thing a reviewer will hit if they run `cdk deploy` with no arguments.
  cdk.Annotations.of(core).addInfo(
    'No connectInstanceArn in context, so the Amazon Connect stack was skipped. ' +
      'Pass -c connectInstanceArn=arn:aws:connect:...:instance/... to deploy the contact flow.',
  );
}

if (deployWebApp) {
  new VanityWebStack(app, `${prefix}WebStack`, {
    env,
    description: 'Vanity number IVR: read API and static web app for recent callers.',
    table: core.table,
    recentIndexName: core.recentIndexName,
    recentShardCount,
    destroyDataOnDelete,
    apiReservedConcurrency: optionalIntContext('apiReservedConcurrency'),
  });
}

cdk.Tags.of(app).add('project', 'vanity-connect');
cdk.Tags.of(app).add('managed-by', 'aws-cdk');

app.synth();
