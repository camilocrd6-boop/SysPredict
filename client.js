/* ===========================
   HardwareGuard - client.js v12 (ajustado)
   =========================== */

/* ---------- Estado global ---------- */
// Acomoda host y protocolo automáticamente para evitar mixed-content.
const HOST = location.hostname || "127.0.0.1";
const API_BASE = `${location.protocol}//${HOST}:8000`;
const WS_PROTO = location.protocol === "https:" ? "wss" : "ws";
const WS_URL = `${WS_PROTO}://${HOST}:8000/ws`;

let ws = null;
let reconnectWait = 1000; // 1s → exponencial hasta 10s
let LAST_DATA = null;
let LAST_OVERVIEW = null;
let LAST_FORECAST = null;
let GX_CURRENT = "cpu";

const histLen = 180; // ~3 min a 1 Hz
const HISTORY = {
  cpu: [],
  mem: [],
  gpu: [],
  gpu_temp: [],
  disk: [],
  net: [],
  bat: []
};

/* ---------- Configuración (persistente) ---------- */
const defaultCfg = {
  theme: "system",      // system|light|dark
  accent: "#5ea9ff",
  density: "normal",    // normal|compact
  anim: true,
  thick: 2,             // grosor líneas chart
  thr_cpu: 95,
  thr_mem: 90,
  thr_gpu_temp: 85,
  thr_net: 50,          // MB/s
  net_unit: "MBps"      // MBps|Mbps (solo visual)
};
let CFG = loadCfg();

/* ---------- Helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function fmt(n, d = 0) {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(d);
}
function pctBar(el, v) {
  if (!el) return;
  el.style.width = clamp(v || 0, 0, 100) + "%";
}

/* ---------- Apariencia ---------- */
applyAppearance();
function applyAppearance() {
  // tema
  document.documentElement.classList.remove("light", "dark");
  if (CFG.theme === "light") document.documentElement.classList.add("light");
  else if (CFG.theme === "dark") document.documentElement.classList.add("dark");
  else {
    // system
    const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.add(dark ? "dark" : "light");
  }
  // acento
  document.documentElement.style.setProperty("--acc", CFG.accent);
  // densidad
  document.documentElement.classList.toggle("compact", CFG.density === "compact");
}
function loadCfg() {
  try {
    const raw = localStorage.getItem("hg-cfg");
    if (!raw) return { ...defaultCfg };
    const parsed = JSON.parse(raw);
    return { ...defaultCfg, ...parsed };
  } catch {
    return { ...defaultCfg };
  }
}
function saveCfg() {
  localStorage.setItem("hg-cfg", JSON.stringify(CFG));
}

/* ---------- Chart.js (gráfica única con datasets reusables) ---------- */
let gxChart = null;
function setupChart() {
  const canvas = document.getElementById("gx-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  gxChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: Array(histLen).fill(""),
      datasets: [{
        label: "Valor",
        data: [],
        fill: false,
        borderWidth: CFG.thick,
        tension: 0.2,
        pointRadius: 0
      }]
    },
    options: {
      animation: CFG.anim,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: "rgba(130,140,160,.15)" } }
      },
      plugins: {
        legend: { display: false },
        tooltip: { mode: "index", intersect: false }
      }
    }
  });
}
setupChart();

