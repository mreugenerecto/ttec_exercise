# Design decisions, and what went wrong on the way

This is the "why" document. [ARCHITECTURE.md](ARCHITECTURE.md) says what the system is;
this says why it is that and not something else, and where I changed my mind.

---

## What "best" means

The brief leaves "best" to me. A vanity number exists for exactly one reason: so somebody
hears it once on the radio and can still dial it an hour later. So I scored candidates on
**memorability**, not on cleverness, and broke that into five things I can measure.

| Component | Weight | Why it is in the list |
| --- | --- | --- |
| **Coverage** — fraction of the 7 digits inside a real word | 0.35 | Leftover digits are the part people forget. `555-CAKES2` beats `555-CAT-892`. Biggest weight because it is the strongest single signal. |
| **Longest word** — longest word ÷ 7 | 0.20 | One long word is easier to hold than the same coverage split in two. This term is what makes a full 7-letter cover (1-800-FLOWERS) win outright. |
| **Fragmentation** — penalty per extra token | 0.15 | `PET-CARE` is fine; `PET-C-4-RE` is unsayable. Coverage alone would happily reward the second, so this exists to stop it. |
| **Tail anchor** — does the number *end* on a word | 0.15 | How every real vanity number is built: 1-800-**FLOWERS**, 1-800-GOT-**JUNK**. The prefix is routing the caller already ignores; the payload lands last, where it sticks. |
| **Commonness** — SCOWL frequency tier of each word | 0.15 | `FLOWERS` should beat `FLOCCUS` at identical coverage. |

Score is `100 × Σ(weight × component)`, every component normalised to 0–1, weights summing
to exactly 1 (there is a test for that). `1-888-HELP-NOW` scores 88.9; a hypothetical
single-common-word cover scores 100.

**The design decision is the separation, not the numbers.** Every weight is a named constant
in [`src/core/score.ts`](../src/core/score.ts), independent of the generator, so they can be
argued about and changed without touching the search. The specific values are my starting
point, and I would not defend any of them to three significant figures.

### What I deliberately did not score

- **Phonetic ease.** Consonant clusters and syllable count matter a lot and I have no signal
  for them. With more time: a CMU-dict-style pronunciation lexicon, penalising unpronounceable
  clusters. `SCHRSTS` is a legal word shape and a terrible phone number.
- **Semantic fit to the business.** This is the single biggest real-world lever and the one
  thing a generic dictionary cannot know: a florist wants `FLOWERS` even if `PLOUGHS` scores
  higher. In production this would be a per-tenant boosted term list on a tenant record.
- **Diversity within the top 5.** The current ranking will happily return `ABLE-RUG`,
  `BAKE-RUG`, `CAKE-RUG`, `ABLE-PUG`, `BALD-RUG` — five results that are really one idea.
  A maximal-marginal-relevance pass over the ranked list would fix it; I judged it lower
  value than getting the ranking itself right, and it is a change confined to one function.
- **Reality.** The honest version of "best" is *measured*, not asserted: log which option
  callers actually redial and learn the weights. Everything above is a prior.

### Why only the last seven digits

Because that is how vanity numbers work. 1-800-FLOWERS keeps its area code as digits — the
NPA is routing information people read as numbers, and on a local call it is often not
dialled at all. Spelling into the area code produces strings nobody recognises as a phone
number. `spellWindow` is a parameter, so a future caller base can disagree.

### Why the search is a segmentation, not a lookup

The interesting constraint is that **0 and 1 have no letters**. Every 0 or 1 is a hard wall
a word cannot cross, so the problem is: partition 7 digits into an ordered sequence of
tokens, each either a dictionary word or a literal digit run.

Naive backtracking generates the same segmentation many times over (`[D][D]` and `[DD]` are
the same number). I made digit runs **canonical**: a digit run is only ever emitted in
maximal form — always followed by a word or by the end of the number. Every distinct
segmentation is then reachable by exactly one path, so there are no duplicates to dedupe and
no wasted branches. That change alone cut the search by roughly an order of magnitude on
letter-dense numbers.

Worst case is capped anyway (`maxWordsPerSpan`, `maxCandidates`), and the result reports
`truncated: true` rather than quietly pretending it was exhaustive.

---

## The decisions I would defend in a review

### Persistence is best-effort, and that is on purpose

If the DynamoDB write fails, the Lambda logs at ERROR (alarmed) and **still returns the
vanity numbers**. A caller should never hear "sorry, something went wrong" because a table
throttled. The call is the product; the analytics record is not.

I am aware this trades durability for availability, and that logging-and-continuing is how
data quietly disappears. The mitigations are the metric filter and alarm on that exact log
line, and `persisted: "false"` in the response so the contact record shows it too.

**In production I would remove the tradeoff rather than tune it**: the handler writes to SQS
or EventBridge, a second Lambda owns the durable write, and the call path has no database
dependency at all. Failed writes then retry into a DLQ instead of being logged and lost.

### The Lambda times out before the contact flow does

Connect gives the Lambda 8 seconds. The Lambda's timeout is 6. If they were equal — or the
Lambda were longer — a slow invocation would surface as an opaque flow-side error with
nothing in CloudWatch. At 6 the Lambda fails first, with a real timeout log and a real
`Errors` metric datapoint. There is a CDK assertion test pinning this.

### The contact flow is generated code, not a checked-in JSON blob

