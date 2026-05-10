#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const OPTION_FLAGS = {
  "--input-file": "inputFile",
  "--output-file": "outputFile",
  "--key": "key",
  "--value-json": "valueJson",
  "--artifact-path": "artifactPath",
  "--receipt-id": "receiptIds",
  "--actions-file": "actionsFile"
};

const DEFAULT_ARTIFACT_ROOT = "artifacts/staging/<productCode>/<channel>";

function requireArgValue(name, value, inlineValue) {
  const missingValue = value === undefined
    || value === null
    || String(value).trim() === ""
    || (inlineValue === undefined && String(value).startsWith("--"));
  if (missingValue) {
    throw new Error(`${name} requires a value.`);
  }
  return String(value).trim();
}

function parseArgs(argv) {
  const options = {
    json: false,
    receiptIds: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const [name, inlineValue] = arg.split("=", 2);
    const key = OPTION_FLAGS[name];
    if (!key) {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = requireArgValue(name, inlineValue ?? argv[index + 1], inlineValue);
    if (key === "receiptIds") {
      options.receiptIds.push(value);
    } else {
      options[key] = value;
    }
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  for (const required of ["inputFile", "key", "valueJson"]) {
    if (!options[required]) {
      throw new Error(`--${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} requires a value.`);
    }
  }
  return options;
}

function commandValue(value) {
  const text = String(value || "");
  if (/[\s"`]/.test(text)) {
    return `"${text.replace(/"/g, "`\"")}"`;
  }
  return text;
}

function statusCommand(outputFile, actionsFile = null) {
  const actionsArg = actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
  return `npm.cmd run staging:readiness:status -- --input-file ${commandValue(outputFile)}${actionsArg}`;
}

function artifactRootFromPath(value) {
  const parts = path.resolve(value).replaceAll("\\", "/").split("/").filter(Boolean);
  for (let index = 0; index < parts.length - 3; index += 1) {
    if (parts[index] === "artifacts" && parts[index + 1] === "staging" && parts[index + 2] && parts[index + 3]) {
      return `artifacts/staging/${parts[index + 2]}/${parts[index + 3]}`;
    }
  }
  return DEFAULT_ARTIFACT_ROOT;
}

function signoffBackfillCommand({ outputFile, artifactRoot, actionsFile = null }) {
  const actionsArg = actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
  return [
    "npm.cmd run staging:signoff:backfill --",
    `--input-file ${commandValue(outputFile)}`,
    "--condition-key full_test_window_passed",
    "--value-json <redacted-json>",
    `--artifact-path ${path.posix.join(artifactRoot, "full-test-output.txt")}`,
    "--decision ready-for-production-signoff",
    actionsArg.trimStart()
  ].filter(Boolean).join(" ");
}

function receiptIdArgs(receiptOperations = []) {
  return receiptOperations
    .filter(Boolean)
    .map((operation) => ` --receipt-id <${operation}-receipt-id>`)
    .join("");
}

function buildNextBackfillCommand({ outputFile, target, actionsFile = null }) {
  if (!target?.key) {
    return null;
  }
  const artifactArg = target.artifactPath ? ` --artifact-path ${commandValue(target.artifactPath)}` : "";
  const actionsArg = actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
  return [
    "npm.cmd run staging:closeout:backfill --",
    `--input-file ${commandValue(outputFile)}`,
    `--key ${commandValue(target.key)}`,
    "--value-json <redacted-json>",
    artifactArg.trimStart(),
    receiptIdArgs(Array.isArray(target.receiptOperations) ? target.receiptOperations : []).trimStart(),
    actionsArg.trimStart()
  ].filter(Boolean).join(" ");
}

function buildOperatorNextCommands({
  outputFile,
  actionsFile,
  rehearsalCommand,
  readinessStatusCommand,
  nextBackfillCommand,
  nextBackfillArtifactPath
}) {
  const commands = [
    {
      key: "readiness_status",
      status: "current",
      command: readinessStatusCommand,
      artifactPath: actionsFile || null,
      nextAction: "Refresh the readiness action queue after this evidence backfill."
    }
  ];
  if (nextBackfillCommand) {
    commands.push({
      key: "next_closeout_backfill",
      status: "blocked_after_readiness_status",
      command: nextBackfillCommand,
      artifactPath: nextBackfillArtifactPath || null,
      nextAction: "Backfill the next pending closeout evidence item after the readiness action queue is refreshed."
    });
  }
  commands.push(
    {
      key: "rehearsal_reload",
      status: nextBackfillCommand ? "blocked_after_next_closeout_backfill" : "blocked_after_readiness_status",
      command: rehearsalCommand,
      artifactPath: outputFile,
      nextAction: "Reload rehearsal after status confirms the next gate or all closeout evidence is ready."
    }
  );
  return commands;
}

function buildEvidenceValue(options) {
  const parsed = JSON.parse(options.valueJson);
  const value = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? { ...parsed }
    : { value: parsed };
  if (options.artifactPath) {
    value.artifactPath = options.artifactPath;
  }
  if (options.receiptIds.length) {
    value.receiptIds = options.receiptIds;
  }
  return value;
}

function extractDecisionValue(value) {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["decision", "value"]) {
      if (typeof value[key] === "string" && value[key].trim()) {
        return value[key].trim();
      }
    }
  }
  return null;
}