/* ---------- Conexión WS ---------- */
connectWS();
function connectWS() {
  try { ws && ws.close(); } catch {}
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    $("#conn-dot")?.classList.remove("offline");
    $("#conn-dot")?.classList.add("online");
    reconnectWait = 1000;
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      const d = msg.data || {};
      const forecast = msg.forecast || null;
      LAST_DATA = d;
      LAST_FORECAST = forecast;

      updateHistory(d);
      renderDashboard(d);
      renderPredictions(forecast, msg.badges || []);
      if (!$("#view-graficas").classList.contains("hidden")) {
        updateChartFor(GX_CURRENT);
        renderMetricTables();
      }
      maybeRaiseAlerts(d);
    } catch (e) {
      console.error("WS parse error:", e);
    }
  };

  ws.onclose = () => {
    $("#conn-dot")?.classList.remove("online");
    $("#conn-dot")?.classList.add("offline");
    setTimeout(connectWS, reconnectWait);
    reconnectWait = Math.min(reconnectWait * 1.8, 10000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

/* ---------- Carga de overview inicial ---------- */
loadOverview();
function loadOverview() {
  fetch(`${API_BASE}/overview`)
    .then(async (r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(ov => {
      LAST_OVERVIEW = ov;
      const txt = [
        `CPU: ${ov.cpu_physical ?? "?"}/${ov.cpu_logical ?? "?"}`,
        `RAM: ${fmt(ov.memory_gb, 1)} GB`,
        `Discos: ${Array.isArray(ov.disks) ? ov.disks.join(", ") : "—"}`,
        `GPU: ${typeof ov.gpu === "string" ? ov.gpu : (ov.gpu?.name || "Desconocida")}`
      ].join(" • ");
      $("#overview").textContent = txt;
      fillComponentsTable(ov);
      if (!$("#view-graficas").classList.contains("hidden")) renderMetricTables();
    })
    .catch(() => {
      $("#overview").textContent = "No se pudo leer /overview";
    });
}

/* ---------- Historia (para gráficas) ---------- */
function pushHist(arr, v) {
  arr.push(v);
  if (arr.length > histLen) arr.shift();
}
function updateHistory(d) {
  // Normalización de campos
  const cpu = d.cpu ?? d.cpu_pct ?? 0;
  const memPct = (() => {
    const u = d.mem_used_gb ?? 0;
    const t = d.mem_total_gb ?? LAST_OVERVIEW?.memory_gb ?? 0;
    if (!t) return d.mem_pct ?? 0;
    return clamp((u / t) * 100, 0, 100);
  })();
  const gpuUtil = d.gpu_util ?? d.gpu ?? d.gpu_pct ?? 0;
  const gpuTemp = d.gpu_temp ?? d.gpu_temp_c ?? 0;
  const disk = (d.disk_read_mb_s ?? 0) + (d.disk_write_mb_s ?? 0); // MB/s
  const net = (d.net_up_mb_s ?? 0) + (d.net_down_mb_s ?? 0); // MB/s
  const bat = d.battery_pct ?? (d.battery ?? 0);

  pushHist(HISTORY.cpu, cpu);
  pushHist(HISTORY.mem, memPct);
  pushHist(HISTORY.gpu, gpuUtil);
  pushHist(HISTORY.gpu_temp, gpuTemp);
  pushHist(HISTORY.disk, disk);
  pushHist(HISTORY.net, net);
  pushHist(HISTORY.bat, bat);
}

/* ---------- Dashboard (KPIs + Salud) ---------- */
function renderDashboard(d) {
  // KPI CPU
  const cpu = d.cpu ?? d.cpu_pct ?? 0;
  $("#cpu-val").textContent = `${fmt(cpu)}%`;
  $("#cpu-sub").textContent = `${LAST_OVERVIEW?.cpu_logical ?? "—"} hilos • ${fmt(d.cpu_freq_ghz ?? d.cpu_ghz ?? 0, 2)} GHz`;
  pctBar($("#cpu-bar"), cpu);

  // KPI GPU
  const gpuUtil = d.gpu_util ?? d.gpu ?? d.gpu_pct ?? 0;
  const gpuTemp = d.gpu_temp ?? d.gpu_temp_c ?? 0;
  $("#gpu-val").textContent = `${fmt(gpuUtil)}%`;
  $("#gpu-sub").textContent = `Mem ${fmt(d.gpu_mem_pct ?? d.gpu_mem ?? 0)}%`;
  pctBar($("#gpu-bar"), gpuUtil);
  $("#gpu-pill").textContent = `${fmt(gpuTemp)}ºC`;

  // KPI Memoria
  const u = d.mem_used_gb ?? 0;
  const t = d.mem_total_gb ?? LAST_OVERVIEW?.memory_gb ?? 0;
  const memPct = t ? (u / t) * 100 : (d.mem_pct ?? 0);
  $("#ram-val").textContent = `${fmt(memPct)}%`;
  $("#ram-sub").textContent = `${fmt(u,1)} / ${fmt(t,1)} GB`;
  pctBar($("#ram-bar"), memPct);

  // KPI Disco (toma R+W como “uso” relativo a 200 MB/s)
  const diskR = d.disk_read_mb_s ?? 0;
  const diskW = d.disk_write_mb_s ?? 0;
  const diskTotal = diskR + diskW;
  const diskPct = clamp((diskTotal / 200) * 100, 0, 100);
  $("#disk-val").textContent = `${fmt(diskPct)}%`;
  $("#disk-sub").textContent = `${fmt(diskR,1)} ↓ / ${fmt(diskW,1)} ↑ MB/s`;
  pctBar($("#disk-bar"), diskPct);

  // KPI Red (sub+down en MB/s → % respecto a 100 MB/s)
  const netUp = d.net_up_mb_s ?? 0;
  const netDown = d.net_down_mb_s ?? 0;
  const netSum = netUp + netDown;
  const netPct = clamp((netSum / 100) * 100, 0, 100);
  $("#net-val").textContent = `${fmt(netPct)}%`;
  $("#net-sub").textContent = `${fmt(netDown,1)} ↓ / ${fmt(netUp,1)} ↑ MB/s`;
  pctBar($("#net-bar"), netPct);

  // KPI Batería
  const bat = d.battery_pct ?? (d.battery ?? null);
  $("#bat-val").textContent = bat === null ? "—" : `${fmt(bat)}%`;
  $("#bat-sub").textContent = (d.battery_sec_left != null)
    ? `${Math.max(0, Math.round(d.battery_sec_left/60))} min restantes`
    : (bat === null ? "No reportado" : "Nivel reportado");
  pctBar($("#bat-bar"), bat ?? 0);

  // Salud (score simple)
  const score = clamp(
    100
    - (cpu*0.2)
    - (Math.max(0, memPct-50)*0.3)
    - (Math.max(0, (d.gpu_temp ?? 0)-60)*0.5)
    - (Math.min(100, diskPct)*0.1)
    - (Math.min(100, netPct)*0.1)
    - ((bat!=null && bat<30) ? (30-bat)*0.5 : 0)
  , 0, 100);
  $("#score").textContent = `${fmt(score,0)}/100`;
  $("#health-bar").style.width = `${fmt(score,0)}%`;
  const label = score >= 85 ? "Excelente" : score >= 65 ? "Buena" : score >= 45 ? "Media" : "Baja";
  $("#health-label").textContent = label;

  // Contadores (OK/Warn/Crit)
  const counts = { ok:0, warn:0, crit:0 };
  function buck(v, warn, crit){ if (v>=crit) counts.crit++; else if (v>=warn) counts.warn++; else counts.ok++; }
  buck(cpu, 80, 95);
  buck(memPct, 80, 90);
  buck(d.gpu_temp ?? 0, 75, 85);
  buck(diskPct, 60, 85);
  buck(netPct, 60, 85);
  $("#ok-count").textContent = counts.ok;
  $("#warn-count").textContent = counts.warn;
  $("#crit-count").textContent = counts.crit;
}

/* ---------- Predicciones ---------- */
function renderPredictions(forecast, badges) {
  const grid = $("#pred-grid");
  if (!grid) return;
  grid.innerHTML = "";

  if (forecast) {
    const makeCard = (title, now, next, unit) => `
      <div class="card">
        <h3>${title}</h3>
        <div class="muted">en ${forecast.horizon_s || 60}s</div>
        <div style="margin-top:.5rem">
          Actual: <b>${fmt(now)}</b> ${unit} · Próximo: <b>${fmt(next)}</b> ${unit}
        </div>
      </div>`;
    const d = LAST_DATA || {};
    const u = d.mem_used_gb ?? 0, t = d.mem_total_gb ?? LAST_OVERVIEW?.memory_gb ?? 0;
    grid.insertAdjacentHTML("beforeend", makeCard("CPU", d.cpu ?? 0, forecast.cpu_next, "%"));
    grid.insertAdjacentHTML("beforeend", makeCard("Memoria (GB)", u, forecast.mem_next, "GB"));
    grid.insertAdjacentHTML("beforeend", makeCard("GPU Temp", d.gpu_temp ?? 0, forecast.gpu_temp_next, "ºC"));
    grid.insertAdjacentHTML("beforeend", makeCard("Disco usado", d.disk_used ?? 0, forecast.disk_used_next, "GB"));
    grid.insertAdjacentHTML("beforeend", makeCard("Batería", d.battery_pct ?? 0, forecast.bat_pct_next, "%"));
  }

  if (badges && badges.length) {
    const wrap = document.createElement("div");
    wrap.className = "grid cards-grid";
    badges.forEach(b => {
      const div = document.createElement("div");
      div.className = "card";
      const cls = b.level === "crit" ? "badge-crit" : b.level === "warn" ? "badge-warn" : "badge-ok";
      div.innerHTML = `<span class="${cls}">${(b.level||"").toUpperCase()}</span> <b style="margin-left:.5rem">${b.label || b.text || ""}</b>`;
      wrap.appendChild(div);
    });
    grid.appendChild(wrap);
  }
}

/* ---------- Componentes ---------- */
function fillComponentsTable(ov) {
  const tbody = $("#tbl-components tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const rows = [
    ["CPU físicos", ov.cpu_physical],
    ["CPU lógicos", ov.cpu_logical],
    ["Memoria total", ov.memory_gb ? `${fmt(ov.memory_gb,1)} GB` : "—"],
    ["Discos", Array.isArray(ov.disks) ? (ov.disks.join(", ") || "—") : "—"],
    ["GPU", typeof ov.gpu === "string" ? ov.gpu : (ov.gpu?.name || "Desconocida")]
  ];

  rows.forEach(([k,v]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${k}</td><td>${v ?? "—"}</td><td>—</td><td><span class="badge-ok">OK</span></td>`;
    tbody.appendChild(tr);
  });
}

/* ---------- Notificaciones por umbral ---------- */
const notif = {
  list: [],
  add(title, sub, level="warn") {
    this.list.unshift({title, sub, level, ts: Date.now()});
    if (this.list.length > 50) this.list.pop();
    this.render();
  },
  render() {
    const ul = $("#notif-list");
    const badge = $("#notif-badge");
    if (!ul || !badge) return;
    ul.innerHTML = "";
    this.list.forEach(n => {
      const div = document.createElement("div");
      div.className = "notif-item";
      const cls = (n.level === "crit" ? "badge-crit" : n.level === "ok" ? "badge-ok" : "badge-warn");
      const when = new Date(n.ts).toLocaleTimeString();
      div.innerHTML = `
        <div><span class="${cls}">${n.level.toUpperCase()}</span></div>
        <div>
          <div class="n-title">${n.title}</div>
          <div class="n-sub">${n.sub} · ${when}</div>
        </div>`;
      ul.appendChild(div);
    });
    badge.textContent = this.list.length;
    badge.classList.toggle("hidden", this.list.length === 0);
  },
  clear(){ this.list = []; this.render(); }
};
$("#notif-btn")?.addEventListener("click", () => $("#notif-panel")?.classList.toggle("hidden"));
$("#notif-clear")?.addEventListener("click", () => notif.clear());

function maybeRaiseAlerts(d) {
  const cpu = d.cpu ?? 0;
  const u = d.mem_used_gb ?? 0, t = d.mem_total_gb ?? LAST_OVERVIEW?.memory_gb ?? 0;
  const memPct = t ? (u / t) * 100 : (d.mem_pct ?? 0);
  const gpuTemp = d.gpu_temp ?? 0;
  const netUp = d.net_up_mb_s ?? 0, netDown = d.net_down_mb_s ?? 0;
  const net = netUp + netDown;

  if (cpu >= CFG.thr_cpu) notif.add("CPU alta", `CPU ${fmt(cpu)}% ≥ ${CFG.thr_cpu}%`, "crit");
  if (memPct >= CFG.thr_mem) notif.add("Memoria alta", `Memoria ${fmt(memPct)}% ≥ ${CFG.thr_mem}%`, "warn");
  if (gpuTemp >= CFG.thr_gpu_temp) notif.add("GPU caliente", `GPU ${fmt(gpuTemp)}ºC ≥ ${CFG.thr_gpu_temp}ºC`, "warn");
  if (net >= CFG.thr_net) notif.add("Tráfico de red elevado", `${fmt(net,1)} MB/s ≥ ${CFG.thr_net} MB/s`, "ok");
}

/* ---------- Vistas / Navegación ---------- */
const nav = $("#nav");
if (nav) {
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest(".sb-item");
    if (!btn) return;
    $$(".sb-item").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;

    // guardar preferencia
    localStorage.setItem("hg-view", view);

    // mostrar/ocultar
    ["dashboard","componentes","predicciones","graficas","tareas","config"].forEach(v => {
      $(`#view-${v}`)?.classList.toggle("hidden", v !== view);
    });

    if (view === "graficas") {
      updateChartFor(GX_CURRENT);
      renderMetricTables();
    }
  });

  // restaurar última vista
  const last = localStorage.getItem("hg-view") || "dashboard";
  const toClick = $(`.sb-item[data-view="${last}"]`) || $(".sb-item[data-view='dashboard']");
  toClick?.click();
}

/* ---------- Pestañas de gráficas ---------- */
$("#gx-tabs")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  $$("#gx-tabs .tab").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  GX_CURRENT = btn.dataset.gx;
  updateChartFor(GX_CURRENT);
  renderMetricTables();
});

