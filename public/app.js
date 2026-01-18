
async function logout(){
  await fetch("/logout",{method:"POST"});
}

async function loadPlaylists(){
  const r = await fetch("/api/playlists");
  if(r.status===401){ alert("Login primero"); return; }
  const j = await r.json();
  const d = document.getElementById("pls");
  d.innerHTML="";
  j.items.forEach(p=>{
    const c = document.createElement("input");
    c.type="checkbox"; c.value=p.id;
    d.appendChild(c);
    d.appendChild(document.createTextNode(" "+p.name+" ("+p.tracks.total+")"));
    d.appendChild(document.createElement("br"));
  });
}

async function mix(){
  const ids=[...document.querySelectorAll("input[type=checkbox]:checked")].map(i=>i.value);
  const name=document.getElementById("name").value;
  const r = await fetch("/api/mix",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({playlistIds:ids,newPlaylistName:name})
  });
  const j = await r.json();
  document.getElementById("out").textContent=JSON.stringify(j,null,2);
}
