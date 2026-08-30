# Vanity Numbers for Amazon Connect

A caller dials in. The IVR reads their caller ID, works out the best vanity numbers that
phone number spells, saves the top five to DynamoDB, and reads the top three back to them
in a voice that actually spells the letters out. A small web app shows the vanity numbers
from the last five callers.

Everything — Lambda, DynamoDB table, contact flow, Lambda association, phone number, web
app — deploys into a fresh AWS account with one `cdk deploy`.

```
  ☎ caller
      │
      ▼
  Amazon Connect ──invoke──▶ Lambda ──▶ vanity engine ──▶ DynamoDB
   contact flow   ◀─results─          (pure, no I/O)          │
      │                                                       │
      ▼                                              CloudFront + API
  "Option one. eight-eight-eight, H-E-L-P, N-O-W."      web app
```

Full diagram and component-by-component walkthrough: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Live deployment

Deployed to account `732837096611`, region `ap-southeast-1`.

| | |
| --- | --- |
| **Phone number** | **+1 (312) 264-8616** — dial it |
| **Web app** | https://db4a0gn07w2ve.cloudfront.net |
| **API** | https://db4a0gn07w2ve.cloudfront.net/api/recent |
| Connect instance | `arn:aws:connect:ap-southeast-1:732837096611:instance/5678f93f-1957-4529-a79e-219fa78b4bd9` |
| Contact flow | `Vanity Number Lookup` — PUBLISHED, ACTIVE, associated to the number |

The number is a US DID chosen over toll-free because it is cheaper to leave running
(~$1/month rather than ~$2, and ~$0.0022/min inbound rather than ~$0.012). **It bills whether
or not anyone calls it** — `npx cdk destroy --all -c connectInstanceArn=...` stops that, and
the Connect instance then needs deleting by hand since this project did not create it.

---

## Documentation

| Document | What is in it |
| --- | --- |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Architecture diagram, request flow, data model, why each piece is where it is |
| **[docs/DESIGN-DECISIONS.md](docs/DESIGN-DECISIONS.md)** | How "best" is defined and why; the decisions behind the code; what I got wrong on the way |
| **[docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md)** | Shortcuts I took that would be bad practice in production, and what high volume / hostile traffic would require |
| **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** | Step-by-step deploy into your own account and Connect instance, plus teardown |

---

## Quick start

```bash
npm install
npm test                 # 179 tests, ~25s
npm run synth            # CloudFormation for all three stacks
```

Deploy the parts that need no Amazon Connect instance:

```bash
npx cdk bootstrap                      # once per account/region
npx cdk deploy VanityCoreStack VanityWebStack
```

Deploy the IVR as well, into your own Connect instance:

```bash
npx cdk deploy --all \
  -c connectInstanceArn=arn:aws:connect:us-east-1:123456789012:instance/<instance-id> \
  -c claimPhoneNumber=true \
  -c alarmEmail=you@example.com
```

The stack outputs print the phone number to dial and the web app URL.
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers creating the Connect instance, the one
manual step CloudFormation cannot do for you, and why.

Try the Lambda without a phone:

```bash
aws lambda invoke --function-name <VanityFunctionArn from outputs> \
  --payload '{"Details":{"Parameters":{"phoneNumber":"+18884357669"}}}' \
  --cli-binary-format raw-in-base64-out /dev/stdout
```

```json
{
  "status": "OK",
  "vanity1": "1-888-HELP-NOW",
  "vanity2": "1-888-HELP-MOW",
  "vanity3": "1-888-GEL-SNOW",
  "vanityCount": "3",
  "storedCount": "5",
  "vanitySpeechSsml": "Here are the top three vanity numbers ... <say-as interpret-as=\"characters\">HELP</say-as> ..."
}
```

---

## Configuration

All deploy-time configuration is CDK context, so a deployment is reproducible from one
command line.