function updateChartFor(kind) {
  if (!gxChart) return;
  let data = [];
  let yLabel = "";
  switch (kind) {
    case "cpu": data = HISTORY.cpu; yLabel = "%"; break;
    case "mem": data = HISTORY.mem; yLabel = "%"; break;
    case "gpu": data = HISTORY.gpu; yLabel = "%"; break;
    case "disk": data = HISTORY.disk; yLabel = "MB/s"; break;
    case "net": data = HISTORY.net; yLabel = "MB/s"; break;
    case "bat": data = HISTORY.bat; yLabel = "%"; break;
  }
  gxChart.data.datasets[0].data = [...data];
  gxChart.data.datasets[0].borderWidth = CFG.thick;
  gxChart.options.animation = CFG.anim;
  gxChart.options.scales.y.title = { display: true, text: yLabel };
  gxChart.update("none");
}

/* ---------- Tablas de “Gráficas” (Datos + Hardware Relacionado) ---------- */
function addRowIf(tbody, key, value) {
  if (value === undefined || value === null || value === "" || Number.isNaN(value)) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${key}</td><td>${value}</td>`;
  tbody.appendChild(tr);
}

function renderMetricTables() {
  const detail = $("#gx-detail");
  const hw = $("#gx-hw");
  if (!detail || !hw) return;
  detail.innerHTML = ""; hw.innerHTML = "";

  const d = LAST_DATA || {};
  const ov = LAST_OVERVIEW || {};
  const cpu = d.cpu ?? d.cpu_pct ?? 0;
  const cpuG = d.cpu_freq_ghz ?? d.cpu_ghz;
  const u = d.mem_used_gb ?? 0;
  const t = d.mem_total_gb ?? ov.memory_gb ?? 0;
  const memPct = t ? Math.round((u / t) * 100) : (d.mem_pct ?? 0);
  const gpuUtil = d.gpu_util ?? d.gpu ?? d.gpu_pct;
  const gpuTemp = d.gpu_temp ?? d.gpu_temp_c;
  const diskR = d.disk_read_mb_s ?? 0, diskW = d.disk_write_mb_s ?? 0;
  const netUp = d.net_up_mb_s ?? 0, netDown = d.net_down_mb_s ?? 0;
  const bat = d.battery_pct ?? d.battery;

  switch (GX_CURRENT) {
    case "cpu":
      addRowIf(detail, "Uso", `${fmt(cpu)}%`);
      addRowIf(detail, "Frecuencia", cpuG != null ? `${fmt(cpuG,2)} GHz` : undefined);
      addRowIf(hw, "Cores físicos", ov.cpu_physical);
      addRowIf(hw, "Hilos lógicos", ov.cpu_logical);
      break;
    case "mem":
      addRowIf(detail, "Uso", `${fmt(memPct)}%`);
      addRowIf(detail, "Usada", `${fmt(u,1)} GB`);
      addRowIf(detail, "Total", `${fmt(t,1)} GB`);
      addRowIf(hw, "Memoria total (sistema)", ov.memory_gb ? `${fmt(ov.memory_gb,1)} GB` : undefined);
      break;
    case "gpu":
      addRowIf(detail, "Uso", gpuUtil != null ? `${fmt(gpuUtil)}%` : undefined);
      addRowIf(detail, "Temperatura", gpuTemp != null ? `${fmt(gpuTemp)} ºC` : undefined);
      if (ov.gpu) {
        const name = typeof ov.gpu === "string" ? ov.gpu : (ov.gpu.name || ov.gpu.adapter || "Desconocida");
        addRowIf(hw, "Modelo GPU", name);
      }
      break;
    case "disk":
      addRowIf(detail, "Lectura", `${fmt(diskR,1)} MB/s`);
      addRowIf(detail, "Escritura", `${fmt(diskW,1)} MB/s`);
      if (Array.isArray(ov.disks)) addRowIf(hw, "Discos", ov.disks.join(", "));
      break;
    case "net":
      addRowIf(detail, "Bajada", `${fmt(netDown,1)} MB/s`);
      addRowIf(detail, "Subida", `${fmt(netUp,1)} MB/s`);
      break;
    case "bat":
      addRowIf(detail, "Nivel", bat != null ? `${fmt(bat)}%` : "No reportado");
      break;
  }
}

/* ---------- Búsqueda ---------- */
$("#search")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = (e.target.value || "").trim().toLowerCase();
  if (!q) return;
  if (["cpu","procesador"].some(k => q.includes(k))) $(`.sb-item[data-view="graficas"]`)?.click(), clickTab("cpu");
  else if (["mem","ram","memoria"].some(k => q.includes(k))) $(`.sb-item[data-view="graficas"]`)?.click(), clickTab("mem");
  else if (["gpu","grafica","gráfica"].some(k => q.includes(k))) $(`.sb-item[data-view="graficas"]`)?.click(), clickTab("gpu");
  else if (["disco","disk","ssd","nvme"].some(k => q.includes(k))) $(`.sb-item[data-view="graficas"]`)?.click(), clickTab("disk");
  else if (["red","net","wifi","ethernet"].some(k => q.includes(k))) $(`.sb-item[data-view="graficas"]`)?.click(), clickTab("net");
  else if (["bateria","batería","battery"].some(k => q.includes(k))) $(`.sb-item[data-view="graficas"]`)?.click(), clickTab("bat");
  else $(`.sb-item[data-view="componentes"]`)?.click();
  e.target.blur();
});
function clickTab(id) {
  const btn = $(`#gx-tabs .tab[data-gx="${id}"]`);
  if (!btn) return;
  btn.click();
}

