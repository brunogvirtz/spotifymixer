const els = {
  btnLogin: document.getElementById("btnLogin"),
  btnLogout: document.getElementById("btnLogout"),
  btnLoad: document.getElementById("btnLoad"),
  btnAll: document.getElementById("btnAll"),
  btnNone: document.getElementById("btnNone"),
  btnMix: document.getElementById("btnMix"),

  loginCard: document.getElementById("loginCard"),
  appGrid: document.getElementById("appGrid"),

  userPill: document.getElementById("userPill"),
  userName: document.getElementById("userName"),

  search: document.getElementById("search"),
  plName: document.getElementById("plName"),

  playlistList: document.getElementById("playlistList"),
  selCount: document.getElementById("selCount"),
  plCount: document.getElementById("plCount"),
  out: document.getElementById("out"),

  toast: document.getElementById("toast"),

  result: document.getElementById("result"),

  curve: document.getElementById("curve"),
  optDup: document.getElementById("optDup"),
  optArtist: document.getElementById("optArtist"),
  optDur: document.getElementById("optDur"),


};

let playlistsCache = [];
let selectedIds = new Set();

function toast(msg, detail = "") {
  els.toast.innerHTML = `${msg}${detail ? `<small>${detail}</small>` : ""}`;
  els.toast.classList.add("show");
  clearTimeout(window.__toastT);
  window.__toastT = setTimeout(() => els.toast.classList.remove("show"), 2800);
}

async function api(url, opts) {
  const r = await fetch(url, opts);
  const contentType = r.headers.get("content-type") || "";
  let data = null;
  if (contentType.includes("application/json")) data = await r.json();
  else data = await r.text();

  if (!r.ok) {
    const errMsg = (data && data.error) ? data.error : (typeof data === "string" ? data : "request_failed");
    throw new Error(errMsg);
  }
  return data;
}

function updateCounts() {
  els.selCount.textContent = String(selectedIds.size);
  els.btnMix.disabled = selectedIds.size < 1;
}

function matchesSearch(p, q) {
  if (!q) return true;
  return (p.name || "").toLowerCase().includes(q);
}

function renderPlaylists() {
  const q = (els.search.value || "").trim().toLowerCase();
  const items = playlistsCache.filter(p => matchesSearch(p, q));

  els.plCount.textContent = String(items.length);
  els.playlistList.innerHTML = "";

  if (!items.length) {
    const div = document.createElement("div");
    div.style.color = "rgba(255,255,255,.65)";
    div.style.fontSize = "13px";
    div.textContent = "No hay playlists para mostrar con ese filtro.";
    els.playlistList.appendChild(div);
    return;
  }

  for (const p of items) {
    const row = document.createElement("div");
    row.className = "plItemCompact";

    const cover = document.createElement("div");
    cover.className = "plCover";
    if (p.image) {
      const img = document.createElement("img");
      img.src = p.image;
      img.alt = p.name || "Playlist";
      cover.appendChild(img);
    } else {
      cover.classList.add("plCoverFallback");
      cover.textContent = "♪";
    }

    const meta = document.createElement("div");
    meta.className = "plMetaCompact";

    const name = document.createElement("div");
    name.className = "plNameCompact";
    name.textContent = p.name || "(sin nombre)";

    const sub = document.createElement("div");
    sub.className = "plSubCompact";
    sub.textContent = `${p.tracksTotal} canciones`;

    meta.appendChild(name);
    meta.appendChild(sub);

    const btn = document.createElement("button");
    btn.className = "btn btnSmall";
    const isOn = selectedIds.has(p.id);
    btn.textContent = isOn ? "Agregada" : "Agregar";
    if (isOn) btn.classList.add("btnOn");

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (selectedIds.has(p.id)) selectedIds.delete(p.id);
      else selectedIds.add(p.id);
      renderPlaylists();
    });

    row.addEventListener("click", () => {
      if (selectedIds.has(p.id)) selectedIds.delete(p.id);
      else selectedIds.add(p.id);
      renderPlaylists();
    });

    row.appendChild(cover);
    row.appendChild(meta);
    row.appendChild(btn);

    els.playlistList.appendChild(row);
  }


  updateCounts();
}

async function checkAuth() {
  try {
    const me = await api("/api/me");
    // Auth OK
    els.userName.textContent = me.display_name || me.id || "Spotify";
    els.userPill.classList.remove("hidden");

    els.btnLogin.classList.add("hidden");
    els.btnLogout.classList.remove("hidden");

    els.loginCard.classList.add("hidden");
    els.appGrid.classList.remove("hidden");

    toast("Conectado ✅", `Hola ${me.display_name || me.id}`);
    return true;
  } catch {
    // Not logged
    els.userPill.classList.add("hidden");

    els.btnLogin.classList.remove("hidden");
    els.btnLogout.classList.add("hidden");

    els.loginCard.classList.remove("hidden");
    els.appGrid.classList.add("hidden");
    return false;
  }
}

