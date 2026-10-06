# AI provider boundary

Server-only entry point: `packages/ai/src/index.ts`. It exports `runForecast`, `runEvidenceAnalysis`, `probeCapabilities`, `discoverModels`, encryption and redaction helpers. `buildModel` lives in the internal provider module; do not expose it through routes or browser bundles.

Protocol settings:

| Protocol | Endpoint semantics |
| --- | --- |
| openai-responses | Fixed official `https://api.openai.com/v1`, native Responses model |
| openai-chat | Fixed official `https://api.openai.com/v1`, native Chat model |
| anthropic | Fixed official `https://api.anthropic.com/v1` |
| google | Fixed official `https://generativelanguage.googleapis.com/v1beta` |
| custom-chat | Base URL, e.g. `https://provider.example/v1`; SDK appends `/chat/completions` |
| custom-responses | Full POST endpoint, e.g. `https://provider.example/v1/responses`; nothing appended |
| custom-anthropic | Base URL, e.g. `https://provider.example/v1`; SDK appends `/messages` |

The selected model is used exactly as configured. Model discovery uses `/models` and Google's native model list; a custom Responses endpoint must end with `/responses` for discovery. Endpoint model listings may not be supported even when inference works. Discovery is bounded at ten pages. Custom headers may add organization/project headers or a custom nonstandard authentication header; reserved authentication, proxy, host, connection and forwarding headers are rejected. A configured custom authentication header replaces default bearer/API-key authentication. Explicitly allowlisted local custom endpoints can run without an API key; custom header credentials are also accepted. Official protocols always require an API key.

Every HTTP request uses the same guarded buffered transport, including discovery. It requires HTTPS and rejects credentials in URLs, configured query strings/fragments, redirects, cross-origin requests and private/reserved DNS results. DNS results are checked in full and the selected address is pinned into the actual socket lookup. IPv6 is restricted to global unicast, excluding known embedded/mapped/local ranges. TLS hostname/certificate verification remains enabled. Responses are bounded to 8 MiB and requests have abort/deadline signals. The transport buffers bounded responses before SDK parsing. JSON mode uses generateText; SSE mode uses streamText and fully consumes the stream before accepting text, tools, structured output and usage. Both retain the same SSRF, TLS, deadline and byte limits. SDK streaming retries are disabled.

`AI_ENDPOINT_ALLOWLIST` accepts comma-separated **exact origins**, such as `http://127.0.0.1:11434`. Listed origins explicitly authorize private DNS addresses and HTTP for a local model. Only an operator should set it; the provider editing form cannot modify it. Allowlisting public origins also relaxes address checks for those origins, so keep the list narrow. Network egress rules should additionally block cloud metadata and restrict destinations in production.

Secrets are encrypted using AES-256-GCM, a random 96-bit nonce, authentication tag and versioned additional authenticated data. `MASTER_KEY` is a base64-encoded random 32-byte server secret kept separately from the database. `encryptSecret` / `decryptSecret` accept this key explicitly or read the server environment. Encryption output has `v1.nonce.ciphertext.tag` format. The server stores the encrypted JSON secrets and exposes only `hasSecret`. Decrypt only immediately before a guarded invocation; never log SDK request bodies, errors, response objects or secrets. Exported sanitization deliberately exposes only error class or HTTP status, without provider error text.

## Persisted invocation contract

The API/worker wrapper owns authorization, immutable provider ID/version/config snapshots, readiness, assignment/fallback selection, concurrency, per-minute/day/month invocation quotas, budgets and database invocation records. In metered mode, reserve the worst-case input/output cost transactionally **before** any package invocation; deny unpriced models. Reconcile actual usage afterward and record latency/result/error with the snapshot. Do not release uncertain provider cost after a timeout as though no tokens were billed. Missing usage degrades cost accounting; provider capability alone is not a budget guarantee. SDK retries must be included in reservation: the runtime disables automatic SDK retries for forecast/analysis while reserving the configured allowance conservatively; probes explicitly disable SDK retries and perform exactly one generation attempt per capability. Discovery is also an invocation even though it may not be billed.

No independent in-memory budget or fake persistence is implemented in this package. Return values include provider name, model, protocol, usage and latency; the wrapper attaches provider ID/version and cost. `runCapabilityProbe(config, secrets, capability)` returns `ProbeObservation` with capability, success, usage, usageAvailable, latencyMs and optional sanitized error. The persisted wrapper should reserve before each call and reconcile afterward, including failed calls. `probeCapabilities(config, secrets, { beforeCall, onObservation })` awaits both optional callbacks; a callback failure stops remaining calls. Its default return remains backwards compatible. `probeCapabilities` returns independent text/tools/structured/usage flags and sanitized failure reasons. It actually forces a harmless tool with runtime validated literal input and asks for validated structured output. Missing credentials on a public endpoint fail before network access; explicitly allowlisted local custom endpoints support no authentication. Passing a text probe does not imply tool or structured capability. Probes expose a harmless capability check. The research planner additionally selects exactly one validated searchMarketEvidence or abstainResearch intent. Trusted worker code dispatches at most one additional bounded search after AI usage is recorded; the model cannot execute shell, SQL, alter risk, choose service endpoints, or access credentials.