A flow's JSON hard-codes the ARN of every Lambda it invokes. As a static file it would need
an ARN string-replaced into it at synth time: works, hides the dependency, and silently
produces a broken flow when the placeholder drifts. Generating it from a typed function
([`lib/contact-flows/vanity-flow.ts`](../lib/contact-flows/vanity-flow.ts)) makes the ARN a
parameter, the prompts readable in a diff, and the whole graph testable —
[`test/infra/contact-flow.test.ts`](../test/infra/contact-flow.test.ts) walks it and asserts
there are no orphaned blocks, no dangling edges, and exactly one terminal disconnect.

Action identifiers are fixed UUIDs, not generated, so a redeploy produces a clean diff
instead of rewriting every edge.

### One CloudFront origin instead of S3 + CORS

The obvious build is "S3 website + API Gateway URL + CORS headers". Putting the API on a
`/api/*` behaviour of the same distribution means no CORS anywhere in the project, the S3
bucket stays fully private behind OAC, and there is one place to attach WAF, a domain, and a
certificate. The cost is a slower first deploy. Worth it for a shape that does not have to be
unpicked later.

### Sharded feed index at N=1

"Last 5 callers across all callers" is DynamoDB's worst query. A Scan is fine at 50 items and
catastrophic at 50 million. A constant-partition GSI is one cheap Query but puts every write
in the system on one partition. So the partition key is `RECENT#<shard>`, the shard count is
configuration, and the reader already fans out and merges. Default 1 — correct for a demo —
and raising it needs no code change and no migration: old items keep their shard, new items
spread out.

### No phone-number library

`libphonenumber-js` is the right answer for general phone parsing and adds ~150 KiB to a
Lambda whose entire job is "is this 10 NANP digits, and what are the last 7?". The validation
surface is small enough to own and unit test. `ParsedPhone` is the seam if that ever changes.

---

## Things that fought back

**Amazon Connect only accepts a flat map of strings.** No nesting, no arrays, 32 KB cap. My
first response shape returned `vanityNumbers: [...]` and Connect simply cannot address it.
Hence `vanity1`, `vanity2`, `vanity3` as separate keys — ugly, and correct, because
`$.External.vanity1` is what a flow block can actually reference. There is a test asserting
every value in the response is a string.

**Polly reads "1-888-HELP-NOW" as prose.** Handed that string it says *"one, eight hundred
eighty-eight, help now"* — useless to somebody writing a number down. The fix is SSML:
`interpret-as="digits"` for numeric runs, `interpret-as="characters"` for letter runs, so the
caller hears *"eight-eight-eight, H-E-L-P, N-O-W"*. The Lambda returns both an SSML and a
plain-text rendering, because SSML is a per-prompt setting in the flow designer that is easy
to get wrong, and a mangled prompt is worse than a slightly robotic one. The SSML fragment
deliberately has **no `<speak>` wrapper** — Connect adds those itself, and a nested `<speak>`
is a hard error at synthesis time.

**555-123-4567 is not a valid phone number.** My NANP validator rejects it, and my first test
fixtures were full of it. NANP exchange codes cannot begin with 0 or 1, so the canonical fake
number is structurally invalid. I decided to keep the validator strict — a caller ID that
cannot exist is more likely spoofed or carrier-mangled than a real customer — and wrote a
test that documents the rejection as intended behaviour rather than papering over it.

**CloudFormation can claim a phone number but cannot point it at a flow.**
`AWS::Connect::PhoneNumber` claims a number and stops. `AWS::Connect::ContactFlow` publishes
a flow. Nothing joins them. Without that last step, `cdk deploy` produces a number plus a
README instruction, which is not the deliverable the brief asks for.

<a id="the-last-mile-cloudformation-cannot-do"></a>
So there is a small `AwsCustomResource` calling `AssociatePhoneNumberContactFlow` on create
and update, and `DisassociatePhoneNumberContactFlow` on delete — the disassociate matters,
because releasing a number bound to a flow fails.

**And CloudFormation cannot create a *usable* Connect instance at all.**
`AWS::Connect::Instance` exists, but what it creates has no approved countries, no phone
numbers, and no admin user, so it cannot take a call. Requiring the reviewer to create the
instance once in the console and pass its ARN in is the honest boundary; everything
downstream of it is automated. This is the one manual step, and it is documented in
[DEPLOYMENT.md](DEPLOYMENT.md).

**CDK puts the Lambda invoke permission in the *function's* stack.** `addPermission` on a
function owned by `VanityCoreStack`, called from `VanityConnectStack`, emits the
`AWS::Lambda::Permission` into the core stack. My assertion test looked at the wrong template
and failed. The test now asserts against the core stack *and says why in a comment* — knowing
which template a resource lands in is exactly the kind of thing a cross-stack refactor breaks
silently.

**`minimumProtocolVersion` on CloudFront is a no-op without a custom certificate.** I set it,
CDK warned, and it was right: on the default `*.cloudfront.net` domain the TLS policy is fixed
by AWS. I removed it rather than leave a line that reads like a security control and is not
one, and left a comment saying when it becomes meaningful.

**The dictionary needed a profanity filter before it needed anything else.** The SCOWL word
lists contain plenty of words you do not want an IVR to read to a customer or a public web
page to display. That filter runs at dictionary-build time
([`tools/blocklist.txt`](../tools/blocklist.txt)) so it cannot be bypassed at runtime. The
list is small and English-only, which is itself a shortcut —
[PRODUCTION-READINESS](PRODUCTION-READINESS.md#5-the-brand-safety-list-is-hand-rolled) covers
what it should be.

**SCOWL tiers past 50 are unusable.** Including tiers 55–70 adds ~12,000 words that are
almost all archaisms and inflected rarities, and they crowd out good answers because they
often have better coverage. Capping at tier 50 (23,873 words) was a straight quality win.
