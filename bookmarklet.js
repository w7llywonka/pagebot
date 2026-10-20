(function(){
var O="__ORIGIN__",ID="__pagebot",W=window,D=document,P=W.__pb,TR="opacity .22s ease,transform .22s cubic-bezier(.2,.8,.2,1),width .18s ease,height .18s ease,border-radius .18s ease";
if(P&&P.f&&P.f.isConnected){if(P.ready||Date.now()-P.t<4000){P.toggle();return;}P.f.remove();P.f=null;P.blocked=1;}
if(!P){
P=W.__pb={r:16,b:16,w:380,h:560,mw:200,mh:46,dw:420,v:__VERSION__};
/* v11: the default panel is about half the window (50% wide, 80% tall; the docked sidebar 40% wide), worked out when the page loads.
   Sizes a person saved still win: the panel sends those on "ready". The literals above are only the fallback for a window that reports no size. */
P.def=function(){var vw=W.innerWidth,vh=W.innerHeight;if(!(vw>0&&vh>0)){return;}P.w=Math.min(Math.max(Math.round(vw*.5),360),vw-32);P.h=Math.min(Math.max(Math.round(vh*.8),420),vh-32);P.dw=Math.min(Math.max(Math.round(vw*.4),420),vw-40);};P.def();
P.lit=function(){var e=[D.body,D.documentElement],i,c,m;for(i=0;i<2;i++){if(e[i]){c=getComputedStyle(e[i]).backgroundColor;m=c.match(/[\d.]+/g);if(m&&(m.length<4||+m[3]>.5)){return .299*m[0]+.587*m[1]+.114*m[2]>140;}}}return true;};
P.win=function(){var sc=W.screen||{},pw=sc.availWidth>0?Math.min(Math.max(Math.round(sc.availWidth*.5),420),sc.availWidth):420,ph=sc.availHeight>0?Math.min(Math.max(Math.round(sc.availHeight*.8),680),sc.availHeight):680;if(P.pop&&!P.pop.closed){P.pop.focus();}else{P.pop=W.open(O+"/widget?popup=1&v="+P.v,"pagebot","width="+pw+",height="+ph);}};
P.bounds=function(){if(P.full||(P.dock&&!P.min)){return;}var w=P.min?P.mw:Math.min(P.w,W.innerWidth-32),h=P.min?P.mh:Math.min(P.h,W.innerHeight-32);P.r=Math.max(0,Math.min(P.r,W.innerWidth-w));P.b=Math.max(0,Math.min(P.b,W.innerHeight-h));};
/* Pointer events can arrive several times per frame. Keep their state current, then paint once. */
P.schedulePlace=function(now){P.placeNow=P.placeNow||now;if(P.placeFrame){return;}P.placeFrame=requestAnimationFrame(function(){var n=P.placeNow;P.placeFrame=0;P.placeNow=0;P.place(n);});};
P.place=function(now){
var f=P.f;if(!f){return;}
var s=f.style,vw=W.innerWidth,vh=W.innerHeight,w,h,dk=P.dock&&!P.min&&!P.full;
s.transition=now?"none":TR;
if(P.full){s.left=s.top="0";s.right=s.bottom="auto";s.width="100vw";s.height="100vh";s.borderRadius="0";}
else if(dk){s.left=s.bottom="auto";s.top=s.right="0";s.width=Math.min(P.dw,vw-40)+"px";s.height="100vh";s.borderRadius="0";}
else{
w=P.min?P.mw:Math.min(P.w,vw-32);h=P.min?P.mh:Math.min(P.h,vh-32);
P.bounds();
s.left=s.top="auto";s.right=P.r+"px";s.bottom=P.b+"px";s.width=w+"px";s.height=h+"px";
s.borderRadius=P.min?P.mh/2+"px":"14px";
}
s.boxShadow=P.full||P.clear?"none":dk?"-10px 0 36px rgba(0,0,0,.3)":P.glass?"0 12px 40px rgba(0,0,0,.25),inset 0 0 0 1px rgba(255,255,255,.4),inset 0 1px 0 rgba(255,255,255,.6)":"0 10px 40px rgba(0,0,0,.45)";
s.backdropFilter=P.glass&&!P.full?"blur(10px) saturate(1.7)":"";s.setProperty("-webkit-backdrop-filter",s.backdropFilter);
if(now){void f.offsetWidth;s.transition=TR;}
};
P.show=function(){
var s=P.f.style;P.open=1;s.display="block";if(P.ready){P.f.contentWindow.postMessage({type:"open"},O);}
requestAnimationFrame(function(){requestAnimationFrame(function(){if(P.open){s.opacity="1";s.transform="none";}});});
};
P.hide=function(){
var s=P.f.style;P.open=0;s.opacity="0";s.transform="translateY(12px) scale(.97)";
setTimeout(function(){if(!P.open&&P.f){s.display="none";P.f.contentWindow.postMessage({type:"hidden"},O);}},220);
};
P.toggle=function(){
if(!P.open){P.show();if(P.min){P.f.contentWindow.postMessage({type:"restore"},O);}}
else if(P.min){P.f.contentWindow.postMessage({type:"restore"},O);}
else{P.hide();}
};
P.sel=function(){
var x=String(W.getSelection()||"").trim().slice(0,8000),t=P.f?(P.ready?P.f.contentWindow:null):(P.pop&&!P.pop.closed?P.pop:null);
if(t&&x!==P.st){P.st=x;t.postMessage({type:"sel",text:x},O);}
};
D.addEventListener("selectionchange",function(){clearTimeout(P.sd);P.sd=setTimeout(P.sel,160);});
P.unmark=function(){if(W.CSS&&CSS.highlights){CSS.highlights.delete("pagebot");}if(P.ol){P.ol.style.outline=P.oo;P.ol=null;}};
P.find=function(q,add){
var n=String(q).replace(/\s+/g,"").toLowerCase(),s="",a=[],m=[],len=0,tw,t,x,tries,p,at,from,r,first,best=null,el,cs,css="::highlight(pagebot){background-color:rgba(255,196,0,.5);color:inherit}";
if(n.length<2){return 0;}
tw=D.createTreeWalker(D.body||D.documentElement,4,{acceptNode:function(e){var g=e.parentNode&&e.parentNode.nodeName;return g==="SCRIPT"||g==="STYLE"||g==="NOSCRIPT"||g==="TEMPLATE"?2:1;}});
/* Index text nodes rather than allocating two entries for every character on the page. */
while(len<1e6&&(t=tw.nextNode())){x=t.nodeValue.replace(/\s+/g,"").toLowerCase().slice(0,1e6-len);if(x){a.push({node:t,start:len,end:len+x.length});m.push(x);len+=x.length;}}
s=m.join("");
function point(offset,end){
var lo=0,hi=a.length-1,k,v,re=/\s+|\u0130/g,hit,shift=0;
while(lo<hi){k=(lo+hi)>>1;if(a[k].end<=offset){lo=k+1;}else{hi=k;}}
v=a[lo];offset-=v.start;
/* Whitespace disappears; capital dotted I lowercases to two UTF-16 units. */
/* Cache only these sparse adjustments for matched nodes, including repeated hidden matches. */
if(!v.map){v.map=[];while((hit=re.exec(v.node.nodeValue))){k=hit.index-shift;if(hit[0]==="\u0130"){k++;shift--;}else{shift+=hit[0].length;}v.map.push(k,shift);}}
lo=0;hi=v.map.length/2;
while(lo<hi){k=(lo+hi)>>1;if(v.map[k*2]<=offset){lo=k+1;}else{hi=k;}}
return {node:v.node,offset:offset+(lo?v.map[(lo-1)*2+1]:0)+(end?1:0)};
}
tries=n.length>60?[n,n.slice(0,40),n.slice(-40)]:[n];
for(p=0;p<tries.length&&!best;p++){
first=null;from=0;
while((at=s.indexOf(tries[p],from))>=0){
r=D.createRange();x=point(at,0);r.setStart(x.node,x.offset);x=point(at+tries[p].length-1,1);r.setEnd(x.node,x.offset);
if(r.getClientRects().length){best=r;break;}
if(!first){first=r;}
from=at+1;
}
best=best||first;
}
if(!best){return 0;}
if(!add){P.unmark();}el=best.startContainer.parentElement;
if(W.Highlight&&W.CSS&&CSS.highlights){
if(!P.hs){P.hs=1;try{cs=new CSSStyleSheet();cs.replaceSync(css);D.adoptedStyleSheets=D.adoptedStyleSheets.concat(cs);}catch(e){cs=D.createElement("style");cs.textContent=css;(D.head||D.documentElement).appendChild(cs);}}
/* add: one more passage in the same highlight (page actions highlight several at once) */
if(add&&P.hl&&CSS.highlights.get("pagebot")===P.hl){P.hl.add(best);}else{P.hl=new Highlight(best);CSS.highlights.set("pagebot",P.hl);}
}else if(el&&!add){P.ol=el;P.oo=el.style.outline;el.style.outline="3px solid rgba(255,190,0,.9)";}
if(el&&el.scrollIntoView&&!add){el.scrollIntoView({block:"center",behavior:"smooth"});}
return 1;
};
D.addEventListener("pointerdown",function(){if(P.ol||(W.CSS&&CSS.highlights&&CSS.highlights.has("pagebot"))){P.unmark();}},true);
/* v9 page actions: refs, and the safety checks (no passwords, cards or file pickers; clicks that leave the page need sure), live here */
P.refs=[];P.rm=new WeakMap();
P.tx=function(s,n){return String(s||"").replace(/\s+/g," ").trim().slice(0,n||80);};
P.vis=function(e){var l=e.labels&&e.labels[0];return !!(e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden"||l&&l.getClientRects().length);};
P.role=function(e){var t=e.tagName,y=(e.type||"").toLowerCase(),r=e.getAttribute("role")||"";
return t==="SELECT"?"select":t==="TEXTAREA"||e.isContentEditable&&t!=="INPUT"?"textbox":t==="INPUT"?/^(checkbox|radio|file)$/.test(y)?y:/^(submit|button|reset|image)$/.test(y)?"button":"textbox":/^(button|link|checkbox|radio|switch)$/.test(r)?r:t==="A"?"link":"button";};
/* a <label>'s own words, without the dropdown options or fields inside it */
P.lt=function(l){var c=l.cloneNode(true);[].forEach.call(c.querySelectorAll("select,textarea,input,script,style"),function(x){x.remove();});return c.textContent;};
P.lab=function(e){var a=e.getAttribute("aria-label"),b=e.getAttribute("aria-labelledby"),l=e.labels&&e.labels[0],m=e.querySelector&&e.querySelector("img[alt]"),f=/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName);
if(!a&&b){b=D.getElementById(b.split(/\s+/)[0]);a=b&&b.textContent;}
return P.tx(a||l&&P.lt(l)||(f?/^(submit|button|reset)$/.test(e.type)&&e.value||e.placeholder||e.title||e.name:e.innerText||e.title||m&&m.alt)||!f&&e.getAttribute("href"));};
/* protected fields, matched on everything that can name one: type, name, id, autocomplete, every label (aria-labelledby too), title, placeholder, and text drawn as dots */
P.bad=function(e){var y=(e.type||"").toLowerCase(),b=e.getAttribute("aria-labelledby"),c,s;
if(y==="file"){return "file";}
if(!/^(textbox|select)$/.test(P.role(e))){return "";}
b=b?b.split(/\s+/).map(function(i){var n=D.getElementById(i);return n?n.textContent:"";}).join(" "):"";
s=[e.name,e.id,e.getAttribute("autocomplete"),e.getAttribute("aria-label"),b,e.placeholder,e.title,[].map.call(e.labels||[],function(l){return l.innerText;}).join(" ")].join(" ");
try{c=getComputedStyle(e).webkitTextSecurity;}catch(x){}
return y==="password"||c&&c!=="none"||/passw|passcode|\bpwd\b|one-time-code|\botp\b|\bpin\b|secret/i.test(s)?"password":/\bcc-|(?:^|[^a-z])cc[_ ]?(?:num|no\b|name|exp|cv|sec|csc|type|month|year|code|holder)|credit|debit|card.?(n(o|um)|code|ver|sec|exp|cvc|cvv|holder)|cvv|cvc|\bcsc\b|security.?code|expir|exp(iry)?.?(date|month|year)|mm\W{0,3}yy|(?:[\dx\u2022*#]{4}[ -]){3}[\dx\u2022*#]{4}/i.test(s)?"payment":"";};
/* where a click would go. nav: this page is left for it (a link to another address, a form submit). tab: another site opens in a new tab or window.
   #links, same-site new tabs and plain buttons stay. A submit button's own formaction/formtarget/formmethod come first, and attributes are
   read with getAttribute, since a field named "target" or "action" shadows the form's properties (and e.formAction is the page's own address when there's no formaction). */
P.go=function(e){var a=e.closest&&e.closest("a[href]"),f=e.form,t=e.tagName,y=(e.type||"").toLowerCase(),u,g,h,r={nav:"",tab:""},
w=function(x){return x&&!/^_(self|top|parent)$/i.test(x);},
far=function(x){try{return new URL(x,location.href).origin!==new URL(location.href).origin;}catch(z){return true;}};
if(a){h=a.getAttribute("href")||"";u=typeof a.href==="string"?a.href:h;g=a.getAttribute("target");
if(/^\s*#/.test(h)||u.indexOf("#")>0&&u.split("#")[0]===location.href.split("#")[0]){return r;}
if(/^\s*javascript:/i.test(h)){if(!/^\s*javascript:\s*(void\s*\(?\s*0?\s*\)?\s*;?)?\s*$/i.test(h)){r.nav="javascript:";}return r;}
if(a.hasAttribute("download")&&!far(u)){return r;}
if(w(g)){if(far(u)){r.tab=u;}}else{r.nav=u;}
return r;}
if(f&&(t==="BUTTON"&&!/^(button|reset)$/.test(y)||t==="INPUT"&&/^(submit|image)$/.test(y))&&!/^dialog$/i.test(e.getAttribute("formmethod")||f.getAttribute("method")||"")){
u=e.getAttribute("formaction")||f.getAttribute("action")||"";try{u=new URL(u,D.baseURI||location.href).href;}catch(z){u=location.href;}g=e.hasAttribute("formtarget")?e.getAttribute("formtarget"):f.getAttribute("target");
if(w(g)){if(far(u)){r.tab=u;}}else{r.nav=u;}}
return r;};
P.on=function(e){return e.tagName==="INPUT"?e.checked:e.getAttribute("aria-checked")==="true";};
P.els=function(q){var c=[],o=[],s=D.querySelectorAll('input:not([type=hidden]),textarea,select,button,a[href],[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[contenteditable=""],[contenteditable=true]'),i,e,x,r,b;
q=P.tx(q,100).toLowerCase();
for(i=0;i<s.length&&c.length<2000;i++){e=s[i];if(P.vis(e)){x={role:P.role(e),label:P.lab(e),e:e};if((x.label+" "+(e.name||"")).toLowerCase().indexOf(q)>=0){c.push(x);}}}
c.sort(function(a,b){return (a.role==="link")-(b.role==="link")+(a.role==="button")*.5-(b.role==="button")*.5;});
for(i=0;i<c.length&&i<150;i++){x=c[i];e=x.e;delete x.e;
r=P.rm.get(e);if(!r){r=P.refs.push(e);P.rm.set(e,r);}x.ref=r;b=P.bad(e);
if(b){x.no=b;if(e.value){x.value="••••";}}
else if(x.role==="textbox"){x.value=P.tx(e.isContentEditable?e.innerText:e.value,100);}
else if(x.role==="select"){r=e.options[e.selectedIndex];x.value=P.tx(r&&r.text);x.opts=[].slice.call(e.options,0,15).map(function(o){return P.tx(o.text,40);});}
if(/^(checkbox|radio|switch)$/.test(x.role)){x.checked=P.on(e);}
if(e.disabled||e.getAttribute("aria-disabled")==="true"){x.off=1;}
if(e.tagName==="INPUT"&&x.role==="textbox"&&e.type!=="text"){x.type=e.type;}
b=P.go(e);if(b.nav){x.nav=1;}else if(b.tab){x.tab=1;}
o.push(x);}
return {els:o,more:c.length-o.length};};
/* one tool call; a refusal is {no:reason}. dry: check and describe it only */
P.act=function(d){var n=d.name,i=d.input||{},e=P.refs[(i.ref|0)-1],r,b,g,h,o,v,t=String(i.text==null?"":i.text).slice(0,5000);
if(n==="els"){return P.els(i.query);}
if(n==="hl"){r=[];b=0;[].concat(i.quotes||[]).slice(0,10).forEach(function(q){var f=0;try{f=P.find(String(q).slice(0,4000),b);}catch(x){}b+=f;r.push(f);});return {found:r};}
if(n==="scroll"&&!i.ref){return {found:P.find(String(i.quote||"").slice(0,4000))};}
if(!e||!e.isConnected||!P.vis(e)){return {no:"gone"};}
r=P.role(e);b=P.bad(e);g=P.go(e);h={role:r,label:P.lab(e),nav:g.nav.slice(0,300)};
if(g.tab){h.tab=g.tab.slice(0,300);}
/* what the control itself says, when that isn't the label the model was shown (an aria-label can say "Cancel" on a "Pay now" button) */
v=/^(button|link|switch|checkbox|radio)$/.test(r)&&P.tx(e.tagName==="INPUT"?/^(submit|button|reset)$/.test(e.type)&&e.value:e.innerText,60);
if(v&&v.toLowerCase()!==h.label.toLowerCase()){h.text=v;}
if(n==="scroll"){P.unmark();e.scrollIntoView({block:"center",behavior:"smooth"});P.ol=e;P.oo=e.style.outline;e.style.outline="3px solid rgba(255,190,0,.9)";return h;}
if(b==="file"||b&&n!=="click"){return {no:b};}
if(e.disabled||e.getAttribute("aria-disabled")==="true"||n==="fill"&&e.readOnly){return {no:"off"};}
if(n==="fill"&&r!=="textbox"||n==="select"&&r!=="select"||n==="check"&&!/^(checkbox|radio|switch)$/.test(r)){return {no:"kind",role:r};}
if(n==="check"&&r==="radio"&&i.checked===false){return {no:"radio"};}
if(n==="select"){v=P.tx(i.option,300).toLowerCase();o=[].filter.call(e.options,function(x){return x.value===i.option||P.tx(x.text,300).toLowerCase()===v;})[0]||v&&[].filter.call(e.options,function(x){return P.tx(x.text,300).toLowerCase().indexOf(v)>=0;})[0];
if(!o||o.disabled){return {no:"option",opts:[].slice.call(e.options,0,20).map(function(x){return P.tx(x.text,40);})};}h.option=P.tx(o.text);}
if(d.dry){return h;}
/* sure is 1 or the address that was approved: a link that changed where it goes since then asks again */
if(n==="click"&&(h.nav||h.tab)&&!(d.sure===1||d.sure===(h.nav||h.tab))){return h.nav?{no:"nav",nav:h.nav}:{no:"tab",tab:h.tab};}
if(e.scrollIntoView){e.scrollIntoView({block:"center"});}if(e.focus){e.focus();}
if(n==="click"){e.click();return h;}
if(n==="check"){if(P.on(e)!==(i.checked!==false)){e.click();}h.checked=P.on(e);return h;}
if(n==="select"){o.selected=true;}
else if(e.isContentEditable){D.execCommand("selectAll");D.execCommand("insertText",false,t);}
/* through the prototype's setter, so frameworks watching the value (React) notice */
else{v=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),"value");if(v&&v.set){v.set.call(e,t);}else{e.value=t;}}
e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));
h.value=P.tx(e.isContentEditable?e.innerText:e.value,200);return h;};
/* v12 the browser toolset. The page as the model reads it: roles, names, states and (masked) values, reaching into open shadow roots
   and same-origin frames, with ::before/::after text, and marks for what only a screenshot shows (cross-origin frames, closed shadow DOM,
   canvas, video, unlabelled images). Refs are "ref_N", the same numbers as P.refs, so they stay put while the page is open.
   Points are viewport pixels of this (top) window; P.at finds the element under one, through shadow roots and frames. */
P.cs=function(e,p){var v=e.ownerDocument&&e.ownerDocument.defaultView;return v&&v.getComputedStyle?v.getComputedStyle(e,p||null):getComputedStyle(e,p||null);};
P.rf=function(e){var r=P.rm.get(e);if(!r){r=P.refs.push(e);P.rm.set(e,r);}return "ref_"+r;};
P.el=function(s){var m=/^ref_(\d{1,9})$/.exec(s||""),e=m&&P.refs[m[1]-1];return e&&e.isConnected?e:null;};
P.gone="That ref isn't on the page anymore. Use read_page or find again.";
P.ps=function(e,w){var c,o="",m,re=/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([\w-]+)\s*\)/g;try{c=P.cs(e,"::"+w).content;}catch(x){return "";}
if(!c||c==="none"||c==="normal"){return "";}
while((m=re.exec(c))){o+=m[3]?e.getAttribute(m[3])||"":(m[1]!=null?m[1]:m[2]).replace(/\\(.)/g,"$1");}
return P.tx(o,200);};
P.RL={A:"link",BUTTON:"button",TEXTAREA:"textbox",OPTION:"option",IMG:"img",SVG:"img",NAV:"navigation",MAIN:"main",HEADER:"banner",FOOTER:"contentinfo",ASIDE:"complementary",FORM:"form",UL:"list",OL:"list",LI:"listitem",TABLE:"table",TR:"row",TH:"columnheader",TD:"cell",DIALOG:"dialog",DETAILS:"group",SUMMARY:"button",FIELDSET:"group",IFRAME:"iframe",FRAME:"iframe",CANVAS:"canvas",VIDEO:"video",AUDIO:"audio",HR:"separator",PROGRESS:"progressbar",METER:"meter",ARTICLE:"article",H1:"heading",H2:"heading",H3:"heading",H4:"heading",H5:"heading",H6:"heading"};
P.IA=/^(link|button|textbox|searchbox|combobox|listbox|checkbox|radio|switch|slider|spinbutton|option|tab|menuitem|menuitemcheckbox|menuitemradio|treeitem|generic)$/;
P.AT=/^(button|textbox|searchbox|combobox|listbox|checkbox|radio|switch|slider|spinbutton|img|progressbar|meter|separator|option|menuitem|menuitemcheckbox|menuitemradio|canvas|video|audio)$/;
P.NC=/^(button|link|heading|option|tab|menuitem|menuitemcheckbox|menuitemradio|treeitem|cell|columnheader|rowheader|checkbox|radio|switch|generic|tooltip)$/;
P.rl=function(e){var r=(e.getAttribute("role")||"").trim().split(/\s+/)[0],t=e.tagName.toUpperCase(),y=(e.type||"").toLowerCase();
if(r&&r!=="presentation"&&r!=="none"){return r;}
if(t==="INPUT"){return /^(checkbox|radio)$/.test(y)?y:/^(submit|button|reset|image|file)$/.test(y)?"button":y==="range"?"slider":y==="number"?"spinbutton":y==="search"?"searchbox":"textbox";}
if(t==="SELECT"){return e.multiple||e.size>1?"listbox":"combobox";}
if(t==="A"&&!e.hasAttribute("href")||r){return "";}
if(t==="SECTION"&&(e.hasAttribute("aria-label")||e.hasAttribute("aria-labelledby"))){return "region";}
if(e.isContentEditable&&!(e.parentElement&&e.parentElement.isContentEditable)){return "textbox";}
return P.RL[t]||"";};
/* names: aria-labelledby (looked up in the element's own shadow root or document), aria-label, the field's label or placeholder, alt, an svg's title, then the words inside */
P.nm=function(e,r){var t=e.tagName.toUpperCase(),b=e.getAttribute("aria-labelledby"),q=e.getRootNode?e.getRootNode():D,v="",l;
if(b){v=b.split(/\s+/).map(function(i){var n=q.getElementById?q.getElementById(i):null;return n?n.textContent:"";}).join(" ");}
v=P.tx(v,100)||P.tx(e.getAttribute("aria-label"),100);
if(!v&&/^(INPUT|SELECT|TEXTAREA|METER|PROGRESS)$/.test(t)){l=e.labels&&e.labels[0];v=P.tx(l&&P.lt(l)||/^(submit|button|reset)$/.test(e.type)&&e.value||e.placeholder||e.title||e.getAttribute("aria-placeholder"),100);}
if(!v&&(t==="IMG"||t==="AREA"||t==="INPUT"&&e.type==="image")){v=P.tx(e.alt,100);}
if(!v&&t==="SVG"){l=e.querySelector("title");v=P.tx(l?l.textContent:e.textContent,100);}
if(!v&&r&&P.NC.test(r)){v=P.tx(P.ps(e,"before")+" "+(e.innerText||e.textContent||"")+" "+P.ps(e,"after"),100);}
return v||P.tx(e.title||(t==="A"?e.getAttribute("href"):""),100);};
/* states, and values with protected fields masked exactly as find_elements masks them */
P.sx=function(e,r){var s=[],a=function(k){return e.getAttribute(k);},t=e.tagName.toUpperCase(),b,v;
if(/^H[1-6]$/.test(t)){s.push("level="+t.charAt(1));}
if(/^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(r)){s.push((t==="INPUT"?e.checked:a("aria-checked")==="true")?"checked":"unchecked");}
if(e.disabled||a("aria-disabled")==="true"){s.push("disabled");}
v=a("aria-expanded");if(v){s.push(v==="true"?"expanded":"collapsed");}else if(t==="SUMMARY"&&e.parentElement&&e.parentElement.tagName==="DETAILS"){s.push(e.parentElement.open?"expanded":"collapsed");}
if(t==="OPTION"&&e.selected||a("aria-selected")==="true"){s.push("selected");}
if(a("aria-current")&&a("aria-current")!=="false"){s.push("current");}
if(/^(INPUT|TEXTAREA|SELECT)$/.test(t)||r==="textbox"&&e.isContentEditable){b=P.bad(e);
if(b==="file"){s.push("file picker: you can't open it");}
else if(b){s.push(b+" field: you can't read or type into it"+(e.value||e.isContentEditable&&P.tx(e.innerText)?" (it has something in it)":""));}
else if(t==="SELECT"){v=e.options[e.selectedIndex];s.push("value="+JSON.stringify(P.tx(v&&v.text,100)));}
else if(r==="slider"){s.push("value="+JSON.stringify(P.tx(e.value,20)));}
else if(!/^(checkbox|radio|button)$/.test(r)){if(t==="INPUT"&&!/^(text|search|)$/.test(e.type)){s.push("type="+e.type);}s.push("value="+JSON.stringify(P.tx(t==="INPUT"||t==="TEXTAREA"?e.value:e.innerText,100)));}}
if(e.readOnly&&r==="textbox"){s.push("read-only");}
if(r==="link"){v=P.go(e);if(v.nav){s.push("leaves the page");}else if(v.tab){s.push("opens another site in a new tab");}}
return s;};
/* where an element's document sits in this window: the frames it's in, each one's border and padding */
P.off=function(e){var x=0,y=0,w=e.ownerDocument.defaultView,f,b,c;while(w&&w!==W&&(f=w.frameElement)){b=f.getBoundingClientRect();c=P.cs(f);x+=b.left+f.clientLeft+(parseFloat(c.paddingLeft)||0);y+=b.top+f.clientTop+(parseFloat(c.paddingTop)||0);w=f.ownerDocument.defaultView;}return {x:x,y:y};};
P.rect=function(e){var r=e.getBoundingClientRect(),o=P.off(e);return {left:r.left+o.x,top:r.top+o.y,right:r.right+o.x,bottom:r.bottom+o.y,width:r.width,height:r.height};};
/* the element under a viewport point, through open shadow roots and same-origin frames (the panel itself doesn't count): {e, x, y, w}, x and y in e's own frame */
P.at=function(x,y){var d=D,w=W,e=null,f,b,c,i,a=d.elementsFromPoint(x,y);
for(i=0;i<a.length&&!e;i++){if(a[i]!==P.f){e=a[i];}}
while(e){if(e.shadowRoot&&(f=e.shadowRoot.elementFromPoint(x,y))&&f!==e&&e.shadowRoot.contains(f)){e=f;continue;}
if(/^I?FRAME$/.test(e.tagName)){try{f=e.contentDocument;}catch(z){f=null;}if(f&&f.documentElement){b=e.getBoundingClientRect();c=P.cs(e);x-=b.left+e.clientLeft+(parseFloat(c.paddingLeft)||0);y-=b.top+e.clientTop+(parseFloat(c.paddingTop)||0);d=f;w=f.defaultView;f=d.elementFromPoint(x,y);if(f){e=f;continue;}}}
break;}
return e?{e:e,x:x,y:y,w:w}:null;};
/* one walk of the page for read_page ("tree"), find ("seek": candidates in o.c) and get_page_text ("text") */
P.walk=function(o,root){var vw=W.innerWidth,vh=W.innerHeight,out=o.out=[],n=0,all=o.f==="all",ia=o.f==="interactive",tree=o.mode==="tree",seek=o.mode==="seek",k=0,x;o.c=[];
function put(s){if(o.cut){return;}if(n+s.length+1>o.max){o.cut=1;return;}out.push(s);n+=s.length+1;}
function pad(d){return new Array(d+1).join("  ");}
function inv(r){return r.right>0&&r.bottom>0&&r.left<vw&&r.top<vh;}
function kids(e){var a;if(e.shadowRoot){return e.shadowRoot.childNodes;}if(e.tagName==="SLOT"&&e.assignedNodes){a=e.assignedNodes({flatten:true});if(a.length){return a;}}return e.childNodes;}
function go(p,d,ox,oy,m,nt,own){var c=kids(p),i;for(i=0;i<c.length&&!o.cut;i++){if(++k>6e4){o.cut=1;return;}if(c[i].nodeType===3){txt(c[i],d,ox,oy,m,nt,own);}else if(c[i].nodeType===1){one(c[i],d,ox,oy,m,nt,own);}}}
function said(s,d,m,own){if(seek){if(own){own.t+=" "+s;if(own.lazy){own.lazy=0;o.c.push(own);}}}else if(!ia&&d<o.d){put(pad(d)+"text "+JSON.stringify(s)+(m?" ["+m+"]":""));}}
function txt(c,d,ox,oy,m,nt,own){var t=P.tx(c.nodeValue,300),g,r;if(!t){return;}if(!tree&&!seek){if(!m){put(t);}return;}if(nt){return;}
if(!m){g=c.ownerDocument.createRange();g.selectNodeContents(c);r=g.getBoundingClientRect();if(!inv({left:r.left+ox,top:r.top+oy,right:r.right+ox,bottom:r.bottom+oy})){if(tree&&!all){return;}m=tree?"offscreen":"";}}
said(t,d,m,own);}
function one(e,d,ox,oy,mk,nt,up){var t=e.tagName.toUpperCase(),m=mk,cs,rs,r,ov,role,nm,show,spec="",fd=null,inter,b,i,x,dd,mm,own,l;
if(/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|META|LINK|TITLE|BASE)$/.test(t)||e===P.f||t==="INPUT"&&e.type==="hidden"){return;}
if(tree&&d>=o.d){o.deep=1;return;}
cs=P.cs(e);rs=e.getClientRects();r=e.getBoundingClientRect();
if(!m){if(cs.display==="none"||!rs.length&&cs.display!=="contents"){l=e.labels&&e.labels[0];if(l&&l.getClientRects().length){r=l.getBoundingClientRect();}else{m=e.closest("details:not([open])")&&!e.closest("summary")?"collapsed":"hidden";}}
else if(cs.visibility==="hidden"||cs.visibility==="collapse"){m="hidden";}
else if(cs.display!=="contents"&&e.checkVisibility&&!e.checkVisibility({contentVisibilityAuto:true})){m=e.closest("details:not([open])")&&!e.closest("summary")?"collapsed":"hidden";}
else if(rs.length&&(r.width<=1&&r.height<=1||r.right+e.ownerDocument.defaultView.scrollX<=0||r.bottom+e.ownerDocument.defaultView.scrollY<=0)){m="offscreen";}}
if(m&&(!tree||!all)){return;}
ov=!m&&cs.display!=="contents"&&!inv({left:r.left+ox,top:r.top+oy,right:r.right+ox,bottom:r.bottom+oy});
if(t==="IFRAME"||t==="FRAME"){try{fd=e.contentDocument;}catch(z){fd=null;}if(!fd||!fd.body){fd=null;spec="cross-origin: use screenshot";}}
if(!tree&&!seek){b=!/^(inline|contents|ruby|table-cell)/.test(cs.display);if(b){put("\n");}x=P.ps(e,"before");if(x){put(x);}
if(fd){go(fd.body,d,0,0,"",nt,null);}else if(!/^(SELECT|SVG|CANVAS|VIDEO|AUDIO|IMG)$/.test(t)){go(e,d,ox,oy,"",nt,null);}
x=P.ps(e,"after");if(x){put(x);}if(b){put("\n");}return;}
role=P.rl(e);
if(t==="CANVAS"){spec="canvas: use screenshot";}
else if(t==="VIDEO"){spec="video: use screenshot";}
else if(t==="IMG"&&role){if(e.getAttribute("alt")===""&&!P.nm(e,role)){return;}if(!P.nm(e,role)){spec="no alt: use screenshot";}}
else if(t==="SVG"&&role){if(e.getAttribute("aria-hidden")==="true"){return;}if(!P.nm(e,role)){if(r.width<24&&r.height<24){return;}spec="svg without text: use screenshot";}}
else if(t.indexOf("-")>0&&!e.shadowRoot&&!e.firstElementChild&&!P.tx(e.textContent)&&r.width*r.height>0){spec="closed shadow DOM: use screenshot";}
inter=P.IA.test(role)||!role&&(e.hasAttribute("tabindex")&&e.tabIndex>=0||cs.cursor==="pointer"&&!(e.parentElement&&P.cs(e.parentElement).cursor==="pointer"));
if(!role&&(inter||spec)){role="generic";}
show=!!role&&(!ia||inter||!!spec);
mm=m||(ov?"offscreen":"");
own=up;
if(show&&(!tree||!ov||all)){nm=P.nm(e,role);
if(seek){own={e:e,role:role,nm:nm,t:"",inter:inter,ov:ov,spec:spec,i:o.c.length};o.c.push(own);}
else{put(pad(d)+role+(nm?" "+JSON.stringify(nm):"")+" ["+P.rf(e)+"]"+(x=P.sx(e,role),x.length?" "+x.join(" "):"")+(spec?" ["+spec+"]":"")+(mm?" ["+mm+"]":""));}
dd=d+1;}else{dd=d;if(seek){own={e:e,role:"",nm:"",t:"",ov:ov,lazy:1};}}
if(t==="SELECT"){if(tree&&!ia&&!P.bad(e)){for(i=0;i<e.options.length&&i<20;i++){x=e.options[i];put(pad(dd)+"option "+JSON.stringify(P.tx(x.text,60))+(x.selected?" selected":""));}if(e.options.length>20){put(pad(dd)+"("+(e.options.length-20)+" more options)");}}return;}
if(P.AT.test(role)||spec&&!fd){return;}
nt=nt||show&&P.NC.test(role);
if(fd){l=e.getBoundingClientRect();go(fd.body,dd,ox+l.left+e.clientLeft+(parseFloat(cs.paddingLeft)||0),oy+l.top+e.clientTop+(parseFloat(cs.paddingTop)||0),m,nt,null);return;}
if(!nt&&(!tree||!ov||all)){x=P.ps(e,"before");if(x){said(x,dd,mm,own);}}
go(e,dd,ox,oy,m,nt,own);
if(!nt&&(!tree||!ov||all)){x=P.ps(e,"after");if(x){said(x,dd,mm,own);}}}
if(root){x=P.off(root);one(root,0,x.x,x.y,"",false,null);}else{go(D.body||D.documentElement,0,0,0,"",false,null);}};
P.read=function(e,f,dp){var o={f:f,d:Math.min(dp||15,50),max:5e4,mode:"tree"};P.walk(o,e);return {text:o.out.join("\n")+(o.deep&&!o.cut&&o.out.length?"\n(Deeper parts are left out: read_page with a ref, or a bigger depth, shows them.)":""),cut:!!o.cut};};
P.text=function(){var o={max:4e5,mode:"text"};P.walk(o,null);return o.out.join(" ").replace(/[ \t]*\n\s*/g,"\n").replace(/[ \t]{2,}/g," ").trim();};
/* find: every visible element (and every element's own text), scored by the query's words against its name, role and text; the best 20 */
P.SY={button:"button",link:"link",field:"textbox searchbox combobox",box:"textbox searchbox combobox checkbox",input:"textbox searchbox combobox",textbox:"textbox",search:"searchbox",dropdown:"combobox listbox",select:"combobox listbox",menu:"menu menuitem combobox",checkbox:"checkbox switch",toggle:"switch checkbox",switch:"switch",radio:"radio",image:"img",picture:"img",photo:"img",icon:"img",heading:"heading",title:"heading",tab:"tab",option:"option radio",slider:"slider",frame:"iframe",iframe:"iframe",canvas:"canvas",video:"video",chart:"canvas img",dialog:"dialog"};
P.seek=function(q){var o={f:"",d:1e3,max:4e5,mode:"seek"},Q=P.tx(q,300).toLowerCase(),ws=Q.split(/[^\p{L}\p{N}$€£%.@-]+/u).map(function(w){return w.replace(/s$/,"").replace(/^\.+|\.+$/g,"");}).filter(function(w){return w&&!/^(the|a|an|to|of|on|in|for|and|or|with|that|this|is|it|me|my|find|where|which|page)$/.test(w);}),hits=[],out=[];
P.walk(o,null);if(!ws.length){ws=[Q];}
o.c.forEach(function(c){var N=c.nm.toLowerCase(),T=P.tx(c.t,300).toLowerCase(),s=0,h=0,rr=0;
ws.forEach(function(w){var y=P.SY[w];if(y&&c.role&&(" "+y+" ").indexOf(" "+c.role+" ")>=0){s+=2;rr++;}else if(N.indexOf(w)>=0){s+=3;h++;}else if(T.indexOf(w)>=0){s+=1.5;h++;}else if(y){rr+=0;}});
if(!h&&!(rr&&rr===ws.length)){return;}if(h+rr>=ws.length){s+=2;}if(N===Q){s+=3;}if(c.inter){s+=.5;}if(c.ov){s-=.25;}hits.push({c:c,s:s});});
hits.sort(function(a,b){return b.s-a.s||a.c.i-b.c.i;});
hits.slice(0,20).forEach(function(h){var c=h.c,x;out.push(c.role?c.role+(c.nm?" "+JSON.stringify(c.nm):"")+" ["+P.rf(c.e)+"]"+(x=P.sx(c.e,c.role),x.length?" "+x.join(" "):"")+(c.spec?" ["+c.spec+"]":"")+(c.ov?" [offscreen]":""):"text "+JSON.stringify(P.tx(c.t,160))+" ["+P.rf(c.e)+"]"+(c.ov?" [offscreen]":""));});
return {text:out.join("\n")+(hits.length>20?"\n("+(hits.length-20)+" more matches. Describe it more closely to narrow them down.)":""),n:Math.min(hits.length,20)};};
/* scroll: the nearest thing under the point that scrolls that way (an element, a frame, then the window), a wheel notch being 100px */
P.scr=function(i){var t=i.target||{},a=P.at(+t.x,+t.y),v=i.scroll_direction,k=Math.min(Math.max(i.scroll_amount|0||3,1),10)*100,dx=v==="left"?-k:v==="right"?k:0,dy=v==="up"?-k:v==="down"?k:0,e=a&&a.e,w,c,b,o;
while(e){if(e.nodeType===11){e=e.host;continue;}
if(e.nodeType===9){w=e.defaultView;b=[w.scrollX,w.scrollY];w.scrollBy({left:dx,top:dy,behavior:"instant"});if(w.scrollX!==b[0]||w.scrollY!==b[1]){return {moved:true};}e=w===W?null:w.frameElement;continue;}
if(e.nodeType===1){c=P.cs(e);o=dy?c.overflowY:c.overflowX;if(/auto|scroll|overlay/.test(o)&&(dy?e.scrollHeight>e.clientHeight:e.scrollWidth>e.clientWidth)){b=[e.scrollLeft,e.scrollTop];e.scrollBy({left:dx,top:dy,behavior:"instant"});if(e.scrollLeft!==b[0]||e.scrollTop!==b[1]){return {moved:true};}}}
e=e.assignedSlot||e.parentNode;}
if(!a){b=[W.scrollX,W.scrollY];W.scrollBy({left:dx,top:dy,behavior:"instant"});return {moved:W.scrollX!==b[0]||W.scrollY!==b[1]};}
return {moved:false};};
/* hover and mouse_move: the pointer and mouse events a real pointer sends, so menus that open on hover open (CSS :hover can't be faked) */
P.mv=function(e,x,y){var w=e.ownerDocument.defaultView,l=P.hov,f=function(n,k,b){var C=/^pointer/.test(k)&&w.PointerEvent||w.MouseEvent;n.dispatchEvent(new C(k,{bubbles:b,cancelable:b,composed:true,clientX:x,clientY:y,view:w,pointerId:1,pointerType:"mouse",isPrimary:true}));};
if(l&&l!==e&&l.isConnected){f(l,"pointerout",true);f(l,"pointerleave",false);f(l,"mouseout",true);f(l,"mouseleave",false);}
if(l!==e){f(e,"pointerover",true);f(e,"pointerenter",false);f(e,"mouseover",true);f(e,"mouseenter",false);}
f(e,"pointermove",true);f(e,"mousemove",true);P.hov=e;};
P.hv=function(t){var a,e,r,x,y,ro;
if(t.type==="ref"){e=P.el(t.ref);if(!e){return {error:P.gone};}r=P.rect(e);if(r.bottom<0||r.right<0||r.top>W.innerHeight||r.left>W.innerWidth){e.scrollIntoView({block:"center",inline:"nearest",behavior:"instant"});}r=e.getBoundingClientRect();x=r.left+r.width/2;y=r.top+r.height/2;}
else{a=P.at(+t.x,+t.y);if(!a){return {error:"There's nothing on the page at that point."};}e=a.e;x=a.x;y=a.y;}
P.mv(e,x,y);ro=P.rl(e)||"generic";return {role:ro,label:P.nm(e,ro)};};
P.tool=function(n,i){var e;
if(n==="view"){return {w:W.innerWidth,h:W.innerHeight,dpr:W.devicePixelRatio||1,sx:W.scrollX,sy:W.scrollY};}
if(n==="read_page"){if(i.ref){e=P.el(i.ref);if(!e){return {error:P.gone};}}return P.read(e,i.filter,i.depth);}
if(n==="find"){return P.seek(String(i.query||""));}
if(n==="get_page_text"){return {url:location.href,title:D.title,text:P.text()};}
if(n==="scroll"){return P.scr(i);}
if(n==="scroll_to"){e=P.el(i.target&&i.target.ref);if(!e){return {error:P.gone};}e.scrollIntoView({block:"center",inline:"nearest",behavior:"instant"});n=P.rl(e)||"generic";return {role:n,label:P.nm(e,n)};}
if(n==="hover"||n==="mouse_move"){return P.hv(i.target||{});}
return {error:"The page doesn't know "+String(n).slice(0,40)+"."};};
W.addEventListener("message",function(e){
if(e.origin!==O){return;}
var d=e.data||{},t=d.type,f=P.f,s=f&&f.style,src=e.source,ok=0;
function reply(x){x.id=d.id;src.postMessage(x,O);}
if(t==="page"){var x=d.max>0&&d.max<=1?"":D.body?D.body.innerText:"";reply({page:{url:location.href,title:D.title,text:x.slice(0,Math.min(d.max||20000,400000))},selection:String(W.getSelection()||"").trim().slice(0,8000)});return;}
if(t==="find"){try{ok=P.find(String(d.text||"").slice(0,4000));}catch(x){}reply({found:ok});return;}
if(t==="act"){try{ok=P.act(d);}catch(x){ok={no:"err",why:String(x&&x.message||x).slice(0,200)};}reply(ok);return;}
if(t==="tool"){try{ok=P.tool(String(d.name||""),d.input&&typeof d.input==="object"?d.input:{});}catch(x){ok={error:"It went wrong on the page: "+String(x&&x.message||x).slice(0,200)};}reply(ok);return;}
if(!f||src!==f.contentWindow){if(t==="hide"){reply({});}return;}
if(t==="ready"){P.ready=1;if(d.pos&&d.pos.r>=0&&d.pos.b>=0){P.r=+d.pos.r;P.b=+d.pos.b;}if(d.size&&d.size.w>0&&d.size.h>0){P.w=+d.size.w;P.h=+d.size.h;}if(d.dw>0){P.dw=+d.dw;}P.dock=d.dock?1:0;P.place(1);P.show();P.st=null;P.sel();}
else if(t==="hide"){s.visibility="hidden";reply({});}
else if(t==="show"){s.visibility="visible";}
else if(t==="close"){P.hide();}
else if(t==="drag"){P.r-=+d.dx||0;P.b-=+d.dy||0;P.bounds();P.schedulePlace();}
else if(t==="where"){reply({pos:{r:P.r,b:P.b},size:{w:P.w,h:P.h},dw:P.dw});}
else if(t==="min"){P.min=d.on?1:0;if(d.w>0&&d.h>0){P.mw=+d.w;P.mh=+d.h;}P.place();}
else if(t==="glass"){P.glass=d.on?1:0;P.place(1);reply({light:P.lit()});}
else if(t==="clear"){P.clear=d.on?1:0;P.place(1);reply({light:P.lit()});}
else if(t==="full"){P.full=d.on?1:0;if(!d.on){s.visibility="hidden";}P.place(1);reply({});}
else if(t==="size"){if(P.dock){if(d.dw>0){P.dw=Math.max(300,Math.min(+d.dw,W.innerWidth-40));}}else{if(d.w>0){P.w=Math.max(300,Math.min(+d.w,W.innerWidth-P.r));}if(d.h>0){P.h=Math.max(360,Math.min(+d.h,W.innerHeight-P.b));}}P.schedulePlace(1);}
else if(t==="dock"){P.dock=d.on?1:0;if(d.w>0){P.dw=+d.w;}P.place();reply({});}
});
W.addEventListener("resize",function(){P.bounds();P.schedulePlace(1);});
}
if(P.blocked){P.win();return;}
var old=D.getElementById(ID);if(old){old.remove();}
old=D.getElementById(ID+"_b");if(old){old.remove();}
var f=P.f=D.createElement("iframe");
f.id=ID;f.src=O+"/widget?v="+(P.v||6);f.title="pagebot";f.allow="display-capture; clipboard-write";
f.style.cssText="all:initial;position:fixed;z-index:2147483647;border:0;display:block;visibility:visible;opacity:0;transform:translateY(12px) scale(.97);transform-origin:100% 100%;background:transparent;color-scheme:light;";
P.ready=0;P.open=1;P.min=0;P.full=0;P.t=Date.now();P.place(1);
D.addEventListener("securitypolicyviolation",function(e){if(P.f===f&&!P.ready&&String(e.blockedURI||"").indexOf(O)===0){f.remove();P.f=null;P.blocked=1;P.win();}});
D.documentElement.appendChild(f);
})();
