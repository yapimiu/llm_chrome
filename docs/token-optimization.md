# Token measurement baseline

Measured on db05532, 2026-10-24. No optimization algorithms changed.

Original baseline: `npm run compile` passed; `npm test` passed (35 files, 590 tests).
Deterministic synthetic fixtures: `tests/token-baseline.test.ts`.

| Fixture | Baseline observation |
| --- | --- |
| DOM, 600 character budget, oversized first element then short Continue button | 144 output characters; 0 shown, 2 omitted. Removing only the first element shows Continue. |
| History, 12 steps, 600 character budget | 600 characters; extract, old blocked note, old error markers absent. |
| Digest, same fixture | 600 characters; extract, old blocked note, old error markers absent. |
| Two invalid 1,600 character replies then success | 3 chat requests; sent prompt estimates 67, 659, 1,252 tokens. |

These are synthetic character counts and local `estimateTokens` estimates, not provider token usage, billing, latency benchmarks, or evidence of real-world task success. No external provider or browser E2E was run. Fixtures document current behavior and should be revised deliberately when each behavior changes.

Before this patch, accounting recorded only the final successful transport request per chat call; step usage retained only the last parsed reply. Format fallback, lean retry, transient failures, aborts, and discarded parse replies therefore needed transport-level accounting before optimization comparisons. Unknown usage must remain distinct from reported zero. Cached input is a subset of input. Cost remains unknown without explicit trustworthy rates and complete usage. Diagnostic telemetry must allowlist numeric measurements and provider/model metadata, excluding page content, prompts, URLs, error text, and response bodies.

## Architecture and accounting added after baseline

The runner calls runStep: fresh observe, prompt/history, chatStream (format/lean/transient retries), local parse and correction. The runner then applies loop detection, risk checks and approval before executing against the observation's snapshot handle and persisting. Collection supports shadow DOM and frames; masking/site hide rules apply before observations reach the prompt. Context estimates use local character-based estimates calibrated against reported prompt usage, not a billing tokenizer. Existing macros, course/skipper shortcuts, and screenshots='stuck' already provide alternatives to repeated model calls.

New transport accounting is isolated in StepRecord.usage and an explicit allowlisted exportUsage helper. Each actual fetch finalizes one event, including failed/aborted streams; attemptInChat distinguishes transport retries from a new ordinary chat call. Parse retries are counted separately. Partial/cumulative SSE usage is merged per field without summing chunks; numeric zero remains distinct from null. summarizeRunUsage exposes reported sums plus unknown attempt counts, mixed model identities, legacy/unmeasured records, and unknown cost (missing rates). Cached input is never added to input totals. No tariff table or inferred price is used.

Existing heavy StepDetail persistence and remote logging can contain observations and response text. This patch does not change that pre-existing behavior; new diagnostic export must use exportUsage rather than the heavy exportRun path. Model identifiers are bounded and reject whitespace, controls and URL syntax. Transport success follows the existing parser's stream completion behavior, including EOF; it does not prove provider billing or valid agent JSON.

Validation after accounting: TypeScript compile and full unit suite; no browser E2E or live provider usage/cost measurements.

## C: retain fitting elements after an oversized line

Only the serializer's non-fitting-line decision changed from break to continue. Budget reserves, zone priority, document output order, element identifiers, states and attribute text remain unchanged. The same DOM fixture now emits 205 characters, shows the Continue button (1 element), and omits only the oversized element (1). This adds useful target coverage within the same 600-character cap; it is not a measured provider token saving. Oversized middle elements and tiny budgets have regression checks. The baseline table above retains the pre-change numbers.

## D: expendable success history and protected context

Ordinary healthy steps now retain action/result and recent target text without repeated reasoning/expected outcome. Verbose successful result messages are bounded to 80 characters. Failure/no-effect action metadata, failure text (including reported success with nothing on the page changed), skipped reasons, safety directives, postponed actions and user replies/rejections remain complete with their source step. Exact protected duplicates retain their first source. Extract facts remain complete and deduplicated. Protected information is not repeated in recent detail blocks, and the historical-index warning explicitly directs the model to the current observation indices.

Arbitrary notes are bounded to 180 characters and six distinct entries; failures/LOOP records keep the six latest distinct entries in full. Safety directives and extract facts have a protected floor. If this floor alone exceeds maxChars, history/digest return it with an explicit soft-budget-overflow marker instead of silently removing constraints. The existing context guard can shorten the page, reset context, warn, or propagate provider overflow; no finite hard limit can preserve arbitrarily many full constraints. This patch changes no runner/risk policy.

Deterministic results: the same pressure fixture now retains extract/blocked/error markers in both history (588 characters) and digest (533), under the 600-character budget. A separate three-healthy-step fixture reconstructed with the pre-change formatter measures 1,808 characters / 606 estimated tokens before, versus 229 characters / 79 estimated tokens after. These are local synthetic estimates, not provider usage. Original baseline figures above remain unchanged. Retry prompt estimates remain [67, 659, 1,252] pending task E.

## E: bounded parse corrections and targeted format fallback

Parse retries now send the unchanged base prompt plus only the latest invalid assistant excerpt (at most 512 characters after stripThinking) and latest correction (parser error excerpt at most 256 characters). Empty/reasoning-only replies use an empty placeholder; length-limit guidance remains. The local normalization/JSON repair and retry limits are unchanged. Exhaustion returns exactly the last messages sent, without adding an unsent correction. Existing one-time context-overflow retry, snapshots, screenshots and risk policy remain intact.

Format fallback now requires explicit response_format/json_schema/json_object/schema/grammar evidence rather than generic JSON text: an unrelated invalid JSON request body produces one failed HTTP attempt. Existing successful-format and lean caches remain.