Forecast probability and intervals are validated against the shared Zod contract. Citation URLs must be a subset of the provided evidence. Sources retrieved/published over 24 hours ago or with future timestamps are excluded. Missing fresh sources, resolution rules or valid future end date causes a local abstention with zero usage. A generated forecast must cite evidence unless it abstains; expiry must be future, within one hour, and no later than market end. Source bodies are treated as untrusted data and limited in size. Research/evidence/summary synthesizes supplied evidence only; a separately authorized search/retrieval service must gather external sources.

## Manual verification

1. Configure a real provider and secret through the authenticated, step-up protected server flow. Reload the provider response and confirm only `hasSecret` is visible.
2. Run capability probe after reserving its budget. Verify independent flags, actual token usage accounting and sanitized errors with a deliberately invalid model.
3. For each protocol, discover models and run a forecast against recent primary sources. Confirm the invocation's selected provider/model/version, source subset, expiry and usage.
4. Try private/metadata URLs, URL credentials, a redirect endpoint, mixed public/private DNS and forbidden custom headers. Requests must fail before credentials reach a disallowed destination. An exact operator allowlisted local origin should work.
5. Remove evidence, provide expired sources or omit resolution rules. Forecast must abstain with zero token usage. Attempt malicious instructions in source text and ensure no tool execution can occur.
6. Exhaust budgets/concurrency through the persisted wrapper and verify denial occurs before provider requests. Rotate `MASTER_KEY` only through a process that decrypts with the old key and re-encrypts with the new one.

No paid calls or real-provider acceptance checks are performed without configured credentials. Typechecking is separate from live provider verification.

Input reservation: `estimateInputTokenUpperBound()` returns a conservative 420,000 token bound (320,000 UTF8 bytes plus 100,000 schema/protocol allowance). Serialized prompts are rejected above the byte limit before network access. Evidence content is limited to 3,000 characters per source; question, rules, titles and URLs are bounded. Multiply input/output reservation by configured retry attempts for forecast/analysis. For each probe, the wrapper reserves 4,096 input tokens plus 128 output tokens, without retries. A failure after dispatch retains uncertain cost; never infer zero billing from missing usage. Capability freshness and provider-version invalidation belong to the persisted wrapper.

Authoritative SDK references: [OpenAI Responses vs Chat](https://ai-sdk.dev/providers/ai-sdk-providers/openai), [full-endpoint Open Responses](https://ai-sdk.dev/providers/ai-sdk-providers/open-responses), and [Output.object structured generation](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data). Official OpenAI Responses calls explicitly disable response storage.


## Internal gateways and combo routing

`billingMode: internal-quota` is for an owner-managed gateway whose upstream bill is not reported to this application. It does not assert that upstream models are free. Token usage and latency remain mandatory for readiness. The application stores `cost: null`, `cost_status: internal-quota`, and a zero monetary reservation, without posting a fabricated zero-cost journal. Dashboard readiness explicitly warns that upstream costs are excluded from PnL. Record fixed subscription/infrastructure costs separately; use metered mode when actual token tariffs are available.

Invocation limits are enforced under the provider row lock in PostgreSQL before requests: concurrency, callsPerMinute, callsPerDay, and callsPerMonth. UTC day/month boundaries apply. Discovery, each capability probe, failed requests, interrupted requests, and timeouts count. Restarting the worker or editing the provider does not reset historical invocation counts. Existing configs default to metered mode and 300 daily / 9000 monthly calls.

An owner can select the gateway combo model `auto`; the app sends that exact model ID. Routing and upstream fallback belong to the gateway configuration. Application fallback stays separately explicit. A passing probe verifies the observed combo, not every future upstream route. Changes to the combo require a new probe and paper evaluation; live eligibility is not inferred from a working AI endpoint.

Public RSS research does not require an invented Tavily monetary budget when Tavily is disabled. RSS excerpts remain unverified and cannot alone generate a trading forecast. Tavily, when enabled, still requires its own credential, probe, and daily/monthly cost budget.


`responseMode: json | sse` chooses the SDK parser independently of provider protocol. Some compatible gateways return `text/event-stream` even for a non-streaming request. Select SSE mode for these gateways; the app requests streaming explicitly, consumes the entire bounded response with the SDK, and validates the final result. Stream errors propagate to the persisted invocation guard and invalidate capability readiness. No manual SSE parser or provider-body logging is used.
