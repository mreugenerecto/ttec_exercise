/**
 * CDK assertion tests.
 *
 * These are not "does CloudFormation work" tests -- they pin the handful of
 * properties that are load-bearing and easy to break silently in a refactor: the
 * TTL attribute name that DynamoDB matches against, the IAM scope of each
 * Lambda, the S3 bucket staying private, and the Lambda timeout staying under
 * Amazon Connect's patience.
 *
 * Bundling is stubbed out: synthesising with real esbuild bundling would make
 * every run of the suite several seconds slower for no additional signal.
 */
process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
process.env.CDK_DEFAULT_REGION = 'us-east-1';

jest.mock('aws-cdk-lib/aws-lambda-nodejs', () => {
  const cdkLambda = jest.requireActual('aws-cdk-lib/aws-lambda');
  const actual = jest.requireActual('aws-cdk-lib/aws-lambda-nodejs');
  return {
    ...actual,
    NodejsFunction: class extends cdkLambda.Function {
      constructor(scope: unknown, id: string, props: Record<string, unknown>) {
        const { entry, bundling, ...rest } = props;
        void entry;
        void bundling;
        super(scope, id, {
          ...rest,
          code: cdkLambda.Code.fromInline('exports.handler = async () => ({});'),
          handler: 'index.handler',
          runtime: cdkLambda.Runtime.NODEJS_22_X,
        });
      }
    },
  };
});

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VanityConnectStack } from '../../lib/vanity-connect-stack';
import { VanityCoreStack } from '../../lib/vanity-core-stack';
import { VanityWebStack } from '../../lib/vanity-web-stack';

const ENV = { account: '123456789012', region: 'us-east-1' };
const CONNECT_INSTANCE_ARN =
  'arn:aws:connect:us-east-1:123456789012:instance/11111111-2222-3333-4444-555555555555';

function buildApp(coreProps = {}) {
  const app = new cdk.App();
  const core = new VanityCoreStack(app, 'CoreStack', { env: ENV, ...coreProps });
  return { app, core };
}

describe('VanityCoreStack', () => {
  const { core } = buildApp();
  const template = Template.fromStack(core);

  it('creates exactly one table, on demand, with the feed index', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'recent-calls-index',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });

  it('names the TTL attribute exactly what the repository writes', () => {
    // A mismatch here is invisible: items simply never expire.
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('enables point-in-time recovery on data we cannot regenerate', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  it('keeps the IVR Lambda under the contact flow timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: Match.anyValue(),
    });
    const functions = template.findResources('AWS::Lambda::Function');
    const timeouts = Object.values(functions)
      .map((f) => (f.Properties as { Timeout?: number }).Timeout)
      .filter((t): t is number => typeof t === 'number');
    expect(timeouts.every((t) => t < 8)).toBe(true);
  });

  it('passes the table name and result counts to the Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          RESULTS_TO_STORE: '5',
          RESULTS_TO_SPEAK: '3',
          TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it('grants the IVR Lambda write access only -- never read', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (p) =>
        ((p.Properties as { PolicyDocument: { Statement: { Action: string | string[] }[] } })
          .PolicyDocument.Statement ?? []) as { Action: string | string[] }[],
    );
    const dynamoActions = statements
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .filter((a) => typeof a === 'string' && a.startsWith('dynamodb:'));

    expect(dynamoActions).toContain('dynamodb:PutItem');
    expect(dynamoActions.some((a) => a.includes('GetItem') || a.includes('Scan'))).toBe(false);
  });

  it('alarms on errors, latency, dropped writes and throttling', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Threshold: 1,
    });
  });

  it('creates a metric filter so silent persistence failures are still visible', () => {
    template.resourceCountIs('AWS::Logs::MetricFilter', 1);
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      MetricTransformations: Match.arrayWith([
        Match.objectLike({ MetricName: 'PersistFailures', MetricNamespace: 'VanityConnect' }),
      ]),
    });
  });

  it('subscribes the alarm email when one is supplied', () => {
    const { core: withEmail } = buildApp({ alarmEmail: 'ops@example.com' });
    Template.fromStack(withEmail).hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
  });

  it('retains the table when asked to protect the data', () => {
    const { core: retained } = buildApp({ destroyDataOnDelete: false });
    Template.fromStack(retained).hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
    });
  });
});

