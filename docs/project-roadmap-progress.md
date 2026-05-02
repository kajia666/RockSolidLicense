# Project Roadmap, Overall Plan, and Development Progress

Updated: 2026-05-02

This document is the rolling project control sheet for RockSolidLicense. It answers three recurring questions:

- What should we do next?
- What is the overall project plan?
- How far are we from an initial production launch?

The current launch target is not "all imaginable features are finished". The target is:

- can go online
- can authorize users
- can deliver to software authors
- can operate the first launch wave

Current overall-plan position: the project is mainly in Phase 5, "Production Readiness and Deployment", with the Phase 4 first-launch operations chain already largely connected. The work now is less about inventing new features and more about converting staging rehearsal, closeout backfill, backup/restore, full-test-window entry, production sign-off, and first-wave support into repeatable launch-day execution. The latest staging work has narrowed production sign-off into its own operator packet, so the remaining work is increasingly real-environment execution instead of script-side wiring. New launch features should now be added through the named staging rehearsal extension points instead of being bolted directly into one large script.

## Current Position

The project is now close to an initial pilot launch. The most important backend/API launch chain is already in place:

- Software-author delivery: SDK package, integration package, release package, launch workflow, launch review, launch smoke, launch mainline.
- Authorization operations: accounts, entitlements, sessions, device bindings, device blocks, cards, policies, audit logs, scoped developer operations.
- First-launch operations: launch bootstrap, first batch setup, inventory refill, first-launch handoff, launch receipt follow-ups, initial launch ops readiness.
- Production readiness: production gate, cutover handoff, recovery drill handoff, operations handoff, post-launch sweep handoff, closeout handoff, stabilization handoff.
- Launch control plane: `/api/developer/launch-mainline`, `/developer/launch-mainline`, route focus, action receipts, recommended downloads, stage gates, checksums, zip exports.
- Launch smoke handoff continuity: the CLI `launch:smoke` first-wave handoff now lands in Launch Review, Developer Ops, and Launch Mainline evidence with `source=launch-smoke` / `handoff=first-wave` preserved in route-focus UI, payload filters, exported summaries, follow-up workspace links, and post-smoke Launch Review / Launch Smoke summary downloads for receipt-visibility review.
- Recommended download routing: Release Package and Launch Workflow text handoffs, Launch Workflow local zip/summary/checklist downloads, Launch Workflow integration env/host-config/host-skeleton download format routing, Launch Workflow handoff zip/checksum downloads, Launch Workflow checklist/action-plan handoff zip format consistency, Launch Review route focus/action/focus-target text, Launch Review scoped Workflow summary/checklist downloads, Launch Smoke route focus/action text, Launch Smoke action-plan scoped Smoke Kit downloads, Launch Mainline route focus/continuation/recommended-download text, First Launch Handoff text, Post-Launch Lifecycle text, Launch Workflow, Release follow-ups, Developer Projects follow-up downloads, Developer License quickstart follow-ups, Developer Ops route-review handoffs, Developer Ops Launch Mainline handoff summary text, shared Initial Launch Ops Gate blocker text, launch receipt follow-up queue downloads/CSV export and Developer Ops follow-up overview text, First Wave Recommendations first-round ops actions, initial-launch traceability next-follow-up downloads, Developer Ops summary/readiness/stabilization traceability text, Developer Ops readiness blocker/action text, Developer Ops operator action manifest text, Launch Mainline post-launch handoff traceability/lifecycle primary-download text, Launch Mainline action receipt handoff text, Launch Mainline zip/checksum/direct handoff download routes, and Developer Ops operator/stabilization follow-ups now consume service-provided download `href` values for recommended downloads, so the first-wave handoff chain no longer relies on frontend source/format guessing in those launch-critical entrypoints.
- Latest backend/API slice: First-Wave Recommendations, Launch Review, and Launch Smoke Kit now pass the selected channel into their internal Developer Ops snapshots; stable and beta launch-duty views no longer silently fall back to the wrong lane when reading latest launch receipts. First-Wave Recommendations now also exposes a machine-readable `launchReadinessBridge` with inventory, first-card, first-round-ops segment state, the current gate, the stable next-action key, confirmation endpoint, summary/json/checksum download hrefs, and matching audit metadata, so the first-wave operator can see exactly whether to run first-batch setup, continue the handoff, or confirm the reviewed snapshot without parsing the full recommendation payload. Developer Ops export now rebuilds the latest bridge from that audit metadata and prints it in the snapshot summary plus initial-launch-readiness download before handoff confirmation, and Launch Mainline now mirrors the same bridge as a top-level `mainlineSummary.firstWaveReadinessBridge`, a dedicated summary/download text section, and a `first_wave_readiness_bridge` overview card with summary/json/checksum download controls plus the confirmation endpoint, so launch duty can see and act on the first-wave gate from the normal Ops packet or the mainline entrypoint instead of opening the recommendation endpoint separately. Post-launch lifecycle receipts and stabilization handoff confirmations now also preserve primary handoff download hrefs through Ops snapshots, Launch Mainline traceability, the post-launch handoff index, and the handoff route map; the route map now calls out the Ops handoff index, Launch Mainline JSON, summary, post-launch handoff index, post-launch lifecycle primary download, checksums, and zip package as critical routes for offline launch-duty review.
- Latest Ops export slice: Developer Ops route-review primary, next, remaining, section, and continuation downloads now include service-generated `href` values directly in the snapshot payload; Ops export/download routes preserve non-default channel scope; route-review section downloads now return section-specific handoff files instead of falling back to the generic summary; Ops export zip/checksum packages now include the route-review handoff files and a direct `launch-mainline-handoff-routes.txt` map for offline launch-duty review, and the same route-map file is now surfaced in Ops readiness and handoff-index recommended downloads. Developer Ops initial launch readiness now also exposes a `stagingLaunchDutyArchive` bridge plus `format=staging-launch-duty-archive`, so launch duty can pull the expected staging archive root, `staging-launch-duty-archive-index.json`, packet paths, and rehearsal/full-test commands directly from the backend/API export bundle; the Developer Ops page now surfaces that same bridge as a first-screen "Download Staging Archive" action and inline snapshot recap instead of forcing operators to discover the export format manually. Developer Ops readiness now also carries a `launchDutyActionOrder` with service-provided downloads for staging archive, launch readiness, and next follow-up, and the page renders that order as one first-screen operator sequence so Launch Smoke / Launch Review / Developer Ops handoff checks are less dependent on manual file discovery. Launch Review, Launch Smoke Kit, Launch Mainline direct handoff route maps, and Launch Mainline post-launch handoff indexes now lift the same `launchDutyActionOrder` into their own top-level text sections, including a safe next-follow-up download fallback, so the first-wave reviewer can see the staging archive, readiness, and next-follow-up sequence without opening the full Ops snapshot first. Developer Ops snapshots now also backfill recent Launch Mainline action receipt audit rows when there is no explicit audit filter, so long Launch Mainline export/download rebuilds no longer lose the latest first-wave receipt after export audit noise pushes it beyond the default snapshot window; Developer Ops and Launch Mainline summaries now print `Launch Receipt Audit Backfill`, and Developer Ops summary JSON plus Launch Mainline post-launch traceability now expose the same count plus a `launchReceiptAuditBackfillStatus` block with `used`, `source`, and `operatorHint`; the same status/source/operator hint now renders in Developer Ops summaries, Developer Ops route-review primary/next/remaining/section direct text downloads, Developer Ops launch receipt next-follow-up, Developer Ops Launch Mainline handoff-routes direct text, Developer Ops initial launch readiness, Developer Ops stabilization handoff, Developer Ops staging launch-duty archive, Developer Ops handoff indexes, Launch Mainline summaries, Launch Mainline handoff download routes, and the Launch Mainline post-launch handoff index, and Developer Ops zip/checksum exports now include `launch-receipt-backfill-status.txt` as a dedicated offline diagnostic anchor with a matching `format=launch-receipt-backfill-status` direct download that is also surfaced in readiness and handoff-index recommended downloads, so launch duty can diagnose protective receipt context from JSON, route-review handoffs, next-action handoff, Ops-to-Launch-Mainline route maps, readiness gates, stabilization handoff, staging archive, summary text, route maps, either offline handoff index, the zip/checksum bundle, or the standalone backfill status file without parsing nested audit filters or remembering the format name; explicit audit-filter route-review files also show `NOT_USED / snapshot-audit-filter` instead of leaving operators to infer why no protective backfill was applied.
- Latest verification slice: broader targeted launch-readiness batches now pass across release package export, release mainline follow-up, launch workflow blockers/restock, launch mainline first-launch and post-launch actions, first-wave recommendations, Developer Ops export, launch pages, the `launch:smoke` CLI preflight, account/card/session authorization flows, production gate/security checks, deployment assets, and runtime-state checks. The full `test\license-flow.test.js` pre-staging gate also passed on 2026-04-28 with 80/80 tests, followed by `node --check src\services.js` and `git diff --check`.
- Latest staging rehearsal slice: the remote launch smoke command now has a `--require-https` gate, a dedicated `launch:smoke:staging` npm script, no-write `staging:preflight` and `recovery:preflight` gates, and a no-write `staging:rehearsal` runner that combines smoke command checks, backup/restore command checks, the reusable `launch:route-map-gate` pre-staging targeted command for route-map visibility plus low-frequency download surfaces, staging environment readiness for HTTPS, non-default secrets, persistent storage, backup/restore drill, route-map gate execution, and live-write approval, a nine-step staging operator checklist, an operator execution plan that sequences generated output files, route-map, recovery, smoke, evidence, visibility, closeout backfill, full-test-window reservation, and production sign-off review, plus readiness gaps for missing handoff/closeout files, missing bearer token, pending closeout keys, blocked full-test-window entry, missing receipt visibility, and blocked production sign-off. `--closeout-input-file` can reload a real backfilled redacted closeout template, narrow fulfilled gaps, enable the full-test-window entry, and clear the production sign-off blocker only after the full test passes, sign-off condition statuses are backfilled, the production sign-off decision is recorded, and Launch Mainline / Launch Review / Launch Smoke / Developer Ops receipt visibility are all marked visible, without printing raw values or modifying data; it also refuses generated example-only closeout input files so placeholder samples cannot accidentally clear launch readiness. The generated Markdown handoff renders missing sign-off keys and missing receipt-visibility keys directly in readiness gaps, includes Closeout Backfill, Full Test Window, Production Sign-Off, Launch Day Watch, Stabilization Handoff, Staging Run Record Template, Staging Environment Binding, Staging Execution Runbook, Staging Readiness Transition, Launch Rehearsal Bundle, Filled Closeout Input Example, and now a Final Rehearsal Packet section that brings the staging dry-run command, environment binding status, execution runbook status, readiness transition status, launch rehearsal bundle status, handoff file, closeout file, filled closeout input path, artifact archive root, route-map gate, live-write smoke, closeout reload, full-test-window command, and ordered packet steps into one operator-facing execution packet. The generated JSON closeout template includes the same `closeoutBackfillGuide`, `fullTestWindowReadiness`, `productionSignoffReadiness`, `launchDayWatchPlan`, `stabilizationHandoffPlan`, `stagingRunRecordTemplate`, `stagingEnvironmentBinding`, `stagingExecutionRunbook`, `stagingReadinessTransition`, `launchRehearsalBundle`, `filledCloseoutInputExample`, `finalRehearsalPacket`, and editable receipt-visibility and production-signoff skeletons with pending statuses and expected values, so launch duty no longer has to guess field names, output paths, safe dry-run commands, execution order, readiness transition state, bundle status, or open separate docs to complete the final sign-off, launch-day watch, staging record, closeout input, packet execution, and stabilization handoff backfill. The runner also carries a redacted result backfill summary for route-map, recovery, live-write smoke, Launch Mainline evidence receipts, and receipt visibility review, a staging acceptance closeout for operator go/no-go and the full-test-window decision, an artifact/receipt ledger that maps each closeout key to its redacted archive path and Launch Mainline receipt operations, a guarded `npm.cmd test` full-test-window entry, production sign-off conditions, the scoped Launch Mainline URL, Launch Review / Launch Smoke receipt-visibility summary downloads, evidence readiness, the evidence recording order, machine-readable Launch Mainline action payloads, copyable evidence PowerShell requests, an optional redacted Markdown handoff file, an optional redacted JSON closeout template, a safe staging environment binding that references password and bearer-token environment variable names without printing raw secrets, a staging execution runbook that maps dry run, route-map gate, recovery drill, live-write smoke, evidence recording, receipt visibility, closeout input backfill, and closeout reload into one sequence, a readiness transition summary that shows whether launch duty is still blocked, ready for the full test window, or ready for launch-day watch, and a launch rehearsal bundle that groups files, commands, closeout targets, operator records, and readiness gates before any live-write smoke run begins.
- Latest staging profile slice: `staging:rehearsal` now accepts `--profile-file` or `RSL_REHEARSAL_PROFILE_FILE` for reusable non-secret staging inputs: base URL, product code, channel, smoke usernames, recovery target, storage profile, environment file, backup directories, and output file paths. CLI flags and environment variables still override profile values, while profile files are rejected if they contain password or bearer-token fields. The runner now emits a `stagingProfileLaunchPlan` that records whether profile-driven rehearsal is ready, which CLI overrides were used, which non-secret inputs or output files are still missing, which secret env vars must be set before live-write smoke and evidence recording, and the recommended profile-driven rehearsal command. Its `backfillManifest` maps route-map, backup/restore, live-write smoke, launch smoke handoff, Launch Mainline evidence receipts, receipt visibility review, and operator go/no-go results to the exact source step, closeout key, artifact path, and receipt operations expected after a real staging run. `stagingProfileOperatorPreflight` now compresses the real rehearsal input check into one safe block: missing non-secret inputs, missing output paths, missing secret env vars, recommended files, command sequence, profile command, staging dry run, route-map gate, live-write smoke, and closeout reload. `stagingRehearsalExecutionSummary` then combines profile preflight, execution runbook, loaded closeout review, readiness transition, final packet status, blocking reasons, ordered next actions, and key commands into one operator-facing summary. `stagingRehearsalRunRecordIndex` now turns the real rehearsal record work into a machine-readable index: pre-full-test closeout records, production sign-off conditions, launch-day/stabilization records, missing record keys, missing sign-off and receipt-visibility keys, reload command, ordered operator milestones, and the next evidence-backfill action; `--run-record-file` or `RSL_REHEARSAL_RUN_RECORD_FILE` can now write that redacted index as its own JSON artifact for staging archive review. `stagingArtifactManifest` now centralizes the generated handoff, closeout, run-record, artifact-manifest, backup/restore drill packet, closeout-reload packet, readiness-review packet, production-signoff packet, filled-closeout, and archive-root paths with source statuses and closeout reload guidance; `--artifact-manifest-file` or `RSL_REHEARSAL_ARTIFACT_MANIFEST_FILE` can write that redacted manifest as a standalone staging archive index. `stagingBackupRestoreDrillPacket` now centralizes recovery preflight commands, target storage/env paths, the `backup_restore_drill_result` closeout key, the expected `backup-restore-drill.txt` archive path, and the two Launch Mainline receipt operations (`record_recovery_drill`, `record_backup_verification`); `--backup-restore-packet-file` or `RSL_REHEARSAL_BACKUP_RESTORE_PACKET_FILE` can write it as a standalone operator packet so backup/restore rehearsal no longer depends on manually combining recovery output, runbook rows, and closeout guidance. `stagingCloseoutReloadPacket` now turns the final closeout reload handoff into a machine-readable packet: draft source, real filled-closeout input path, closeout template path, reload command, missing closeout keys, source statuses, operator steps, and full-test-window next action; `--closeout-reload-packet-file` or `RSL_REHEARSAL_CLOSEOUT_RELOAD_PACKET_FILE` can write that packet as a standalone archive artifact. `stagingReadinessReviewPacket` now summarizes the post-reload decision chain for launch duty: full-test-window readiness, production sign-off readiness, launch-day watch readiness, stabilization handoff readiness, current gate blockers, closeout reload command, and full-test command; `--readiness-review-packet-file` or `RSL_REHEARSAL_READINESS_REVIEW_PACKET_FILE` can write it as a standalone operator review artifact. `stagingProductionSignoffPacket` now centralizes the production sign-off decision, missing sign-off keys, receipt-visibility gaps, closeout reload command, guarded full-test command, sign-off archive step, and launch-day watch entry; `--production-signoff-packet-file` or `RSL_REHEARSAL_PRODUCTION_SIGNOFF_PACKET_FILE` can write it as a standalone operator packet so launch duty no longer has to combine readiness review, run-record index, and closeout input by hand. It also emits a profile-driven `filledCloseoutInputDraft` that pre-populates pending closeout fields with source steps, artifact paths, and receipt-operation hints while keeping every value `null` and `exampleOnly: true`, so it cannot accidentally clear closeout readiness before real redacted evidence is attached; `--filled-closeout-draft-file` or `RSL_REHEARSAL_FILLED_CLOSEOUT_DRAFT_FILE` can now write that draft as a standalone operator artifact to copy into the real filled closeout input. When that draft is copied into a real input, the loaded `backfillReview` reports `draft_promoted` or `draft_needs_values`, filled/missing counts, placeholder keys, and the artifact paths to fix without exposing values; the same summary is mirrored into the staging execution runbook, its reload step, and the final rehearsal packet. The Markdown handoff, standalone run-record JSON, standalone artifact-manifest JSON, standalone backup/restore drill packet JSON, standalone closeout-reload packet JSON, standalone readiness-review packet JSON, standalone production-signoff packet JSON, standalone filled-closeout draft JSON, and JSON closeout template carry the profile path, provided keys, launch plan, operator preflight, execution summary, run record index, artifact manifest, backup/restore drill packet, closeout reload packet, readiness review packet, production sign-off packet, backfill manifest, closeout draft, and loaded closeout review, and `docs/staging-rehearsal-profile.example.json` gives launch duty a secret-free starting point for the first real staging rehearsal.
- Latest launch-duty archive slice: `stagingLaunchDutyArchiveIndex` now gathers the run-record index, artifact manifest, backup/restore drill packet, closeout reload packet, readiness review packet, and production sign-off packet into one redacted archive index with packet statuses, archive paths, the dry-run command, closeout reload command, and guarded full-test-window command. `--launch-duty-archive-index-file` or `RSL_REHEARSAL_LAUNCH_DUTY_ARCHIVE_INDEX_FILE` can write that standalone JSON artifact, `stagingArtifactManifest` and the environment binding now list it with the rest of the launch-duty archive set, and `docs/staging-rehearsal-profile.example.json` includes the backup/restore and sign-off packet paths so the first real staging rehearsal can produce a complete handoff bundle without manual file discovery.
- Latest Developer Ops staging archive bridge slice: Developer Ops initial launch readiness and `format=staging-launch-duty-archive` now expose the same backup/restore drill packet and production sign-off packet paths that `staging:rehearsal` can write. The profile-driven dry-run command also includes `--backup-restore-packet-file` and `--production-signoff-packet-file`, so Launch Smoke / Launch Review / Developer Ops reviewers can pull the complete staging archive bundle from the API export instead of manually remembering the two newer packet filenames.
- Latest staging archive completeness slice: the Developer Ops staging launch-duty archive bridge now emits a `packetCompleteness` block with expected/listed/missing packet counts, present and missing keys, and the next archive action. Developer Ops summary text, initial launch readiness text, staging archive text, zip/checksum offline text, and the Developer Ops page render the same completeness status, so reviewers can see whether all six launch-duty packet paths are represented before closeout reload without manually cross-checking the packet list.
- Latest launch-duty action order propagation slice: the same staging archive packet completeness now rides inside the shared `launchDutyActionOrder`, including the staging-archive step. Launch Review summary downloads, Launch Smoke summary downloads, Launch Mainline handoff route maps, and Launch Mainline post-launch handoff indexes now print the completeness count and next archive action alongside the staging archive / readiness / follow-up sequence, so first-wave reviewers do not have to open Developer Ops first just to confirm whether the six packet paths are represented.
- Latest launch-duty next-operations slice: the shared `launchDutyActionOrder` now also carries the staging archive next operations after packet completeness: closeout reload command, production sign-off packet path, guarded full-test-window command, and the next readiness step. Launch Review, Launch Smoke, and Launch Mainline text handoffs can now show the transition from complete staging archive paths to closeout reload and full-test-window review without requiring operators to cross-open Developer Ops.
- Latest launch runway slice: the same shared launch-duty action order now prints the final launch runway sequence, `closeout_reload -> full_test_window -> production_signoff -> launch_day_watch`, with the current gate and launch-day-watch entry marker. This keeps the last operational path toward initial launch visible from Launch Review, Launch Smoke, and Launch Mainline instead of hiding it inside the staging rehearsal script.
- Latest Developer Ops runway page slice: the Developer Ops launch-duty action-order card now renders the same final launch runway, current gate, and launch-day-watch entry marker on the page itself. Operators can see the last four launch steps from the first-screen Ops summary before downloading handoff text, which keeps the fastest path to initial launch visible during staging closeout and sign-off.
- Latest Developer Ops runway quick-actions slice: the same Ops page runway card now exposes safe copy actions for the closeout reload command, guarded full-test-window command, and production sign-off packet path. The buttons only copy or mirror text into the output panel; they do not execute commands, so launch duty can move faster without adding risky browser-side execution.
- Latest Launch Mainline runway handoff slice: the Launch Mainline page now mirrors the staging archive launch runway from the existing Developer Ops action order, including safe copy actions for closeout reload, the guarded full-test-window command, and the production sign-off packet path. This keeps the launch-day operator path visible from the primary mainline workspace instead of forcing an extra page hop.
- Latest Launch Mainline API runway slice: the Launch Mainline backend summary now exposes a first-class `launchRunway` payload derived from the Developer Ops launch-duty action order, including the current gate, sequence, next action, and safe copy values for closeout reload, full-test-window, and production sign-off packet handoff. The page now prefers this API payload before falling back to the embedded action order.
- Latest runway operator checklist slice: `mainlineSummary.launchRunway` now also carries an operator checklist for the real staging handoff path: profile-driven dry run, filled closeout input, closeout reload, guarded full-test-window, production sign-off packet, and launch-day watch entry. The Launch Mainline page renders this checklist from API data so launch duty does not need to reconstruct those inputs from long-form docs.
- Latest runway checklist state slice: each Launch Mainline runway checklist item now carries machine-readable `status`, `completion`, `evidenceOperation`, `evidenceStatus`, and optional evidence timestamp metadata, while summary/download text and the Launch Mainline page render the same state. This turns the final runway from a static handoff list into an operator-facing first-launch state checklist.
- Latest runway checklist aggregate slice: `mainlineSummary.launchRunway.checklistState` now summarizes total/required/ready/queued checklist counts, recorded versus pending evidence counts, and the next pending evidence operation. Summary downloads and the Launch Mainline page render that aggregate, so launch duty can see the remaining first-launch evidence burden without scanning every checklist row.
- Latest runway evidence-operation slice: `checklistState` now also groups checklist rows by unique Launch Mainline evidence operation, including recorded/pending operation counts, per-operation item counts, statuses, and recorded timestamps. Real `POST /api/developer/launch-mainline/action` evidence receipts now flow into that grouping, so recording a first-wave ops sweep marks the shared runway operation as recorded while the remaining rehearsal and launch-day readiness operations stay pending.
- Latest runway next-evidence action slice: `checklistState.nextEvidenceAction` now maps the next pending runway evidence operation to the exact Launch Mainline action key, operator label, recommended download key, download format, and service-generated download href. Summary downloads and the Launch Mainline page render the same action/download hint, so the launch operator can move from the runway state directly to the next evidence record and handoff package without manually matching operation names.
- Latest runway quick-action slice: the Launch Mainline page now renders `checklistState.nextEvidenceAction` as runway-local quick controls: `Record Runway Evidence` posts the next evidence action and reloads Launch Mainline, while `Download Runway Handoff` pulls the matching handoff download through the service-provided href. A sequential runway test now verifies that the next action advances from rehearsal, to launch-day readiness, to post-launch sweep, then clears when all runway evidence is recorded.
- Latest runway follow-up slice: after a runway evidence quick action runs, the Launch Mainline `Last Mainline Action` panel now renders a runway-specific follow-up card with the recorded evidence key, pending evidence counts, next runway action, matching download format, and the same next-action controls. This keeps the operator on the first screen after each evidence receipt instead of requiring them to inspect JSON output or manually re-read the runway checklist.
- Latest runway hero-status slice: `mainlineSummary.launchRunway.heroStatus` now lifts runway evidence readiness into the Launch Mainline top controls. While evidence is pending, the hero controls expose `Record Next Runway Evidence` plus the matching handoff download; once all runway evidence is recorded, they switch to `Enter Launch-Day Watch` and `Download Launch-Day Watch Handoff`. The page also renders a top-level runway status pill, and Launch Mainline action receipts preserve setup-type hero controls so bootstrap/first-batch receipts keep the same top-level follow-up chain.
- Latest launch-day watch panel slice: Launch Mainline now exposes a first-class `mainlineSummary.launchDayWatchPanel` payload and a matching first-screen `Launch-Day Watch` card on `/developer/launch-mainline`. The panel shows whether launch-day watch is still blocked by runway evidence or ready after production sign-off, keeps the watch-entry marker, first-wave checkpoint order, primary Ops workspace, launch-day-watch handoff, operations handoff, and the remaining runway-evidence action/download on the same screen, and Launch Mainline action receipts preserve that panel so the operator sees the updated watch state immediately after recording runway evidence.
- Latest launch rehearsal extensibility slice: `launchRehearsalBundle.extensionPoints` now names the safe incremental entry points for future launch features: add output files through `buildStagingEnvironmentBinding`, execution steps through `buildStagingExecutionRunbook`, closeout evidence keys through `buildStagingAcceptanceCloseout`, and readiness gates through `buildStagingReadinessTransition`. The bundle also records the affected mirrored outputs and the required workflow: add the builder field, mirror it into the bundle, add rehearsal assertions, add handoff rendering, add closeout-template assertions, then run the staging rehearsal targeted test and `launch:route-map-gate`. This makes later additions easier because new features have a defined owner, output mirror, and test checkpoint instead of becoming one-off launch-day script edits.
- Latest launch receipt visibility slice: `POST /api/developer/launch-mainline/action` receipts for first-wave ops sweep now expose a dedicated `visibility` block, matching handoff text, a `receipt_visibility` section in the Launch Mainline last-action payload, matching `receiptVisibility` data in Developer Ops latest launch receipts, and text visibility lines in Developer Ops summary, launch receipt next-follow-up, handoff-index, Launch Review summary, Launch Smoke Kit summary, Launch Mainline post-launch handoff index downloads, and the direct `format=handoff-download-routes` Launch Mainline route map. The same visibility block now also carries a redacted staging result backfill checklist with the required route-map, backup/restore, live-write smoke, launch smoke handoff, Launch Mainline evidence receipt, and receipt-visibility review result keys, plus the Launch Mainline / Developer Ops destinations and Launch Review / Launch Smoke visibility summary downloads. These point operators straight to the Developer Ops summary, launch receipt next follow-up, Launch Mainline post-launch sweep handoff, Launch Mainline post-launch handoff index, handoff download routes, Launch Review / Launch Smoke receipt-visibility summaries, and staging result backfill targets from the main first-wave duty screens, which shortens the remaining manual cross-check between Launch Mainline, Launch Review, Launch Smoke, and Developer Ops after a recorded evidence step.
- Latest launch route-map gate slice: `npm run launch:route-map-gate` now bundles the reusable targeted gate for Launch Mainline action visibility, the two launch-critical Developer Ops / Launch Mainline `license-flow` cases, low-frequency launch download surfaces across Release Package, First Wave Recommendations, Developer Integration Package, Developer Cards, and Admin Ops export, Launch Smoke script continuity, Staging Rehearsal continuity, `src/services.js` syntax, and `git diff --check`. `npm run launch:route-map-gate -- --dry-run --json` prints the exact command plan without running it, which turns the previously manual Launch Smoke / Launch Review / Developer Ops route-map and download-surface review into a repeatable pre-staging command.

