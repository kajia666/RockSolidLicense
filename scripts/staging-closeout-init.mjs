#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const OPTION_FLAGS = {
  "--draft-file": "draftFile",
  "--output-file": "outputFile",
  "--actions-file": "actionsFile"
};

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
    json: false
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
    const value = inlineValue ?? argv[index + 1];
    options[key] = requireArgValue(name, value, inlineValue);
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  if (!options.draftFile) {
    throw new Error("--draft-file requires a value.");
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

function receiptIdArgs(receiptOperations = []) {
  return receiptOperations
    .filter(Boolean)
    .map((operation) => ` --receipt-id <${operation}-receipt-id>`)
    .join("");
}

function buildFirstBackfillCommand({ outputFile, target, actionsFile = null }) {
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
  firstBackfillCommand,
  firstBackfillArtifactPath
}) {
  const commands = [
    {
      key: "readiness_status",
      status: "current",
      command: readinessStatusCommand,
      artifactPath: actionsFile || null,
      nextAction: "Generate or refresh the readiness action queue before backfilling evidence."
    }
  ];
  if (firstBackfillCommand) {
    commands.push({
      key: "first_closeout_backfill",
      status: "blocked_after_readiness_status",
      command: firstBackfillCommand,
      artifactPath: firstBackfillArtifactPath || null,
      nextAction: "Backfill the first pending closeout evidence item after the readiness action queue is refreshed."
    });
  }
  commands.push(
    {
      key: "rehearsal_reload",
      status: firstBackfillCommand ? "blocked_after_first_closeout_backfill" : "blocked_after_readiness_status",
      command: rehearsalCommand,
      artifactPath: outputFile,
      nextAction: "Reload rehearsal after the current evidence backfill item is recorded."
    }
  );
  return commands;
}

function isFilledValue(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function buildEvidenceProgress({ acceptanceFields, statusCommand, outputFile, actionsFile }) {
  const fields = Array.isArray(acceptanceFields) ? acceptanceFields : [];
  const pendingFields = fields.filter((field) => !isFilledValue(field?.value));
  const currentTarget = pendingFields[0] || null;
  const receiptOperations = Array.isArray(currentTarget?.receiptOperations) ? currentTarget.receiptOperations : [];
  const firstBackfillCommand = buildFirstBackfillCommand({
    outputFile,
    target: currentTarget ? { ...currentTarget, receiptOperations } : null,
    actionsFile
  });
  return {
    status: pendingFields.length === 0 ? "filled" : "awaiting_real_evidence",
    requiredCount: fields.length,
    filledCount: fields.length - pendingFields.length,
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
    firstBackfillCommand,
    statusCommand,
    nextAction: firstBackfillCommand
      ? "Run statusCommand, then run firstBackfillCommand with real redacted evidence."
      : "Run statusCommand, then backfill the currentTarget with real redacted evidence."
  };
}

function buildFirstEvidenceBackfillHandoff({
  evidenceProgress,
  actionsFile,
  rehearsalCommand
}) {
  if (!evidenceProgress?.firstBackfillCommand || !evidenceProgress.currentTarget) {
    return null;
  }
  return {
    status: "ready_for_first_closeout_backfill",
    currentActionKey: "backfill_closeout_evidence",
    statusCommand: evidenceProgress.statusCommand,
    firstBackfillCommand: evidenceProgress.firstBackfillCommand,
    firstBackfillTarget: {
      key: evidenceProgress.currentTarget.key,
      artifactPath: evidenceProgress.currentTarget.artifactPath,
      sourceStep: evidenceProgress.currentTarget.sourceStep,
      receiptOperations: evidenceProgress.currentTarget.receiptOperations
    },
    actionQueueFile: actionsFile || null,
    reloadCommand: rehearsalCommand,
    nextAction: "Run statusCommand, then firstBackfillCommand with real redacted evidence before the rehearsal reload."
  };
}

function promoteDraft(draft, draftFile) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new Error("closeout draft must be a JSON object.");
  }
  if (draft.mode !== "staging-closeout-input-draft") {
    throw new Error("Only staging-closeout-input-draft payloads can be promoted.");
  }
  const nextDraft = {
    ...draft,
    status: "awaiting_real_evidence",
    promotedFromDraft: {
      path: draftFile,
      promotedAt: "pending_operator_evidence"
    }
  };
  delete nextDraft.exampleOnly;
  delete nextDraft.doNotSubmitWithoutReplacingPlaceholders;
  return nextDraft;
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "written") {
    console.log(`Filled closeout input initialized: ${result.outputFile}`);
    if (result.evidenceProgress) {
      const progress = result.evidenceProgress;
      console.log(`Evidence progress: ${progress.filledCount}/${progress.requiredCount} filled, ${progress.pendingCount} pending`);
      if (progress.currentTarget) {
        console.log(`First backfill target: ${progress.currentTarget.key}`);
        if (progress.currentTarget.artifactPath) {
          console.log(`First target artifact: ${progress.currentTarget.artifactPath}`);
        }
        if (progress.currentTarget.sourceStep) {
          console.log(`First target source step: ${progress.currentTarget.sourceStep}`);
        }
      }
      if (progress.firstBackfillCommand) {
        console.log(`First backfill command: ${progress.firstBackfillCommand}`);
      }
      console.log(`First target status check: ${progress.statusCommand}`);
    }
    if (result.firstEvidenceBackfillHandoff) {
      const handoff = result.firstEvidenceBackfillHandoff;
      console.log(`First evidence handoff: ${handoff.status}`);
      console.log(`First evidence status refresh: ${handoff.statusCommand}`);
      console.log(`First evidence backfill: ${handoff.firstBackfillCommand}`);
      console.log(`First evidence target: ${handoff.firstBackfillTarget.key} -> ${handoff.firstBackfillTarget.artifactPath || "-"}`);
      if (handoff.firstBackfillTarget.sourceStep) {
        console.log(`First evidence source step: ${handoff.firstBackfillTarget.sourceStep}`);
      }
      console.log(`First evidence rehearsal reload: ${handoff.reloadCommand}`);
      console.log(`First evidence next action: ${handoff.nextAction}`);
    }
    const currentCommand = result.operatorNextCommands?.find((item) => item.status === "current");
    const firstBackfill = result.operatorNextCommands?.find((item) => item.key === "first_closeout_backfill");
    const rehearsalReload = result.operatorNextCommands?.find((item) => item.key === "rehearsal_reload");
    if (currentCommand) {
      console.log(`Current command: ${currentCommand.command}`);
      if (currentCommand.artifactPath) {
        console.log(`Action queue file: ${currentCommand.artifactPath}`);
      }
    } else {
      console.log(result.statusCommand);
    }
    if (firstBackfill) {
      console.log(`First backfill after status: ${firstBackfill.command}`);
    }
    if (rehearsalReload) {
      console.log(`Rehearsal reload: ${rehearsalReload.command}`);
    } else {
      console.log(result.nextCommand);
    }
    console.log(`Next action: ${result.nextAction}`);
    return;
  }
  console.log(`Staging closeout init failed: ${result.error.message}`);
}

