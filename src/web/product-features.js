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
    }
  ]);

  const FEATURE_KEY_MAP = Object.freeze(
    Object.fromEntries(FEATURE_ENTRIES.map((entry) => [entry.key, entry]))
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

  globalThisRef.RSProductFeatures = Object.freeze({
    entries: FEATURE_ENTRIES,
    keys: Object.freeze(FEATURE_ENTRIES.map((entry) => entry.key)),
    entryForKey,
    fieldId,
    isEnabled,
    countEnabled,
    readConfig,
    writeConfig,
    renderTagList
  });
}(window));