/* ---------- Tareas / Reglas (simple) ---------- */
const RULES = [];
$("#rule-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const type = $("#rule-type").value;
  const op = $("#rule-op").value;
  const thr = Number($("#rule-th").value);
  const dur = Number($("#rule-dur").value);
  RULES.push({ type, op, thr, dur, hit: 0, last: 0 });
  renderRules();
  e.target.reset();
});
function renderRules() {
  const tb = $("#tbl-rules tbody");
  if (!tb) return;
  tb.innerHTML = "";
  RULES.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i+1}</td>
      <td>${r.type} ${r.op} ${r.thr} (${r.dur}s)</td>
      <td><button class="btn btn-ghost" data-i="${i}">Eliminar</button></td>`;
    tb.appendChild(tr);
  });
  tb.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-i]");
    if (!btn) return;
    RULES.splice(Number(btn.dataset.i), 1);
    renderRules();
  }, { once: true });
}
// evaluación cada segundo reutilizando LAST_DATA
setInterval(() => {
  if (!LAST_DATA) return;
  RULES.forEach(r => {
    const v = getRuleValue(r.type, LAST_DATA);
    if (v == null) return;
    const cond = r.op === ">" ? v > r.thr : v < r.thr;
    if (cond) {
      r.hit++;
      if (r.hit >= r.dur) {
        toast("Regla disparada", `${r.type} ${r.op} ${r.thr} durante ${r.dur}s`);
        notif.add("Regla disparada", `${r.type} ${r.op} ${r.thr}`, "ok");
        r.hit = 0;
      }
    } else {
      r.hit = 0;
    }
  });
}, 1000);
function getRuleValue(type, d) {
  switch (type) {
    case "cpu": return d.cpu ?? d.cpu_pct;
    case "mem": {
      const u = d.mem_used_gb ?? 0, t = d.mem_total_gb ?? LAST_OVERVIEW?.memory_gb ?? 0;
      return t ? (u/t)*100 : d.mem_pct;
    }
    case "gpu_temp": return d.gpu_temp ?? d.gpu_temp_c;
    case "net": return (d.net_up_mb_s ?? 0) + (d.net_down_mb_s ?? 0);
  }
  return null;
}
function toast(title, msg) {
  const el = $("#rule-toast");
  if (!el) return;
  el.textContent = `${title}: ${msg}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2500);
}