function backfill(payload, options) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("closeout input must be a JSON object.");
  }
  const acceptanceFields = Array.isArray(payload.acceptanceFields) ? payload.acceptanceFields : [];
  const fieldIndex = acceptanceFields.findIndex((field) => field?.key === options.key);
  if (fieldIndex < 0) {
    throw new Error(`Unknown closeout key: ${options.key}`);
  }
  const value = buildEvidenceValue(options);
  const nextFields = acceptanceFields.map((field, index) => index === fieldIndex
    ? {
      ...field,
      status: "filled",
      value,
      artifactPath: options.artifactPath || field.artifactPath || null,
      receiptIds: options.receiptIds
    }
    : field);
  const decision = options.key === "operator_go_no_go" ? extractDecisionValue(value) : null;
  return {
    ...payload,
    decision: decision || payload.decision || null,
    acceptanceFields: nextFields
  };
}

function isFilled(field) {
  if (!field || field.value === null || field.value === undefined) {
    return false;
  }
  if (typeof field.value === "string") {
    return field.value.trim() !== "";
  }
  if (Array.isArray(field.value)) {
    return field.value.length > 0;
  }
  if (typeof field.value === "object") {
    return Object.keys(field.value).length > 0;
  }
  return true;
}

function buildEvidenceProgress({ fields, outputFile, actionsFile, readinessStatusCommand }) {
  const acceptanceFields = Array.isArray(fields) ? fields : [];
  const pendingFields = acceptanceFields.filter((field) => !isFilled(field));
  const currentTarget = pendingFields[0] || null;
  const receiptOperations = Array.isArray(currentTarget?.receiptOperations) ? currentTarget.receiptOperations : [];
  const nextBackfillCommand = buildNextBackfillCommand({
    outputFile,
    target: currentTarget ? { ...currentTarget, receiptOperations } : null,
    actionsFile
  });
  return {
    status: pendingFields.length === 0 ? "filled" : "awaiting_more_closeout_evidence",
    requiredCount: acceptanceFields.length,
    filledCount: acceptanceFields.length - pendingFields.length,
    pendingCount: pendingFields.length,
    currentTarget: currentTarget
      ? {
        key: currentTarget.key || null,
        status: currentTarget.status || "pending_operator_entry",
        artifactPath: currentTarget.artifactPath || null,
        sourceStep: currentTarget.sourceStep || null,
        receiptOperations
      }
      : null,
    pendingKeys: pendingFields.map((field) => field.key).filter(Boolean),
    nextBackfillCommand,
    statusCommand: readinessStatusCommand,
    nextAction: nextBackfillCommand
      ? "Run statusCommand, then run nextBackfillCommand with real redacted evidence."
      : "Run statusCommand to move to the full-test or sign-off action."
  };
}