Estimated initial pilot-launch readiness: 93%-95%.

This estimate means the core flow is mostly ready for a controlled first launch, but still needs staging rehearsal, backup/restore rehearsal, and real first-wave operating data before being treated as production-stable.

## Immediate Next Plan

Work should continue in short backend/API-first slices. Each slice should end with a commit, targeted verification, and a note about the next slice. For launch-facing additions, use the `launchRehearsalBundle.extensionPoints` workflow first so new fields, steps, closeout keys, or readiness gates stay easy to review.

1. Finish a final spot audit for any non-critical or older launch-adjacent download surfaces outside the now-hardened Release, Launch Workflow, Launch Review, Launch Smoke, Launch Mainline, Developer Projects, Developer License, Developer Ops first-wave chain, and First Wave Recommendations chain.
   The main launch-critical route/download handoffs, Release Package/Launch Workflow/Launch Review/Launch Smoke/Launch Mainline text handoffs, Launch Workflow local zip/summary/checklist downloads, Launch Workflow integration env/host-config/host-skeleton downloads, Launch Workflow handoff zip/checksum downloads and checklist/action-plan handoff zip entries, Launch Review scoped Workflow summary/checklist downloads, Launch Smoke action-plan scoped Smoke Kit downloads, Launch Mainline Developer Ops route-review primary/remaining downloads, Launch Mainline direct handoff route-map downloads, Developer Ops route-review snapshot/section downloads and offline zip/checksum entries, Developer Ops Launch Mainline route-map export files, First Launch Handoff text, Post-Launch Lifecycle text, receipt follow-up queue downloads/CSV export and Developer Ops follow-up overview text, first-round ops recommendation downloads, Developer Ops Launch Mainline handoff summary text, shared Initial Launch Ops Gate blocker text, Developer Ops readiness blocker/action text, Developer Ops operator action manifest text, and Developer Ops text handoffs now round-trip through service-provided `href` values; remaining work is mostly residual cleanup and regression coverage.

