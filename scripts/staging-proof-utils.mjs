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
