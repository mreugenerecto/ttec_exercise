/**
 * Amazon Connect stack: contact flow, Lambda association, and (optionally) a
 * claimed phone number wired to the flow.
 *
 * This stack is only added to the app when a Connect instance ARN is supplied,
 * because there is no way to create a usable Connect instance from
 * CloudFormation -- `AWS::Connect::Instance` exists, but the instance it creates
 * has no phone numbers, no approved countries, and no admin user, so it cannot
 * actually take a call. Requiring the reviewer to create the instance once by
 * hand (30 seconds in the console) and pass its ARN in is the honest tradeoff;
 * everything downstream of it is automated. See docs/DEPLOYMENT.md.
 */
import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { buildVanityContactFlow } from './contact-flows/vanity-flow';

export interface VanityConnectStackProps extends cdk.StackProps {
  /** arn:aws:connect:<region>:<account>:instance/<instance-id> */
  readonly connectInstanceArn: string;
  /** The IVR Lambda from the core stack. */
  readonly vanityFunction: IFunction;
  /** Name for the contact flow in the Connect console. */
  readonly contactFlowName?: string;
  /**
   * Claim a phone number and point it at the flow. Off by default: claiming a
   * number costs money (a few USD/month) and can fail if the account has not
   * been approved for that country, and a reviewer should opt into both.
   */
  readonly claimPhoneNumber?: boolean;
  /** 'TOLL_FREE' or 'DID'. Toll-free is usually claimable without a support case. */
  readonly phoneNumberType?: 'TOLL_FREE' | 'DID';
  /** ISO country code for the claimed number. */
  readonly phoneNumberCountryCode?: string;
}

export class VanityConnectStack extends cdk.Stack {
  public readonly contactFlow: connect.CfnContactFlow;

  constructor(scope: Construct, id: string, props: VanityConnectStackProps) {
    super(scope, id, props);

    const instanceArn = props.connectInstanceArn;
    const instanceId = cdk.Fn.select(1, cdk.Fn.split('instance/', instanceArn));

    // ------------------------------------------------- Lambda <-> Connect wiring
    //
    // Two separate things are needed and it is easy to do only one:
    //   1. A resource policy on the Lambda so Connect is allowed to invoke it.
    //   2. An integration association so the function appears in the flow
    //      designer's Lambda dropdown and can be referenced by ARN.
    // Missing (1) fails at call time with an opaque flow error; missing (2)
    // fails at flow-publish time.

    props.vanityFunction.addPermission('AllowAmazonConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      // Scope the trust to this one instance, not to Connect as a whole.
      sourceArn: instanceArn,
      sourceAccount: this.account,
    });

    const association = new connect.CfnIntegrationAssociation(this, 'VanityLambdaAssociation', {
      instanceId: instanceArn,
      integrationType: 'LAMBDA_FUNCTION',
      integrationArn: props.vanityFunction.functionArn,
    });

    // ------------------------------------------------------------ contact flow

    this.contactFlow = new connect.CfnContactFlow(this, 'VanityContactFlow', {
      instanceArn,
      name: props.contactFlowName ?? 'Vanity Number Lookup',
      type: 'CONTACT_FLOW',
      description: 'Speaks the top 3 vanity numbers for the caller ID.',
      content: buildVanityContactFlow({
        lambdaFunctionArn: props.vanityFunction.functionArn,
        name: props.contactFlowName ?? 'Vanity Number Lookup',
      }),
    });

    // Publishing a flow that references an unassociated Lambda is rejected.
    this.contactFlow.node.addDependency(association);

    const contactFlowId = cdk.Fn.select(1, cdk.Fn.split('contact-flow/', this.contactFlow.attrContactFlowArn));

    // ----------------------------------------------------------- phone number

    if (props.claimPhoneNumber) {
      const phoneNumber = new connect.CfnPhoneNumber(this, 'VanityPhoneNumber', {
        targetArn: instanceArn,
        type: props.phoneNumberType ?? 'TOLL_FREE',
        countryCode: props.phoneNumberCountryCode ?? 'US',
        description: 'Vanity number demo line',
      });

      const phoneNumberId = cdk.Fn.select(1, cdk.Fn.split('phone-number/', phoneNumber.attrPhoneNumberArn));

      // There is no CloudFormation resource for "point this number at this
      // flow" -- AWS::Connect::PhoneNumber claims the number and stops there.
      // A small custom resource closes the last mile so `cdk deploy` really does
      // produce a number a reviewer can dial, rather than a number plus a
      // README step.
      const wiring = new AwsCustomResource(this, 'AssociatePhoneNumberToFlow', {
        onCreate: {
          service: 'connect',
          action: 'AssociatePhoneNumberContactFlow',
          parameters: {
            InstanceId: instanceId,
            PhoneNumberId: phoneNumberId,
            ContactFlowId: contactFlowId,
          },
          physicalResourceId: PhysicalResourceId.of(`phone-flow-association-${this.stackName}`),
        },
        // Same call on update: the API is idempotent and simply repoints the
        // number, which is exactly what we want if the flow is replaced.
        onUpdate: {
          service: 'connect',
          action: 'AssociatePhoneNumberContactFlow',
          parameters: {
            InstanceId: instanceId,
            PhoneNumberId: phoneNumberId,
            ContactFlowId: contactFlowId,
          },
          physicalResourceId: PhysicalResourceId.of(`phone-flow-association-${this.stackName}`),
        },
        // Disassociate on delete, otherwise releasing the number fails because
        // it is still bound to a flow.
        onDelete: {
          service: 'connect',
          action: 'DisassociatePhoneNumberContactFlow',
          parameters: {
            InstanceId: instanceId,
            PhoneNumberId: phoneNumberId,
          },
        },
        policy: AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: [
              'connect:AssociatePhoneNumberContactFlow',
              'connect:DisassociatePhoneNumberContactFlow',
            ],
            resources: [
              `arn:${this.partition}:connect:${this.region}:${this.account}:phone-number/*`,
              `${instanceArn}/contact-flow/*`,
            ],
          }),
        ]),
        installLatestAwsSdk: false,
      });
      wiring.node.addDependency(this.contactFlow);

      new cdk.CfnOutput(this, 'PhoneNumber', {
        value: phoneNumber.attrAddress,
        description: 'Dial this number to reach the vanity IVR.',
      });
    }

    // ---------------------------------------------------------------- outputs

    new cdk.CfnOutput(this, 'ContactFlowArn', {
      value: this.contactFlow.attrContactFlowArn,
      description: 'Assign this flow to a phone number if you did not claim one.',
    });
    new cdk.CfnOutput(this, 'ConnectInstanceId', { value: instanceId });
  }
}