describe('VanityConnectStack', () => {
  const app = new cdk.App();
  const core = new VanityCoreStack(app, 'CoreStack', { env: ENV });
  const connect = new VanityConnectStack(app, 'ConnectStack', {
    env: ENV,
    connectInstanceArn: CONNECT_INSTANCE_ARN,
    vanityFunction: core.vanityFunction,
    claimPhoneNumber: true,
  });
  const template = Template.fromStack(connect);

  it('publishes a contact flow containing the Lambda ARN', () => {
    template.resourceCountIs('AWS::Connect::ContactFlow', 1);
    template.hasResourceProperties('AWS::Connect::ContactFlow', {
      Type: 'CONTACT_FLOW',
      InstanceArn: CONNECT_INSTANCE_ARN,
    });
  });

  it('associates the Lambda with the Connect instance', () => {
    template.hasResourceProperties('AWS::Connect::IntegrationAssociation', {
      IntegrationType: 'LAMBDA_FUNCTION',
      InstanceId: CONNECT_INSTANCE_ARN,
    });
  });

  it('grants Connect permission to invoke, scoped to this one instance', () => {
    // The permission is a property of the *function*, so CDK places it in the
    // stack that owns the function (the core stack) even though the Connect
    // stack asks for it. Asserting on the right template is the point of this
    // test as much as asserting on the right principal.
    Template.fromStack(core).hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'connect.amazonaws.com',
      SourceArn: CONNECT_INSTANCE_ARN,
      SourceAccount: '123456789012',
    });
  });

  it('claims a phone number and wires it to the flow', () => {
    template.hasResourceProperties('AWS::Connect::PhoneNumber', {
      TargetArn: CONNECT_INSTANCE_ARN,
      Type: 'TOLL_FREE',
      CountryCode: 'US',
    });
    // The custom resource that closes the last mile CloudFormation cannot.
    template.resourceCountIs('Custom::AWS', 1);
  });

  it('does not claim a number unless asked', () => {
    const otherApp = new cdk.App();
    const otherCore = new VanityCoreStack(otherApp, 'CoreStack', { env: ENV });
    const noPhone = new VanityConnectStack(otherApp, 'ConnectStack', {
      env: ENV,
      connectInstanceArn: CONNECT_INSTANCE_ARN,
      vanityFunction: otherCore.vanityFunction,
    });
    Template.fromStack(noPhone).resourceCountIs('AWS::Connect::PhoneNumber', 0);
  });
});

describe('VanityWebStack', () => {
  const app = new cdk.App();
  const core = new VanityCoreStack(app, 'CoreStack', { env: ENV });
  const web = new VanityWebStack(app, 'WebStack', {
    env: ENV,
    table: core.table,
    recentIndexName: core.recentIndexName,
  });
  const template = Template.fromStack(web);

  it('keeps the site bucket completely private', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('serves the site and the API from one CloudFront distribution', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: '/api/*' })]),
      }),
    });
  });

  it('forces HTTPS on both the site and the API', () => {
    // No ViewerCertificate assertion: CloudFront only emits one (and only
    // honours minimumProtocolVersion) once a custom domain and certificate are
    // attached. On the default *.cloudfront.net domain the TLS policy is fixed
    // by AWS, so asserting on it here would be asserting on nothing.
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: '/api/*', ViewerProtocolPolicy: 'https-only' }),
        ]),
      }),
    });
  });

  it('sends security headers, including a content security policy', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: Match.objectLike({
            ContentSecurityPolicy: Match.stringLikeRegexp("default-src 'none'"),
          }),
          FrameOptions: { FrameOption: 'DENY', Override: true },
        }),
      }),
    });
  });

  it('throttles the public API', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: 50,
        ThrottlingBurstLimit: 100,
      }),
    });
  });

  it('does not reserve concurrency by default, so it deploys in a fresh account', () => {
    // AWS rejects any reservation that would leave under 10 unreserved
    // executions, and a new account's whole limit is 10. Hard-coding one makes
    // the stack undeployable exactly where a reviewer will try it.
    const functions = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions)) {
      expect((fn.Properties as Record<string, unknown>).ReservedConcurrentExecutions).toBeUndefined();
    }
  });

  it('caps the public API Lambda concurrency when asked to', () => {
    const otherApp = new cdk.App();
    const otherCore = new VanityCoreStack(otherApp, 'CoreStack', { env: ENV });
    const capped = new VanityWebStack(otherApp, 'WebStack', {
      env: ENV,
      table: otherCore.table,
      recentIndexName: otherCore.recentIndexName,
      apiReservedConcurrency: 25,
    });
    Template.fromStack(capped).hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 25,
    });
  });

  it('exposes only a GET route', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /api/recent',
    });
  });
});

describe('app wiring', () => {
  it('synthesises the whole app without a Connect instance', () => {
    const app = new cdk.App();
    const core = new VanityCoreStack(app, 'CoreStack', { env: ENV });
    new VanityWebStack(app, 'WebStack', {
      env: ENV,
      table: core.table,
      recentIndexName: core.recentIndexName,
    });
    expect(() => app.synth()).not.toThrow();
  });
});
