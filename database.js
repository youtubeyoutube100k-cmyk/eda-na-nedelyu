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
      votes: JSON.parse(localStorage.getItem("eda-votes") || "{}")
    };
  }
  function normalize(s) {
    return JSON.stringify({
      checked: Array.isArray(s?.checked) ? s.checked : [],
      votes: s?.votes && typeof s.votes === "object" ? s.votes : {}
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
    const safe = JSON.parse(normalize(state));
    checked = safe.checked;
    votes = safe.votes;
    localStorage.setItem("eda-checked", JSON.stringify(checked));
    localStorage.setItem("eda-votes", JSON.stringify(votes));
    if (typeof applyLanguage === "function") applyLanguage();
    applyingRemote = false;
  }
  async function acceptRemote(remote) {
    const normalized = normalize(remote);
    const emptyState = normalize({ checked: [], votes: {} });
    const local = stateNow();
    const localNormalized = normalize(local);
    // On the first connection, preserve existing local data if the cloud is still empty.
    if (!lastRemote && normalized === emptyState && localNormalized !== emptyState) {
      const saved = await rpc("save_family_state", { p_code: code, p_state: local });
      lastRemote = normalize(saved || local);
      return;
    }
    if (normalized !== lastRemote) {
      lastRemote = normalized;
      applyState(remote);
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
    if (this === localStorage && (key === "eda-checked" || key === "eda-votes")) queueSave();
  };

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
      const remote = await rpc("get_family_state", { p_code: code });
      await acceptRemote(remote);
      toast("Семейная база подключена ✓");
      pollTimer = setInterval(() => loadRemote(true).catch(() => {
        clearInterval(pollTimer);
      }), 8000);
    } catch (err) {
      localStorage.removeItem("eda-family-code");
      code = "";
      toast("База не подключилась. Проверь семейный код и настройки Supabase.");
      console.error(err);
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
  window.addEventListener("load", start);
})();
