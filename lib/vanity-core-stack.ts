/**
 * Core stack: the data store, the IVR Lambda, and the observability around them.
 *
 * Split out from the Connect and web stacks so that a reviewer can deploy this
 * one on its own -- it has no dependency on an Amazon Connect instance existing,
 * which is the part most likely to block someone on first run.
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import * as path from 'path';

export interface VanityCoreStackProps extends cdk.StackProps {
  /**
   * Where the "recent calls" feed index is partitioned. 1 is right for a demo;
   * see src/lib/repository.ts for when and why to raise it.
   */
  readonly recentShardCount?: number;
  /** Days to retain call records. Enforced by DynamoDB TTL, not by a job. */
  readonly retentionDays?: number;
  /** If set, alarms email here. Without it the alarms still fire, just quietly. */
  readonly alarmEmail?: string;
  /**
   * Destroy the table on `cdk destroy`. True by default because this is an
   * exercise a reviewer should be able to clean up in one command. In production
   * this is RETAIN, full stop -- see docs/PRODUCTION-READINESS.md.
   */
  readonly destroyDataOnDelete?: boolean;
}

export class VanityCoreStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly vanityFunction: NodejsFunction;
  public readonly alarmTopic: sns.Topic;
  public readonly recentIndexName = 'recent-calls-index';

  constructor(scope: Construct, id: string, props: VanityCoreStackProps = {}) {
    super(scope, id, props);

    const recentShardCount = props.recentShardCount ?? 1;
    const retentionDays = props.retentionDays ?? 90;
    const destroyData = props.destroyDataOnDelete ?? true;

    // ---------------------------------------------------------------- storage

    this.table = new dynamodb.Table(this, 'CallsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      // On-demand: call volume for an IVR is spiky and unpredictable, and
      // provisioned capacity would mean either paying for the peak all day or
      // throttling the peak. Above a sustained, well-understood baseline,
      // provisioned + autoscaling is materially cheaper and worth revisiting.
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      // Caller phone numbers are PII. Point-in-time recovery is cheap insurance
      // against a bad deploy deleting them; encryption at rest is on by default
      // with an AWS-owned key (see the KMS note in PRODUCTION-READINESS.md).
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: destroyData ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: this.recentIndexName,
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      // INCLUDE, not ALL: the feed only needs these four attributes, and a
      // narrower projection is a smaller index to write on every single call.
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['callerNumber', 'contactId', 'requestedAt', 'vanityNumbers'],
    });

    // ---------------------------------------------------------------- compute

    const logGroup = new logs.LogGroup(this, 'VanityFunctionLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.vanityFunction = new NodejsFunction(this, 'VanityFunction', {
      entry: path.join(__dirname, '..', 'src', 'handlers', 'connect-vanity.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // Graviton: same code, ~20% cheaper, and this workload is pure JS with no
      // native dependencies, so there is no portability cost.
      architecture: lambda.Architecture.ARM_64,
      // 512 MB is not about memory (the dictionary index is ~5 MB); it is about
      // CPU, which Lambda allocates proportionally. At 128 MB the cold-start
      // index build is noticeably slower, and a caller is waiting for it.
      memorySize: 512,
      // Deliberately UNDER the flow's 8 s limit so the Lambda times out first
      // and we get a real CloudWatch error instead of an opaque flow timeout.
      timeout: cdk.Duration.seconds(6),
      logGroup,
      environment: {
        TABLE_NAME: this.table.tableName,
        RECENT_INDEX_NAME: this.recentIndexName,
        RECENT_SHARD_COUNT: String(recentShardCount),
        RESULTS_TO_STORE: '5',
        RESULTS_TO_SPEAK: '3',
        RETENTION_DAYS: String(retentionDays),
        LOG_LEVEL: 'INFO',
        SERVICE_NAME: 'vanity-connect',
        // Skip the SDK's default credential-chain probing of EC2 IMDS, which
        // costs ~100 ms on every cold start inside Lambda.
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        // The dictionary is imported as JSON and bundled with the code. See
        // tools/build-dictionary.ts for why, and when it should move to S3.
        format: cdk.aws_lambda_nodejs.OutputFormat.CJS,
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    // Least privilege: the IVR handler only ever writes. It has no reason to be
    // able to read other callers' records, and saying so here means a future bug
    // cannot turn into a data-exfiltration path.
    this.table.grant(this.vanityFunction, 'dynamodb:PutItem');

    // ---------------------------------------------------------- observability

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'Vanity Connect alarms',
    });
    if (props.alarmEmail) {
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    }

    const alarmAction = new cwActions.SnsAction(this.alarmTopic);

    // Any error at all is worth knowing about: this Lambda runs once per call,
    // so even a low error count means real callers heard the failure prompt.
    const errorAlarm = new cloudwatch.Alarm(this, 'VanityFunctionErrors', {
      metric: this.vanityFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Vanity Lambda returned errors; callers are hearing the failure prompt.',
    });
    errorAlarm.addAlarmAction(alarmAction);

    // p99 duration, not average: the average hides the cold starts, and a cold
    // start is exactly what pushes us past the flow's 8 s patience.
    const latencyAlarm = new cloudwatch.Alarm(this, 'VanityFunctionLatency', {
      metric: this.vanityFunction.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p99',
      }),
      threshold: cdk.Duration.seconds(4).toMilliseconds(),
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Vanity Lambda p99 approaching the contact flow timeout.',
    });
    latencyAlarm.addAlarmAction(alarmAction);

    // Persistence failures never reach the caller (by design), so without this
    // metric they would be invisible. It reads the log group directly.
    const persistFailureMetric = new logs.MetricFilter(this, 'PersistFailureMetric', {
      logGroup,
      metricNamespace: 'VanityConnect',
      metricName: 'PersistFailures',
      filterPattern: logs.FilterPattern.literal('{ $.msg = "Failed to persist call record*" }'),
      metricValue: '1',
    });

    const persistAlarm = new cloudwatch.Alarm(this, 'PersistFailureAlarm', {
      metric: persistFailureMetric.metric({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Call records are being silently dropped; the IVR is still serving callers.',
    });
    persistAlarm.addAlarmAction(alarmAction);

    const throttleAlarm = new cloudwatch.Alarm(this, 'TableThrottleAlarm', {
      metric: this.table.metricThrottledRequestsForOperations({
        operations: [dynamodb.Operation.PUT_ITEM, dynamodb.Operation.QUERY],
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'DynamoDB is throttling; check for a hot partition on the feed index.',
    });
    throttleAlarm.addAlarmAction(alarmAction);

    // ---------------------------------------------------------------- outputs

    new cdk.CfnOutput(this, 'TableName', {
      value: this.table.tableName,
      description: 'DynamoDB table holding call records.',
    });
    new cdk.CfnOutput(this, 'VanityFunctionArn', {
      value: this.vanityFunction.functionArn,
      description: 'Associate this Lambda with your Amazon Connect instance.',
    });
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'Subscribe to receive operational alarms.',
    });
  }
}
