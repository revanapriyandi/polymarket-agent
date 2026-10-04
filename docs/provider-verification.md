# AI protocol verification — 2026-10-04

This records manual execution against a controlled local HTTP fixture. It does not establish acceptance by a real model/provider, paid API activity, production deployment or database metering. No real API key was used. No provider records, role assignments or application database rows were created or changed. No automated test suite was added.

## Scope and execution

The actual `runCapabilityProbe` entry point, installed AI SDK adapters and `guardedFetch` transport were exercised using an inline Node module piped from PowerShell into `node --import tsx --input-type=module`. The module created an ephemeral HTTP server bound to `127.0.0.1` on a random port and set `AI_ENDPOINT_ALLOWLIST` to that exact origin inside the child process only. It closed the server at completion. Source code and persistent environment configuration were unchanged by these commands.

Installed versions inspected: `ai` 7.0.127, `@ai-sdk/openai-compatible` 3.0.62, `@ai-sdk/open-responses` 2.0.58 and `@ai-sdk/anthropic` 4.0.71.

The fixture returned native non-streaming Chat Completions, Responses and Anthropic Messages envelopes. Valid text contained `READY`; valid structured output contained `{"marker":"READY"}`; valid tool calls targeted `capability_probe` with the same literal marker. Anthropic structured output followed the SDK's JSON tool fallback for the fixture model. The fixture emitted usage of ten input and two output tokens. These token counts are fixture values, not measurements of model billing.

## Observed protocol results

Twenty-seven HTTP generation calls were observed across exactly these routes: `/v1/chat/completions`, `/v1/responses` and `/v1/messages`. Each selected capability caused one request; probes disabled SDK retries.

| Controlled scenario | custom-chat | custom-responses | custom-anthropic |
| --- | --- | --- | --- |
| Valid text | Success, known 10/2 usage | Success, known 10/2 usage | Success, known 10/2 usage |
| Valid forced harmless tool | Success, known 10/2 usage | Success, known 10/2 usage | Success, known 10/2 usage |
| Valid structured marker | Success, known 10/2 usage | Success, known 10/2 usage | Success, known 10/2 usage |
| HTTP 401 | Failed; sanitized HTTP status | Failed; sanitized HTTP status | Failed; sanitized HTTP status |
| Text returned instead of forced tool | Failed; usage unavailable | Failed; usage unavailable | Failed; usage unavailable |
| Incorrect text marker | Failed; known 10/2 usage | Failed; known 10/2 usage | Failed; known 10/2 usage |
| Incorrect forced-tool marker | Failed; known 10/2 usage | Failed; known 10/2 usage | Failed; known 10/2 usage |
| Incorrect structured marker | Failed; usage unavailable | Failed; usage unavailable | Failed; usage unavailable |
| Unknown input usage | Text succeeded; usage unavailable | Text succeeded; usage unavailable | Partial usage envelope rejected; usage unavailable |

For Chat/Responses the unknown-usage scenario omitted `usage`. For Anthropic it supplied `output_tokens` but omitted `input_tokens`; the installed adapter rejected this malformed response. The observations establish failure handling for that payload, not acceptance of all possible Anthropic unknown-usage formats.

HTTP authentication failures exposed only `Provider request failed (HTTP 401)`. Incorrect text/tool markers exposed `Provider did not return the validated capability output`. SDK validation failures exposed `Provider operation failed (Error)`. Raw provider response/error text did not appear in these observations.

When SDK output validation throws, a probe observation can contain empty usage even though the fixture included counts. Such failures must keep the maximum reservation rather than assume free usage. A successful text observation with `usageAvailable=false` must also fail the persisted readiness gate. This drill exercised the observations directly; database reservation, journaling, version invalidation and aggregate provider readiness were inspected in source but were not executed here.

## Observed endpoint and header rejection

A second inline module executed seventeen rejection checks. All rejected before opening a connection to the specified private/metadata targets:

- HTTP loopback without an exact allowlist entry; configured URL query, credentials and fragment.
- Overriding the official OpenAI Chat endpoint.
- Custom `authorization`, `x-api-key`, `cookie`, `Host` and `x-forwarded-for` headers, and a CRLF header value.
- HTTPS loopback and RFC1918 addresses without allowlisting.
- AWS-style `169.254.169.254` and cloud-style `100.100.100.200` metadata addresses.
- A request URL with a different origin from the configured endpoint.
- The AWS-style metadata address even when its exact origin was temporarily allowlisted inside the process.

Returned messages matched the corresponding guards: `Invalid provider endpoint`, `Official provider endpoint cannot be overridden`, `Custom header rejected`, `Provider address rejected`, `Metadata address rejected` and `Provider request origin rejected`.

The source also pins a validated DNS result into the socket lookup, buffers non-streaming responses, rejects redirects and caps response bodies at 8 MiB. DNS rebinding, redirects, large responses, IPv6 ranges and deadline cancellation were not dynamically exercised in this drill.

## Remaining external acceptance

Official OpenAI Responses, OpenAI Chat, Anthropic and Gemini adapters are present in the implementation but were not called with real credentials. Real custom providers were also not called. Before enabling a provider for actual workload, configure its exact protocol/model/endpoint, authoritative token prices and budgets, then run the persisted UI capability probe. Verify text, tools, structured output and usage independently, along with invocation records and operating-cost journal entries. Configure role assignments only after those checks. Real generation quality, provider billing, rate limits, model availability and production networking remain separate acceptance gates.
