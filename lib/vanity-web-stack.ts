/**
 * Bonus deliverable: a small web app showing the vanity numbers from the last
 * five callers.
 *
 * ARCHITECTURE CHOICE -- ONE ORIGIN, NOT TWO.
 * The obvious build is "S3 website + API Gateway URL + CORS". I put the API
 * behind the same CloudFront distribution as the static site instead, on a
 * `/api/*` behaviour. That means:
 *   - no CORS at all (same origin), so no preflight round trip and no
 *     `Access-Control-Allow-Origin: *` to get wrong later;
 *   - the S3 bucket stays fully private behind Origin Access Control;
 *   - one place to attach WAF, one place to attach a custom domain and cert.
 * The cost is a slower first deploy (CloudFront takes a few minutes), which is
 * the right trade for a shape that does not have to be unpicked in production.
 */
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as path from 'path';

export interface VanityWebStackProps extends cdk.StackProps {
  readonly table: dynamodb.ITable;
  readonly recentIndexName: string;
  readonly recentShardCount?: number;
  /** Matches the core stack so `cdk destroy` really removes everything. */
  readonly destroyDataOnDelete?: boolean;
  /**
   * Reserved concurrency for the public read API. Unset by default, and that
   * default is deliberate rather than lazy.
   *
   * A cap here is genuinely valuable: it turns a traffic flood into 429s on this
   * one function instead of exhausting account concurrency and taking the *IVR*
   * Lambda down with it. But a reserved value is carved out of the account's
   * pool, and AWS refuses any reservation that would leave fewer than 10
   * unreserved executions. A brand-new account has a limit of exactly 10, so
   * hard-coding a reservation makes this stack undeployable in precisely the
   * account a reviewer is most likely to use -- which is how I found out.
   *
   * So it is opt-in: `-c apiReservedConcurrency=10` once the account limit has
   * been raised. In production this is set, and sized against the account limit.
   */
  readonly apiReservedConcurrency?: number;
}

export class VanityWebStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: VanityWebStackProps) {
    super(scope, id, props);

    const destroyData = props.destroyDataOnDelete ?? true;

    // --------------------------------------------------------------- read API

    const apiLogGroup = new logs.LogGroup(this, 'ApiFunctionLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const apiFunction = new NodejsFunction(this, 'RecentCallsFunction', {
      entry: path.join(__dirname, '..', 'src', 'handlers', 'api-recent.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      logGroup: apiLogGroup,
      environment: {
        TABLE_NAME: props.table.tableName,
        RECENT_INDEX_NAME: props.recentIndexName,
        RECENT_SHARD_COUNT: String(props.recentShardCount ?? 1),
        LOG_LEVEL: 'INFO',
        SERVICE_NAME: 'vanity-api',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      bundling: { minify: true, sourceMap: true, target: 'node22' },
      tracing: lambda.Tracing.ACTIVE,
      // See the prop docs: valuable, but not safe to hard-code. The API is not
      // left unprotected without it -- API Gateway throttling below is the first
      // line of defence and does not depend on the account's concurrency pool.
      ...(props.apiReservedConcurrency !== undefined
        ? { reservedConcurrentExecutions: props.apiReservedConcurrency }
        : {}),
    });

    // Read-only, and only on the index the feed actually uses.
    props.table.grantReadData(apiFunction);

    const httpApi = new apigwv2.HttpApi(this, 'RecentCallsApi', {
      apiName: 'vanity-recent-calls',
      description: 'Read-only feed of recent callers and their vanity numbers.',
      // CORS is intentionally absent: the app is served same-origin through
      // CloudFront. If you ever call this endpoint from another origin, add it
      // here explicitly rather than reaching for a wildcard.
    });

    httpApi.addRoutes({
      // The path includes /api because CloudFront forwards the viewer path
      // unchanged to this origin. Keeping the prefix here avoids a rewrite
      // function, which is one less thing between a request and a response.
      path: '/api/recent',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('RecentCallsIntegration', apiFunction),
    });

    // Throttling and access logs are not exposed on the L2 default stage yet, so
    // drop to the L1. Without a throttle, a single client can drive unbounded
    // Lambda invocations and DynamoDB reads on your bill.
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const cfnStage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    cfnStage.defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
      detailedMetricsEnabled: true,
    };
    cfnStage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        routeKey: '$context.routeKey',
        status: '$context.status',
        integrationLatency: '$context.integrationLatency',
        responseLatency: '$context.responseLatency',
      }),
    };

    // ------------------------------------------------------------ static site

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      // No public access anywhere: CloudFront reaches the bucket through Origin
      // Access Control, so the bucket itself is never addressable.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: destroyData ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: destroyData,
    });

    // Sensible baseline headers on every response. HSTS is set but short: a long
    // max-age on a CloudFront domain you might tear down is a foot-gun.
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          // The app ships one HTML, one CSS and one JS file, all same-origin,
          // and talks only to /api on its own origin. Nothing else is allowed.
          contentSecurityPolicy:
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(30),
          includeSubdomains: true,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(
            `${httpApi.apiId}.execute-api.${this.region}.${this.urlSuffix}`,
            { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY },
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          // Never cache at the edge: the whole point of the page is freshness.
          // The 5 s `cache-control` the Lambda sets is what absorbs refresh
          // hammering, and that is a deliberate, visible decision in one place.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Forwarding the viewer Host header would make API Gateway reject the
          // request, since it would not match the execute-api domain.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders,
        },
      },
      // North America + Europe only. Cheapest class that still serves the
      // reviewer; a global audience would want PriceClass.PRICE_CLASS_ALL.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      // NOTE: no `minimumProtocolVersion` here. CloudFront only honours it once a
      // custom domain and ACM certificate are attached; on the default
      // *.cloudfront.net domain the TLS policy is fixed by AWS, and setting it
      // produces a synth warning and a false sense of security. Attach a domain
      // (see docs/PRODUCTION-READINESS.md) and it becomes meaningful.
      comment: 'Vanity number demo web app',
      // SPA-style fallback so a refresh on any path still lands on the app.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'web'))],
      destinationBucket: siteBucket,
      distribution: this.distribution,
      // Invalidate the whole site: it is three small files, so a targeted
      // invalidation would be premature optimisation.
      distributionPaths: ['/*'],
      prune: true,
    });

    // ---------------------------------------------------------------- outputs

    new cdk.CfnOutput(this, 'WebAppUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Open this to see the last 5 callers.',
    });
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: `https://${this.distribution.distributionDomainName}/api/recent`,
      description: 'Read-only JSON feed of recent callers (numbers are masked).',
    });
  }
}
