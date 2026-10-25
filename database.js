(() => {
  const cfg = window.EDADB_CONFIG || {};
  const ready = cfg.url && cfg.anonKey &&
    cfg.url.startsWith("https://") &&
    !cfg.url.includes("PASTE_") &&
    !cfg.anonKey.includes("PASTE_");
  let code = localStorage.getItem("eda-family-code") || "";
  let applyingRemote = false;
  let saveTimer = null;
  let pollTimer = null;
  let lastRemote = "";

  function stateNow() {
    return {
      checked: JSON.parse(localStorage.getItem("eda-checked") || "[]"),
      votes: JSON.parse(localStorage.getItem("eda-votes") || "{}"),
      menu: JSON.parse(localStorage.getItem("eda-menu") || "null"),
      groceries: JSON.parse(localStorage.getItem("eda-groceries") || "null"),
      notificationTimes: JSON.parse(localStorage.getItem("eda-notification-times") || '["08:30"]')
    };
  }
  function normalize(s) {
    return JSON.stringify({
      checked: Array.isArray(s?.checked) ? s.checked : [],
      votes: s?.votes && typeof s.votes === "object" ? s.votes : {},
      menu: Array.isArray(s?.menu) ? s.menu : null,
      groceries: Array.isArray(s?.groceries) ? s.groceries : null,
      notificationTimes: Array.isArray(s?.notificationTimes) ? s.notificationTimes : ["08:30"]
    });
  }
  async function rpc(name, body) {
    const response = await fetch(cfg.url.replace(/\/$/, "") + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {
        "apikey": cfg.anonKey,
        "Authorization": "Bearer " + cfg.anonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const msg = await response.text();
      throw new Error(msg || ("Supabase error " + response.status));
    }
    return response.json();
  }
  function applyState(state) {
    applyingRemote = true;
    try {
      const safe = JSON.parse(normalize(state));
      checked = safe.checked;
      votes = safe.votes;
      localStorage.setItem("eda-checked", JSON.stringify(checked));
      localStorage.setItem("eda-votes", JSON.stringify(votes));
      if (Array.isArray(safe.menu)) localStorage.setItem("eda-menu", JSON.stringify(safe.menu));
      if (Array.isArray(safe.groceries)) localStorage.setItem("eda-groceries", JSON.stringify(safe.groceries));
      if (Array.isArray(safe.notificationTimes)) localStorage.setItem("eda-notification-times", JSON.stringify(safe.notificationTimes));
      if (typeof window.edaApplyCloudExtensions === "function") window.edaApplyCloudExtensions(safe);
      if (typeof applyLanguage === "function") applyLanguage();
    } finally {
      applyingRemote = false;
    }
  }
  async function acceptRemote(remote) {
    const normalized = normalize(remote);
    const local = stateNow();
    const cloud = JSON.parse(normalized);
    const localHasExtendedData = Array.isArray(local.menu) && Array.isArray(local.groceries);
    // Upgrade older cloud records without discarding the site's existing menu or shopping list.
    if (!lastRemote && localHasExtendedData && (!Array.isArray(cloud.menu) || !Array.isArray(cloud.groceries))) {
      const merged = {
        checked: cloud.checked.length ? cloud.checked : local.checked,
        votes: Object.keys(cloud.votes).length ? cloud.votes : local.votes,
        menu: Array.isArray(cloud.menu) ? cloud.menu : local.menu,
        groceries: Array.isArray(cloud.groceries) ? cloud.groceries : local.groceries,
        notificationTimes: Array.isArray(cloud.notificationTimes) ? cloud.notificationTimes : local.notificationTimes
      };
      const saved = await rpc("save_family_state", { p_code: code, p_state: merged });
      lastRemote = normalize(saved || merged);
      applyState(merged);
      return;
    }
    if (normalized !== lastRemote) {
      lastRemote = normalized;
      applyState(cloud);
    }
  }
  async function loadRemote(showError) {
    if (!ready || !code) return;
    try {
      const remote = await rpc("get_family_state", { p_code: code });
      await acceptRemote(remote);
    } catch (err) {
      if (showError) toast("Не удалось обновить базу. Проверь интернет-соединение.");
      throw err;
    }
  }
  async function saveRemote() {
    if (!ready || !code || applyingRemote) return;
    try {
      const local = stateNow();
      const normalized = normalize(local);
      const saved = await rpc("save_family_state", { p_code: code, p_state: local });
      lastRemote = normalize(saved || local);
    } catch (err) {
      console.error("Не удалось сохранить семейные данные:", err);
      toast("Не удалось сохранить данные в облако. Проверь подключение.");
    }
  }
  function queueSave() {
    if (!ready || !code || applyingRemote) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveRemote, 500);
  }
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    originalSetItem.call(this, key, value);
    if (this === localStorage && (key === "eda-checked" || key === "eda-votes" || key === "eda-menu" || key === "eda-groceries" || key === "eda-notification-times")) queueSave();
  };

  async function connectAndPoll() {
    const remote = await rpc("get_family_state", { p_code: code });
    await acceptRemote(remote);
    toast("Семейная база подключена ✓");
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => loadRemote(false).catch(err => {
      console.warn("Синхронизация временно недоступна; повторим позже.", err);
    }), 8000);
  }

  async function start() {
    if (!ready) {
      console.info("Supabase пока не настроен: заполните config.js после создания проекта.");
      return;
    }
    if (!code) {
      code = (window.prompt("Введите общий семейный код для синхронизации телефонов:") || "").trim();
      if (!code) {
        toast("Облачная синхронизация пока не включена.");
        return;
      }
      localStorage.setItem("eda-family-code", code);
    }
    try {
      await connectAndPoll();
    } catch (err) {
      const invalidCode = String(err?.message || "").includes("Неверный семейный код");
      if (invalidCode) {
        localStorage.removeItem("eda-family-code");
        code = (window.prompt("Семейный код изменился. Введите актуальный семейный код:") || "").trim();
        if (!code) {
          toast("Семейный код не введён. Синхронизация не включена.");
          return;
        }
        localStorage.setItem("eda-family-code", code);
        try {
          await connectAndPoll();
        } catch (retryError) {
          localStorage.removeItem("eda-family-code");
          code = "";
          toast("Не удалось подключиться. Проверь код и интернет.");
          console.error(retryError);
        }
      } else {
        toast("Не удалось обновить базу. Проверь интернет-соединение.");
        console.error(err);
      }
    }
  }

  window.edaDatabase = {
    isConfigured: () => !!ready,
    syncNow: () => saveRemote(),
    clearFamilyCode: () => {
      localStorage.removeItem("eda-family-code");
      code = "";
      if (pollTimer) clearInterval(pollTimer);
      toast("Семейный код удалён с этого устройства.");
    }
  };
  window.addEventListener("online", () => loadRemote(false).catch(() => {}));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadRemote(false).catch(() => {});
  });
  window.addEventListener("load", start);
})();
