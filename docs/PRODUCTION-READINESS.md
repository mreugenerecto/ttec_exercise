# Production readiness

Two questions from the brief, answered honestly:

1. **What shortcuts did I take that would be bad practice in production?**
2. **What else would I need before this took high volume and hostile traffic?**

---

## Part 1 — Shortcuts I took

Each of these is a deliberate call I would not make in a system that mattered. They are
listed roughly worst-first.

### 1. The web API is unauthenticated

`GET /api/recent` is reachable by anyone with the CloudFront URL. Numbers are masked
(`+1888***7669`) and the contact id is stripped, so it is not a raw PII dump — but it is
still a public list of who has recently called a business, and an attacker who already knows
a number can use it to *confirm* that person called. That is a real privacy problem, not a
theoretical one.

**Production:** Amazon Cognito (or IAM auth with SigV4 from an authenticated app) in front of
the route, scoped to a tenant, with access logged and audited. I left it open because the
brief asks for a demo web app and an auth flow would have buried the part being assessed.

### 2. `removalPolicy: DESTROY` is the default

`cdk destroy` deletes the DynamoDB table and empties the S3 bucket. That is right for an
exercise a reviewer should be able to clean up in one command, and catastrophic anywhere
else. `-c destroyDataOnDelete=false` flips both to `RETAIN`, and there is a test for it — but
**the default is wrong for production and I would invert it**, along with adding a
`DeletionProtectionEnabled` on the table and an SCP that blocks table deletion outright.

### 3. The database write is inline and best-effort