function buildNextCloseoutEvidenceHandoff({
  backfilledKey,
  evidenceProgress,
  actionsFile,
  rehearsalCommand
}) {
  if (!evidenceProgress?.nextBackfillCommand || !evidenceProgress.currentTarget) {
    return null;
  }
  return {
    status: "ready_for_next_closeout_backfill",
    currentActionKey: "backfill_closeout_evidence",
    backfilledKey,
    progress: {
      requiredCount: evidenceProgress.requiredCount,
      filledCount: evidenceProgress.filledCount,
      pendingCount: evidenceProgress.pendingCount
    },
    statusCommand: evidenceProgress.statusCommand,
    nextBackfillCommand: evidenceProgress.nextBackfillCommand,
    nextBackfillTarget: {
      key: evidenceProgress.currentTarget.key,
      artifactPath: evidenceProgress.currentTarget.artifactPath,
      sourceStep: evidenceProgress.currentTarget.sourceStep,
      receiptOperations: evidenceProgress.currentTarget.receiptOperations
    },
    actionQueueFile: actionsFile || null,
    reloadCommand: rehearsalCommand,
    nextAction: "Run statusCommand, then nextBackfillCommand with real redacted evidence before the rehearsal reload."
  };
}

function buildFullTestReadyHandoff({
  outputFile,
  actionsFile,
  artifactRoot,
  closeoutDecision,
  readinessStatusCommand,
  rehearsalCommand,
  evidenceProgress
}) {
  if (closeoutDecision !== "ready-for-full-test-window" || evidenceProgress?.status !== "filled") {
    return null;
  }
  return {
    status: "ready_for_full_test_window",
    currentActionKey: "run_full_test_window",
    statusCommand: readinessStatusCommand,
    reloadCommand: rehearsalCommand,
    actionQueueFile: actionsFile || null,
    fullTestCommand: "npm.cmd test",
    fullTestResultArtifactPath: path.posix.join(artifactRoot, "full-test-output.txt"),
    productionSignoffPacketPath: path.posix.join(artifactRoot, "staging-production-signoff-packet.json"),
    signoffBackfillCommand: signoffBackfillCommand({ outputFile, artifactRoot, actionsFile }),
    nextAction: "Run statusCommand to confirm full-test readiness, run fullTestCommand, then use signoffBackfillCommand with the redacted full-test result."
  };
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "written") {
    console.log(`Closeout evidence backfilled: ${result.key}`);
    console.log(`Backfilled target: ${result.targetType}/${result.key}`);
    if (result.artifactPath) {
      console.log(`Backfilled artifact path: ${result.artifactPath}`);
    }
    if (Array.isArray(result.receiptIds) && result.receiptIds.length) {
      console.log(`Backfilled receipt IDs: ${result.receiptIds.join(", ")}`);
    }
    if (result.evidenceProgress) {
      const progress = result.evidenceProgress;
      console.log(`Closeout evidence progress: ${progress.filledCount}/${progress.requiredCount} filled, ${progress.pendingCount} pending`);
      if (progress.currentTarget) {
        console.log(`Next closeout target: ${progress.currentTarget.key}`);
        if (progress.currentTarget.artifactPath) {
          console.log(`Next target artifact: ${progress.currentTarget.artifactPath}`);
        }
        if (progress.currentTarget.sourceStep) {
          console.log(`Next target source step: ${progress.currentTarget.sourceStep}`);
        }
      }
      if (progress.nextBackfillCommand) {
        console.log(`Next backfill command: ${progress.nextBackfillCommand}`);
      }
    }
    if (result.nextCloseoutEvidenceHandoff) {
      const handoff = result.nextCloseoutEvidenceHandoff;
      console.log(`Next closeout handoff: ${handoff.status}`);
      console.log(`Next closeout status refresh: ${handoff.statusCommand}`);
      console.log(`Next closeout backfill: ${handoff.nextBackfillCommand}`);
      console.log(`Next closeout target: ${handoff.nextBackfillTarget.key} -> ${handoff.nextBackfillTarget.artifactPath || "-"}`);
      if (handoff.nextBackfillTarget.sourceStep) {
        console.log(`Next closeout source step: ${handoff.nextBackfillTarget.sourceStep}`);
      }
      console.log(`Next closeout progress: ${handoff.progress.filledCount}/${handoff.progress.requiredCount} filled, ${handoff.progress.pendingCount} pending`);
      console.log(`Next closeout rehearsal reload: ${handoff.reloadCommand}`);
      console.log(`Next closeout next action: ${handoff.nextAction}`);
    }
    if (result.fullTestReadyHandoff) {
      const handoff = result.fullTestReadyHandoff;
      console.log(`Full-test readiness: ${handoff.status}`);
      console.log(`Full-test status refresh: ${handoff.statusCommand}`);
      console.log(`Full-test rehearsal reload: ${handoff.reloadCommand}`);
      console.log(`Full-test command: ${handoff.fullTestCommand}`);
      console.log(`Full-test result artifact: ${handoff.fullTestResultArtifactPath}`);
      console.log(`Production signoff packet: ${handoff.productionSignoffPacketPath}`);
      console.log(`Full-test signoff backfill: ${handoff.signoffBackfillCommand}`);
      console.log(`Full-test next action: ${handoff.nextAction}`);
    }
    console.log(`Backfilled status refresh: ${result.statusCommand}`);
    const currentCommand = result.operatorNextCommands?.find((item) => item.status === "current");
    const nextBackfill = result.operatorNextCommands?.find((item) => item.key === "next_closeout_backfill");
    const rehearsalReload = result.operatorNextCommands?.find((item) => item.key === "rehearsal_reload");
    if (currentCommand) {
      console.log(`Current command: ${currentCommand.command}`);
      if (currentCommand.artifactPath) {
        console.log(`Action queue file: ${currentCommand.artifactPath}`);
      }
    } else {
      console.log(result.statusCommand);
    }
    if (nextBackfill) {
      console.log(`Next backfill after status: ${nextBackfill.command}`);
    }
    if (rehearsalReload) {
      console.log(`Rehearsal reload: ${rehearsalReload.command}`);
    } else {
      console.log(result.nextCommand);
    }
    console.log(`Next action: ${result.nextAction}`);
    return;
  }
  console.log(`Staging closeout backfill failed: ${result.error.message}`);
}

