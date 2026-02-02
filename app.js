(() => {
  const $ = (sel) => document.querySelector(sel);

  // =========================
  // Supabase Client
  // =========================
  const SUPABASE_URL = "https://nuzpvkwkwksoqiggmymr.supabase.co";
  const SUPABASE_KEY = "sb_publishable_BqrMS126Z0iRSCobPYN1uw_-t5gUi0L";

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      // Evita conflito de sessão (GoTrue) em GitHub Pages / github.io
      storageKey: "metas-semana-auth",
    },
  });

  // Debug (opcional): permite testar no console do Pages sem criar outro client
  window.__sb = supabase;

  // =========================
  // Consts / Helpers
  // =========================
  const LS_SELECTED_WS = "metas_selected_workspace_v1";

  const DAYS = [
    { key: "mon", label: "Seg" },
    { key: "tue", label: "Ter" },
    { key: "wed", label: "Qua" },
    { key: "thu", label: "Qui" },
    { key: "fri", label: "Sex" },
    { key: "sat", label: "Sáb" },
    { key: "sun", label: "Dom" },
  ];

  function clampInt(n, min = 0) {
    n = Number(n);
    if (Number.isNaN(n)) return min;
    return Math.max(min, Math.floor(n));
  }
  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
  function escapeAttr(str) {
    return escapeHtml(str).replaceAll("\n", " ");
  }
  function toDateInputValue(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  function parseDateInput(value) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function startOfWeekMonday(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay(); // 0 Sun ... 6 Sat
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d;
  }
  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }
  function fmtDateBr(date) {
    const d = new Date(date);
    return d.toLocaleDateString("pt-BR");
  }
  function setMode(mode) {
    document.body.dataset.mode = mode; // home | view
  }
  function setAuth(on) {
    document.body.dataset.auth = on ? "in" : "out";
  }

  // =========================
  // State
  // =========================
  const state = {
    session: null,
    user: null,
    workspaceId: null,

    goals: [],
    selectedGoalId: null,
    selectedDayKey: "mon",

    modalMode: "create",
    editingGoalId: null,
  };

  // =========================
  // UI Elements
  // =========================
  const authBar = $("#authBar");
  const authBarOut = $("#authBarOut");
  const userPill = $("#userPill");
  const workspaceSelect = $("#workspaceSelect");
  const authMsg = $("#authMsg");
  const authEmail = $("#authEmail");
  const authPass = $("#authPass");

  const goalsList = $("#goalsList");
  const homeEmpty = $("#homeEmpty");
  const countPill = $("#countPill");

  const viewEmpty = $("#viewEmpty");
  const viewContent = $("#viewContent");
  const viewPill = $("#viewPill");
  const viewTitle = $("#viewTitle");
  const viewWeek = $("#viewWeek");
  const viewReward = $("#viewReward");
  const summary = $("#summary");
  const dayTabs = $("#dayTabs");
  const dayLabel = $("#dayLabel");
  const fixedList = $("#fixedList");
  const extraList = $("#extraList");

  const modalBg = $("#modalBg");
  const modalTitle = $("#modalTitle");
  const inpName = $("#inpName");
  const inpWeekStart = $("#inpWeekStart");
  const inpMinPoints = $("#inpMinPoints");
  const inpReward = $("#inpReward");
  const inpFixedPerDay = $("#inpFixedPerDay");
  const inpDefaultPoints = $("#inpDefaultPoints");

  // =========================
  // Realtime (NEW)
  // =========================
  let realtimeChannel = null;
  let rtTimer = null;

  function stopRealtime() {
    if (rtTimer) {
      clearTimeout(rtTimer);
      rtTimer = null;
    }
    if (realtimeChannel) {
      supabase.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
  }

  function scheduleRefreshFromRealtime() {
    // debounce: junta várias mudanças seguidas em 1 refresh
    if (rtTimer) clearTimeout(rtTimer);
    rtTimer = setTimeout(async () => {
      rtTimer = null;
      await fetchAllGoals();
      // manter view atual atualizada
      renderView();
    }, 300);
  }

  function startRealtime() {
    stopRealtime();
    if (!state.user || !state.workspaceId) return;

    const ws = state.workspaceId;

    realtimeChannel = supabase
      .channel(`rt-workspace-${ws}`)

      // tasks (filtra por workspace via join “manual” usando weekly_goal_id -> goals cache)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks" },
        async (payload) => {
          // A tabela tasks não tem workspace_id; então vamos checar se o goal do evento está no workspace atual.
          const goalId =
            payload.new?.weekly_goal_id ?? payload.old?.weekly_goal_id ?? null;

          if (!goalId) return;

          // se ainda não carregou goals, refresca
          if (!state.goals?.length) return scheduleRefreshFromRealtime();

          const isFromThisWorkspace = state.goals.some(
            (g) => g.id === goalId && g.workspace_id === ws
          );

          if (!isFromThisWorkspace) return;

          console.log("[RT] tasks change", payload.eventType);
          scheduleRefreshFromRealtime();
        }
      )

      // weekly_goals (tem workspace_id, dá pra filtrar direto)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "weekly_goals",
          filter: `workspace_id=eq.${ws}`,
        },
        async (payload) => {
          console.log("[RT] weekly_goals change", payload.eventType);
          scheduleRefreshFromRealtime();
        }
      )

      .subscribe((status) => {
        console.log("[RT] status:", status);
      });
  }

  // =========================
  // Supabase - Auth
  // =========================
  function showAuthMessage(msg) {
    authMsg.textContent = msg || "";
  }

  async function signUp() {
    const email = authEmail.value.trim();
    const password = authPass.value.trim();
    if (!email || !password) return showAuthMessage("Informe email e senha.");

    showAuthMessage("Criando conta...");
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) return showAuthMessage("Erro: " + error.message);

    showAuthMessage(
      "Conta criada! Se o Confirm Email estiver OFF, você já consegue entrar."
    );
  }

  async function signIn() {
    const email = authEmail.value.trim();
    const password = authPass.value.trim();
    if (!email || !password) return showAuthMessage("Informe email e senha.");

    showAuthMessage("Entrando...");
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) return showAuthMessage("Erro: " + error.message);

    showAuthMessage("");
    state.session = data.session;
    state.user = data.user;
    await afterLogin();
  }

  async function signOut() {
    stopRealtime(); // NEW
    await supabase.auth.signOut();

    state.session = null;
    state.user = null;
    state.workspaceId = null;
    state.goals = [];
    state.selectedGoalId = null;

    setAuth(false);
    setMode("home");
    renderHome();
    renderView();
  }

  // =========================
  // Supabase - Workspace
  // =========================
  async function loadWorkspaces() {
    const { data: mem, error: memErr } = await supabase
      .from("workspace_members")
      .select("workspace_id, role")
      .order("created_at", { ascending: true });

    if (memErr) throw memErr;

    const ids = mem.map((x) => x.workspace_id);
    if (ids.length === 0) return [];

    const { data: wss, error: wsErr } = await supabase
      .from("workspaces")
      .select("id, name, owner_id, created_at")
      .in("id", ids)
      .order("created_at", { ascending: true });

    if (wsErr) throw wsErr;

    const map = new Map(wss.map((w) => [w.id, w]));
    return ids.map((id) => map.get(id)).filter(Boolean);
  }

  // ✅ cria workspace sem RPC
  async function createWorkspace() {
    const name = prompt("Nome do grupo (workspace):", "Metas da Semana");
    if (!name) return;

    try {
      const { data: ws, error: wsErr } = await supabase
        .from("workspaces")
        .insert([{ name: name.trim(), owner_id: state.user.id }])
        .select("id")
        .single();

      if (wsErr) throw wsErr;

      const { error: memErr } = await supabase
        .from("workspace_members")
        .insert([{ workspace_id: ws.id, user_id: state.user.id, role: "owner" }]);

      if (memErr) throw memErr;

      await refreshWorkspaceList(ws.id);
      alert("Grupo criado com sucesso!");
    } catch (err) {
      alert("Erro ao criar grupo: " + (err?.message || err));
      console.error(err);
    }
  }

  async function refreshWorkspaceList(selectId) {
    const wss = await loadWorkspaces();

    workspaceSelect.innerHTML = "";
    if (wss.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Nenhum grupo ainda";
      workspaceSelect.appendChild(opt);

      state.workspaceId = null;
      localStorage.removeItem(LS_SELECTED_WS);
      state.goals = [];

      stopRealtime(); // NEW

      renderHome();
      renderView();
      return;
    }

    for (const w of wss) {
      const opt = document.createElement("option");
      opt.value = w.id;
      opt.textContent = w.name;
      workspaceSelect.appendChild(opt);
    }

    const saved = localStorage.getItem(LS_SELECTED_WS);
    const chosen = selectId || saved || wss[0].id;

    state.workspaceId = chosen;
    localStorage.setItem(LS_SELECTED_WS, chosen);
    workspaceSelect.value = chosen;

    await fetchAllGoals();
    startRealtime(); // NEW
  }

  // =========================
  // Supabase - Goals + Tasks
  // =========================
  function emptyTaskBuckets() {
    const obj = {};
    for (const d of DAYS) obj[d.key] = [];
    return obj;
  }

  function mapDbToGoal(goalRow, tasksForGoal) {
    const fixedTasks = emptyTaskBuckets();
    const extraTasks = emptyTaskBuckets();

    for (const t of tasksForGoal) {
      const entry = {
        id: t.id,
        name: t.name,
        points: clampInt(t.points, 0),
        done: !!t.done,
        type: t.type,
        day_key: t.day_key,
      };
      if (t.type === "fixed") fixedTasks[t.day_key].push(entry);
      else extraTasks[t.day_key].push(entry);
    }

    return {
      id: goalRow.id,
      workspace_id: goalRow.workspace_id, // NEW: usado no filtro realtime
      name: goalRow.name,
      weekStart: new Date(goalRow.week_start).toISOString(),
      minPoints: clampInt(goalRow.min_points, 0),
      reward: goalRow.reward || "",
      fixedTasks,
      extraTasks,
      createdAt: goalRow.created_at,
      updatedAt: goalRow.updated_at,
    };
  }

  async function fetchAllGoals() {
    if (!state.workspaceId) {
      state.goals = [];
      renderHome();
      renderView();
      return;
    }

    const { data: goals, error: gErr } = await supabase
      .from("weekly_goals")
      .select(
        "id, workspace_id, name, week_start, min_points, reward, created_at, updated_at"
      )
      .eq("workspace_id", state.workspaceId)
      .order("week_start", { ascending: false });

    if (gErr) return alert("Erro ao carregar metas: " + gErr.message);

    const goalIds = goals.map((g) => g.id);
    let tasks = [];
    if (goalIds.length) {
      const { data: tData, error: tErr } = await supabase
        .from("tasks")
        .select(
          "id, weekly_goal_id, day_key, type, name, points, done, created_at, updated_at"
        )
        .in("weekly_goal_id", goalIds);

      if (tErr) return alert("Erro ao carregar tarefas: " + tErr.message);
      tasks = tData;
    }

    const tasksByGoal = new Map();
    for (const t of tasks) {
      if (!tasksByGoal.has(t.weekly_goal_id)) tasksByGoal.set(t.weekly_goal_id, []);
      tasksByGoal.get(t.weekly_goal_id).push(t);
    }

    state.goals = goals.map((gr) =>
      mapDbToGoal(gr, tasksByGoal.get(gr.id) || [])
    );

    renderHome();
    renderView();
  }

  async function dbCreateGoal(payload) {
    const { data, error } = await supabase
      .from("weekly_goals")
      .insert(payload)
      .select(
        "id, workspace_id, name, week_start, min_points, reward, created_at, updated_at"
      )
      .single();

    if (error) throw error;
    return data;
  }

  async function dbUpdateGoal(goalId, patch) {
    const { error } = await supabase.from("weekly_goals").update(patch).eq("id", goalId);
    if (error) throw error;
  }

  async function dbDeleteGoal(goalId) {
    const { error } = await supabase.from("weekly_goals").delete().eq("id", goalId);
    if (error) throw error;
  }

  async function dbInsertTasks(tasks) {
    if (!tasks.length) return;
    const { error } = await supabase.from("tasks").insert(tasks);
    if (error) throw error;
  }

  async function dbUpdateTask(taskId, patch) {
    const { error } = await supabase.from("tasks").update(patch).eq("id", taskId);
    if (error) throw error;
  }

  async function dbDeleteTask(taskId) {
    const { error } = await supabase.from("tasks").delete().eq("id", taskId);
    if (error) throw error;
  }

  // =========================
  // Stats / Reward
  // =========================
  function computeStats(goal) {
    let totalTasks = 0;
    let doneTasks = 0;
    let pointsPossible = 0;
    let pointsEarned = 0;

    for (const d of DAYS) {
      const fixed = goal.fixedTasks?.[d.key] || [];
      const extra = goal.extraTasks?.[d.key] || [];
      const all = [...fixed, ...extra];

      for (const t of all) {
        totalTasks += 1;
        pointsPossible += clampInt(t.points, 0);
        if (t.done) {
          doneTasks += 1;
          pointsEarned += clampInt(t.points, 0);
        }
      }
    }
    return { totalTasks, doneTasks, pointsPossible, pointsEarned };
  }

  function computeRewardStatus(goal, stats) {
    const weekStart = new Date(goal.weekStart);
    const weekEnd = addDays(weekStart, 6);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const reached = stats.pointsEarned >= goal.minPoints;
    const ended = today > weekEnd;

    let label, pillText, pillClass;

    if (reached) {
      label = "LIBERADA";
      pillText = "Premiação liberada ✅";
      pillClass = "ok";
    } else if (ended) {
      label = "NÃO LIBERADA";
      pillText = "Premiação não liberada ❌";
      pillClass = "bad";
    } else {
      label = "EM ANDAMENTO";
      pillText = "Premiação pendente ⏳";
      pillClass = "warn";
    }

    return { label, pillText, pillClass };
  }

  function getRewardPill(goal, stats) {
    const r = computeRewardStatus(goal, stats);
    return `<span class="pill ${r.pillClass}">${r.pillText}</span>`;
  }

  function makePill(text, cls = "") {
    const s = document.createElement("span");
    s.className = "pill" + (cls ? " " + cls : "");
    s.textContent = text;
    return s;
  }

  // =========================
  // Render Home
  // =========================
  function renderHome() {
    countPill.textContent = `${state.goals.length} meta(s)`;
    goalsList.innerHTML = "";

    if (state.goals.length === 0) {
      homeEmpty.style.display = "block";
      return;
    }
    homeEmpty.style.display = "none";

    const sorted = [...state.goals].sort((a, b) =>
      b.weekStart > a.weekStart ? 1 : -1
    );

    for (const g of sorted) {
      const s = new Date(g.weekStart);
      const e = addDays(s, 6);
      const stats = computeStats(g);

      const el = document.createElement("div");
      el.className = "goalItem";
      el.innerHTML = `
        <div style="min-width:0;">
          <strong style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(
            g.name
          )}</strong>
          <div class="meta">
            <span class="pill">${fmtDateBr(s)} → ${fmtDateBr(e)}</span>
            <span class="pill">${stats.doneTasks}/${stats.totalTasks} metas</span>
            <span class="pill">${stats.pointsEarned}/${stats.pointsPossible} pts</span>
            ${getRewardPill(g, stats)}
          </div>
        </div>
        <div class="actions">
          <button class="btn" data-open="${g.id}">Visualizar</button>
          <button class="btn" data-edit="${g.id}">Editar</button>
        </div>
      `;

      goalsList.appendChild(el);
    }

    goalsList.querySelectorAll("[data-open]").forEach((btn) => {
      btn.addEventListener("click", () => openGoal(btn.getAttribute("data-open")));
    });

    goalsList.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => openModalEdit(btn.getAttribute("data-edit")));
    });
  }

  // =========================
  // Render View
  // =========================
  function renderView() {
    const g = state.goals.find((x) => x.id === state.selectedGoalId);

    if (!g) {
      viewPill.textContent = "Nenhuma selecionada";
      viewEmpty.style.display = "block";
      viewContent.style.display = "none";
      return;
    }

    viewPill.textContent = "Meta aberta";
    viewEmpty.style.display = "none";
    viewContent.style.display = "block";

    const s = new Date(g.weekStart);
    const e = addDays(s, 6);

    viewTitle.textContent = g.name;
    viewWeek.textContent = `Semana: ${fmtDateBr(s)} → ${fmtDateBr(e)}`;

    const stats = computeStats(g);
    const rewardInfo = computeRewardStatus(g, stats);
    viewReward.innerHTML = `Premiação: <b>${escapeHtml(
      g.reward || "—"
    )}</b> • Status: <b>${rewardInfo.label}</b>`;

    summary.innerHTML = "";
    summary.appendChild(
      makePill(
        `Metas: ${stats.doneTasks}/${stats.totalTasks}`,
        stats.doneTasks === stats.totalTasks ? "ok" : ""
      )
    );
    summary.appendChild(
      makePill(
        `Pontos: ${stats.pointsEarned}/${stats.pointsPossible}`,
        stats.pointsEarned >= g.minPoints ? "ok" : ""
      )
    );
    summary.appendChild(makePill(`Mínimo: ${g.minPoints} pts`, "warn"));
    summary.appendChild(makePill(rewardInfo.pillText, rewardInfo.pillClass));

    dayTabs.innerHTML = "";
    for (const d of DAYS) {
      const tab = document.createElement("div");
      tab.className = "tab" + (d.key === state.selectedDayKey ? " active" : "");
      tab.textContent = d.label;
      tab.addEventListener("click", () => {
        state.selectedDayKey = d.key;
        renderView();
      });
      dayTabs.appendChild(tab);
    }

    const dayIndex = DAYS.findIndex((d) => d.key === state.selectedDayKey);
    const dayDate = addDays(s, dayIndex);
    dayLabel.textContent = `${DAYS[dayIndex].label} • ${fmtDateBr(dayDate)}`;

    renderTaskList(fixedList, g.fixedTasks[state.selectedDayKey], g, "fixed");
    renderTaskList(extraList, g.extraTasks[state.selectedDayKey], g, "extra");
  }

  // =========================
  // Task list with pencil edit
  // =========================
  function renderTaskList(container, tasks, goal, type) {
    container.innerHTML = "";
    if (!tasks || tasks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent =
        type === "fixed"
          ? "Nenhuma meta fixa aqui."
          : "Nenhuma meta adicional ainda. Clique em “Adicionar”.";
      container.appendChild(empty);
      return;
    }

    for (const t of tasks) {
      const row = document.createElement("div");
      row.className = "task";
      row.dataset.taskId = t.id;

      row.innerHTML = `
        <input class="chk" type="checkbox" ${t.done ? "checked" : ""} aria-label="Concluída" />

        <div class="name">
          <input class="taskName" value="${escapeAttr(t.name)}" readonly />
          <div class="small">${type === "fixed" ? "Fixa" : "Adicional"} • ID: ${t.id.slice(
        -6
      )}</div>
        </div>

        <div class="pts">
          <input class="taskPts" type="number" min="0" step="1" value="${t.points}" />
        </div>

        <div class="nameActions">
          <button class="iconBtn btnEditName" title="Editar texto">✏️</button>
          <button class="iconBtn ok btnSaveName" title="Salvar" style="display:none;">✅</button>
          <button class="iconBtn warn btnCancelName" title="Cancelar" style="display:none;">↩️</button>
          <button class="iconBtn btnDelete" title="Excluir">🗑️</button>
        </div>
      `;

      const chk = row.querySelector(".chk");
      const nameInp = row.querySelector(".taskName");
      const ptsInp = row.querySelector(".taskPts");
      const delBtn = row.querySelector(".btnDelete");

      const btnEditName = row.querySelector(".btnEditName");
      const btnSaveName = row.querySelector(".btnSaveName");
      const btnCancelName = row.querySelector(".btnCancelName");

      let originalName = t.name;
      let editing = false;

      function setEditing(on) {
        editing = on;

        if (on) {
          originalName = t.name;
          nameInp.readOnly = false;
          nameInp.focus();
          nameInp.setSelectionRange(nameInp.value.length, nameInp.value.length);

          btnEditName.style.display = "none";
          btnSaveName.style.display = "inline-flex";
          btnCancelName.style.display = "inline-flex";
        } else {
          nameInp.readOnly = true;

          btnEditName.style.display = "inline-flex";
          btnSaveName.style.display = "none";
          btnCancelName.style.display = "none";
        }
      }

      btnEditName.addEventListener("click", () => setEditing(true));

      btnSaveName.addEventListener("click", async () => {
        const newName = nameInp.value.trim();
        if (!newName) {
          alert("O texto da meta não pode ficar vazio.");
          nameInp.value = originalName;
          return;
        }

        try {
          t.name = newName;
          await dbUpdateTask(t.id, { name: newName });
          setEditing(false);
          renderHome();
        } catch (err) {
          alert("Erro ao salvar texto: " + (err?.message || err));
          nameInp.value = originalName;
        }
      });

      btnCancelName.addEventListener("click", () => {
        nameInp.value = originalName;
        setEditing(false);
      });

      nameInp.addEventListener("keydown", (e) => {
        if (!editing) return;

        if (e.key === "Enter") {
          e.preventDefault();
          btnSaveName.click();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          btnCancelName.click();
        }
      });

      chk.addEventListener("change", async () => {
        t.done = chk.checked;
        try {
          await dbUpdateTask(t.id, { done: t.done });
          renderHome();
          renderView();
        } catch (err) {
          alert("Erro ao atualizar: " + (err?.message || err));
          t.done = !t.done;
          chk.checked = t.done;
        }
      });

      ptsInp.addEventListener("input", async () => {
        const v = clampInt(ptsInp.value, 0);
        ptsInp.value = v;
        t.points = v;

        try {
          await dbUpdateTask(t.id, { points: v });
          renderHome();
          renderView();
        } catch (err) {
          alert("Erro ao salvar pontos: " + (err?.message || err));
        }
      });

      delBtn.addEventListener("click", async () => {
        const list =
          type === "fixed"
            ? goal.fixedTasks[state.selectedDayKey]
            : goal.extraTasks[state.selectedDayKey];

        const idx = list.findIndex((x) => x.id === t.id);
        if (idx < 0) return;

        try {
          await dbDeleteTask(t.id);
          list.splice(idx, 1);
          renderHome();
          renderView();
        } catch (err) {
          alert("Erro ao excluir: " + (err?.message || err));
        }
      });

      container.appendChild(row);
    }
  }

  // =========================
  // Navigation
  // =========================
  function openGoal(id) {
    state.selectedGoalId = id;
    state.selectedDayKey = "mon";
    setMode("view");
    renderView();
  }

  function closeGoal() {
    state.selectedGoalId = null;
    setMode("home");
    renderView();
  }

  // =========================
  // Modal Create/Edit
  // =========================
  function openModalCreate() {
    if (!state.workspaceId) {
      alert("Selecione ou crie um grupo primeiro.");
      return;
    }

    state.modalMode = "create";
    state.editingGoalId = null;
    modalTitle.textContent = "Nova meta semanal";

    const monday = startOfWeekMonday(new Date());
    inpName.value = "";
    inpWeekStart.value = toDateInputValue(monday);
    inpMinPoints.value = "10";
    inpReward.value = "";
    inpFixedPerDay.value = "2";
    inpDefaultPoints.value = "1";

    modalBg.style.display = "flex";
  }

  function openModalEdit(id) {
    const g = state.goals.find((x) => x.id === id);
    if (!g) return;

    state.modalMode = "edit";
    state.editingGoalId = id;
    modalTitle.textContent = "Editar meta semanal";

    inpName.value = g.name || "";
    inpWeekStart.value = toDateInputValue(new Date(g.weekStart));
    inpMinPoints.value = String(clampInt(g.minPoints, 0));
    inpReward.value = g.reward || "";

    inpFixedPerDay.value = "2";
    inpDefaultPoints.value = "1";

    modalBg.style.display = "flex";
  }

  function closeModal() {
    modalBg.style.display = "none";
  }

  async function upsertGoal() {
    const name = inpName.value.trim();
    if (!name) {
      alert("Informe um nome para a meta semanal.");
      return;
    }

    let weekStart = parseDateInput(
      inpWeekStart.value || toDateInputValue(startOfWeekMonday(new Date()))
    );
    weekStart = startOfWeekMonday(weekStart);

    const minPoints = clampInt(inpMinPoints.value, 0);
    const reward = inpReward.value.trim();

    try {
      if (state.modalMode === "create") {
        const fixedPerDay = clampInt(inpFixedPerDay.value, 0);
        const defaultPoints = clampInt(inpDefaultPoints.value, 0);

        const goalRow = await dbCreateGoal({
          workspace_id: state.workspaceId,
          name,
          week_start: toDateInputValue(weekStart),
          min_points: minPoints,
          reward,
          created_by: state.user.id,
        });

        const tasksToInsert = [];
        for (const d of DAYS) {
          for (let i = 1; i <= fixedPerDay; i++) {
            tasksToInsert.push({
              weekly_goal_id: goalRow.id,
              day_key: d.key,
              type: "fixed",
              name: `Meta fixa ${i}`,
              points: defaultPoints,
              done: false,
            });
          }
        }
        await dbInsertTasks(tasksToInsert);

        closeModal();
        await fetchAllGoals();
        closeGoal();
        return;
      }

      await dbUpdateGoal(state.editingGoalId, {
        name,
        week_start: toDateInputValue(weekStart),
        min_points: minPoints,
        reward,
      });

      closeModal();
      await fetchAllGoals();
      if (state.selectedGoalId) renderView();
    } catch (err) {
      alert("Erro ao salvar meta: " + (err?.message || err));
    }
  }

  // =========================
  // Delete / Add tasks
  // =========================
  async function deleteSelectedGoal() {
    const id = state.selectedGoalId;
    if (!id) return;

    const g = state.goals.find((x) => x.id === id);
    if (!g) return;

    const ok = confirm(`Excluir a meta "${g.name}"? Isso apaga todas as tarefas dela.`);
    if (!ok) return;

    try {
      await dbDeleteGoal(id);
      state.selectedGoalId = null;
      await fetchAllGoals();
      closeGoal();
    } catch (err) {
      alert("Erro ao excluir meta: " + (err?.message || err));
    }
  }

  async function addExtraTask() {
    const g = state.goals.find((x) => x.id === state.selectedGoalId);
    if (!g) return;

    try {
      const { data, error } = await supabase
        .from("tasks")
        .insert([
          {
            weekly_goal_id: g.id,
            day_key: state.selectedDayKey,
            type: "extra",
            name: "Nova meta adicional",
            points: 1,
            done: false,
          },
        ])
        .select("id, weekly_goal_id, day_key, type, name, points, done")
        .single();

      if (error) throw error;

      g.extraTasks[state.selectedDayKey].push({
        id: data.id,
        name: data.name,
        points: data.points,
        done: data.done,
        type: data.type,
        day_key: data.day_key,
      });

      renderHome();
      renderView();
    } catch (err) {
      alert("Erro ao adicionar meta adicional: " + (err?.message || err));
    }
  }

  async function addFixedTask() {
    const g = state.goals.find((x) => x.id === state.selectedGoalId);
    if (!g) return;

    try {
      const nextNum = (g.fixedTasks[state.selectedDayKey]?.length || 0) + 1;

      const { data, error } = await supabase
        .from("tasks")
        .insert([
          {
            weekly_goal_id: g.id,
            day_key: state.selectedDayKey,
            type: "fixed",
            name: `Meta fixa ${nextNum}`,
            points: 1,
            done: false,
          },
        ])
        .select("id, weekly_goal_id, day_key, type, name, points, done")
        .single();

      if (error) throw error;

      g.fixedTasks[state.selectedDayKey].push({
        id: data.id,
        name: data.name,
        points: data.points,
        done: data.done,
        type: data.type,
        day_key: data.day_key,
      });

      renderHome();
      renderView();
    } catch (err) {
      alert("Erro ao adicionar meta fixa: " + (err?.message || err));
    }
  }

  function clearLocalCache() {
    localStorage.removeItem(LS_SELECTED_WS);
    alert(
      "Cache local limpo (workspace selecionado). Recarregue/seleciona o grupo novamente."
    );
  }

  // =========================
  // After login
  // =========================
  async function afterLogin() {
    setAuth(true);
    setMode("home");

    authBar.style.display = "flex";
    authBarOut.style.display = "none";
    userPill.textContent = state.user?.email || "logado";

    try {
      await refreshWorkspaceList();
      startRealtime(); // NEW (garantia)
    } catch (err) {
      alert("Erro ao carregar grupos: " + (err?.message || err));
      console.error(err);
    }
  }

  // =========================
  // Bind events
  // =========================
  $("#btnSignUp").addEventListener("click", signUp);
  $("#btnSignIn").addEventListener("click", signIn);
  $("#btnLogout").addEventListener("click", signOut);

  $("#btnCreateWorkspace").addEventListener("click", createWorkspace);
  $("#btnRefresh").addEventListener("click", fetchAllGoals);

  workspaceSelect.addEventListener("change", async () => {
    const id = workspaceSelect.value;
    state.workspaceId = id || null;
    if (id) localStorage.setItem(LS_SELECTED_WS, id);

    stopRealtime(); // NEW (evita canal antigo)
    await fetchAllGoals();
    startRealtime(); // NEW
    closeGoal();
  });

  $("#btnNew").addEventListener("click", openModalCreate);
  $("#btnCloseModal").addEventListener("click", closeModal);
  $("#btnCancel").addEventListener("click", closeModal);
  $("#btnSave").addEventListener("click", () => upsertGoal());

  $("#btnBack").addEventListener("click", closeGoal);
  $("#btnEditFromView").addEventListener("click", () => {
    if (state.selectedGoalId) openModalEdit(state.selectedGoalId);
  });
  $("#btnDelete").addEventListener("click", () => deleteSelectedGoal());

  $("#btnAddTask").addEventListener("click", () => addExtraTask());
  $("#btnAddFixed").addEventListener("click", () => addFixedTask());

  $("#btnReset").addEventListener("click", clearLocalCache);

  modalBg.addEventListener("click", (e) => {
    if (e.target === modalBg) closeModal();
  });

  // =========================
  // Boot
  // =========================
  async function boot() {
    setMode("home");
    state.selectedGoalId = null;

    renderHome();
    renderView();

    const { data } = await supabase.auth.getSession();
    state.session = data.session;
    state.user = data.session?.user || null;

    if (state.user) {
      await afterLogin();
    } else {
      setAuth(false);
      authBar.style.display = "none";
      authBarOut.style.display = "flex";
    }

    supabase.auth.onAuthStateChange(async (_event, session) => {
      state.session = session;
      state.user = session?.user || null;

      if (state.user) {
        await afterLogin();
      } else {
        await signOut();
      }
    });
  }

  boot();
})();