async function loadPlaylists() {
  try {
    els.btnLoad.disabled = true;
    els.btnLoad.textContent = "Cargando…";
    const data = await api("/api/playlists");

    playlistsCache = (data.items || []).map(p => ({
      id: p.id,
      name: p.name,
      tracksTotal: p.tracks?.total ?? 0,
      image: p.images?.[0]?.url || "",
      owner: p.owner?.display_name || "",
    }));


    // Limpio selección si algo ya no existe
    const valid = new Set(playlistsCache.map(p => p.id));
    selectedIds = new Set([...selectedIds].filter(id => valid.has(id)));

    renderPlaylists();
    toast("Playlists cargadas", `${playlistsCache.length} encontradas`);
  } catch (e) {
    toast("Error cargando playlists", String(e.message || e));
  } finally {
    els.btnLoad.disabled = false;
    els.btnLoad.textContent = "Cargar";
  }
}

function renderResult(res, playlistCount) {
  if (!res || !res.ok) return;

  const imgHtml = res.image
    ? `<img src="${res.image}" alt="Playlist cover">`
    : `<div class="resultCoverFallback">♪</div>`;

  els.result.innerHTML = `
    <div class="resultCover">${imgHtml}</div>
    <div class="resultMeta">
      <div class="resultTitle">${escapeHtml(res.name || "Playlist creada")}</div>
      <div class="resultSub">
        <span class="tagBig">${res.tracksTotal ?? 0} canciones</span>
        <span class="tagBig">Mezcla de ${playlistCount} playlists</span>
      </div>
    </div>
    <div class="resultActions">
      <a class="btn btnSpotify btnBig" href="${res.url}" target="_blank" rel="noopener noreferrer">
        Ver playlist
      </a>
    </div>
  `;
  els.result.classList.remove("hidden");
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}


async function mix() {
  try {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const mode = document.querySelector('input[name="mode"]:checked')?.value || "strict";
    const curve = els.curve.value || "steady";
    const removeDuplicates = !!els.optDup.checked;
    const avoidSameArtist = !!els.optArtist.checked;
    const preferSimilarDuration = !!els.optDur.checked;


    const name = (els.plName.value || "").trim() || "Roadtrip mix ✨";

    els.btnMix.disabled = true;
    els.btnMix.textContent = "Creando…";
    els.out.textContent = "{\n  \"status\": \"Creando playlist...\"\n}";

    const res = await api("/api/mix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playlistIds: ids,
        newPlaylistName: name,
        mode,
        curve,
        removeDuplicates,
        avoidSameArtist,
        preferSimilarDuration,
      }),
    });

    els.out.textContent = JSON.stringify(res, null, 2);
    renderResult(res, ids.length);

    if (res.url) {
      toast("Listo 🎉", "Playlist creada. Abrila desde la salida.");
    } else {
      toast("Listo", "Playlist creada.");
    }
  } catch (e) {
    els.out.textContent = JSON.stringify({ error: String(e.message || e) }, null, 2);
    toast("Error creando playlist", String(e.message || e));
  } finally {
    els.btnMix.disabled = selectedIds.size < 1;
    els.btnMix.textContent = "Crear mezclada";
  }
}

// Wire up
els.btnLogin.addEventListener("click", () => location.href = "/login");
els.btnLogout.addEventListener("click", async () => {
  try {
    await api("/logout", { method: "POST" });
    selectedIds.clear();
    playlistsCache = [];
    els.playlistList.innerHTML = "";
    els.out.textContent = "{}";
    els.result.classList.add("hidden");
    els.result.innerHTML = "";
    toast("Sesión cerrada", "Volvé a conectar cuando quieras.");
  } catch {}
  await checkAuth();
});

els.btnLoad.addEventListener("click", loadPlaylists);
els.btnAll.addEventListener("click", () => {
  const q = (els.search.value || "").trim().toLowerCase();
  // Selecciona solo los visibles con filtro
  for (const p of playlistsCache) {
    if (matchesSearch(p, q)) selectedIds.add(p.id);
  }
  renderPlaylists();
});
els.btnNone.addEventListener("click", () => {
  selectedIds.clear();
  renderPlaylists();
});
els.search.addEventListener("input", renderPlaylists);
els.btnMix.addEventListener("click", mix);

// Boot
(async function init(){
  const ok = await checkAuth();
  if (ok) {
    // auto-cargar para que se vea vivo
    await loadPlaylists();
  }
})();
