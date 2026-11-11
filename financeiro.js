(() => {
  "use strict";

  const STORAGE_KEY = "controle-financeiro:v1";
  const NO_CARD = ""; // pagamento sem cartão (dinheiro, Pix, débito, boleto…)

  const DEFAULT_CATEGORIES = [
    ["Mercado", "#16a34a"],
    ["Alimentação", "#f97316"],
    ["Transporte", "#0ea5e9"],
    ["Moradia", "#8b5cf6"],
    ["Saúde", "#ef4444"],
    ["Lazer", "#eab308"],
    ["Compras", "#ec4899"],
    ["Assinaturas", "#14b8a6"],
    ["Outros", "#64748b"],
  ];

  // ---------- Utilidades ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const money = (cents) => brl.format((cents || 0) / 100);
  const monthFmt = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
  const shortMonthFmt = new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit" });

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /** Converte "1.234,56", "1234.56", "R$ 10" em centavos. Retorna NaN se inválido. */
  function parseMoney(input) {
    let s = String(input ?? "").trim().replace(/[R$\s]/g, "");
    if (!s) return NaN;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  }
  const centsToInput = (cents) => (cents ? (cents / 100).toFixed(2).replace(".", ",") : "");

  // Meses representados como inteiro: ano*12 + (mês-1)
  const monthKey = (y, m) => y * 12 + m;
  const keyToDate = (k) => new Date(Math.floor(k / 12), k % 12, 1);
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const keyLabel = (k) => monthFmt.format(keyToDate(k));
  const keyShort = (k) => capitalize(shortMonthFmt.format(keyToDate(k)).replace(".", ""));
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const formatDate = (iso) => {
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  };

  // ---------- Estado ----------
  function defaultState() {
    return {
      version: 1,
      categories: DEFAULT_CATEGORIES.map(([name, color]) => ({ id: uid(), name, color, budget: 0 })),
      cards: [],
      expenses: [],
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.expenses)) return normalizeState(data);
      }
    } catch (err) {
      console.warn("Não foi possível ler os dados salvos", err);
    }
    return defaultState();
  }

  function normalizeState(data) {
    return {
      version: 1,
      categories: Array.isArray(data.categories) ? data.categories : [],
      cards: Array.isArray(data.cards) ? data.cards : [],
      expenses: Array.isArray(data.expenses) ? data.expenses : [],
    };
  }

  let state = loadState();
  let currentMonth = (() => {
    const d = new Date();
    return monthKey(d.getFullYear(), d.getMonth());
  })();

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      toast("Erro ao salvar no navegador: " + err.message);
    }
  }

  const findCard = (id) => state.cards.find((c) => c.id === id);
  const findCategory = (id) => state.categories.find((c) => c.id === id);

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function readLS(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function writeLS(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    } catch {}
  }

  // ---------- Nuvem (Supabase): fila de alterações ----------
  // Toda alteração é aplicada na hora no navegador e entra numa fila que é
  // enviada ao Supabase quando houver conexão e login. Assim o app funciona offline.
  const CFG = window.FINANCEIRO_CONFIG || {};
  const cloudEnabled = Boolean(
    CFG.supabaseUrl && CFG.supabaseAnonKey && !/COLE_AQUI/.test(CFG.supabaseUrl + CFG.supabaseAnonKey),
  );
  const QUEUE_KEY = STORAGE_KEY + ":fila";
  const OWNER_KEY = STORAGE_KEY + ":conta"; // id do usuário dono dos dados locais
  const TABLES = ["categories", "cards", "expenses"];
  let queue = readJSON(QUEUE_KEY, []);
  let client = null;
  let user = null;

  const toRow = {
    categories: (c) => ({ id: c.id, name: c.name, color: c.color, budget: c.budget || 0 }),
    cards: (c) => ({
      id: c.id,
      name: c.name,
      closing_day: c.closingDay,
      due_day: c.dueDay,
      limit_cents: c.limit || 0,
      color: c.color,
    }),
    expenses: (e) => ({
      id: e.id,
      description: e.description,
      category_id: e.categoryId,
      card_id: e.cardId || null,
      date: e.date,
      installments: e.installments,
      total: e.total,
      notes: e.notes || "",
    }),
  };
  const fromRow = {
    categories: (r) => ({ id: r.id, name: r.name, color: r.color, budget: Number(r.budget) || 0 }),
    cards: (r) => ({
      id: r.id,
      name: r.name,
      closingDay: r.closing_day,
      dueDay: r.due_day,
      limit: Number(r.limit_cents) || 0,
      color: r.color,
    }),
    expenses: (r) => ({
      id: r.id,
      description: r.description,
      categoryId: r.category_id,
      cardId: r.card_id || NO_CARD,
      date: r.date,
      installments: r.installments,
      total: Number(r.total),
      notes: r.notes || "",
    }),
  };

  function enqueue(kind, op, item) {
    if (!cloudEnabled || !readLS(OWNER_KEY)) return; // dados só locais: nada a enviar
    queue = queue.filter((q) => !(q.kind === kind && q.id === item.id));
    queue.push({ kind, op, id: item.id, row: op === "upsert" ? toRow[kind](item) : null });
    writeLS(QUEUE_KEY, queue);
  }

  function putItem(kind, item) {
    const list = state[kind];
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item;
    else list.push(item);
    enqueue(kind, "upsert", item);
  }

  function removeItem(kind, id) {
    state[kind] = state[kind].filter((x) => x.id !== id);
    enqueue(kind, "delete", { id });
  }

  /** Substitui todos os dados (importar backup / apagar tudo), refletindo na nuvem. */
  function replaceState(next) {
    for (const kind of TABLES) {
      const keep = new Set(next[kind].map((x) => x.id));
      state[kind].filter((x) => !keep.has(x.id)).forEach((x) => enqueue(kind, "delete", x));
      next[kind].forEach((x) => enqueue(kind, "upsert", x));
    }
    state = next;
  }

  function commit() {
    save();
    renderAll();
    scheduleSync();
  }

  // ---------- Regras de parcelamento ----------
  /** Mês da 1ª parcela: compras a partir do dia de fechamento vão para a próxima fatura. */
  function firstInstallmentMonth(expense) {
    const [y, m, d] = expense.date.split("-").map(Number);
    let key = monthKey(y, m - 1);
    const card = findCard(expense.cardId);
    if (card && d >= Number(card.closingDay)) key += 1;
    return key;
  }

  /** Divide o total em N parcelas; os centavos que sobram vão para as primeiras parcelas. */
  function splitAmount(totalCents, n) {
    const base = Math.floor(totalCents / n);
    const rest = totalCents - base * n;
    return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
  }

  function installmentsOf(expense) {
    const start = firstInstallmentMonth(expense);
    return splitAmount(expense.total, expense.installments).map((amount, i) => ({
      expense,
      number: i + 1,
      month: start + i,
      amount,
    }));
  }

  const allInstallments = () => state.expenses.flatMap(installmentsOf);

  function remainingOf(expense, fromMonth) {
    return installmentsOf(expense)
      .filter((p) => p.month >= fromMonth)
      .reduce((s, p) => s + p.amount, 0);
  }

  // ---------- UI helpers ----------
  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  const tag = (color, text) => `<span class="tag"><span class="dot" style="background:${escapeHtml(color)}"></span>${escapeHtml(text)}</span>`;
  const cardTag = (id) => {
    const card = findCard(id);
    return card ? tag(card.color, card.name) : `<span class="muted">Sem cartão</span>`;
  };
  const categoryTag = (id) => {
    const cat = findCategory(id);
    return cat ? tag(cat.color, cat.name) : `<span class="muted">—</span>`;
  };

  function fillSelect(select, items, { all, allLabel, none, noneLabel } = {}) {
    const prev = select.options.length ? select.value : null;
    let html = "";
    if (all) html += `<option value="*">${allLabel}</option>`;
    if (none) html += `<option value="${NO_CARD}">${noneLabel}</option>`;
    html += items.map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`).join("");
    select.innerHTML = html;
    if (prev !== null && [...select.options].some((o) => o.value === prev)) select.value = prev;
  }

  const byName = (a, b) => a.name.localeCompare(b.name, "pt-BR");

  function refreshSelects() {
    const cards = [...state.cards].sort(byName);
    const cats = [...state.categories].sort(byName);
    for (const id of ["#monthFilterCard", "#filterCard"]) {
      fillSelect($(id), cards, { all: true, allLabel: "Todos os cartões", none: true, noneLabel: "Sem cartão" });
    }
    for (const id of ["#monthFilterCategory", "#filterCategory"]) {
      fillSelect($(id), cats, { all: true, allLabel: "Todos os tipos" });
    }
    const form = $("#expenseForm");
    fillSelect(form.categoryId, cats);
    fillSelect(form.cardId, cards, { none: true, noneLabel: "Sem cartão (dinheiro, Pix, débito…)" });
  }

  function matches(filterValue, value) {
    return filterValue === "*" || (value || NO_CARD) === filterValue;
  }

  function barsHtml(rows, total) {
    if (!rows.length) return `<p class="empty">Nada neste mês.</p>`;
    const max = Math.max(...rows.map((r) => Math.max(r.value, r.cap || 0)), 1);
    return rows
      .map((r) => {
        const pct = (r.value / max) * 100;
        const share = total ? Math.round((r.value / total) * 100) : 0;
        const over = r.cap && r.value > r.cap;
        const sub = r.cap
          ? `<span class="sub ${over ? "over" : ""}">${money(r.value)} de ${money(r.cap)} ${r.capLabel}${over ? " — acima!" : ""}</span>`
          : r.sub
            ? `<span class="sub">${r.sub}</span>`
            : "";
        return `<div class="bar-row">
          <span class="label"><span class="dot" style="background:${escapeHtml(r.color)}"></span><span>${escapeHtml(r.name)}</span></span>
          <span class="value">${money(r.value)} <small class="muted">${share}%</small></span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${escapeHtml(r.color)}"></div></div>
          ${sub}
        </div>`;
      })
      .join("");
  }

  // ---------- Render: resumo do mês ----------
  function renderMonth() {
    $("#monthLabel").textContent = capitalize(keyLabel(currentMonth));
    const all = allInstallments();
    const inMonth = all.filter((p) => p.month === currentMonth);
    const total = inMonth.reduce((s, p) => s + p.amount, 0);
    const newPurchases = inMonth.filter((p) => p.number === 1).reduce((s, p) => s + p.expense.total, 0);
    const future = all.filter((p) => p.month > currentMonth).reduce((s, p) => s + p.amount, 0);

    $("#kpiTotal").textContent = money(total);
    $("#kpiCount").textContent = inMonth.length;
    $("#kpiNew").textContent = money(newPurchases);
    $("#kpiFuture").textContent = money(future);

    // Por categoria
    const catMap = new Map();
    for (const p of inMonth) catMap.set(p.expense.categoryId, (catMap.get(p.expense.categoryId) || 0) + p.amount);
    const catRows = [...catMap].map(([id, value]) => {
      const cat = findCategory(id) || { name: "Sem tipo", color: "#94a3b8", budget: 0 };
      return { name: cat.name, color: cat.color, value, cap: cat.budget || 0, capLabel: "do orçamento" };
    });
    catRows.sort((a, b) => b.value - a.value);
    $("#byCategory").innerHTML = barsHtml(catRows, total);

    // Por cartão
    const cardMap = new Map();
    for (const p of inMonth) {
      const id = p.expense.cardId || NO_CARD;
      cardMap.set(id, (cardMap.get(id) || 0) + p.amount);
    }
    const cardRows = [...cardMap].map(([id, value]) => {
      const card = findCard(id);
      if (!card) return { name: "Sem cartão", color: "#94a3b8", value };
      const due = Math.min(Number(card.dueDay), new Date(Math.floor(currentMonth / 12), (currentMonth % 12) + 1, 0).getDate());
      return {
        name: card.name,
        color: card.color,
        value,
        sub: `Vence dia ${String(due).padStart(2, "0")} · fecha dia ${String(card.closingDay).padStart(2, "0")}`,
      };
    });
    cardRows.sort((a, b) => b.value - a.value);
    $("#byCard").innerHTML = barsHtml(cardRows, total);

    // Tabela
    const fCard = $("#monthFilterCard").value || "*";
    const fCat = $("#monthFilterCategory").value || "*";
    const rows = inMonth
      .filter((p) => matches(fCard, p.expense.cardId) && matches(fCat, p.expense.categoryId))
      .sort((a, b) => a.expense.date.localeCompare(b.expense.date));
    const filteredTotal = rows.reduce((s, p) => s + p.amount, 0);
    $("#monthRows").innerHTML = rows.length
      ? rows
          .map(
            (p) => `<tr>
          <td>${formatDate(p.expense.date)}</td>
          <td class="desc">${escapeHtml(p.expense.description)}</td>
          <td>${categoryTag(p.expense.categoryId)}</td>
          <td>${cardTag(p.expense.cardId)}</td>
          <td>${p.expense.installments > 1 ? `${p.number}/${p.expense.installments}` : "À vista"}</td>
          <td class="num">${money(p.amount)}</td>
        </tr>`,
          )
          .join("") + `<tr class="total-row"><td colspan="5"><strong>Total</strong></td><td class="num"><strong>${money(filteredTotal)}</strong></td></tr>`
      : `<tr><td colspan="6" class="empty">Nenhuma parcela neste mês. Clique em “+ Novo gasto” para começar.</td></tr>`;

    // Previsão próximos 12 meses
    const forecast = [];
    for (let k = currentMonth + 1; k <= currentMonth + 12; k++) {
      forecast.push({ k, v: all.filter((p) => p.month === k).reduce((s, p) => s + p.amount, 0) });
    }
    $("#forecast").innerHTML = forecast
      .map((f) => `<button type="button" class="forecast-item" data-month="${f.k}"><span>${keyShort(f.k)}</span><strong>${money(f.v)}</strong></button>`)
      .join("");
  }

  // ---------- Render: lançamentos ----------
  function renderExpenses() {
    const q = $("#searchExpenses").value.trim().toLowerCase();
    const fCard = $("#filterCard").value || "*";
    const fCat = $("#filterCategory").value || "*";
    const onlyOpen = $("#onlyOpen").checked;
    const nowKey = (() => {
      const d = new Date();
      return monthKey(d.getFullYear(), d.getMonth());
    })();

    const list = state.expenses
      .filter((e) => (!q || e.description.toLowerCase().includes(q)) && matches(fCard, e.cardId) && matches(fCat, e.categoryId))
      .map((e) => ({ e, remaining: remainingOf(e, nowKey) }))
      .filter((x) => !onlyOpen || x.remaining > 0)
      .sort((a, b) => b.e.date.localeCompare(a.e.date));

    if (!list.length) {
      $("#expenseRows").innerHTML = `<tr><td colspan="9" class="empty">Nenhum gasto encontrado.</td></tr>`;
      return;
    }
    const sumTotal = list.reduce((s, x) => s + x.e.total, 0);
    const sumRemaining = list.reduce((s, x) => s + x.remaining, 0);
    $("#expenseRows").innerHTML =
      list
        .map(({ e, remaining }) => {
          const parts = installmentsOf(e);
          const last = parts[parts.length - 1].month;
          return `<tr>
          <td>${formatDate(e.date)}</td>
          <td class="desc">${escapeHtml(e.description)}${e.notes ? `<br><small class="muted">${escapeHtml(e.notes)}</small>` : ""}</td>
          <td>${categoryTag(e.categoryId)}</td>
          <td>${cardTag(e.cardId)}</td>
          <td>${e.installments > 1 ? `${e.installments}x <small class="muted">${keyShort(parts[0].month)} → ${keyShort(last)}</small>` : `À vista <small class="muted">${keyShort(parts[0].month)}</small>`}</td>
          <td class="num">${money(parts[0].amount)}</td>
          <td class="num">${money(e.total)}</td>
          <td class="num ${remaining ? "" : "muted"}">${remaining ? money(remaining) : "Quitado"}</td>
          <td class="num">
            <button class="icon-btn" data-edit="${e.id}" title="Editar" aria-label="Editar">✎</button>
            <button class="icon-btn" data-dup="${e.id}" title="Duplicar" aria-label="Duplicar">⧉</button>
            <button class="icon-btn del" data-del="${e.id}" title="Excluir" aria-label="Excluir">🗑</button>
          </td>
        </tr>`;
        })
        .join("") +
      `<tr><td colspan="6"><strong>${list.length} compra(s)</strong></td><td class="num"><strong>${money(sumTotal)}</strong></td><td class="num"><strong>${money(sumRemaining)}</strong></td><td></td></tr>`;
  }

  // ---------- Render: cartões ----------
  function renderCards() {
    const nowKey = (() => {
      const d = new Date();
      return monthKey(d.getFullYear(), d.getMonth());
    })();
    const list = [...state.cards].sort(byName);
    $("#cardList").innerHTML = list.length
      ? list
          .map((c) => {
            const used = state.expenses.filter((e) => e.cardId === c.id).reduce((s, e) => s + remainingOf(e, nowKey), 0);
            const limitInfo = c.limit
              ? `<div class="limit-track"><div class="bar-fill" style="width:${Math.min(100, (used / c.limit) * 100)}%;background:${used > c.limit ? "var(--danger)" : escapeHtml(c.color)}"></div></div>
                 <small>${money(used)} usados de ${money(c.limit)} · disponível ${money(Math.max(0, c.limit - used))}</small>`
              : `<small>${money(used)} em parcelas a pagar</small>`;
            return `<li>
            <span class="swatch" style="background:${escapeHtml(c.color)}"></span>
            <div class="info"><strong>${escapeHtml(c.name)}</strong><small>Fecha dia ${c.closingDay} · vence dia ${c.dueDay}</small>${limitInfo}</div>
            <button class="icon-btn" data-edit-card="${c.id}" title="Editar" aria-label="Editar">✎</button>
            <button class="icon-btn del" data-del-card="${c.id}" title="Excluir" aria-label="Excluir">🗑</button>
          </li>`;
          })
          .join("")
      : `<li class="empty">Nenhum cartão cadastrado ainda.</li>`;
  }

  // ---------- Render: categorias ----------
  function renderCategories() {
    const list = [...state.categories].sort(byName);
    $("#categoryList").innerHTML = list.length
      ? list
          .map((c) => {
            const count = state.expenses.filter((e) => e.categoryId === c.id).length;
            return `<li>
            <span class="swatch" style="background:${escapeHtml(c.color)}"></span>
            <div class="info"><strong>${escapeHtml(c.name)}</strong><small>${count} lançamento(s)${c.budget ? ` · orçamento ${money(c.budget)}/mês` : ""}</small></div>
            <button class="icon-btn" data-edit-cat="${c.id}" title="Editar" aria-label="Editar">✎</button>
            <button class="icon-btn del" data-del-cat="${c.id}" title="Excluir" aria-label="Excluir">🗑</button>
          </li>`;
          })
          .join("")
      : `<li class="empty">Nenhum tipo cadastrado.</li>`;
  }

  function renderAll() {
    refreshSelects();
    renderMonth();
    renderExpenses();
    renderCards();
    renderCategories();
  }

  // ---------- Dialog de gasto ----------
  const expenseDialog = $("#expenseDialog");
  const expenseForm = $("#expenseForm");

  function openExpense(expense, { duplicate = false } = {}) {
    if (!state.categories.length) {
      toast("Cadastre ao menos um tipo de gasto primeiro.");
      switchTab("categories");
      return;
    }
    refreshSelects();
    expenseForm.reset();
    const editing = expense && !duplicate;
    $("#expenseFormTitle").textContent = editing ? "Editar gasto" : "Novo gasto";
    expenseForm.id.value = editing ? expense.id : "";
    expenseForm.description.value = expense?.description || "";
    expenseForm.categoryId.value = expense?.categoryId || state.categories.slice().sort(byName)[0].id;
    expenseForm.cardId.value = expense ? expense.cardId || NO_CARD : localStorage.getItem(STORAGE_KEY + ":lastCard") ?? NO_CARD;
    if (expenseForm.cardId.selectedIndex < 0) expenseForm.cardId.value = NO_CARD;
    expenseForm.date.value = duplicate ? todayISO() : expense?.date || todayISO();
    expenseForm.installments.value = expense?.installments || 1;
    expenseForm.amount.value = expense ? centsToInput(expense.total) : "";
    expenseForm.amountMode.value = "total";
    expenseForm.notes.value = expense?.notes || "";
    updatePreview();
    expenseDialog.showModal();
    expenseForm.description.focus();
  }

  function readExpenseForm() {
    const n = Math.max(1, Math.min(120, parseInt(expenseForm.installments.value, 10) || 1));
    const value = parseMoney(expenseForm.amount.value);
    const total = expenseForm.amountMode.value === "installment" ? value * n : value;
    return {
      id: expenseForm.id.value || uid(),
      description: expenseForm.description.value.trim(),
      categoryId: expenseForm.categoryId.value,
      cardId: expenseForm.cardId.value || NO_CARD,
      date: expenseForm.date.value,
      installments: n,
      total,
      notes: expenseForm.notes.value.trim(),
    };
  }

  function updatePreview() {
    const e = readExpenseForm();
    const el = $("#expensePreview");
    if (!e.date || !Number.isFinite(e.total) || e.total <= 0) {
      el.textContent = "";
      return;
    }
    const parts = installmentsOf(e);
    const first = parts[0];
    const last = parts[parts.length - 1];
    const card = findCard(e.cardId);
    const where = card ? `na fatura de ${keyLabel(first.month)} do ${card.name}` : `em ${keyLabel(first.month)}`;
    el.textContent =
      e.installments > 1
        ? `${e.installments}x de ${money(first.amount)}${first.amount !== last.amount ? ` (última ${money(last.amount)})` : ""} = ${money(e.total)}. Primeira parcela ${where}, última em ${keyLabel(last.month)}.`
        : `${money(e.total)} à vista, ${where}.`;
  }

  expenseForm.addEventListener("input", updatePreview);
  expenseForm.addEventListener("change", updatePreview);
  $("#cancelExpense").addEventListener("click", () => expenseDialog.close());

  expenseForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const e = readExpenseForm();
    if (!e.description) return toast("Informe a descrição.");
    if (!Number.isFinite(e.total) || e.total <= 0) return toast("Informe um valor válido.");
    if (!e.date) return toast("Informe a data da compra.");
    const idx = state.expenses.findIndex((x) => x.id === e.id);
    putItem("expenses", e);
    writeLS(STORAGE_KEY + ":lastCard", e.cardId);
    expenseDialog.close();
    // Leva o resumo para o mês da primeira parcela, pra pessoa ver onde caiu.
    currentMonth = firstInstallmentMonth(e);
    commit();
    toast(idx >= 0 ? "Gasto atualizado." : "Gasto adicionado.");
  });

  // ---------- Formulário de cartão ----------
  const cardForm = $("#cardForm");
  cardForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const clampDay = (v) => Math.max(1, Math.min(31, parseInt(v, 10) || 1));
    const limit = parseMoney(cardForm.limit.value);
    const card = {
      id: cardForm.id.value || uid(),
      name: cardForm.name.value.trim(),
      closingDay: clampDay(cardForm.closingDay.value),
      dueDay: clampDay(cardForm.dueDay.value),
      limit: Number.isFinite(limit) && limit > 0 ? limit : 0,
      color: cardForm.color.value,
    };
    if (!card.name) return toast("Informe o nome do cartão.");
    putItem("cards", card);
    resetCardForm();
    commit();
    toast("Cartão salvo.");
  });
  function resetCardForm() {
    cardForm.reset();
    cardForm.id.value = "";
    $("#cardFormTitle").textContent = "Novo cartão";
  }
  $("#cardReset").addEventListener("click", (ev) => {
    ev.preventDefault();
    resetCardForm();
  });

  // ---------- Formulário de categoria ----------
  const categoryForm = $("#categoryForm");
  categoryForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const budget = parseMoney(categoryForm.budget.value);
    const cat = {
      id: categoryForm.id.value || uid(),
      name: categoryForm.name.value.trim(),
      color: categoryForm.color.value,
      budget: Number.isFinite(budget) && budget > 0 ? budget : 0,
    };
    if (!cat.name) return toast("Informe o nome.");
    if (state.categories.some((c) => c.id !== cat.id && c.name.toLowerCase() === cat.name.toLowerCase())) {
      return toast("Já existe um tipo com esse nome.");
    }
    putItem("categories", cat);
    resetCategoryForm();
    commit();
    toast("Tipo de gasto salvo.");
  });
  function resetCategoryForm() {
    categoryForm.reset();
    categoryForm.id.value = "";
    $("#categoryFormTitle").textContent = "Novo tipo de gasto";
  }
  $("#categoryReset").addEventListener("click", (ev) => {
    ev.preventDefault();
    resetCategoryForm();
  });

  // ---------- Ações em listas (delegação) ----------
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("button");
    if (!t) return;
    const d = t.dataset;

    if (d.edit) openExpense(state.expenses.find((e) => e.id === d.edit));
    else if (d.dup) openExpense(state.expenses.find((e) => e.id === d.dup), { duplicate: true });
    else if (d.del) {
      const e = state.expenses.find((x) => x.id === d.del);
      if (e && confirm(`Excluir "${e.description}" (${money(e.total)})?`)) {
        removeItem("expenses", d.del);
        commit();
        toast("Gasto excluído.");
      }
    } else if (d.editCard) {
      const c = findCard(d.editCard);
      cardForm.id.value = c.id;
      cardForm.name.value = c.name;
      cardForm.closingDay.value = c.closingDay;
      cardForm.dueDay.value = c.dueDay;
      cardForm.limit.value = centsToInput(c.limit);
      cardForm.color.value = c.color;
      $("#cardFormTitle").textContent = "Editar cartão";
      cardForm.name.focus();
    } else if (d.delCard) {
      const c = findCard(d.delCard);
      const used = state.expenses.filter((e) => e.cardId === c.id).length;
      const msg = used
        ? `O cartão "${c.name}" tem ${used} lançamento(s). Eles continuarão existindo, mas ficarão como "Sem cartão". Excluir?`
        : `Excluir o cartão "${c.name}"?`;
      if (confirm(msg)) {
        removeItem("cards", c.id);
        state.expenses.filter((e) => e.cardId === c.id).forEach((e) => putItem("expenses", { ...e, cardId: NO_CARD }));
        commit();
      }
    } else if (d.editCat) {
      const c = findCategory(d.editCat);
      categoryForm.id.value = c.id;
      categoryForm.name.value = c.name;
      categoryForm.color.value = c.color;
      categoryForm.budget.value = centsToInput(c.budget);
      $("#categoryFormTitle").textContent = "Editar tipo de gasto";
      categoryForm.name.focus();
    } else if (d.delCat) {
      const c = findCategory(d.delCat);
      const used = state.expenses.filter((e) => e.categoryId === c.id).length;
      if (used) return toast(`"${c.name}" tem ${used} lançamento(s). Mude-os de tipo antes de excluir.`);
      if (confirm(`Excluir o tipo "${c.name}"?`)) {
        removeItem("categories", c.id);
        commit();
      }
    } else if (d.month) {
      currentMonth = Number(d.month);
      renderMonth();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  // ---------- Navegação ----------
  function switchTab(name) {
    $$(".tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
    $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${name}`));
  }
  $$(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  $("#newExpenseBtn").addEventListener("click", () => openExpense(null));
  $("#prevMonth").addEventListener("click", () => {
    currentMonth -= 1;
    renderMonth();
  });
  $("#nextMonth").addEventListener("click", () => {
    currentMonth += 1;
    renderMonth();
  });
  $("#todayMonth").addEventListener("click", () => {
    const d = new Date();
    currentMonth = monthKey(d.getFullYear(), d.getMonth());
    renderMonth();
  });

  ["#monthFilterCard", "#monthFilterCategory"].forEach((id) => $(id).addEventListener("change", renderMonth));
  ["#searchExpenses", "#filterCard", "#filterCategory", "#onlyOpen"].forEach((id) => $(id).addEventListener("input", renderExpenses));

  // ---------- Exportação / importação ----------
  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $("#exportJson").addEventListener("click", () => {
    download(`financeiro-backup-${todayISO()}.json`, JSON.stringify(state, null, 2), "application/json");
  });

  $("#importJson").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.expenses)) throw new Error("arquivo não parece um backup válido");
      if (!confirm("Importar este backup vai substituir todos os dados atuais. Continuar?")) return;
      replaceState(normalizeState(data));
      commit();
      toast("Backup importado.");
    } catch (err) {
      toast("Falha ao importar: " + err.message);
    }
  });

  $("#clearAll").addEventListener("click", () => {
    const where = user ? " (neste computador E na nuvem, em todos os aparelhos)" : "";
    if (!confirm(`Apagar TODOS os gastos, cartões e tipos${where}? Isso não pode ser desfeito.`)) return;
    replaceState(defaultState());
    commit();
    toast("Dados apagados.");
  });

  $("#exportMonthCsv").addEventListener("click", () => {
    const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = allInstallments()
      .filter((p) => p.month === currentMonth)
      .sort((a, b) => a.expense.date.localeCompare(b.expense.date))
      .map((p) =>
        [
          formatDate(p.expense.date),
          p.expense.description,
          findCategory(p.expense.categoryId)?.name || "",
          findCard(p.expense.cardId)?.name || "Sem cartão",
          `${p.number}/${p.expense.installments}`,
          (p.amount / 100).toFixed(2).replace(".", ","),
        ]
          .map(csvCell)
          .join(";"),
      );
    const header = ["Data", "Descrição", "Tipo", "Cartão", "Parcela", "Valor"].map(csvCell).join(";");
    const d = keyToDate(currentMonth);
    download(
      `gastos-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}.csv`,
      "﻿" + [header, ...rows].join("\r\n"),
      "text/csv;charset=utf-8",
    );
  });

  // ---------- Nuvem (Supabase): login e sincronização ----------
  const PAGE = 1000; // o Supabase devolve no máximo 1000 linhas por consulta
  let syncing = false;
  let syncAgain = false;
  let syncTimer = null;
  let channel = null;
  let cloudStatus = cloudEnabled ? "loading" : "off";

  const isNetworkError = (err) => !err?.code || /fetch|network|load failed/i.test(err.message || "");

  function setStatus(status) {
    cloudStatus = status;
    const btn = $("#cloudBtn");
    const pending = queue.length ? ` · ${queue.length} pendente(s)` : "";
    const labels = {
      off: "Salvo só neste navegador",
      loading: "Conectando…",
      signedout: "Entrar para sincronizar",
      syncing: "Sincronizando…",
      ok: "Sincronizado",
      offline: "Sem conexão" + pending,
      error: "Erro ao sincronizar" + pending,
    };
    btn.dataset.status = status;
    $("#cloudLabel").textContent = labels[status] || status;
    btn.title = user ? `Conectado como ${user.email}` : labels[status];
    renderAccount();
  }

  async function fetchAll(kind) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client.from(kind).select("*").order("id").range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < PAGE) return rows;
    }
  }

  async function flush() {
    while (queue.length) {
      const batch = queue.slice();
      for (const kind of TABLES) {
        for (const op of ["delete", "upsert"]) {
          const items = batch.filter((q) => q.kind === kind && q.op === op);
          if (!items.length) continue;
          const table = client.from(kind);
          const { error } =
            op === "upsert"
              ? await table.upsert(items.map((q) => q.row))
              : await table.delete().in("id", items.map((q) => q.id));
          if (error) {
            if (isNetworkError(error)) throw error;
            console.error("Supabase recusou a alteração", error, items);
            toast("A nuvem recusou uma alteração: " + error.message);
          }
          queue = queue.filter((q) => !items.includes(q));
          writeLS(QUEUE_KEY, queue);
        }
      }
    }
  }

  async function pull() {
    const [categories, cards, expenses] = await Promise.all(TABLES.map(fetchAll));
    const next = {
      version: 1,
      categories: categories.map(fromRow.categories),
      cards: cards.map(fromRow.cards),
      expenses: expenses.map(fromRow.expenses),
    };
    // Alterações feitas enquanto baixava continuam valendo.
    for (const q of queue) {
      const list = next[q.kind];
      const i = list.findIndex((x) => x.id === q.id);
      if (i >= 0) list.splice(i, 1);
      if (q.op === "upsert") list.push(fromRow[q.kind](q.row));
    }
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      state = next;
      save();
      renderAll();
    }
  }

  async function sync() {
    if (!client || !user) return;
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    setStatus("syncing");
    try {
      do {
        syncAgain = false;
        await flush();
        await pull();
      } while (syncAgain);
      setStatus("ok");
    } catch (err) {
      console.warn("Falha ao sincronizar", err);
      setStatus(navigator.onLine && !isNetworkError(err) ? "error" : "offline");
    } finally {
      syncing = false;
    }
  }

  function scheduleSync(delay = 300) {
    if (!cloudEnabled) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, delay);
    if (user && queue.length && cloudStatus !== "syncing") setStatus(navigator.onLine ? cloudStatus : "offline");
  }

  function subscribeRealtime() {
    if (channel) client.removeChannel(channel);
    channel = client.channel("financeiro-" + user.id);
    for (const table of TABLES) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, () => scheduleSync(500));
    }
    channel.subscribe();
  }

  /** Primeira vez que este navegador entra numa conta: decide o que fazer com os dados locais. */
  async function linkLocalData() {
    const [cats, exps] = await Promise.all([
      client.from("categories").select("id").limit(1),
      client.from("expenses").select("id").limit(1),
    ]);
    if (cats.error) throw cats.error;
    if (exps.error) throw exps.error;
    const serverEmpty = !cats.data.length && !exps.data.length;
    const hasLocal = state.expenses.length || state.cards.length;
    writeLS(OWNER_KEY, user.id);

    if (serverEmpty) {
      // Conta nova: envia tudo o que já existe neste navegador (inclui os tipos padrão).
      TABLES.forEach((k) => state[k].forEach((x) => enqueue(k, "upsert", x)));
      if (hasLocal) toast("Enviando seus dados para a nuvem…");
      return;
    }
    if (!hasLocal) return;
    const ok = confirm(
      `Esta conta já tem dados na nuvem.\n\nDeseja juntar os ${state.expenses.length} gasto(s) e ${state.cards.length} cartão(ões) ` +
        `deste computador com os da nuvem?\n\nOK = juntar\nCancelar = descartar os deste computador e usar só os da nuvem`,
    );
    if (!ok) return;
    const [serverCats, serverCards] = await Promise.all([fetchAll("categories"), fetchAll("cards")]);
    const remap = (localList, serverList, kind) => {
      const byName = new Map(serverList.map((r) => [r.name.trim().toLowerCase(), r.id]));
      const map = new Map();
      for (const item of localList) {
        const existing = byName.get(item.name.trim().toLowerCase());
        if (existing) map.set(item.id, existing);
        else {
          map.set(item.id, item.id);
          enqueue(kind, "upsert", item);
        }
      }
      return map;
    };
    const catMap = remap(state.categories, serverCats, "categories");
    const cardMap = remap(state.cards, serverCards, "cards");
    for (const e of state.expenses) {
      enqueue("expenses", "upsert", {
        ...e,
        categoryId: catMap.get(e.categoryId) || e.categoryId,
        cardId: e.cardId ? cardMap.get(e.cardId) || e.cardId : NO_CARD,
      });
    }
  }

  async function onSignedIn(sessionUser) {
    if (user && user.id === sessionUser.id) return;
    user = sessionUser;
    const owner = readLS(OWNER_KEY);
    try {
      if (owner && owner !== user.id) {
        // Dados locais eram de outra conta: começa limpo.
        state = defaultState();
        queue = [];
        writeLS(QUEUE_KEY, queue);
        writeLS(OWNER_KEY, null);
        save();
        renderAll();
      }
      if (readLS(OWNER_KEY) !== user.id) await linkLocalData();
    } catch (err) {
      console.warn(err);
      setStatus("offline");
      user = null; // tenta de novo na próxima conexão
      setTimeout(() => client.auth.getSession().then(({ data }) => data.session && onSignedIn(data.session.user)), 15000);
      return;
    }
    subscribeRealtime();
    await sync();
  }

  function onSignedOut() {
    user = null;
    if (channel) client.removeChannel(channel);
    channel = null;
    setStatus("signedout");
  }

  async function initCloud() {
    if (!cloudEnabled) {
      setStatus("off");
      return;
    }
    if (!window.supabase?.createClient) {
      setStatus("error");
      console.error("Biblioteca do Supabase não carregou (vendor/supabase.js).");
      return;
    }
    client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    client.auth.onAuthStateChange((event, session) => {
      // Não chamar o Supabase direto dentro deste callback (recomendação da documentação).
      setTimeout(() => {
        if (session?.user) onSignedIn(session.user);
        else if (event === "SIGNED_OUT" || event === "INITIAL_SESSION") onSignedOut();
      }, 0);
    });
    window.addEventListener("online", () => scheduleSync(0));
    window.addEventListener("offline", () => user && setStatus("offline"));
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && scheduleSync(0));
    setInterval(() => scheduleSync(0), 2 * 60 * 1000);
  }

  // ---------- Conta (diálogo de login) ----------
  const accountDialog = $("#accountDialog");
  const loginForm = $("#loginForm");

  function renderAccount() {
    const logged = Boolean(user);
    $("#loginForm").hidden = logged || !cloudEnabled;
    $("#accountInfo").hidden = !logged;
    $("#cloudOffInfo").hidden = cloudEnabled;
    if (logged) {
      $("#accountEmail").textContent = user.email;
      $("#accountPending").textContent = queue.length
        ? `${queue.length} alteração(ões) ainda não enviada(s).`
        : "Tudo enviado para a nuvem.";
    }
  }

  $("#cloudBtn").addEventListener("click", () => {
    renderAccount();
    accountDialog.showModal();
  });
  $("#closeAccount").addEventListener("click", () => accountDialog.close());

  async function doAuth(mode) {
    if (!client) return toast("Não foi possível conectar ao Supabase.");
    const email = loginForm.email.value.trim();
    const password = loginForm.password.value;
    if (!email || password.length < 6) return toast("Informe e-mail e uma senha de pelo menos 6 caracteres.");
    const msg = $("#loginMsg");
    msg.textContent = mode === "signup" ? "Criando conta…" : "Entrando…";
    const { data, error } =
      mode === "signup"
        ? await client.auth.signUp({ email, password })
        : await client.auth.signInWithPassword({ email, password });
    if (error) {
      const known = {
        "Invalid login credentials": "E-mail ou senha incorretos.",
        "Email not confirmed": "Confirme seu e-mail antes de entrar (veja sua caixa de entrada).",
        "User already registered": "Já existe uma conta com esse e-mail. Use “Entrar”.",
      };
      msg.textContent = known[error.message] || "Erro: " + error.message;
      return;
    }
    if (mode === "signup" && !data.session) {
      msg.textContent = "Conta criada! Confirme pelo link enviado ao seu e-mail e depois clique em “Entrar”.";
      return;
    }
    msg.textContent = "";
    loginForm.reset();
    accountDialog.close();
    toast("Conectado.");
  }

  loginForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    doAuth("signin");
  });
  $("#signupBtn").addEventListener("click", () => doAuth("signup"));
  $("#syncNow").addEventListener("click", () => scheduleSync(0));
  $("#logoutBtn").addEventListener("click", async () => {
    if (
      queue.length &&
      !confirm(`Há ${queue.length} alteração(ões) que ainda não foram para a nuvem e serão perdidas. Sair mesmo assim?`)
    )
      return;
    await client.auth.signOut({ scope: "local" });
    // Remove os dados deste computador; eles continuam salvos na nuvem.
    state = defaultState();
    queue = [];
    writeLS(QUEUE_KEY, queue);
    writeLS(OWNER_KEY, null);
    save();
    renderAll();
    onSignedOut();
    accountDialog.close();
    toast("Você saiu. Seus dados continuam na nuvem.");
  });

  // ---------- Início ----------
  save();
  renderAll();
  initCloud();
})();