For the same two-invalid-reply fixture, baseline estimates [67, 659, 1,252] (sum 1,978) become [67, 297, 297] (sum 661). Both baseline and after have 3 chat calls, 2 invalid replies, and 1/1 synthetic tasks successful. This demonstrates bounded repeated input in a deterministic fixture, not fewer calls, a lower parse-error rate, provider token accounting, cost savings, or real-world task success.

The unrelated-JSON HTTP400 fixture records transport attempts 3 → 1 and successful tasks 0 → 0. The before count reconstructs the archived generic matcher over the three auto formats; the after count is the mocked fetch invocation count. These are rejected synthetic HTTP attempts, not paid provider generations or evidence of successful task execution.

## F: observation modes with conservative completeness

Standard remains the default for old/new settings and keeps the existing user character cap and 80-character element labels. Explicit Minimal uses min(user cap, 4,000) with unchanged label precision. Detailed uses 160-character element labels within the same user cap. Settings expose all modes; Adaptive is explicitly experimental and opt-in. None changes collection filtering, element numbering, risk checks, screenshot policy or model/cloud selection.

Adaptive starts Standard and selects Detailed after errors, no-effect results, skipped/rejected actions, LOOP/STUCK or model switch. It can select Minimal only after a healthy same-page step whose previous collector-visible representation was known complete and at most 4,000 characters. Every step collects fresh data and handles. If the current Minimal observation is incomplete/unknown or has a different URL, it collects Standard again before calling the model and uses that last handle.

Collection now reports text-budget truncation separately, including early skips where rendered text can be shorter than the cap and final render slicing. Old metadata is unknown. Completeness is conservative: any multiple/missing frames, missing frame tags/info, collector walk/text truncation or serializer omissions/truncation prevent auto-Minimal. The single-frame gate describes the collector-visible representation, not all website content. This avoids claiming completeness from string length alone. No live success, cost or token-saving benefit of Adaptive has been measured; simple complete pages may produce the same payload in Standard and Minimal.

## G: static system prefix before run-specific values

The system template now defines random PAGE boundary markers and the current action limit in a final suffix. Static instructions still specify untrusted page/screenshot data, task/site-note trust, current indices, risk confirmation, no blocked/postponed bypass, and all existing actions. Template rendering, random per-run boundaries, page-marker neutralization, schema and action semantics are unchanged.

For different 12-character boundaries and action limits 3/5, the original template's common prefix was 804 characters; the revised prefix is 6,649 characters and includes all safety/action rules. This is a structural caching opportunity only: no provider cache hits, billed cached tokens, latency or cost savings were measured. Custom user templates remain unchanged.

A separate accounting correction accepts tagged model identities such as qwen3:14b and namespace/model:tag while rejecting URL syntax, whitespace, controls and oversized free text.

## H: reuse existing replay mechanisms

Existing Replayer/Skipper/course mechanisms already avoid LLM calls for their supported explicit workflows. They are not duplicated or broadened. A safe three-step replay regression checks fresh observations, rebound indices 10/20/30, snapshot handles 1/2/3, and real risk assessment before each action, with zero fetch calls. Existing risky-action rejection coverage remains. No automatic replay or click policy was added.

## I: visible accounting and separate safe export

The current-run panel reports server input/output/cache counts, per-field unknown attempt counts, HTTP outcome groups, chat calls, transport retries, parse retries, all parse errors (including the final exhausted reply), and legacy/unmeasured coverage. Cost explicitly remains unknown because rates are not configured. Missing legacy counters remain unknown rather than reported zero.

The run log's “Токены” button downloads a separate accounting JSON through bg:run-usage-export: loadRun then exportUsage, without loading heavy step details or using exportRun. Its explicit allowlist contains numeric counters, safe run-status enum and provider/model metadata, with no task/result/error/page/prompt/profile-label fields. Existing heavy debugging exports and remote logging are unchanged. No tariff tables or new raw logging were added.


## Final deterministic comparison and validation

G2 removes only redundant run-marker metadata and introductory wording. Security/action rules remain intact. Template length is 6,750 → 6,740 characters; rendered system length (12-character boundary, one-digit limit) is 6,736 → 6,726. Common static prefix across different boundaries/limits is 804 → 6,649 characters. The final template adds no systematic character overhead for providers without caching.

| Synthetic measurement | Before | Final |
| --- | --- | --- |
| DOM cap 600: shown / omitted elements | 0 / 2 | 1 / 1 |
| Pressure history / digest chars; extract, blocked note, error retained | 600 / 600; none retained | 588 / 533; all retained |
| Healthy history local estimated input tokens | 606 | 79 |
| Two invalid replies: local estimated input per call (sum) | 67, 659, 1,252 (1,978) | 67, 297, 297 (661) |
| Same JSON scenario: chat calls / invalid replies / successful tasks | 3 / 2 / 1 of 1 | 3 / 2 / 1 of 1 |
| Unrelated JSON HTTP400: transport attempts / successful tasks | 3 / 0 of 1 | 1 / 0 of 1 |
| Explicit safe three-step replay | Existing mechanism | 0 fetch calls; fresh handles and real risk assessment each step |
| Reported live provider usage / actual cache hits / actual cost | Not measured / unknown / unknown | Not measured / unknown / unknown |

The HTTP400 before count reconstructs the archived classifier over three auto formats; final counts use mocked fetch. All other input-token figures use local estimateTokens on synthetic fixtures, not billed provider usage. No live provider or browser E2E task success is claimed. Adaptive behavior remains opt-in with no measured live savings. Final validation: npm run compile passed; npm test passed (38 files, 639 tests); git diff --check passed. npm run build passed (dist/chrome-mv3).
