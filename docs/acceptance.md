# Manual acceptance gates

This is a checklist, not a record that the listed gates have passed. Record date, environment, operator and actual evidence for each run. Never substitute successful compilation for operational verification.

| Gate | Manual acceptance | Evidence required |
| --- | --- | --- |
| Source/build | Run typecheck, lint and production build | Command exit status and build output |
| Owner access | Sign in/out; reject wrong password; check unauthenticated API access | Browser and HTTP evidence |
| Settings/secrets | Save valid settings, reject invalid ratios and stale versions, verify secret never returned | Redacted response / audit evidence |
| Provider | Assign explicit supported model, probe capabilities, confirm configured budgets and usage | Real probe / invocation evidence |
| News/search | Save public HTTPS feeds; save Tavily key; probe saved config; observe source/date/freshness/matching and fetch errors | Redacted services response + actual probe/feed evidence |
| Runtime | Observe worker heartbeat, feed status, persisted role runs and tools | Worker/database + UI snapshot |
| Portfolio | Switch paper/live and verify ledger, reserved funds, unmarked positions and pUSD units | Mode-scoped records / journals |
| Controls | Reauthenticate pause, resume and emergency stop; confirm worker processes requested cancellation | Queue + worker + order evidence |
| Paper | Observe fills, costs, settlements and profit without real capital | Journal/order/settlement evidence |
| Evaluation | Review each strategy/profile separately after required duration and resolved events | Persisted profile evaluation |
| Live | All readiness gates pass; explicit live authorization and server execution switch | Separate live transaction evidence |
| Responsive UI | Inspect desktop/mobile, records overflow, settings drawer and error/empty states | Fresh screenshots / browser inspection |
| Deploy/recovery | Follow deployment runbook, HTTPS checks, encrypted backup and isolated restore drill | Host SHA, health checks, backup/restore results |

Thirty-day paper performance, production deployment, successful real provider billing and real profit remain unverified unless separately evidenced. Agent access is constrained by versioned role allowlists and server handlers; the UI exposes safe operational controls, not unrestricted shell or credential access.