2. Tighten initial launch ops readiness after real first-launch actions.
   Verify that launch bootstrap, first batch setup, inventory refill, first-wave ops sweep, and closeout/stabilization actions all refresh the same readiness chain. First-Wave Recommendations, Launch Review, and Launch Smoke Kit now protect that chain from cross-channel launch receipt drift; post-launch lifecycle, staging result backfill, and stabilization confirmation hrefs round-trip into Ops, Launch Mainline traceability, the handoff index, and route-map exports, including dedicated Ops handoff-index, Launch Mainline JSON/summary/post-launch index/direct route-map, post-launch lifecycle primary-download, checksums, and zip routes; remaining work is grouped verification and a few low-frequency action/export edges.

3. Continue hardening launch receipt follow-up recovery.
   `launchReceiptNextFollowUp`, `recommendedAction`, `recommendedDownload`, Developer Ops launch receipt follow-up CSV, Release Package/Launch Workflow/Launch Review/Launch Smoke/Launch Mainline summary and route-focus text, First Launch Handoff text, Post-Launch Lifecycle text, readiness traceability, shared Initial Launch Ops Gate blocker text, Developer Ops follow-up overview text, Developer Ops Launch Mainline handoff summary text, Developer Ops readiness blocker/action text, Developer Ops operator action manifest text, Developer Ops summary/readiness/stabilization text, Launch Mainline post-launch traceability JSON/lifecycle primary-download text, post-launch handoff summary/index text, Launch Mainline action receipt handoff text, and Launch Mainline zip/checksum/direct handoff download routes now carry the same download href chain; remaining work is mostly grouped regression around the already-connected path.

