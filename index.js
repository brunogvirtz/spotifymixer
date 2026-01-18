
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

app.post("/api/mix", requireAuth, async (req,res)=>{
  const { playlistIds, newPlaylistName } = req.body;
  let groups = playlistIds.map(()=>[]);

  for(let i=0;i<playlistIds.length;i++){
    let url = `https://api.spotify.com/v1/playlists/${playlistIds[i]}/tracks?limit=100`;
    while(url){
      const data = await spotify(req,url);
      for(const it of data.items){
        if(it.track && it.track.id) groups[i].push(it.track);
      }
      url = data.next;
    }
  }

  let result=[], idx=0, added=true;
  while(added){
    added=false;
    for(const g of groups){
      if(g[idx]){ result.push(g[idx]); added=true; }
    }
    idx++;
  }

  const me = await spotify(req,"https://api.spotify.com/v1/me");
  const create = await fetch(`https://api.spotify.com/v1/users/${me.id}/playlists`,{
    method:"POST",
    headers:{
      "Authorization":"Bearer "+req.session.token,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({name:newPlaylistName || "Mixed Playlist", public:false})
  });
  const pl = await create.json();

  for(let i=0;i<result.length;i+=100){
    const batch = result.slice(i,i+100).map(t=>"spotify:track:"+t.id);
    await fetch(`https://api.spotify.com/v1/playlists/${pl.id}/tracks`,{
      method:"POST",
      headers:{
        "Authorization":"Bearer "+req.session.token,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({uris:batch})
    });
  }

  res.json({ok:true, url:pl.external_urls.spotify});
});

const port = process.env.PORT || 3000;
app.listen(port,()=>console.log("Running on",port));