| Context key | Default | Meaning |
| --- | --- | --- |
| `connectInstanceArn` | *(none)* | Connect instance to deploy the flow into. Omit to skip the Connect stack entirely. |
| `claimPhoneNumber` | `false` | Claim a number and wire it to the flow. Costs money — opt in. |
| `phoneNumberType` | `TOLL_FREE` | `TOLL_FREE` or `DID`. |
| `phoneNumberCountryCode` | `US` | Country to claim in. Must be enabled on the instance. |
| `deployWebApp` | `true` | Deploy the bonus web app. Set `false` to skip CloudFront. |
| `alarmEmail` | *(none)* | Subscribe an address to the alarm topic. |
| `recentShardCount` | `1` | Feed index shards. See [the repository](src/lib/repository.ts) for when to raise it. |
| `retentionDays` | `90` | DynamoDB TTL on call records. |
| `destroyDataOnDelete` | `true` | `cdk destroy` removes the table and bucket. **Set `false` for anything real.** |
| `apiReservedConcurrency` | *(unset)* | Reserve concurrency for the public API Lambda. Unset by default — AWS rejects any reservation leaving under 10 unreserved executions, and a new account's entire limit is 10. See [PRODUCTION-READINESS](docs/PRODUCTION-READINESS.md#the-web-edge). |
| `stackPrefix` | `Vanity` | Prefix for stack names, so several copies can coexist. |

Runtime behaviour is Lambda environment variables (`RESULTS_TO_STORE`, `RESULTS_TO_SPEAK`,
`LOG_LEVEL`, …), set by the CDK and documented in [`src/lib/config.ts`](src/lib/config.ts).

---

## Repository layout

```
bin/vanity-connect.ts          CDK app entry point; reads context, wires the stacks
lib/
  vanity-core-stack.ts         DynamoDB table, IVR Lambda, alarms, metric filters
  vanity-connect-stack.ts      Contact flow, Lambda association, phone number
  vanity-web-stack.ts          Read API, S3 + CloudFront, one origin for both
  contact-flows/vanity-flow.ts The contact flow, generated as typed code
src/
  core/                        Pure logic. No AWS, no I/O, no clock.
    keypad.ts                    E.161 letter <-> digit mapping
    phone.ts                     NANP parsing, validation, log redaction
    dictionary.ts                digit-string -> words index, built once per cold start
    dictionary.generated.json    23,873 words (committed; see tools/build-dictionary.ts)
    segment.ts                   the token type the generator produces
    vanity.ts                    the segmentation search
    score.ts                     the definition of "best"
    speech.ts                    SSML so Polly spells letters instead of reading words
  lib/                         Runtime plumbing
    config.ts                    env parsing, validated at first use
    logger.ts                    structured JSON logging
    repository.ts                DynamoDB access and the sharded "recent calls" feed
  handlers/
    connect-vanity.ts            invoked by the contact flow
    api-recent.ts                invoked by API Gateway for the web app
test/                          179 tests mirroring src/ and lib/
tools/
  build-dictionary.ts          generates the dictionary from SCOWL word lists
  blocklist.txt                words excluded from a customer-facing IVR
web/                           the bonus app: one HTML, one CSS, one JS, no build step
docs/                          the four documents linked above
```

---

## Testing

```bash
npm test                 # everything
npm run test:coverage    # with a coverage report
npm run build            # typecheck only (tsc --noEmit)
```

| Layer | Approach |
| --- | --- |
| `src/core/*` | Straight unit tests. The whole engine is pure, so there is nothing to mock. |
| `src/lib/repository.ts` | Stubbed at the AWS SDK boundary; asserts the *commands* sent — key shapes, index name, sort direction, shard fan-out. |
| `src/handlers/*` | Full handler invoked with realistic Connect and API Gateway events, including every failure branch. |
| `lib/contact-flows/*` | The flow JSON is walked as a graph: no orphans, no dangling edges, every path terminates in a disconnect. |
| `lib/*-stack.ts` | CDK assertions on the properties that are load-bearing and fail silently — the TTL attribute name, IAM scope, bucket privacy, Lambda timeout under Connect's ceiling. |

Coverage is 96% of statements / 88% of branches, with a floor enforced in
`jest.config.js`. What is *not* covered — and what I would add with more time — is written
up in [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md).

---

## Regenerating the dictionary

The word list is committed so the build is hermetic and a reviewer can deploy without dev
dependencies. To rebuild it (e.g. after editing `tools/blocklist.txt`):

```bash
npm run gen:dictionary
```