4. Keep the full pre-staging gate green while preparing staging.
   Broader targeted batches now pass across release package, launch workflow, launch mainline actions, first-wave recommendations, Developer Ops export, launch pages, the `launch:smoke` CLI preflight, account/card/session authorization, production gate/security checks, deployment assets, and runtime-state checks. The 2026-04-28 full `license-flow` gate passed with 80/80 tests plus static checks, and `launch:route-map-gate` now packages the latest route-map / visibility targeted check for quick repeat runs; the next verification step is staging rehearsal with real-like secrets, storage, HTTPS, and `launch:smoke --base-url`.

5. Prepare staging launch rehearsal.
   Use a real server-like environment, non-default secrets, HTTPS, persistent storage, backup/restore rehearsal, and one test software-author project. Start from `docs/staging-rehearsal-profile.example.json`, keep passwords and bearer tokens in environment variables, then run `staging:rehearsal --profile-file <profile.json>` to generate the handoff and closeout template. The command-line `launch:smoke` preflight can now run locally against an ephemeral in-memory app; `staging:rehearsal` combines the remote smoke command gate, recovery rehearsal command gate, environment readiness, the nine-step operator checklist, operator execution plan, readiness gaps, optional closeout input reload, result backfill summary, staging acceptance closeout, artifact/receipt ledger, guarded full-test-window entry, production sign-off conditions, Launch Mainline evidence readiness, evidence action plan, copyable evidence requests, optional local handoff file, and optional closeout template JSON without writes. Its closeout input now requires the five final receipt visibility lanes (`launchMainline`, `launchReview`, `launchSmoke`, `developerOps`, `launchOpsOverviewStatus`) to be visible before production sign-off can clear, and the generated closeout template already contains those editable lanes plus the production sign-off condition skeleton; and `launch:smoke:staging` runs the remote staging path with an HTTPS requirement plus explicit `--allow-live-writes`. Its `handoff` output now carries the scoped Launch Review route, Developer Ops route, Launch Mainline evidence route, first-wave downloads, Launch Review / Launch Smoke receipt-visibility summary downloads, Ops handoff index, and a seven-step operator checklist.