/* ---------- Configuración: bindings ---------- */
$("#cfg-theme")?.addEventListener("change", e => { CFG.theme = e.target.value; saveCfg(); applyAppearance(); });
$("#cfg-accent")?.addEventListener("input", e => { CFG.accent = e.target.value; saveCfg(); applyAppearance(); });
$("#cfg-density")?.addEventListener("change", e => { CFG.density = e.target.value; saveCfg(); applyAppearance(); });
$("#cfg-anim")?.addEventListener("change", e => { CFG.anim = e.target.checked; saveCfg(); updateChartFor(GX_CURRENT); });
$("#cfg-thick")?.addEventListener("input", e => { CFG.thick = Number(e.target.value); saveCfg(); updateChartFor(GX_CURRENT); });

$("#cfg-cpu")?.addEventListener("input", e => { CFG.thr_cpu = Number(e.target.value); saveCfg(); });
$("#cfg-mem")?.addEventListener("input", e => { CFG.thr_mem = Number(e.target.value); saveCfg(); });
$("#cfg-gpu")?.addEventListener("input", e => { CFG.thr_gpu_temp = Number(e.target.value); saveCfg(); });
$("#cfg-net")?.addEventListener("input", e => { CFG.thr_net = Number(e.target.value); saveCfg(); });
$("#cfg-net-unit")?.addEventListener("change", e => { CFG.net_unit = e.target.value; saveCfg(); });

