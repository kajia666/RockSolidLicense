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

function buildOperatorNextCommands({ outputFile, actionsFile, rehearsalCommand, readinessStatusCommand }) {
  return [
    {
      key: "readiness_status",
      status: "current",
      command: readinessStatusCommand,
      artifactPath: actionsFile || null,
      nextAction: "Generate or refresh the readiness action queue before backfilling evidence."
    },
    {
      key: "rehearsal_reload",
      status: "blocked_after_readiness_status",
      command: rehearsalCommand,
      artifactPath: outputFile,
      nextAction: "Reload rehearsal after the current evidence backfill item is recorded."
    }
  ];
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
    const currentCommand = result.operatorNextCommands?.find((item) => item.status === "current");
    const rehearsalReload = result.operatorNextCommands?.find((item) => item.key === "rehearsal_reload");
    if (currentCommand) {
      console.log(`Current command: ${currentCommand.command}`);
      if (currentCommand.artifactPath) {
        console.log(`Action queue file: ${currentCommand.artifactPath}`);
      }
    } else {
      console.log(result.statusCommand);
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
    writeResult({
      status: "written",
      mode: "staging-closeout-init",
      draftFile,
      outputFile,
      ...(actionsFile ? { actionsFile } : {}),
      acceptanceFieldCount: acceptanceFields.length,
      placeholderCount,
      nextCommand,
      statusCommand: nextStatusCommand,
      operatorNextCommands: buildOperatorNextCommands({
        outputFile,
        actionsFile,
        rehearsalCommand: nextCommand,
        readinessStatusCommand: nextStatusCommand
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