## Feature Extension Policy

New launch-facing functionality should be easy to add when it fits one of the existing extension categories:

1. Output files: add the source path and status in `buildStagingEnvironmentBinding`, then mirror it into the bundle and final packet.
2. Operator steps: add the command or step in `buildStagingExecutionRunbook`, then mirror it into `launchRehearsalBundle.executionOrder` and `finalRehearsalPacket.orderedSteps`.
3. Closeout evidence: add the acceptance key in `buildStagingAcceptanceCloseout`, then wire the backfill target and bundle closeout key.
4. Readiness gates: add the gate in `buildStagingReadinessTransition`, then mirror the gate into bundle readiness and operator readiness gaps.

The expected workflow for each incremental launch feature is: add the builder field, mirror it in `launchRehearsalBundle`, add rehearsal assertions, add Markdown handoff rendering, add closeout-template assertions, run the targeted staging rehearsal test, then run `launch:route-map-gate`. Larger product or payment features may still need separate design, but small backend/API launch additions now have a clean path.

## Overall Project Plan

### Phase 1: Core Authorization Platform

Goal: provide the backend service that software authors rely on for runtime authorization.

Current state: mostly complete.

Main capabilities:

- Admin login and product management.
- Developer accounts and project ownership.
- Developer member/project-scope permissions.
- License policies and grants.
- Card login, recharge, account login, entitlements, sessions, devices, audit logs.
- Runtime startup/bootstrap/version/notice checks.
- Token key generation and rotation support.

