
import express from "express";
import session from "express-session";
import fetch from "node-fetch";

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static("public"));

app.use(session({
  secret: process.env.SESSION_SECRET || "dev_secret",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: "lax" }
}));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;

const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public"
].join(" ");

function requireAuth(req,res,next){
  if(!req.session.token) return res.status(401).json({error:"not_logged"});
  next();
}

app.get("/login",(req,res)=>{
  const params = new URLSearchParams({
    response_type:"code",
    client_id:CLIENT_ID,
    scope:SCOPES,
    redirect_uri:REDIRECT_URI
  });
  res.redirect("https://accounts.spotify.com/authorize?"+params.toString());
});

app.get("/callback", async (req,res)=>{
  const { code } = req.query;
  if(!code) return res.send("No code");

  const body = new URLSearchParams({
    grant_type:"authorization_code",
    code,
    redirect_uri:REDIRECT_URI
  });

  const r = await fetch("https://accounts.spotify.com/api/token",{
    method:"POST",
    headers:{
      "Content-Type":"application/x-www-form-urlencoded",
      "Authorization":"Basic "+Buffer.from(CLIENT_ID+":"+CLIENT_SECRET).toString("base64")
    },
    body
  });

  const j = await r.json();
  req.session.token = j.access_token;
  res.redirect("/");
});

app.post("/logout",(req,res)=>{
  req.session.destroy(()=>res.json({ok:true}));
});

async function spotify(req,url){
  const r = await fetch(url,{headers:{Authorization:"Bearer "+req.session.token}});
  return r.json();
}


app.get("/api/me", requireAuth, async (req,res)=>{
  res.json(await spotify(req,"https://api.spotify.com/v1/me"));
});

app.get("/api/playlists", requireAuth, async (req,res)=>{
  res.json(await spotify(req,"https://api.spotify.com/v1/me/playlists?limit=50"));
});

