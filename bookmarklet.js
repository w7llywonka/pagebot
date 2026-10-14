(function(){
var O="__ORIGIN__",ID="__pagebot",W=window,D=document,P=W.__pb,TR="opacity .22s ease,transform .22s cubic-bezier(.2,.8,.2,1),width .18s ease,height .18s ease,border-radius .18s ease";
if(P&&P.f&&P.f.isConnected){if(P.ready||Date.now()-P.t<4000){P.toggle();return;}P.f.remove();P.f=null;P.blocked=1;}
if(!P){
P=W.__pb={r:16,b:16,mw:200,mh:46};
P.win=function(){if(P.w&&!P.w.closed){P.w.focus();}else{P.w=W.open(O+"/widget?popup=1","pagebot","width=420,height=680");}};
P.place=function(now){
var f=P.f;if(!f){return;}
var s=f.style,vw=W.innerWidth,vh=W.innerHeight,w,h;
s.transition=now?"none":TR;
if(P.full){s.left=s.top="0";s.right=s.bottom="auto";s.width="100vw";s.height="100vh";s.borderRadius="0";s.boxShadow="none";}
else{
w=P.min?P.mw:Math.min(380,vw-32);h=P.min?P.mh:Math.min(560,vh-32);
P.r=Math.max(0,Math.min(P.r,vw-w));P.b=Math.max(0,Math.min(P.b,vh-h));
s.left=s.top="auto";s.right=P.r+"px";s.bottom=P.b+"px";s.width=w+"px";s.height=h+"px";
s.borderRadius=P.min?P.mh/2+"px":"14px";s.boxShadow="0 10px 40px rgba(0,0,0,.45)";
}
if(now){void f.offsetWidth;s.transition=TR;}
};
P.show=function(){
var s=P.f.style;P.open=1;s.display="block";
requestAnimationFrame(function(){requestAnimationFrame(function(){if(P.open){s.opacity="1";s.transform="none";}});});
};
P.hide=function(){
var s=P.f.style;P.open=0;s.opacity="0";s.transform="translateY(12px) scale(.97)";
setTimeout(function(){if(!P.open){s.display="none";}},220);
};
P.toggle=function(){
if(!P.open){P.show();if(P.min){P.f.contentWindow.postMessage({type:"restore"},O);}}
else if(P.min){P.f.contentWindow.postMessage({type:"restore"},O);}
else{P.hide();}
};
W.addEventListener("message",function(e){
if(e.origin!==O){return;}
var d=e.data||{},t=d.type,f=P.f,s=f&&f.style,src=e.source;
function reply(x){x.id=d.id;src.postMessage(x,O);}
if(t==="page"){var x=D.body?D.body.innerText:"";reply({page:{url:location.href,title:D.title,text:x.slice(0,Math.min(d.max||20000,400000))},selection:String(W.getSelection()||"").slice(0,8000)});return;}
if(!f||src!==f.contentWindow){if(t==="hide"){reply({});}return;}
if(t==="ready"){P.ready=1;if(d.pos&&d.pos.r>=0&&d.pos.b>=0){P.r=+d.pos.r;P.b=+d.pos.b;}P.place(1);P.show();}
else if(t==="hide"){s.visibility="hidden";reply({});}
else if(t==="show"){s.visibility="visible";}
else if(t==="close"){P.hide();}
else if(t==="drag"){P.r-=+d.dx||0;P.b-=+d.dy||0;P.place();}
else if(t==="where"){reply({pos:{r:P.r,b:P.b}});}
else if(t==="min"){P.min=d.on?1:0;if(d.w>0&&d.h>0){P.mw=+d.w;P.mh=+d.h;}P.place();}
else if(t==="full"){P.full=d.on?1:0;if(!d.on){s.visibility="hidden";}P.place(1);reply({});}
});
W.addEventListener("resize",function(){P.place(1);});
}
if(P.blocked){P.win();return;}
var old=D.getElementById(ID);if(old){old.remove();}
old=D.getElementById(ID+"_b");if(old){old.remove();}
var f=P.f=D.createElement("iframe");
f.id=ID;f.src=O+"/widget?v=2";f.title="pagebot";f.allow="display-capture; clipboard-write";
f.style.cssText="all:initial;position:fixed;z-index:2147483647;border:0;display:block;visibility:visible;opacity:0;transform:translateY(12px) scale(.97);transform-origin:100% 100%;background:transparent;";
P.ready=0;P.open=1;P.min=0;P.full=0;P.t=Date.now();P.place(1);
D.addEventListener("securitypolicyviolation",function(e){if(P.f===f&&!P.ready&&String(e.blockedURI||"").indexOf(O)===0){f.remove();P.f=null;P.blocked=1;P.win();}});
D.documentElement.appendChild(f);
})();