Remaining work:

- Final security review of default secrets, deployment envs, and token-key rotation procedure.
- Real-world abuse/error-path review after first pilot users.

### Phase 2: SDK and Software-Author Integration

Goal: let a software author integrate the SDK into their own protected application.

Current state: usable for pilot integration.

Main capabilities:

- Windows C/C++ SDK package and demo assets.
- Integration package exports.
- Host config/env snippets.
- CMake and Visual Studio consumer materials.
- Developer integration workspace.

Remaining work:

- One or two real software-author integration rehearsals.
- Confirm the SDK packaging instructions match the actual build artifacts on a clean machine.
- Decide which examples are official for first launch and which are internal only.

### Phase 3: Software-Author Delivery Chain

Goal: give software authors a guided path from project setup to release handoff.

Current state: strong and close to pilot-ready.

Main capabilities:

- Release package.
- Launch workflow.
- Launch review.
- Launch smoke.
- Launch mainline.
- Route focus and preserved handoff context.
- Recommended workspace actions and downloads.
- Checksums and zip exports.

Remaining work:

- Continue reducing any fallback logic where frontend or route recovery guesses source/format.
- Keep documentation aligned with supported API formats and generated handoff assets.
- Keep the full `license-flow` gate and grouped launch-readiness checks green before staging launch.

### Phase 4: First Launch Operations

Goal: make the first customer-facing wave operable instead of only deployable.

Current state: late-stage hardening. The main chain is largely connected; remaining Phase 4 work is mostly one realistic first-wave rehearsal, support noise review, and confirmation that real first-launch evidence moves readiness into the expected non-blocking state.