Covered in detail in [DESIGN-DECISIONS](DESIGN-DECISIONS.md#persistence-is-best-effort-and-that-is-on-purpose).
Short version: a failed write is logged, alarmed, and lost. Production splits it — handler
→ SQS → writer Lambda → DLQ — so the call path has no database dependency and nothing is
dropped, only delayed.

### 4. Hand-rolled logger

[`src/lib/logger.ts`](../src/lib/logger.ts) is ~90 lines of JSON-to-stdout. **AWS Lambda
Powertools for TypeScript** gives the same output plus X-Ray trace correlation, sampled debug
logging, and EMF custom metrics, maintained by AWS. I wrote my own only to keep the
dependency surface of the exercise small and the bundle honest. In production I would delete
this file on day one.

<a id="5-the-brand-safety-list-is-hand-rolled"></a>
### 5. The brand-safety list is hand-rolled

[`tools/blocklist.txt`](../tools/blocklist.txt) is ~110 English terms I wrote out. A
customer-facing IVR needs better: a maintained, locale-aware profanity/brand-safety corpus
(licensed, or AWS Comprehend toxicity detection at build time), plus a **runtime** deny-list
in SSM Parameter Store so a bad word can be removed in minutes rather than in a deploy. It
also needs a "confusable combination" check — words that are innocuous alone and not in
sequence.

### 6. The dictionary is baked into the Lambda bundle

23,873 words ship inside the deployment package. Tuning the word list therefore requires a
code deploy, and every tenant gets the same dictionary. Production: an S3 object loaded on
cold start (or a Lambda layer), versioned and cache-busted by an env var, so word-list
changes ship independently of code and different tenants/locales can differ.

### 7. No integration or end-to-end tests

178 unit and CDK-assertion tests, and nothing that talks to a real service. Missing:

- **DynamoDB Local in CI** — catches the class of bug unit tests structurally cannot:
  reserved words in expressions, item size limits, real TTL semantics.
- **A deployed-stack smoke test** — invoke the real Lambda, assert the item lands.
- **A Connect call test** — the `StartOutboundVoiceContact` API can place a call into the
  flow and assert on the resulting contact attributes. This is the only way to catch a flow
  JSON schema change, and it is the gap that worries me most.
- **A synthetic canary** (CloudWatch Synthetics) hitting `/api/recent` on a schedule.

### 8. One environment, no pipeline

`cdk deploy` from a laptop. Production: **CDK Pipelines**, an account per stage
(dev/stage/prod), `cdk diff` gated on approval, and **`cdk-nag`** wired into synth so
security regressions fail the build rather than the review. Lambda deployments would go
through aliases with a CodeDeploy canary shift, so a bad version affects 10% of calls for
five minutes instead of 100% of calls until someone notices.

### 9. `phoneNumber` is a test override in production code

The handler honours `Details.Parameters.phoneNumber`, which overrides the real caller ID.
That is a test hook in shipped code — a smell unless it is documented and inert by default,
which it is: it only fires when a flow explicitly passes it, and it logs a WARN every time it
is used so it cannot be used quietly. It stays because it is genuinely how a reviewer
exercises specific numbers without a phone that dials from them. In production it would be
gated behind an env flag defaulting to off in prod accounts.

### 10. AWS-managed encryption key

The table uses `TableEncryption.AWS_MANAGED`. Phone numbers are PII, so production wants a
**customer-managed KMS key** with an explicit key policy — that is what makes "revoke access
to this data" a single, auditable action, and what most compliance regimes actually ask for.
Same for the S3 bucket and the CloudWatch log groups.

### 11. Scoring weights are asserted, not measured

Five weights chosen by judgement, with no data behind them. See
[DESIGN-DECISIONS](DESIGN-DECISIONS.md#what-best-means). The right version logs which option
callers redial and learns them.

### 12. The AWS SDK is externalised from the bundle

esbuild marks `@aws-sdk/*` external, so the Lambda uses the SDK version baked into the Node
22 runtime. Smaller bundle, faster cold start — and a version I do not control, which can
change under me during an AWS runtime update. For a service where that matters I would bundle
the SDK explicitly and take the cold-start cost.

### 13. Single region, no DR

One region, no backup strategy beyond point-in-time recovery, no tested restore. See below.

### 14. No load test

Every performance claim in this repo (~1–3 ms warm, p99 flat) comes from local measurement
and reasoning about the algorithm's bounds. None of it has been validated under concurrency
against real Lambda cold starts and real DynamoDB latency.

---

## Part 2 — What high volume and hostile traffic would need

### Telephony is a different threat model

This is the part people miss when they treat an IVR as "just another API".

- **Toll fraud.** Claimed numbers cost money per minute. A robo-dialler hitting the line
  ten thousand times a day is a direct, uncapped bill. Mitigations: Connect's per-instance
  concurrency quotas set deliberately rather than left at default, AWS Budgets with actions,
  and a per-ANI rate limit — a DynamoDB counter with a short TTL, checked at the top of the
  handler, that plays "please try again later" past N calls per number per hour.
- **Caller ID spoofing.** `CustomerEndpoint.Address` is not authenticated. Anything derived
  from it is attacker-controlled. Here that is low impact (the worst case is a wasted
  invocation and a junk row), but it means the caller number must never be treated as
  identity — no "look up your account by the number you're calling from" without a second
  factor. **STIR/SHAKEN** attestation is the real answer where the carrier supplies it.
- **Prompt cost.** Neural Polly is billed per character. A long SSML prompt multiplied by a
  flood of calls is a real line item. Frequently-played prompts should be pre-synthesised to
  S3 and played as audio.
- **Flow logging volume.** Enabled here because it is the only way to debug a hung call. At
  volume it is a meaningful CloudWatch bill — sample it, or turn it on per-contact via a
  contact attribute.

### Compute and data at scale

- **Cold starts.** The dictionary index build costs ~30 ms on a cold start, inside a call
  where the caller is listening to silence. At volume: **provisioned concurrency** sized to
  the daily call curve, or move the dictionary to a lazily-loaded S3 object so the cold path
  is smaller. Node has no SnapStart, so provisioned concurrency is the lever.
- **Caching.** Vanity results are a pure function of the phone number — perfectly cacheable.
  A warm in-process LRU would absorb repeat callers for free; DAX or ElastiCache would absorb
  them across instances. Neither is worth it at demo volume and both are obvious wins at
  scale.
- **The feed index hot partition.** Already discussed: raise `RECENT_SHARD_COUNT`. Past a few
  thousand writes/second, stop asking DynamoDB for a global feed at all — fan Streams into
  an ElastiCache sorted set (or OpenSearch if the feed needs filtering). The table stays the
  system of record; the feed becomes a derived, disposable read model.
- **Billing mode.** On-demand is right for spiky, unpredictable IVR traffic. Above a
  sustained, well-understood baseline, provisioned capacity with autoscaling is materially
  cheaper and worth revisiting with real numbers.
- **Write amplification.** Every call writes the base item *and* the GSI item. The GSI's
  `INCLUDE` projection keeps that as small as possible; it should be re-checked if attributes
  are added.

### The web edge

- **AWS WAF on the distribution** — a rate-based rule is the single highest-value addition
  and the most obvious omission here. (It is not in the stack because a `CLOUDFRONT`-scoped
  Web ACL must live in `us-east-1`, which means a second, cross-region stack; that is the
  right shape and it is scope I chose not to add for a demo.)
- **Shield Advanced** if the number is publicised.
- **CloudFront caching for `/api/*`** is deliberately disabled so the page is live. Under
  load, a 1–5 second edge TTL collapses a flood into one origin request per second — a big
  lever, and one that is a one-line change.
- The API already has: 50 rps / 100 burst throttling, `reservedConcurrentExecutions: 10` so a
  flood cannot exhaust account concurrency and take the **IVR** Lambda down with it, a
  bounded `limit` parameter validated before any I/O, and error responses that never echo the
  underlying AWS message (which names the table, region, and sometimes the account).

### Data protection and compliance

- Phone numbers are PII. That brings **GDPR/CCPA erasure**: a documented, tested deletion
  path by caller number. The `CALLER#<e164>` partition key was chosen partly so that "delete
  everything about this person" is a single Query-and-BatchDelete rather than a Scan.
- **90-day TTL** is a retention *decision*, not a cleanup convenience. It should be reviewed
  against whatever policy actually applies.
- Redaction in logs is implemented. It needs to be enforced, not just practised — a lint rule
  or a log-scanning canary that fails CI when a raw `+1\d{10}` appears in a log statement.
- **VPC endpoints** for DynamoDB if the Lambdas ever move into a VPC.
- **CloudTrail data events** on the table for an audit trail of who read what.

### Operations

- A **CloudWatch dashboard** per stack, and **SLOs** with error budgets: call success rate,
  p99 flow duration, persistence success rate.
- A **runbook** per alarm. An alarm without a documented response is a pager that trains
  people to ignore it.
- **Composite alarms** so one incident is one page, not four.
- **Multi-region.** Amazon Connect Global Resiliency for the telephony side, DynamoDB Global
  Tables for the data. Expensive; only worth it against a stated RTO/RPO.
- **A tested restore.** Point-in-time recovery that has never been exercised is a belief, not
  a backup.