app.post("/api/mix", requireAuth, async (req, res) => {
  const {
    playlistIds,
    newPlaylistName,
    mode = "strict", // "strict" | "flex"
    curve = "steady", // "steady" | "build" | "cooldown" | "wave"
    removeDuplicates = true,
    avoidSameArtist = true,
    preferSimilarDuration = true,
    maxTracks = 500, // tope por seguridad
  } = req.body || {};

  if (!Array.isArray(playlistIds) || playlistIds.length < 1) {
    return res.status(400).json({ error: "playlistIds_required" });
  }

  // ---------- helpers ----------
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const norm = (x, a, b) => clamp01((x - a) / (b - a));

  function targetAt(t) {
    // t in [0..1], devuelve target energy/valence (0..1)
    // Ajustalo a gusto
    if (curve === "build") {
      return { energy: 0.25 + 0.65 * t, valence: 0.30 + 0.55 * t };
    }
    if (curve === "cooldown") {
      return { energy: 0.85 - 0.60 * t, valence: 0.75 - 0.45 * t };
    }
    if (curve === "wave") {
      const w = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
      return { energy: 0.30 + 0.55 * w, valence: 0.35 + 0.50 * w };
    }
    // steady
    return { energy: 0.60, valence: 0.60 };
  }

  function trackKey(track) {
    return track?.id ? `spotify:track:${track.id}` : null;
  }

  async function spotifyJson(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        Authorization: "Bearer " + req.session.token,
      },
    });
    return r.json();
  }

  async function fetchPlaylistTracks(plId) {
    const out = [];
    let url = `https://api.spotify.com/v1/playlists/${plId}/tracks?limit=100`;
    while (url) {
      const data = await spotify(req, url);
      for (const it of data.items || []) {
        const tr = it.track;
        if (tr && tr.id) out.push(tr);
      }
      url = data.next;
    }
    return out;
  }

  async function fetchAudioFeaturesByIds(ids) {
    const map = new Map();
    // Spotify: hasta 100 ids por request
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const url =
        "https://api.spotify.com/v1/audio-features?ids=" + batch.join(",");
      const data = await spotify(req, url);
      for (const af of data.audio_features || []) {
        if (af && af.id) map.set(af.id, af);
      }
    }
    return map;
  }

  function getArtistId(track) {
    return track?.artists?.[0]?.id || "";
  }

  function featureVector(af, track) {
    // Normalizaciones razonables
    return {
      energy: af?.energy ?? 0.5,
      valence: af?.valence ?? 0.5,
      danceability: af?.danceability ?? 0.5,
      tempo: norm(af?.tempo ?? 120, 60, 180),
      loudness: norm((af?.loudness ?? -12), -30, 0), // -30..0
      duration: norm((track?.duration_ms ?? 180000) / 1000, 120, 420), // 2..7min
      acousticness: af?.acousticness ?? 0.5,
      speechiness: af?.speechiness ?? 0.33,
    };
  }

  function distance(a, b) {
    // distancia ponderada para transiciones suaves
    // (pesos ajustables)
    const w = {
      energy: 1.6,
      valence: 1.2,
      tempo: 1.0,
      loudness: 0.8,
      duration: 0.7,
      danceability: 0.6,
    };
    let d = 0;
    d += w.energy * Math.abs(a.energy - b.energy);
    d += w.valence * Math.abs(a.valence - b.valence);
    d += w.tempo * Math.abs(a.tempo - b.tempo);
    d += w.loudness * Math.abs(a.loudness - b.loudness);
    d += w.duration * Math.abs(a.duration - b.duration);
    d += w.danceability * Math.abs(a.danceability - b.danceability);
    return d;
  }

  function targetPenalty(vec, t) {
    const tgt = targetAt(t);
    // penaliza estar lejos del target a lo largo del mix
    return 0.9 * Math.abs(vec.energy - tgt.energy) + 0.7 * Math.abs(vec.valence - tgt.valence);
  }

  // ---------- 1) cargar tracks por playlist ----------
  const perPlaylist = [];
  for (const plId of playlistIds) {
    perPlaylist.push(await fetchPlaylistTracks(plId));
  }

  // flatten con metadata de origen
  let candidates = [];
  for (let i = 0; i < perPlaylist.length; i++) {
    for (const tr of perPlaylist[i]) {
      candidates.push({
        track: tr,
        plIndex: i,
        uri: trackKey(tr),
        artistId: getArtistId(tr),
      });
    }
  }

  if (removeDuplicates) {
    const seen = new Set();
    candidates = candidates.filter((c) => {
      if (!c.uri) return false;
      if (seen.has(c.uri)) return false;
      seen.add(c.uri);
      return true;
    });
  }

  // limitar
  if (candidates.length > maxTracks * 5) {
    candidates = candidates.slice(0, maxTracks * 5);
  }

  // ---------- 2) audio features ----------
  const ids = [...new Set(candidates.map((c) => c.track.id))];
  const afMap = await fetchAudioFeaturesByIds(ids);

  // Precompute vectors
  for (const c of candidates) {
    const af = afMap.get(c.track.id);
    c.af = af;
    c.vec = featureVector(af, c.track);
  }

  // ---------- 3) preparar buckets por playlist ----------
  const buckets = playlistIds.map(() => []);
  for (const c of candidates) buckets[c.plIndex].push(c);

  // shuffle ligero dentro de cada bucket para no sesgar por orden original
  // (si querés respetar más el orden original, sacá esto)
  for (const b of buckets) {
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
  }

  // ---------- 4) build sequence ----------
  const selected = [];
  const used = new Set();
  const counts = playlistIds.map(() => 0);

  function fairnessPenalty(plIndex, step) {
    if (mode === "strict") return 0;
    // en flex, empuja al balance
    const total = step + 1;
    const expected = total / playlistIds.length;
    const over = Math.max(0, counts[plIndex] - expected);
    return 0.12 * over; // ajustable
  }

  function recentPlaylistPenalty(plIndex) {
    if (!selected.length) return 0;
    const last = selected[selected.length - 1];
    if (last.plIndex === plIndex) return 0.25;
    return 0;
  }

  function artistPenalty(candidate) {
    if (!avoidSameArtist) return 0;
    if (!selected.length) return 0;
    const lastArtist = selected[selected.length - 1].artistId;
    return lastArtist && candidate.artistId && lastArtist === candidate.artistId ? 0.35 : 0;
  }

  function durationJumpPenalty(vec) {
    if (!preferSimilarDuration) return 0;
    if (!selected.length) return 0;
    const prev = selected[selected.length - 1].vec;
    const jump = Math.abs(prev.duration - vec.duration);
    return 0.25 * jump; // 0..0.25
  }

  function scoreCandidate(candidate, step) {
    const t = (maxTracks <= 1) ? 0 : step / (maxTracks - 1);
    let s = 0;

    // smooth transition from previous
    if (selected.length) {
      s += distance(selected[selected.length - 1].vec, candidate.vec);
    } else {
      // primer tema: acercarlo al target inicial
      s += 0.7 * targetPenalty(candidate.vec, 0);
    }

    // follow curve target
    s += targetPenalty(candidate.vec, t);

    // penalties
    s += artistPenalty(candidate);
    s += recentPlaylistPenalty(candidate.plIndex);
    s += fairnessPenalty(candidate.plIndex, step);
    s += durationJumpPenalty(candidate.vec);

    return s;
  }

  function pickFromBucket(bucketIndex, step) {
    const bucket = buckets[bucketIndex];
    let best = null;
    let bestScore = Infinity;

    // miramos top K para mantener performance
    const K = Math.min(30, bucket.length);
    for (let i = 0; i < bucket.length && i < K; i++) {
      const c = bucket[i];
      if (used.has(c.uri)) continue;
      const sc = scoreCandidate(c, step);
      if (sc < bestScore) {
        bestScore = sc;
        best = c;
      }
    }

    if (!best) return null;

    used.add(best.uri);
    counts[best.plIndex] += 1;
    selected.push(best);

    // removemos best del bucket para no volver a evaluarlo
    const idx = bucket.indexOf(best);
    if (idx >= 0) bucket.splice(idx, 1);

    return best;
  }

  function pickGlobal(step) {
    // busca en todos los buckets el mejor (con fairness penalty)
    let best = null;
    let bestScore = Infinity;
    let bestBucket = -1;

    for (let bi = 0; bi < buckets.length; bi++) {
      const bucket = buckets[bi];
      if (!bucket.length) continue;

      const K = Math.min(20, bucket.length);
      for (let i = 0; i < K; i++) {
        const c = bucket[i];
        if (used.has(c.uri)) continue;
        const sc = scoreCandidate(c, step);
        if (sc < bestScore) {
          bestScore = sc;
          best = c;
          bestBucket = bi;
        }
      }
    }

    if (!best) return null;

    used.add(best.uri);
    counts[best.plIndex] += 1;
    selected.push(best);

    const bucket = buckets[bestBucket];
    const idx = bucket.indexOf(best);
    if (idx >= 0) bucket.splice(idx, 1);

    return best;
  }

  for (let step = 0; step < maxTracks; step++) {
    let picked = null;

    if (mode === "strict") {
      // turno fijo: round-robin por playlist
      const bi = step % buckets.length;
      picked = pickFromBucket(bi, step);

      // si esa playlist se quedó sin tracks, buscamos la próxima con tracks
      if (!picked) {
        for (let tries = 1; tries < buckets.length; tries++) {
          const alt = (bi + tries) % buckets.length;
          picked = pickFromBucket(alt, step);
          if (picked) break;
        }
      }
    } else {
      // flex: elige el mejor global con penalizaciones de balance
      picked = pickGlobal(step);
    }

    if (!picked) break;
  }

  const orderedUris = selected.map((c) => c.uri).filter(Boolean);

  // ---------- 5) crear playlist y subir tracks ----------
  const me = await spotify(req, "https://api.spotify.com/v1/me");
  const create = await fetch(`https://api.spotify.com/v1/users/${me.id}/playlists`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + req.session.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: newPlaylistName || "Roadtrip mix ✨",
      public: false,
      description: `SpotifyMixer (${mode}, ${curve}) • ${orderedUris.length} tracks`,
    }),
  });
  const pl = await create.json();

  for (let i = 0; i < orderedUris.length; i += 100) {
    const batch = orderedUris.slice(i, i + 100);
    await fetch(`https://api.spotify.com/v1/playlists/${pl.id}/tracks`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + req.session.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uris: batch }),
    });
  }

  // Traer playlist final (para portada + tracks)
  const plFinal = await spotifyJson(`https://api.spotify.com/v1/playlists/${pl.id}`);

  res.json({
    ok: true,
    id: plFinal.id,
    url: plFinal.external_urls?.spotify,
    name: plFinal.name,
    tracksTotal: plFinal.tracks?.total ?? orderedUris.length,
    image: plFinal.images?.[0]?.url || "",
    mode,
    curve,
    usedTracks: orderedUris.length,
  });
});


const port = process.env.PORT || 3000;
app.listen(port,()=>console.log("Running on",port));