Main capabilities:

- Launch bootstrap.
- First batch setup.
- Inventory refill.
- First-launch handoff.
- Initial launch ops readiness.
- Launch receipt follow-ups.
- First-wave ops sweep.
- Closeout and stabilization handoffs.

Remaining work:

- Rehearse one complete first-launch path using realistic starter policy, starter cards, starter account, and one test client.
- Confirm the first-launch readiness gate moves from `HOLD` to the expected status after the right evidence is recorded.
- Confirm post-launch follow-up queues are useful for support and not too noisy.

### Phase 5: Production Readiness and Deployment

Goal: safely run the service outside local development.

Current state: active focus. Strong documentation, server-side gates, staging rehearsal scripts, closeout templates, and sign-off gates exist; the main remaining work is real environment setup, backup/restore rehearsal, one complete staging run, and the full repository test window before cutover sign-off.

Main capabilities:

- Production launch checklist.
- Production operations runbook.
- Observability guide.
- Incident response playbook.
- Backup/restore scripts and docs.
- Linux and Windows deployment guides.
- Cutover, recovery drill, operations, post-launch, closeout, and stabilization handoffs.

Remaining work:

- Choose first production OS and storage profile.
- Configure real HTTPS entrypoint.
- Replace default admin password and server token secret.
- Decide whether initial pilot uses SQLite or PostgreSQL.
- Run backup and restore drill.
- Run full launch rehearsal on staging.

### Phase 6: Commercial Operations

Goal: support real sales, support, renewals, and first customers.

Current state: operational foundation exists, but commercial packaging still needs decisions.

Main capabilities already available:

- Card batches and card inventory.
- Account and entitlement operations.
- Scoped developer audit logs.
- Developer operations export.
- Reseller and hierarchy docs exist.

Remaining work:

- Decide first sales model: card-only, account-only, or mixed.
- Decide first batch size and naming conventions.
- Prepare support scripts for common user issues.
- Prepare refund/replacement/abuse handling policy.
- Add payment/order automation only if needed before the first paid launch.

## Development Progress

Current high-level progress:

- Core backend/API authorization: 90%-95%.
- Developer delivery and handoff chain: 92%-94%.
- Launch Mainline and first-launch operations: 90%-93%.
- SDK/integration packaging: 80%-85%.
- Production deployment readiness: 86%-91%.
- Commercial operations readiness: 65%-75%.

Overall initial pilot-launch readiness: 93%-95%.

This is high enough to keep moving toward a controlled launch, but not high enough to skip staging, the full repository test window, backup/restore rehearsal, or first-wave support preparation.

## Work Remaining Before Initial Launch

Minimum remaining work before a controlled pilot:

1. Finish residual route/download spot checks outside the launch-critical first-wave handoff chain and any less-used Ops export variants.
2. Keep the full `license-flow` pre-staging gate and grouped launch-readiness checks green after any new backend/API changes.
3. Run the full repository test suite once before staging rehearsal sign-off.
4. Prepare staging environment with non-default secrets and public HTTPS.
5. Run one complete staging rehearsal:
   release package -> launch workflow -> bootstrap -> first batch setup -> launch review -> `staging:rehearsal --handoff-file ... --closeout-file ...` -> `launch:route-map-gate` -> `launch:smoke:staging --base-url https://... --allow-live-writes` -> launch smoke workspace -> launch mainline -> developer ops -> post-launch sweep -> backfill closeout input with full-test status, production sign-off decision, and all five visible receipt-visibility lanes.
6. Use the `staging:rehearsal` recovery commands to verify backup/restore and recovery drill on a separate restore target.
7. Create first pilot software-author project and first batch of test cards/accounts.
8. Prepare support and escalation notes for first users.

## Testing Rhythm

Current rhythm:

