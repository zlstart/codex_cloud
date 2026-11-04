# Independent live observer findings

The original run completed in 1,210.071 seconds with 32 provider responses, 35 tools, and 577 ordered events. The targeted repair completed in 377.268 seconds with 5 responses, 4 tools, and 385 ordered events. Both timelines have paired tool starts/completions and no duplicate identities. The original run had five explicit failed tools: two malformed patches, two Bash-only commands passed to POSIX sh, and a final `grep -c tmp` returning 1 for the benign zero-match case. Earlier generated Node test failures were masked by wrapper commands that printed `EXIT=1` but exited 0; the model subsequently repaired those tests.

Final independent physics/data verification passed all 51 checks. The 1,266 sampled states agree with independent Newtonian RK4 integration at tenfold smaller dt=0.0001, with maximum position difference 8.324868572273658e-12 and velocity difference 1.5521833818255004e-11 across 51 comparison states. Every producer-size step was independently recomputed to check the reported conservation metrics. The numerical verifier did not execute or import generated code.

Baseline and final downloaded CSV, metrics.json, and PNG files are byte-identical. The complete embedded HTML sim-data JSON is also byte-identical. Only the HTML and its generator changed, as requested. Detailed full SHA256 values are in `hash-preservation.json`.

The independent local /health observer recorded 3,360 successful samples, no failures, median 1.887 ms, p95 2.626 ms, p99 4.151 ms, and maximum 139.08 ms. One sample exceeded 100 ms; none exceeded 500 ms. Collection ran from 14:49:05.617322 to 15:17:15.741150 UTC. The first valid sample was 41.079322 seconds after original submission. Initial sandbox-denied probes were excluded. A 9.560303-second collector restart gap enabled following the repair run; it is a monitoring coverage gap, not an application outage. Measurements include a database read and local client overhead; they do not represent remote user or reverse proxy latency.

The provider never emitted an actual compaction item. The original run had 26 threshold-exceeded responses (maximum 82,663 input tokens); all 5 repair responses exceeded the 32,000 threshold (maximum 101,697 input tokens). Total observed input usage across both runs was 2,284,601 tokens; output-token and cached-token detail was not recorded, so billing cannot be derived. Union of observed tool intervals was 66.863516 seconds originally and 1.566822 seconds for repair. The rest of each run includes model generation, streaming, and uninstrumented overhead; it is not a direct provider-latency measurement. The final response-to-run-completed delays were 10.507148 and 10.454806 seconds, respectively, which merit separate cleanup instrumentation.

Remaining final-answer wording caveat: the repair chat answer describes t=6.33 as the minimum state distance for all t>0, while also quoting a smaller distance at t=12.65 (0.0043 versus 0.0096). The accurate description is the first recurrence region near t=6.33, not the global minimum across the whole interval. The repaired HTML/data are consistent; this caveat concerns the chat explanation.

Recommended improvements supported by this run:

- Probe and clearly report effective provider compaction support. Crossing a threshold and accepting the parameter did not establish actual compaction.
- Record response start/completion, output/cached tokens, and cleanup timing so long periods without timeline events can be explained accurately.
- Include original argument length and truncation metadata. The first patch error referenced character 36,085, beyond the retained 30,000-character display payload.
- Give malformed patch errors concise schema guidance. Retain explicit shell selection and preserve child command exit codes; a successful wrapper is insufficient evidence that an inner test passed.
- Provide a reusable browser-capable artifact verification path. The agent spent multiple rounds repairing ad hoc DOM tests because the runtime lacked a browser, and those tests did not measure mobile overflow.

Startup checks and final rendered browser checks are reported separately by the root and browser verification agents. This observer did not mutate application code or generated deliverables, launch models, or archive authentication state.