function main() {
  const json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    const draftFile = path.resolve(options.draftFile);
    const draft = JSON.parse(readFileSync(draftFile, "utf8"));
    const outputFile = path.resolve(options.outputFile || draft.copyTo || "filled-closeout-input.json");
    const actionsFile = options.actionsFile ? path.resolve(options.actionsFile) : null;
    const closeoutInput = promoteDraft(draft, draftFile);
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(closeoutInput, null, 2)}\n`, "utf8");
    const acceptanceFields = Array.isArray(closeoutInput.acceptanceFields) ? closeoutInput.acceptanceFields : [];
    const placeholderCount = acceptanceFields.filter((field) => field?.value === null || field?.value === undefined).length;
    const nextCommand = `npm.cmd run staging:rehearsal -- --closeout-input-file ${commandValue(outputFile)}`;
    const nextStatusCommand = statusCommand(outputFile, actionsFile);
    const evidenceProgress = buildEvidenceProgress({
      acceptanceFields,
      statusCommand: nextStatusCommand,
      outputFile,
      actionsFile
    });
    const firstEvidenceBackfillHandoff = buildFirstEvidenceBackfillHandoff({
      evidenceProgress,
      actionsFile,
      rehearsalCommand: nextCommand
    });
    writeResult({
      status: "written",
      mode: "staging-closeout-init",
      draftFile,
      outputFile,
      ...(actionsFile ? { actionsFile } : {}),
      acceptanceFieldCount: acceptanceFields.length,
      placeholderCount,
      evidenceProgress,
      ...(firstEvidenceBackfillHandoff ? { firstEvidenceBackfillHandoff } : {}),
      nextCommand,
      statusCommand: nextStatusCommand,
      operatorNextCommands: buildOperatorNextCommands({
        outputFile,
        actionsFile,
        rehearsalCommand: nextCommand,
        readinessStatusCommand: nextStatusCommand,
        firstBackfillCommand: evidenceProgress.firstBackfillCommand,
        firstBackfillArtifactPath: evidenceProgress.currentTarget?.artifactPath
      }),
      nextAction: "Run statusCommand to pick the first closeout evidence backfill target."
    }, options.json);
  } catch (error) {
    writeResult({
      status: "fail",
      mode: "staging-closeout-init",
      error: {
        message: error.message
      }
    }, json);
    process.exitCode = 1;
  }
}

main();