$("#cfg-save")?.addEventListener("click", () => { saveCfg(); toast("Configuración", "Guardada"); });
$("#cfg-reset")?.addEventListener("click", () => {
  CFG = { ...defaultCfg }; saveCfg(); applyAppearance(); updateChartFor(GX_CURRENT);
  // setea UI
  setConfigInputs();
  toast("Configuración", "Restablecida");
});
$("#cfg-export")?.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(CFG, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "hardwareguard-config.json";
  a.click();
});
$("#cfg-import")?.addEventListener("click", () => $("#cfg-import-file").click());
$("#cfg-import-file")?.addEventListener("change", async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  const text = await f.text();
  try {
    const obj = JSON.parse(text);
    CFG = { ...defaultCfg, ...obj }; saveCfg(); applyAppearance(); setConfigInputs(); updateChartFor(GX_CURRENT);
    toast("Configuración", "Importada");
  } catch {
    toast("Configuración", "Archivo inválido");
  }
});
function setConfigInputs() {
  $("#cfg-theme").value = CFG.theme;
  $("#cfg-accent").value = CFG.accent;
  $("#cfg-density").value = CFG.density;
  $("#cfg-anim").checked = CFG.anim;
  $("#cfg-thick").value = CFG.thick;
  $("#cfg-cpu").value = CFG.thr_cpu;
  $("#cfg-mem").value = CFG.thr_mem;
  $("#cfg-gpu").value = CFG.thr_gpu_temp;
  $("#cfg-net").value = CFG.thr_net;
  $("#cfg-net-unit").value = CFG.net_unit;
}
setConfigInputs();

/* ---------- Primera selección para gráfico ---------- */
clickTab(GX_CURRENT);
