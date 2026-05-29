export function buildBoundSecretEnvProof(source = {}) {
  const credentialEnv = source?.stagingEnvironmentBinding?.credentialEnv
    && typeof source.stagingEnvironmentBinding.credentialEnv === "object"
      ? source.stagingEnvironmentBinding.credentialEnv
      : null;
  const requiredKeys = [
    credentialEnv?.adminPassword,
    credentialEnv?.developerPassword,
    credentialEnv?.developerBearerToken
  ].filter((key) => typeof key === "string" && key.trim());

  if (!requiredKeys.length) {
    return {
      status: "pending_real_environment_confirmation",
      requiredKeys: [],
      missingKeys: []
    };
  }

  const missingKeys = requiredKeys.filter((key) => !String(process.env[key] || "").trim());
  return {
    status: missingKeys.length ? "pending_real_environment_confirmation" : "ready_secret_env_loaded",
    requiredKeys,
    missingKeys
  };
}

export function buildProductionSwitchSecretEnvProof(source = {}, targetEnvFile = null) {
  const boundSecretEnvProof = buildBoundSecretEnvProof(source);
  const requiredKeys = Array.isArray(boundSecretEnvProof.requiredKeys) ? boundSecretEnvProof.requiredKeys : [];
  const missingKeys = Array.isArray(boundSecretEnvProof.missingKeys) ? boundSecretEnvProof.missingKeys : [];
  const currentMissingKey = missingKeys[0] || null;
  return {
    status: boundSecretEnvProof.status || (missingKeys.length ? "pending_real_environment_confirmation" : "ready_secret_env_loaded"),
    requiredKeys,
    presentKeys: requiredKeys.filter((key) => !missingKeys.includes(key)),
    missingKeys,
    requiredCount: requiredKeys.length,
    missingCount: missingKeys.length,
    currentMissingKey,
    targetEnvFile: targetEnvFile || null,
    currentActionKey: currentMissingKey
      ? "set_required_secret_env"
      : requiredKeys.length ? "confirm_secret_env_loaded" : "bind_required_secret_env",
    nextAction: currentMissingKey
      ? `Set ${currentMissingKey} in the target shell before continuing production switch proof.`
      : requiredKeys.length
        ? "Required secret environment variables are loaded; continue production switch proof."
        : "Bind the required secret environment variable names before continuing production switch proof."
  };
}

export function buildProductionSwitchPublicHttpsProof(baseUrl = null) {
  const normalizedBaseUrl = typeof baseUrl === "string"
    ? baseUrl.trim()
    : baseUrl == null ? "" : String(baseUrl).trim();
  let scheme = null;
  if (normalizedBaseUrl) {
    try {
      scheme = new URL(normalizedBaseUrl).protocol.replace(/:$/, "").toLowerCase() || null;
    } catch {
      const schemeMatch = normalizedBaseUrl.match(/^([a-z][a-z0-9+.-]*):\/\//i);
      scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;
    }
  }
  const isHttps = scheme === "https";
  const status = !normalizedBaseUrl
    ? "pending_real_environment_value"
    : isHttps ? "ready_public_https_entrypoint" : "blocked_until_public_https";
  return {
    status,
    baseUrl: normalizedBaseUrl || null,
    scheme,
    isHttps,
    currentActionKey: !normalizedBaseUrl
      ? "set_public_https_entrypoint"
      : isHttps ? "confirm_public_https_entrypoint" : "replace_public_base_url_with_https",
    nextAction: !normalizedBaseUrl
      ? "Set a public HTTPS base URL before continuing production switch proof."
      : isHttps
        ? "Public HTTPS entrypoint is configured; keep live-write smoke and launch switch checks on this URL."
        : "Replace the staging base URL with a public HTTPS endpoint before live-write smoke or production switch review."
  };
}

export function buildProductionSwitchStorageProfileProof(storageProfile = null) {
  const normalizedStorageProfile = typeof storageProfile === "string"
    ? storageProfile.trim()
    : storageProfile == null ? "" : String(storageProfile).trim();
  const isSelected = Boolean(normalizedStorageProfile);
  return {
    status: isSelected ? "ready_storage_profile_selected" : "pending_real_environment_value",
    storageProfile: normalizedStorageProfile || null,
    isSelected,
    currentActionKey: isSelected ? "confirm_storage_profile_selected" : "select_storage_profile",
    nextAction: isSelected
      ? "Storage profile is selected; keep backup and recovery proof aligned to this profile."
      : "Select the storage profile before continuing production switch proof."
  };
}

export function buildProductionSwitchBackupRestoreDrillProof({
  status = "blocked_after_readiness_status",
  closeoutInputFile = null,
  artifactPath = null,
  command = null,
  closeoutKey = "backup_restore_drill_result",
  receiptOperations = []
} = {}) {
  const normalizedStatus = typeof status === "string" && status.trim()
    ? status.trim()
    : "blocked_after_readiness_status";
  const ready = normalizedStatus.startsWith("ready_");
  const normalizedCloseoutInputFile = typeof closeoutInputFile === "string"
    ? closeoutInputFile.trim() || null
    : closeoutInputFile == null ? null : String(closeoutInputFile).trim() || null;
  const normalizedArtifactPath = typeof artifactPath === "string"
    ? artifactPath.trim() || null
    : artifactPath == null ? null : String(artifactPath).trim() || null;
  const normalizedCommand = typeof command === "string"
    ? command.trim() || null
    : command == null ? null : String(command).trim() || null;
  const normalizedCloseoutKey = typeof closeoutKey === "string" && closeoutKey.trim()
    ? closeoutKey.trim()
    : "backup_restore_drill_result";
  const normalizedReceiptOperations = Array.isArray(receiptOperations)
    ? [...new Set(receiptOperations
      .map((operation) => typeof operation === "string" ? operation.trim() : "")
      .filter(Boolean))]
    : [];
  return {
    status: normalizedStatus,
    closeoutKey: normalizedCloseoutKey,
    closeoutInputFile: normalizedCloseoutInputFile,
    artifactPath: normalizedArtifactPath,
    command: normalizedCommand,
    receiptOperations: normalizedReceiptOperations,
    currentActionKey: ready
      ? "confirm_backup_restore_drill_evidence"
      : "backfill_backup_restore_drill_evidence",
    nextAction: ready
      ? "Backup/restore drill evidence is attached; keep receipt links visible through production sign-off and launch-duty review."
      : "Backfill backup_restore_drill_result with redacted evidence and required receipt IDs before continuing production switch proof."
  };
}
