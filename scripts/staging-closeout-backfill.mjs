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

function buildOperatorNextCommands({ outputFile, actionsFile, rehearsalCommand, readinessStatusCommand }) {
  return [
    {
      key: "readiness_status",
      status: "current",
      command: readinessStatusCommand,
      artifactPath: actionsFile || null,
      nextAction: "Refresh the readiness action queue after this evidence backfill."
    },
    {
      key: "rehearsal_reload",
      status: "blocked_after_readiness_status",
      command: rehearsalCommand,
      artifactPath: outputFile,
      nextAction: "Reload rehearsal after status confirms the next gate or all closeout evidence is ready."
    }
  ];
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
    console.log(`Backfilled status refresh: ${result.statusCommand}`);
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
      nextCommand,
      statusCommand: nextStatusCommand,
      operatorNextCommands: buildOperatorNextCommands({
        outputFile,
        actionsFile,
        rehearsalCommand: nextCommand,
        readinessStatusCommand: nextStatusCommand
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