function main() {
  const json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    const inputFile = path.resolve(options.inputFile);
    const outputFile = path.resolve(options.outputFile || options.inputFile);
    const actionsFile = options.actionsFile ? path.resolve(options.actionsFile) : null;
    const payload = JSON.parse(readFileSync(inputFile, "utf8"));
    const nextPayload = backfill(payload, options);
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(nextPayload, null, 2)}\n`, "utf8");
    const fields = Array.isArray(nextPayload.acceptanceFields) ? nextPayload.acceptanceFields : [];
    const filledFieldCount = fields.filter(isFilled).length;
    const nextCommand = `npm.cmd run staging:rehearsal -- --closeout-input-file ${commandValue(outputFile)}`;
    const nextStatusCommand = statusCommand(outputFile, actionsFile);
    const artifactRoot = artifactRootFromPath(outputFile);
    const evidenceProgress = buildEvidenceProgress({
      fields,
      outputFile,
      actionsFile,
      readinessStatusCommand: nextStatusCommand
    });
    const nextCloseoutEvidenceHandoff = buildNextCloseoutEvidenceHandoff({
      backfilledKey: options.key,
      evidenceProgress,
      actionsFile,
      rehearsalCommand: nextCommand
    });
    const fullTestReadyHandoff = buildFullTestReadyHandoff({
      outputFile,
      actionsFile,
      artifactRoot,
      closeoutDecision: nextPayload.decision || null,
      readinessStatusCommand: nextStatusCommand,
      rehearsalCommand: nextCommand,
      evidenceProgress
    });
    writeResult({
      status: "written",
      mode: "staging-closeout-backfill",
      inputFile,
      outputFile,
      ...(actionsFile ? { actionsFile } : {}),
      targetType: "closeout_evidence",
      key: options.key,
      artifactPath: options.artifactPath || null,
      receiptIds: options.receiptIds,
      filledFieldCount,
      remainingPlaceholderCount: fields.length - filledFieldCount,
      evidenceProgress,
      ...(nextCloseoutEvidenceHandoff ? { nextCloseoutEvidenceHandoff } : {}),
      ...(fullTestReadyHandoff ? { fullTestReadyHandoff } : {}),
      nextCommand,
      statusCommand: nextStatusCommand,
      operatorNextCommands: buildOperatorNextCommands({
        outputFile,
        actionsFile,
        rehearsalCommand: nextCommand,
        readinessStatusCommand: nextStatusCommand,
        nextBackfillCommand: evidenceProgress.nextBackfillCommand,
        nextBackfillArtifactPath: evidenceProgress.currentTarget?.artifactPath
      }),
      nextAction: "Run statusCommand to pick the next closeout, full-test, or sign-off action."
    }, options.json);
  } catch (error) {
    writeResult({
      status: "fail",
      mode: "staging-closeout-backfill",
      error: {
        message: error.message
      }
    }, json);
    process.exitCode = 1;
  }
}

main();