- Run focused tests on every small backend/API slice.
- Latest grouped targeted verification passed 57 tests across launch readiness, first-wave operations, account/card/session authorization, production gate/security, deployment assets, runtime-state, launch pages, and `launch:smoke`.
- Latest full pre-staging gate passed on 2026-04-28: `node --test --test-concurrency=1 --test-isolation=none test\license-flow.test.js` reported 80/80 passing tests, then `node --check src\services.js` and `git diff --check` exited cleanly.
- Latest staging smoke command check passed on 2026-04-28: `test\launch-smoke-script.test.js` covers the `--require-https` guard, the dedicated `launch:smoke:staging` script, local ephemeral smoke, remote live-write smoke against a test API, the post-smoke handoff links into Launch Review, Developer Ops, and Launch Mainline evidence, plus Launch Review / Launch Smoke summary downloads used to verify receipt visibility before handoff.
- Latest staging command preflight check passed on 2026-04-28: `test\staging-preflight-script.test.js` covers the no-write HTTPS/product/credential gate and verifies the emitted next command does not print smoke passwords.
- Latest recovery command preflight check passed on 2026-04-28: `test\recovery-preflight-script.test.js` covers unsupported target rejection, Linux PostgreSQL preview command generation, Windows SQLite command generation, and the no-write recovery-drill boundary.
- Latest staging rehearsal runner check passed on 2026-04-29: `test\staging-rehearsal-script.test.js` covers the combined no-write smoke/recovery gates, live-write blocking on preflight failure, the redacted launch smoke command, the `launch:route-map-gate` targeted pre-staging command and dry-run command, non-secret `--profile-file` loading with CLI override, profile secret-field refusal, profile-driven launch plan generation, profile-driven operator preflight generation, staging rehearsal execution summary generation, staging rehearsal run record index generation and standalone `--run-record-file` JSON output, profile-driven backfill manifest generation, profile-driven filled closeout draft generation and standalone `--filled-closeout-draft-file` JSON output, loaded closeout input backfill review, draft-promotion placeholder reporting, profile source rendering in handoff and closeout template, staging environment readiness for HTTPS, non-default secrets, persistent storage, backup/restore drill, route-map gate execution, and live-write approval, the nine-step staging operator checklist from readiness review through receipt-visibility verification, the machine-readable operator execution plan from generated files through production sign-off review, readiness summary and readiness gaps, closeout input reload that narrows fulfilled gaps, refusal of generated example-only closeout input files, the top-level Full Test Window Readiness section, the top-level Production Sign-Off Readiness section, the top-level Launch Day Watch Plan section, the top-level Stabilization Handoff Plan section, the top-level Staging Run Record Template section, the top-level Staging Rehearsal Run Record Index section, the top-level Staging Environment Binding section, the top-level Staging Execution Runbook section, the top-level Staging Readiness Transition section, the top-level Launch Rehearsal Bundle section, the top-level Filled Closeout Input Example section, the top-level Filled Closeout Input Draft section, the top-level Loaded Closeout Input Review section, and the top-level Final Rehearsal Packet section, safe staging dry-run command generation without raw smoke passwords, full-test-window, production sign-off, launch-day watch, stabilization handoff, staging run record, staging run record index, staging environment binding, staging execution runbook, staging readiness transition, launch rehearsal bundle, launch rehearsal extension points, filled closeout input example, filled closeout input draft, loaded closeout input review, closeout review mirroring into the runbook reload step and final packet, staging rehearsal execution summary and run record index in handoff and closeout template, and final packet readiness in the JSON closeout template, production sign-off blocker clearing only after sign-off evidence and all five receipt-visibility lanes are visible, explicit blocking when one receipt-visibility lane is missing, template-style `value: "visible"` receipt visibility backfill, Markdown handoff rendering for missing receipt-visibility keys, generated closeout-template skeletons for receipt visibility and production sign-off, the Closeout Backfill Guide in both Markdown and JSON outputs, the redacted result backfill summary, staging acceptance closeout, artifact/receipt ledger, guarded full-test-window entry, production sign-off conditions, Launch Mainline URL, Launch Review / Launch Smoke receipt-visibility summary downloads, evidence readiness with bearer-token presence checks, evidence order, machine-readable evidence action payloads, copyable evidence PowerShell requests, optional redacted Markdown handoff file generation, optional redacted closeout template JSON generation, optional redacted run-record-index JSON generation, optional redacted filled-closeout draft JSON generation, real staging environment binding generation, real staging execution runbook generation, readiness transition status changes from blocked to full-test-window-ready to launch-day-watch-ready, launch rehearsal bundle generation, and handoff rendering for the incremental extension workflow.
- Latest launch route-map targeted gate passed on 2026-04-29: `npm.cmd run launch:route-map-gate` ran Launch Mainline action visibility, targeted Developer Ops export plus Launch Mainline first-wave action, low-frequency launch download surface tests, Launch Smoke script continuity, Staging Rehearsal continuity, `node --check src\services.js`, and `git diff --check`. This gate reported 25/25 targeted tests passing and now covers the staging result backfill checklist, staging acceptance closeout, artifact/receipt ledger, guarded full-test-window entry, production sign-off conditions, the five-lane receipt visibility production sign-off gate, staging environment binding, staging execution runbook, staging readiness transition, launch rehearsal bundle, profile-driven launch plan generation, profile-driven operator preflight generation, staging rehearsal execution summary generation, staging rehearsal run record index generation and standalone run-record JSON output, profile-driven backfill manifest generation, profile-driven filled closeout draft generation and standalone draft JSON output, loaded closeout input backfill review, draft-promotion placeholder reporting, closeout review mirroring into the runbook reload step and final packet, and Markdown handoff rendering for missing receipt-visibility keys carried through Launch Mainline action visibility, Developer Ops receipt text, and the staging rehearsal handoff; it is intentionally not the full repository suite.
- The next major verification step is staging rehearsal against a real-like environment, followed by the full repository test window before sign-off.
- Run full test suite when either:
  - another 2-4 launch-mainline/backend API commits land, or
  - before the first staging deployment rehearsal, whichever comes first.

Recommended full verification gate before pilot:

```powershell
node --test --test-concurrency=1 --test-isolation=none test\license-flow.test.js
node --check src\services.js
git diff --check
```

Latest run: 2026-04-28, passed 80/80 tests plus clean static and diff checks.

If the full suite is too slow or noisy, split it into grouped runs but do not skip:

- release package export
- launch workflow export
- launch review
- launch smoke
- launch mainline actions
- developer ops export
- account/card/session authorization flows
- deployment/security/static checks

## Operating Definition of "Ready to Launch"

The project can be treated as initially launchable when all of these are true:

- A software author can create/configure a project.
- The software author can integrate the SDK using the exported package.
- The software author can produce a protected client build.
- The backend can authorize first users by card or account.
- First cards/accounts can be created, delivered, revoked, and audited.
- Launch Mainline reaches an explainable non-blocking state for the selected pilot lane.
- Backup/restore has been rehearsed.
- Public HTTPS and non-default secrets are configured.
- A support operator knows where to inspect accounts, sessions, devices, cards, and audit logs.
- The first-wave post-launch review has a clear owner and handoff path.

## Current Risk Register

### High

- Full repository test suite has been intentionally deferred during rapid backend/API iteration, although the main `license-flow` pre-staging gate is now green.
- Real deployment rehearsal has not replaced local verification yet.
- Commercial operations decisions may still affect first-launch packaging.

### Medium

- Some older or non-critical route/download key mappings may still need spot audit outside the launch-critical paths recently tested.
- SDK clean-machine integration should be rehearsed before inviting a real software author.
- Payment/order automation may be unnecessary for pilot, but the manual process must be explicit if payment is accepted.

### Low

- Documentation is broad and useful, but needs occasional index updates when new handoff formats are added.
- README is long; new operators should start with this roadmap plus the launch checklist, not the whole README.

## Recommended Reading Order

For launch planning:

- [production-launch-checklist.md](production-launch-checklist.md)
- [developer-launch-mainline.md](developer-launch-mainline.md)
- [launch-mainline-rehearsal.md](launch-mainline-rehearsal.md)
- [production-operations-runbook.md](production-operations-runbook.md)

For software-author handoff:

- [developer-integration.md](developer-integration.md)
- [developer-release.md](developer-release.md)
- [developer-launch-workflow.md](developer-launch-workflow.md)
- [developer-ops.md](developer-ops.md)

For production operations:

- [observability-guide.md](observability-guide.md)
- [incident-response-playbook.md](incident-response-playbook.md)
- [daily-operations-checklist.md](daily-operations-checklist.md)
- [shift-handover-template.md](shift-handover-template.md)
