(function initializeProductFeatureHelpers(globalThisRef) {
  const FEATURE_ENTRIES = Object.freeze([
    {
      key: "allowRegister",
      fieldSuffix: "allow-register",
      tagLabel: "register",
      summaryLabel: "Register Open",
      detailLabel: "allowRegister"
    },
    {
      key: "allowAccountLogin",
      fieldSuffix: "allow-account-login",
      tagLabel: "account",
      summaryLabel: "Account Login Open",
      detailLabel: "allowAccountLogin"
    },
    {
      key: "allowCardLogin",
      fieldSuffix: "allow-card-login",
      tagLabel: "card",
      summaryLabel: "Card Login Open",
      detailLabel: "allowCardLogin"
    },
    {
      key: "allowCardRecharge",
      fieldSuffix: "allow-card-recharge",
      tagLabel: "recharge",
      summaryLabel: "Recharge Open",
      detailLabel: "allowCardRecharge"
    },
    {
      key: "allowVersionCheck",
      fieldSuffix: "allow-version-check",
      tagLabel: "version",
      summaryLabel: "Version Check Open",
      detailLabel: "allowVersionCheck"
    },
    {
      key: "allowNotices",
      fieldSuffix: "allow-notices",
      tagLabel: "notices",
      summaryLabel: "Notices Open",
      detailLabel: "allowNotices"
    },
    {
      key: "allowClientUnbind",
      fieldSuffix: "allow-client-unbind",
      tagLabel: "unbind",
      summaryLabel: "Client Unbind Open",
      detailLabel: "allowClientUnbind"
    },
    {
      key: "requireStartupBootstrap",
      fieldSuffix: "require-startup-bootstrap",
      tagLabel: "startup gate",
      summaryLabel: "Startup Gate On",
      detailLabel: "requireStartupBootstrap"
    },
    {
      key: "requireLocalTokenValidation",
      fieldSuffix: "require-local-token-validation",
      tagLabel: "token verify",
      summaryLabel: "Token Verify On",
      detailLabel: "requireLocalTokenValidation"
    },
    {
      key: "requireHeartbeatGate",
      fieldSuffix: "require-heartbeat-gate",
      tagLabel: "heartbeat gate",
      summaryLabel: "Heartbeat Gate On",
      detailLabel: "requireHeartbeatGate"
    }
  ]);

  const FEATURE_KEY_MAP = Object.freeze(
    Object.fromEntries(FEATURE_ENTRIES.map((entry) => [entry.key, entry]))
  );

  const AUTHORIZATION_PRESET_ENTRIES = Object.freeze([
    {
      key: "hybrid_launch",
      label: "Hybrid Launch",
      summary: "账号注册/登录 + 卡密直登 + 卡密充值，适合大多数首发场景。",
      featureConfig: {
        allowRegister: true,
        allowAccountLogin: true,
        allowCardLogin: true,
        allowCardRecharge: true,
        allowVersionCheck: true,
        allowNotices: true,
        allowClientUnbind: false,
        requireStartupBootstrap: true,
        requireLocalTokenValidation: true,
        requireHeartbeatGate: true
      }
    },
    {
      key: "account_recharge",
      label: "Account + Recharge",
      summary: "账号注册/登录，卡密只用于充值或续费，不开放卡密直登。",
      featureConfig: {
        allowRegister: true,
        allowAccountLogin: true,
        allowCardLogin: false,
        allowCardRecharge: true,
        allowVersionCheck: true,
        allowNotices: true,
        allowClientUnbind: false,
        requireStartupBootstrap: true,
        requireLocalTokenValidation: true,
        requireHeartbeatGate: true
      }
    },
    {
      key: "direct_card",
      label: "Direct Card",
      summary: "卡密直接登录，不开放账号注册/登录，适合纯卡密售卖场景。",
      featureConfig: {
        allowRegister: false,
        allowAccountLogin: false,
        allowCardLogin: true,
        allowCardRecharge: false,
        allowVersionCheck: true,
        allowNotices: true,
        allowClientUnbind: false,
        requireStartupBootstrap: true,
        requireLocalTokenValidation: true,
        requireHeartbeatGate: true
      }
    },
    {
      key: "account_only_seeded",
      label: "Account Only",
      summary: "只开放账号登录，不开放注册和卡密直登，适合已预置账号的项目。",
      featureConfig: {
        allowRegister: false,
        allowAccountLogin: true,
        allowCardLogin: false,
        allowCardRecharge: true,
        allowVersionCheck: true,
        allowNotices: true,
        allowClientUnbind: false,
        requireStartupBootstrap: true,
        requireLocalTokenValidation: true,
        requireHeartbeatGate: true
      }
    }
  ]);

  const AUTHORIZATION_PRESET_MAP = Object.freeze(
    Object.fromEntries(AUTHORIZATION_PRESET_ENTRIES.map((entry) => [entry.key, entry]))
  );

  function entryForKey(featureKey) {
    return FEATURE_KEY_MAP[featureKey] || null;
  }

  function fieldId(prefix, featureKey) {
    const entry = entryForKey(featureKey);
    return entry ? `${prefix}-${entry.fieldSuffix}` : `${prefix}-${featureKey}`;
  }

  function isEnabled(featureConfig = {}, featureKey) {
    return featureConfig?.[featureKey] !== false;
  }

  function countEnabled(items = [], featureKey) {
    return items.filter((item) => isEnabled(item.featureConfig, featureKey)).length;
  }

  function readConfig(prefix, readValue) {
    return Object.fromEntries(
      FEATURE_ENTRIES.map((entry) => [entry.key, readValue(fieldId(prefix, entry.key)) === "true"])
    );
  }

  function writeConfig(prefix, featureConfig = {}, writeValue) {
    for (const entry of FEATURE_ENTRIES) {
      writeValue(fieldId(prefix, entry.key), String(isEnabled(featureConfig, entry.key)));
    }
  }

  function renderTagList(featureConfig = {}, renderTag, labelKey = "tagLabel") {
    return FEATURE_ENTRIES
      .map((entry) => renderTag(entry[labelKey] || entry.tagLabel, isEnabled(featureConfig, entry.key)))
      .join("");
  }

  function normalizeConfig(featureConfig = {}) {
    return Object.fromEntries(
      FEATURE_ENTRIES.map((entry) => [entry.key, isEnabled(featureConfig, entry.key)])
    );
  }

  function presetForKey(presetKey) {
    return AUTHORIZATION_PRESET_MAP[presetKey] || null;
  }

  function inferAuthorizationPreset(featureConfig = {}) {
    const normalizedConfig = normalizeConfig(featureConfig);
    return AUTHORIZATION_PRESET_ENTRIES.find((entry) =>
      FEATURE_ENTRIES.every((featureEntry) => normalizedConfig[featureEntry.key] === entry.featureConfig[featureEntry.key])
    ) || null;
  }

  function describeAuthorizationConfig(featureConfig = {}) {
    const accountLoginEnabled = isEnabled(featureConfig, "allowAccountLogin");
    const registerEnabled = isEnabled(featureConfig, "allowRegister");
    const cardLoginEnabled = isEnabled(featureConfig, "allowCardLogin");
    const cardRechargeEnabled = isEnabled(featureConfig, "allowCardRecharge");
    const startupRequired = isEnabled(featureConfig, "requireStartupBootstrap");
    const tokenValidationRequired = isEnabled(featureConfig, "requireLocalTokenValidation");
    const heartbeatGateRequired = isEnabled(featureConfig, "requireHeartbeatGate");

    const loginModes = [];
    if (accountLoginEnabled) {
      loginModes.push(registerEnabled ? "account+register" : "account-only");
    }
    if (cardLoginEnabled) {
      loginModes.push("direct-card");
    }
    if (!loginModes.length) {
      loginModes.push("no-login-path");
    }

    const hints = [];
    if (cardRechargeEnabled) {
      hints.push("card recharge on");
    }
    if (startupRequired) {
      hints.push("startup gate on");
    }
    if (tokenValidationRequired) {
      hints.push("token verify on");
    }
    if (heartbeatGateRequired) {
      hints.push("heartbeat gate on");
    }

    return {
      loginLabel: loginModes.join(" + "),
      hardeningLabel: [
        startupRequired ? "startup" : null,
        tokenValidationRequired ? "token" : null,
        heartbeatGateRequired ? "heartbeat" : null
      ].filter(Boolean).join(" + ") || "relaxed",
      summary: `${loginModes.join(" + ")} | ${hints.join(" | ") || "minimal local gates"}`
    };
  }

  function applyAuthorizationPreset(prefix, presetKey, writeValue) {
    const preset = presetForKey(presetKey);
    if (!preset) {
      return null;
    }
    writeConfig(prefix, preset.featureConfig, writeValue);
    return preset;
  }

  globalThisRef.RSProductFeatures = Object.freeze({
    entries: FEATURE_ENTRIES,
    keys: Object.freeze(FEATURE_ENTRIES.map((entry) => entry.key)),
    authorizationPresets: AUTHORIZATION_PRESET_ENTRIES,
    entryForKey,
    fieldId,
    isEnabled,
    countEnabled,
    readConfig,
    writeConfig,
    renderTagList,
    presetForKey,
    inferAuthorizationPreset,
    describeAuthorizationConfig,
    applyAuthorizationPreset
  });
}(window));
