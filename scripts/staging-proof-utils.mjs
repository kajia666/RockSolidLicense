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
