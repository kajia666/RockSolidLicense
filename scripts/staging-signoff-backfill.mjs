#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RECEIPT_VISIBILITY_KEYS = [
  "launchMainline",
  "launchReview",
  "launchSmoke",
  "developerOps",
  "launchOpsOverviewStatus"
];

const OPTION_FLAGS = {
  "--input-file": "inputFile",
  "--output-file": "outputFile",
  "--condition-key": "conditionKey",
  "--receipt-lane": "receiptLane",
  "--value-json": "valueJson",
  "--artifact-path": "artifactPath",
  "--receipt-id": "receiptIds",
  "--decision": "decision",
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
  for (const required of ["inputFile", "valueJson"]) {
    if (!options[required]) {
      throw new Error(`--${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} requires a value.`);
    }
  }
  if (Boolean(options.conditionKey) === Boolean(options.receiptLane)) {
    throw new Error("Provide exactly one of --condition-key or --receipt-lane.");
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
      nextAction: "Refresh the readiness action queue after this sign-off backfill."
    },
    {
      key: "rehearsal_reload",
      status: "blocked_after_readiness_status",
      command: rehearsalCommand,
      artifactPath: outputFile,
      nextAction: "Reload rehearsal after status confirms the next sign-off, receipt visibility, or launch-day watch gate."
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

function isReceiptVisibilityVisible(value) {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    return ["visible", "pass", "confirmed"].includes(value.trim().toLowerCase());
  }
  if (value && typeof value === "object") {
    return [value.status, value.result, value.visibility, value.value]
      .map((item) => String(item || "").trim().toLowerCase())
      .some((item) => ["visible", "pass", "confirmed"].includes(item));
  }
  return false;
}

function countFilledConditions(productionSignoff) {
  const conditions = Array.isArray(productionSignoff?.conditions) ? productionSignoff.conditions : [];
  return conditions.filter(isFilled).length;
}

function countVisibleReceiptLanes(receiptVisibility = {}) {
  return RECEIPT_VISIBILITY_KEYS.filter((key) => isReceiptVisibilityVisible(receiptVisibility[key])).length;
}

function backfillCondition(payload, options, value) {
  const productionSignoff = payload.productionSignoff && typeof payload.productionSignoff === "object"
    ? payload.productionSignoff
    : {};
  const conditions = Array.isArray(productionSignoff.conditions) ? productionSignoff.conditions : [];
  const conditionIndex = conditions.findIndex((condition) => condition?.key === options.conditionKey);
  if (conditionIndex < 0) {
    throw new Error(`Unknown production sign-off condition: ${options.conditionKey}`);
  }
  const nextConditions = conditions.map((condition, index) => index === conditionIndex
    ? {
      ...condition,
      status: "filled",
      value,
      artifactPath: options.artifactPath || condition.artifactPath || null,
      receiptIds: options.receiptIds
    }
    : condition);
  return {
    ...payload,
    productionSignoff: {
      ...productionSignoff,
      decision: options.decision || productionSignoff.decision || null,
      conditions: nextConditions
    }
  };
}

function backfillReceiptLane(payload, options, value) {
  if (!RECEIPT_VISIBILITY_KEYS.includes(options.receiptLane)) {
    throw new Error(`Unknown receipt visibility lane: ${options.receiptLane}`);
  }
  const productionSignoff = payload.productionSignoff && typeof payload.productionSignoff === "object"
    ? payload.productionSignoff
    : {};
  const receiptVisibility = payload.receiptVisibility && typeof payload.receiptVisibility === "object"
    ? payload.receiptVisibility
    : {};
  const signoffReceiptVisibility = productionSignoff.receiptVisibility && typeof productionSignoff.receiptVisibility === "object"
    ? productionSignoff.receiptVisibility
    : {};
  return {
    ...payload,
    receiptVisibility: {
      ...receiptVisibility,
      [options.receiptLane]: value
    },
    productionSignoff: {
      ...productionSignoff,
      decision: options.decision || productionSignoff.decision || null,
      receiptVisibility: {
        ...signoffReceiptVisibility,
        [options.receiptLane]: value
      }
    }
  };
}

function backfill(payload, options) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("closeout input must be a JSON object.");
  }
  const value = buildEvidenceValue(options);
  return options.conditionKey
    ? backfillCondition(payload, options, value)
    : backfillReceiptLane(payload, options, value);
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "written") {
    console.log(`Production sign-off evidence backfilled: ${result.key}`);
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
  console.log(`Staging signoff backfill failed: ${result.error.message}`);
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

    const productionSignoff = nextPayload.productionSignoff || {};
    const conditions = Array.isArray(productionSignoff.conditions) ? productionSignoff.conditions : [];
    const receiptVisibility = nextPayload.receiptVisibility || productionSignoff.receiptVisibility || {};
    const filledConditionCount = countFilledConditions(productionSignoff);
    const visibleReceiptLaneCount = countVisibleReceiptLanes(receiptVisibility);
    const targetType = options.conditionKey ? "production_signoff_condition" : "receipt_visibility_lane";
    const key = options.conditionKey || options.receiptLane;
    const nextCommand = `npm.cmd run staging:rehearsal -- --closeout-input-file ${commandValue(outputFile)}`;
    const nextStatusCommand = statusCommand(outputFile, actionsFile);
    writeResult({
      status: "written",
      mode: "staging-signoff-backfill",
      inputFile,
      outputFile,
      ...(actionsFile ? { actionsFile } : {}),
      targetType,
      key,
      artifactPath: options.artifactPath || null,
      receiptIds: options.receiptIds,
      productionDecision: productionSignoff.decision || null,
      filledConditionCount,
      visibleReceiptLaneCount,
      missingConditionCount: conditions.length - filledConditionCount,
      missingReceiptLaneCount: RECEIPT_VISIBILITY_KEYS.length - visibleReceiptLaneCount,
      nextCommand,
      statusCommand: nextStatusCommand,
      operatorNextCommands: buildOperatorNextCommands({
        outputFile,
        actionsFile,
        rehearsalCommand: nextCommand,
        readinessStatusCommand: nextStatusCommand
      }),
      nextAction: "Run statusCommand to pick the next sign-off, receipt visibility, or launch-day watch action."
    }, options.json);
  } catch (error) {
    writeResult({
      status: "fail",
      mode: "staging-signoff-backfill",
      error: {
        message: error.message
      }
    }, json);
    process.exitCode = 1;
  }
}

main();
