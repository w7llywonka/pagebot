(function(){
var O="__ORIGIN__",ID="__pagebot",W=window,D=document;
var f=D.getElementById(ID);
if(f){f.style.display=f.style.display==="none"?"block":"none";return;}
function btn(){
var b=D.getElementById(ID+"_b");if(b){b.remove();}
b=D.createElement("button");b.id=ID+"_b";b.textContent="Open pagebot";
b.title="This site blocks the overlay, so pagebot opens in a small window";
b.style.cssText="all:initial;position:fixed;bottom:16px;right:16px;z-index:2147483647;padding:10px 14px;border-radius:10px;background:#d97757;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.3);";
b.onclick=function(){W.open(O+"/widget?popup=1","pagebot","width=420,height=680");b.remove();};
D.documentElement.appendChild(b);
}
if(!W.__pbListen){
W.__pbListen=1;
W.addEventListener("message",function(e){
if(e.origin!==O){return;}
var d=e.data||{},src=e.source,fr=D.getElementById(ID);
function reply(x){x.id=d.id;src.postMessage(x,O);}
if(d.type==="ready"){W.__pbReady=1;}
else if(d.type==="page"){var t=D.body?D.body.innerText:"";reply({page:{url:location.href,title:D.title,text:t.slice(0,20000)},selection:String(W.getSelection()||"").slice(0,8000)});}
else if(d.type==="hide"){if(fr){fr.style.visibility="hidden";}reply({});}
else if(d.type==="show"){if(fr){fr.style.visibility="visible";}}
else if(d.type==="close"){if(fr){fr.style.display="none";}}
});
}
if(W.__pbBlocked){btn();return;}
f=D.createElement("iframe");
f.id=ID;f.src=O+"/widget";f.allow="display-capture; clipboard-write";
f.style.cssText="all:initial;position:fixed;bottom:16px;right:16px;width:380px;height:560px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);border:0;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.45);z-index:2147483647;background:#141414;color-scheme:dark;display:block;visibility:visible;";
var done=0;
function fail(){if(done||W.__pbReady){return;}done=1;W.__pbBlocked=1;f.remove();btn();}
D.addEventListener("securitypolicyviolation",function(e){if(String(e.blockedURI||"").indexOf(O)===0){fail();}});
D.documentElement.appendChild(f);
setTimeout(fail,6000);
})();
