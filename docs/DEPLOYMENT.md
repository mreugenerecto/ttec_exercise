# Deployment

Deploying into your own AWS account and Amazon Connect instance, and tearing it back down.

---

## Prerequisites

- Node.js 20+ and npm
- AWS credentials with permission to create Lambda, DynamoDB, IAM, CloudWatch, SNS, S3,
  CloudFront, API Gateway and Amazon Connect resources
- A region where **Amazon Connect is available** and where you intend to claim a number.
  `us-east-1` is the safest choice: it has the broadest phone-number availability and the
  fewest surprises.

```bash
npm install
npm test          # 178 tests — run these first, they are fast
```

---

## Step 0 — Bootstrap CDK (once per account/region)

```bash
npx cdk bootstrap aws://<account-id>/<region>
```

---

## Step 1 — Create an Amazon Connect instance (the one manual step)

**This cannot be automated, and here is why.** `AWS::Connect::Instance` exists, but the
instance it creates has no approved countries, no phone numbers, and no administrator, so it
cannot take a call. Creating it in the console takes about a minute and is the honest
boundary between "the reviewer's environment" and "this project".

1. Amazon Connect console → **Add an instance**
2. Identity management: **Store users in Amazon Connect** (simplest for a review)
3. Create an administrator
4. Telephony: leave **inbound calls** enabled
5. Skip data storage customisation; **Create instance**

Then copy the instance ARN:

```bash
aws connect list-instances --query 'InstanceSummaryList[].{Alias:InstanceAlias,Arn:Arn}' --output table
```

You want the value shaped like
`arn:aws:connect:us-east-1:123456789012:instance/11111111-2222-3333-4444-555555555555`.

---

## Step 2 — Deploy

Everything, including a claimed phone number wired to the flow:

```bash
npx cdk deploy --all \
  -c connectInstanceArn=arn:aws:connect:us-east-1:123456789012:instance/<instance-id> \
  -c claimPhoneNumber=true \
  -c alarmEmail=you@example.com
```

Or in pieces — the core and web stacks need no Connect instance at all:

```bash
npx cdk deploy VanityCoreStack VanityWebStack
```

**What you get in the outputs:**

| Output | Stack | Use |
| --- | --- | --- |
| `PhoneNumber` | Connect | **Dial this.** |
| `ContactFlowArn` | Connect | Assign manually if you did not claim a number |
| `WebAppUrl` | Web | Open in a browser |
| `ApiEndpoint` | Web | `curl` it |
| `VanityFunctionArn` | Core | Invoke directly for testing |
| `TableName`, `AlarmTopicArn` | Core | Inspect data / subscribe to alarms |

First deploy takes ~8–12 minutes; almost all of that is CloudFront. Subsequent deploys are
under a minute unless the distribution changes. If you passed `alarmEmail`, **confirm the SNS
subscription email** or the alarms will fire into the void.

### If `claimPhoneNumber` fails

Claiming can be rejected if the instance is not approved for the country, or if no numbers
are available in the pool. Options:

- try `-c phoneNumberType=DID` instead of the default `TOLL_FREE` (or vice versa)
- try a different `-c phoneNumberCountryCode=...`
- claim a number by hand in the Connect console, then in **Channels → Phone numbers** set its
  contact flow to **Vanity Number Lookup**. The flow itself deploys either way.

Toll-free numbers in some countries require an AWS support case for regulatory reasons.

---

## Step 3 — Test it

**By phone.** Dial the number in the `PhoneNumber` output. You should hear a greeting, a
short pause, then something like:

> *"Here are the top three vanity numbers for your phone number. Option one: eight-eight-eight,
> H-E-L-P, N-O-W…"*

**Without a phone.** Invoke the Lambda directly. The `phoneNumber` parameter overrides the
caller ID so you can exercise any number (it logs a WARN whenever it is used):

```bash
aws lambda invoke --function-name <VanityFunctionArn> \
  --payload '{"Details":{"Parameters":{"phoneNumber":"+18884357669"}}}' \
  --cli-binary-format raw-in-base64-out /dev/stdout
```

Interesting numbers to try:

| Number | Why |
| --- | --- |
| `+18884357669` | spells `HELP-NOW` — the happy path |
| `+13105550101` | all 0s and 1s — returns `NO_VANITY` with a spoken explanation |
| `+447700900123` | not NANP — returns `UNSUPPORTED_NUMBER` |
| `anonymous` | withheld caller ID — returns `NO_CALLER_ID` |

**The web app.** Open `WebAppUrl`. It polls `/api/recent` every 15 seconds, so a call should
appear within a few seconds of hanging up.

```bash
curl -s "$(aws cloudformation describe-stacks --stack-name VanityWebStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" --output text)" | jq
```

**Inspect the data.**

```bash
aws dynamodb scan --table-name <TableName> --max-items 5
```

(A Scan is fine for eyeballing a demo table and is not how the application reads —
see [ARCHITECTURE.md](ARCHITECTURE.md#data-model).)

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Call connects, greeting plays, then silence then disconnect | The Lambda errored or timed out. Check the `VanityFunction` log group; the flow's error branch should have spoken an apology, so silence means the flow itself failed. |
| "Our vanity number service is not responding" | Lambda invocation failed — check the invoke permission and the integration association. |
| Flow will not publish | The Lambda must be associated with the instance *before* a flow can reference it. `VanityConnectStack` orders this with an explicit dependency; if you built the flow by hand, associate the Lambda first. |
| Web app shows "Could not load recent callers" | Check the `RecentCallsFunction` log group. A cold CloudFront distribution can also 502 for a minute after first deploy. |
| Web app is empty but calls succeeded | Confirm `persisted` is `true` in the Lambda response and check the `PersistFailures` metric. |
| `cdk deploy` fails on the phone number | See "If `claimPhoneNumber` fails" above. |

Contact flow logs (enabled by the flow's first block) are in the
`/aws/connect/<instance-alias>` log group — that is where to look when a call behaves
strangely but the Lambda looks fine.

---

## Teardown

```bash
npx cdk destroy --all \
  -c connectInstanceArn=arn:aws:connect:us-east-1:123456789012:instance/<instance-id>
```

This releases the claimed phone number, deletes the contact flow, the table, the bucket and
the distribution. **You must delete the Connect instance yourself**, since this project never
created it.

Two things to know:

- Passing the same context on destroy matters — without `connectInstanceArn` the Connect
  stack is not in the app, so CDK will not know to destroy it.
- `destroyDataOnDelete` defaults to `true`, which is why the table and bucket go. If you
  deployed with `-c destroyDataOnDelete=false`, they are retained and you will need to remove
  them by hand.

---

## Cost

At demo volume this is effectively free apart from the phone number. Rough US pricing:

| | Cost |
| --- | --- |
| Claimed phone number | ~$0.03–$0.06 per day (DID), toll-free similar plus higher per-minute |
| Inbound voice | ~$0.018 per minute (DID), higher for toll-free |
| Lambda, DynamoDB on-demand, CloudWatch | pennies; comfortably inside free tier at this volume |
| CloudFront | free tier covers a demo |
| Neural Polly | billed per character; a handful of calls is negligible |

**The phone number bills whether or not anyone calls it.** If you are leaving this deployed,
that is the line item to watch — and `cdk destroy` is how you stop it.
