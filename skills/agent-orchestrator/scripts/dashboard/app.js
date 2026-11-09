const $=(t,a={},...kids)=>{const e=document.createElement(t);for(const[k,v]of Object.entries(a)){if(k==="class")e.className=v;else if(k.startsWith("on"))e.addEventListener(k.slice(2),v);else e.setAttribute(k,v)}
for(const c of kids.flat())if(c!=null)e.append(c.nodeType?c:document.createTextNode(String(c)));return e};
const fmt=n=>n==null?"-":n<1000?String(n):n<1e6?(n/1000).toFixed(n<1e4?1:0)+"k":(n/1e6).toFixed(1)+"M";
const outcome=t=>t.phase==="parked"?"parked":t.closed&&t.state==="idle"?"completed":t.state;
const exitedLabel=t=>outcome(t);
const cls=s=>s==="running"?"s-running":s==="needs-decision"?"s-ask":s==="completed"?"s-completed":s==="prepared"||s==="idle"||s==="parked"?"s-idle":"s-bad";
let sel=null,state=[],lastState="",lastDetail="",server=null;const IND=18;
// A row with sub-agents opens while any agent under it runs and closes once none do; clicking its
// arrow, or the row itself, overrides that until the running state under it changes.
const manual=new Map(),live=new Map();
const isOpen=k=>{const a=!!live.get(k),m=manual.get(k);if(m&&m.auto===a)return m.open;manual.delete(k);return a};
// Sections whose older rows (finished and quiet a while; the server flags them) are shown, until
// "hide older" is clicked or the page reloads.
const olderShown=new Set();
// Sections shown as a plan graph instead of the session tree, kept in this tab's session storage so
// a reload keeps them, as keepState keeps the chosen row.
const graphShown=new Set((()=>{try{return JSON.parse(sessionStorage.getItem("orchGraphView")||"[]")}catch{return[]}})());
const keepViews=()=>{try{sessionStorage.setItem("orchGraphView",JSON.stringify([...graphShown].slice(-50)))}catch{}};
// Rows are rebuilt when data changes; starting every pulse at the page timeline's origin keeps
// rebuilt dots in step instead of restarting their beat.
// Rows that changed place glide from their old position to the new one (rising or dropping), and
// new rows fade in, instead of the order jumping.
const slide=(root,before)=>{if(!before.size||matchMedia("(prefers-reduced-motion: reduce)").matches)return;
  for(const b of root.querySelectorAll("tbody.session")){const old=before.get(b.dataset.key),dy=old==null?null:old-b.getBoundingClientRect().top;
    if(dy==null)b.animate([{opacity:0},{opacity:1}],{duration:350,easing:"ease-out"});
    else if(Math.abs(dy)>1)b.animate([{transform:"translateY("+dy+"px)"},{transform:"none"}],{duration:550,easing:"cubic-bezier(.2,.8,.2,1)"})}};
const syncPulses=root=>{for(const d of root.querySelectorAll(".dot.d-run,.gnode.d-run .gdot"))for(const a of d.getAnimations())a.startTime=0};
const dotClass=t=>{const s=outcome(t);return s==="running"?"d-run":s==="needs-decision"?"d-ask":s==="completed"?"d-ok":s==="idle"||s==="prepared"||s==="parked"?"":"d-bad"};
const sectionTitle=run=>run.goal||run.id.replace(/^\d{8}-\d{6}-/,"");
// A session's activity line, after a short marker while it is stuck on one failing command.
const nowText=t=>(t.stuck?"stuck: `"+(t.stuck.command.length>30?t.stuck.command.slice(0,29)+"…":t.stuck.command)+"` failed "+t.stuck.failures+"× · ":"")+(t.now||"");
// Choosing a row, or its node in the graph view, marks it and paints its details at once from the
// board already loaded; the table and the row's log refresh behind it.
function choose(el){if(!el)return;sel=el.dataset.key;
  for(const b of document.querySelectorAll("tbody.session.sel,.gnode.sel"))b.classList.remove("sel");el.classList.add("sel");
  compose();document.querySelector("main").classList.remove("no-detail");detail();lastState="";refresh()}
// Choose a session from the attention lane as its row would be chosen, opening the rows above it
// (an open stays until the running state under that row changes) and scrolling its row into view.
function reveal(key){const[runId,taskKey]=key.split("/"),run=state.find(r=>r.id===runId),byKey=new Map((run?.tasks||[]).map(t=>[t.key,t]));
  for(let p=byKey.get(taskKey)?.parentKey;p;p=byKey.get(p)?.parentKey){const k=runId+"/"+p;if(!isOpen(k))manual.set(k,{open:true,auto:!!live.get(k)})}
  sel=key;compose();lastState="";document.querySelector("main").classList.remove("no-detail");
  const at='[data-key="'+CSS.escape(key)+'"]';
  refresh().then(()=>{document.querySelector("tbody.session"+at+",.gnode"+at)?.scrollIntoView({block:"nearest",inline:"nearest"});return detail()})}
// Close the details panel: the table takes the full width until a session is chosen again.
function closeDetail(){sel=null;lastDetail="";lastState="";document.querySelector("main").classList.add("no-detail");refresh()}
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&sel&&!e.target?.closest?.("#compose"))closeDetail()});
// Clicking anywhere on a row with sub-agents opens it; clicking it again while it is chosen closes it.
function toggleRow(row){const k=row?.dataset.key;if(!k||!row.querySelector(".caret[data-key]"))return;
  const open=sel===k?!isOpen(k):true;if(open!==isOpen(k))manual.set(k,{open,auto:!!live.get(k)})}
const pick=row=>{toggleRow(row);choose(row)};
document.getElementById("runs").addEventListener("click",e=>{const cr=e.target.closest(".caret[data-key]");
  if(cr){const k=cr.dataset.key;manual.set(k,{open:!isOpen(k),auto:!!live.get(k)});lastState="";refresh();return}
  const ob=e.target.closest(".older[data-run]");if(ob){const r=ob.dataset.run;if(!olderShown.delete(r))olderShown.add(r);redrawSection(r);return}
  const vb=e.target.closest(".view[data-run]");if(vb){if(vb.dataset.view==="graph")graphShown.add(vb.dataset.run);else graphShown.delete(vb.dataset.run);keepViews();redrawSection(vb.dataset.run);return}
  if(!getSelection().isCollapsed)return;const a=e.target.closest(".attn[data-key]");if(a)reveal(a.dataset.key);else{const g=e.target.closest(".gnode[data-key]");if(g)choose(g);else pick(e.target.closest("tbody.session"))}});
document.getElementById("runs").addEventListener("pointerover",e=>{const row=e.target.closest("tbody.session,.gnode[data-key]");if(row&&row.dataset.key!==sel)preload(row.dataset.key)});
document.getElementById("runs").addEventListener("focusin",e=>{if(refocusing)return;const row=e.target.closest("tbody.session,.gnode[data-key]");if(row&&row.dataset.key!==sel)preload(row.dataset.key)});
document.getElementById("runs").addEventListener("keydown",e=>{if(e.key!=="Enter")return;const a=e.target.closest(".attn[data-key]");if(a)return reveal(a.dataset.key);
  const g=e.target.closest(".gnode[data-key]");if(g)choose(g);else pick(e.target.closest("tbody.session"))});
// Ask once, only after a deliberate click on the attention count. Remember a dismissed prompt
// too, so polling, reconnecting and reloading the dashboard never ask again.
let notificationAsked=false;
function askNotifications(){
  if(!("Notification" in window)||Notification.permission!=="default"||notificationAsked)return;
  try{if(localStorage.getItem("orchNotificationAsked"))return;localStorage.setItem("orchNotificationAsked","1")}catch{}
  notificationAsked=true;Notification.requestPermission().catch(()=>{});
}
const needButton=document.getElementById("need");
needButton.addEventListener("click",()=>{document.getElementById("runs").scrollTo({top:0});askNotifications()});
needButton.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();needButton.click()}});
// Hold a panel still while the user presses in it or has text selected in it, so an update
// does not wipe the selection; it catches up once the selection is cleared.
let pressed=null,behind=false;
const holding=el=>{if(pressed&&el.contains(pressed))return true;const s=getSelection();return !!s&&!s.isCollapsed&&el.contains(s.anchorNode)};
function catchUp(){if(!behind||holding(document.getElementById("runs"))||holding(document.getElementById("detail")))return;behind=false;lastState="";lastDetail="";refresh().then(detail)}
// A press holds its panel from pointerdown until pointerup or pointercancel, so the click that follows
// lands on the very element that was pressed, never on one a redraw put in its place; then one
// pending redraw catches up, after the click has been handled.
const release=()=>{pressed=null;setTimeout(catchUp,0)};
document.addEventListener("pointerdown",e=>{pressed=e.target},true);
document.addEventListener("pointerup",release,true);
document.addEventListener("pointercancel",release,true);
document.addEventListener("selectionchange",()=>{if(getSelection().isCollapsed)catchUp()});
async function refresh(){
  let text,heavy={running:0,waiting:0};try{const r=await fetch("api/state"),v=r.headers.get("x-orch-server");if(server&&v&&v!==server){keepState();location.reload();return}server=v;heavy=JSON.parse(r.headers.get("x-orch-heavy")||"null")||heavy;text=await r.text()}catch{const st=document.getElementById("stamp");st.className="live off";st.textContent="disconnected";st.title="is orch.mjs dashboard still running?";return}
  const st=document.getElementById("stamp");st.className="live";st.textContent="";st.title="updated "+new Date().toLocaleTimeString();
  const heavyText=" · heavy: "+heavy.running+" running, "+heavy.waiting+" waiting";
  const grand=document.getElementById("grand");grand.textContent=grand.textContent.replace(/ · heavy:.*$/, "")+heavyText;
  if(text===lastState)return;if(holding(document.getElementById("runs"))){behind=true;return}lastState=text;state=JSON.parse(text);
  let tin=0,tout=0,running=0;
  const root=document.getElementById("runs");
  const before=new Map([...root.querySelectorAll("tbody.session")].map(b=>[b.dataset.key,b.getBoundingClientRect().top]));
  // Each wide graph keeps its horizontal scroll across the redraw, and the board keeps its focus.
  const scrolled=new Map([...root.querySelectorAll(".gwrap[data-run]")].map(w=>[w.dataset.run,w.scrollLeft])),focus=focusedOn(root);
  root.replaceChildren();
  if(!state.length)root.append($("p",{class:"muted empty"},"No runs active recently."));
  // The attention lane: what needs someone now across every section, in the server's order (most
  // urgent kind first, then the longest waiting); shown only when something does.
  const lane=state.flatMap(run=>(run.attention||[]).map(a=>({...a,run,k:run.id+"/"+a.key}))).sort((a,b)=>a.rank-b.rank||a.sinceMs-b.sinceMs);
  const need=document.getElementById("need");need.hidden=!lane.length;need.textContent=lane.length+(lane.length===1?" needs":" need")+" attention";
  if(lane.length)root.append($("div",{class:"lane"},$("h2",{},"Needs attention"),...lane.map(a=>$("div",{class:"attn a-"+a.kind+(sel===a.k?" sel":""),"data-key":a.k,tabindex:"0",role:"button",title:a.reason},
    $("span",{class:"tag",...(a.kind==="question"?{style:"color:var(--ask)",title:"Asked while it keeps working: answer in the box under its details"}:{})},a.label),$("b",{},a.id),$("span",{class:"where",...(a.runId?{title:"run "+a.runId}:{})},a.runGoal||(a.runId?a.runId.replace(/^\d{8}-\d{6}-/,""):sectionTitle(a.run))),
    a.sinceMs?$("span",{class:"tick","data-since":String(a.sinceMs),title:"waiting since "+new Date(a.sinceMs).toLocaleTimeString()},dur(Date.now()-a.sinceMs)):null,
    $("span",{class:"why"},a.reason.replace(/^(waiting|no events for) [^·]+(· )?/,""))))));
  tick();
  for(const run of state){tin+=run.totals.tokensIn;tout+=run.totals.tokensOut;running+=run.totals.running;root.append(sectionView(run))}
  for(const w of root.querySelectorAll(".gwrap[data-run]"))if(scrolled.get(w.dataset.run))w.scrollLeft=scrolled.get(w.dataset.run);
  refocus(root,focus);
  syncPulses(root);
  slide(root,before);
  document.getElementById("grand").textContent=running+" running · "+fmt(tin)+" in / "+fmt(tout)+" out"+heavyText;
  compose();
}
// One section of the board: its header, with the view toggle, and its session tree or plan graphs.
function sectionView(run){
  const by=run.orchestrator?.agent?("launched by "+run.orchestrator.agent+(run.orchestrator.sessionId?" session "+run.orchestrator.sessionId.slice(0,8):"")):"";
  // One <tbody> per session, so its row and its activity line hover and select as one item.
  const byKey=new Map(run.tasks.map(t=>[t.key,t]));
  for(const t of run.tasks)live.set(run.id+"/"+t.key,false);
  for(const t of run.tasks)if(t.state==="running")for(let p=t.parentKey;p;p=byKey.get(p)?.parentKey)live.set(run.id+"/"+p,true);
  // Older rows stay folded away unless the section shows them; the chosen session and the rows
  // above it always show. Arrows and "+N hidden" count only the rows listed.
  const chosen=new Set();if(sel?.startsWith(run.id+"/"))for(let k=sel.slice(run.id.length+1);k;k=byKey.get(k)?.parentKey)chosen.add(k);
  const older=new Set(run.tasks.filter(t=>t.older&&!chosen.has(t.key))),showOlder=olderShown.has(run.id);
  const listed=run.tasks.filter(t=>showOlder||!older.has(t)),kids=new Map(),below=new Map();
  for(const t of listed){if(t.parentKey)kids.set(t.parentKey,(kids.get(t.parentKey)||0)+1);for(let p=t.parentKey;p;p=byKey.get(p)?.parentKey)below.set(p,(below.get(p)||0)+1)}
  const hiddenBy=t=>{for(let p=t.parentKey;p;p=byKey.get(p)?.parentKey)if(!isOpen(run.id+"/"+p))return true;return false};
  const rows=listed.filter(t=>!hiddenBy(t)).map(t=>{
    const key=run.id+"/"+t.key,c="session"+(sel===key?" sel":"")+(t.closed?" closed":""),nk=kids.get(t.key)||0,nd=below.get(t.key)||0,shut=nk>0&&!isOpen(key);
    const indent=w=>({class:"name",style:"padding-left:"+(6+t.depth*IND+w)+"px;--pad:"+(4+t.depth*IND)+"px;--gw:"+(t.depth*IND)+"px"});
    return $("tbody",{class:c,"data-key":key,tabindex:"0"},$("tr",{},
      $("td",{...indent(0),title:t.native&&t.parent!=="orchestrator"?"started by "+t.parent:""},
        nk?$("span",{class:"caret","data-key":key,title:shut?"expand":"collapse"},shut?"▶":"▼"):$("span",{class:"caret blank"}),
        $("span",{class:"dot "+dotClass(t),title:outcome(t)}),t.main?$("b",{},"main session"):t.id,
        t.scopeViolations?.length?$("span",{class:"warn",title:"changed outside its planned files:\n"+t.scopeViolations.join("\n")},"⚠"):null,
        t.inbox?.unread>0?$("span",{class:"mail",title:"messages the agent has not read yet:\n"+(t.inbox.unreadMessages||[]).map(m=>new Date(m.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})+"  "+m.text).join("\n")},"✉ "+t.inbox.unread+" unread"):null,
        shut&&nd?$("span",{class:"more"},"+"+nd+" hidden"):null),$("td",{title:t.why||""},t.agent),$("td",{},t.modelLabel),$("td",{},t.mode),
      $("td",{class:"state "+cls(outcome(t))},exitedLabel(t)+(t.attempt>1?" · "+t.attempt+" attempts":"")),$("td",{class:"num"},t.elapsed),$("td",{class:"num"},t.steps),
      $("td",{class:"num"},(t.tokensExact?"":"~")+fmt(t.tokensIn)),$("td",{class:"num"},(t.tokensExact?"":"~")+fmt(t.tokensOut)),
      $("td",{},t.session?t.session.slice(0,8):"-")),
      $("tr",{class:"nowrow"},$("td",{...indent(32),colspan:"10"},nowText(t))))});
  // The run's goal as its title, with a short status after it; run id, launcher, and branch are in the tooltip.
  const clock=ms=>{const d=new Date(ms),t=d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});return d.toDateString()===new Date().toDateString()?t:d.toLocaleDateString([],{month:"short",day:"numeric"})+" "+t};
  const tt=run.totals,ap=tt.exact?"":"~",started=clock(Date.parse(run.createdAt)),awaiting=(run.attention||[]).filter(a=>a.kind==="awaiting-review").length;
  const summary=[tt.running?tt.running+" running":null,tt.finished?tt.finished+" finished":null,awaiting?awaiting+" awaiting review":null,ap+fmt(tt.tokensIn)+" in / "+ap+fmt(tt.tokensOut)+" out","started "+started,!run.running&&run.activeMs?"last active "+clock(run.activeMs):null].filter(Boolean).join(" · ");
  const tip=[[run.id,by,[(run.repo||"").split("/").pop(),run.baseBranch].filter(Boolean).join(" @ ")].filter(Boolean).join(" · "),...((run.runs||[]).length>1?["runs:",...run.runs.map(r=>"  "+(r.goal||r.id))]:[]),"token counts leave out the main session"].join("\n");
  const graph=graphShown.has(run.id);
  const toggle=!graph&&older.size?$("button",{class:"older","data-run":run.id,title:showOlder?"fold away the finished rows that have been quiet a while":"list the finished rows that have been quiet a while"},showOlder?"hide older":"show "+older.size+" older"):null;
  const view=(v,label,on)=>$("button",{class:"view"+(on?" on":""),"data-run":run.id,"data-view":v,"aria-pressed":String(on),title:v==="graph"?"Show the plan as a graph of tasks and their dependencies":"Show the sessions as a tree"},label);
  const views=$("span",{class:"views",role:"group","aria-label":"View"},view("tree","Tree",!graph),$("span",{class:"vsep"},"·"),view("graph","Graph",graph));
  return $("div",{class:"run"+(graph?" graph-mode":""),"data-run":run.id},$("h2",{title:tip},sectionTitle(run),$("span",{class:"sub"}," · "+summary),toggle,views),
    graph?graphView(run):$("table",{},$("thead",{},$("tr",{},$("th",{},"task"),$("th",{},"agent"),$("th",{},"model"),$("th",{},"mode"),$("th",{},"state"),$("th",{class:"num"},"elapsed"),
      $("th",{class:"num"},"steps"),$("th",{class:"num"},"tokens in"),$("th",{class:"num"},"out"),$("th",{},"session"))),...(rows.length?rows:[$("tbody",{},$("tr",{},$("td",{colspan:"10",class:"muted"},older.size?"every row is older; show them from the header":"no tasks yet")))])),
  )}
// A redraw replaces every element of the board. The one that had focus (a tree row by its task key,
// a graph node by its run and task, an attention item, or a section's toggle) is found again and
// focused without scrolling, so Tab and Enter keep working. Focus outside the board, such as in the
// message box, is never taken. The details panel passes its own `keys` (PANEL_FOCUS).
const FOCUS_KEYS=[["tbody.session",["key"]],[".gnode",["node"]],[".attn",["key"]],[".view",["run","view"]],[".older",["run"]]];
function focusedOn(root,keys=FOCUS_KEYS){const a=document.activeElement;if(!a||a===root||!root.contains(a))return null;
  const hit=keys.find(([s])=>a.matches(s));
  return hit?hit[0]+hit[1].map(k=>"[data-"+k+'="'+CSS.escape(a.dataset[k]??"")+'"]').join(""):null}
let refocusing=false; // the focusin handler leaves a refocused row's log alone
function refocus(root,selector){const el=selector&&root.querySelector(selector);if(!el||document.activeElement===el)return;
  refocusing=true;try{el.focus({preventScroll:true})}finally{refocusing=false}}
// A section's own toggles redraw just that section from the board already loaded, even while text
// is selected elsewhere on the board, which holds every other redraw back.
function redrawSection(id){const root=document.getElementById("runs"),run=state.find(r=>r.id===id),old=root.querySelector('.run[data-run="'+CSS.escape(id)+'"]');
  if(!run||!old){lastState="";refresh();return}
  const focus=focusedOn(root),fresh=sectionView(run);old.replaceWith(fresh);refocus(root,focus);syncPulses(fresh)}
// The agent's structured report (its orch-result block) and the files it changed outside its plan.
// Each check shows the evidence `orch.mjs result` saved for it: the last matching run in the
// agent's log, as in "pass · ran, exit 0". A check reported as passing without a successful run is
// marked as a warning, as `result` warns. The dashboard only reads saved evidence.
const evidenceWords=e=>!e.ran?"NOT FOUND in the log":e.exitCode===0?"ran, exit 0":"exit "+(e.exitCode??"unknown");
const checkWarning=c=>{const e=c?.evidence;if(c?.result!=="pass"||!e||e.exitCode===0)return null;
  return !e.ran?"reported pass, but no matching run is in the log":e.exitCode==null?"reported pass, but the log has no exit code for its last run":"reported pass, but its last run exited "+e.exitCode};
function reportView(t){const r=t.report,out=t.scopeViolations||[];if(!r&&!out.length)return[];
  const text=v=>typeof v==="string"?v:JSON.stringify(v),list=(items,f=text)=>$("ul",{},...items.map(x=>$("li",{},f(x))));
  const mark=(s,ok,bad)=>$("span",{class:"state "+(s===ok?"s-completed":s===bad?"s-bad":s==null||s==="not-run"?"s-idle":"s-running")},s||"unknown");
  const check=c=>{const e=c&&typeof c==="object"?c.evidence:null,warn=checkWarning(c);
    return $("span",{class:warn?"check mismatch":"check",title:warn||""},mark(c?.result,"pass","fail"),
      e&&["pass","fail"].includes(c?.result)?$("span",{class:warn?"evw":"muted"}," · "+evidenceWords(e)+(warn?" ⚠":"")):null," "+(c?.cmd||"(no command)")+(c?.note?" — "+c.note:""))};
  const unproven=r?.checks?.length&&!t.native&&!t.main&&!t.external&&!["running","prepared"].includes(t.state)&&r.checks.some(c=>c&&typeof c==="object"&&!c.evidence);
  const rows=r?.invalid?[["report","invalid orch-result block: "+r.error]]:r?[["outcome",mark(r.outcome,"done","blocked")],
    ["checks",r.checks?.length?[list(r.checks,check),unproven?$("p",{class:"muted note"},"evidence is worked out by `orch.mjs result`"):null]:null],
    ["decisions",r.decisions?.length?list(r.decisions,d=>typeof d==="string"?d:(d?.question||"(no question)")+(d?.recommendation?" → "+d.recommendation:"")):null],
    ["unresolved",r.unresolved?.length?list(r.unresolved):null]]:[];
  rows.push(["outside its files",out.length?list(out):null]);
  return[$("h3",{},r?"Structured report":"Scope"),$("dl",{class:"report"},...rows.filter(([,v])=>v!=null).flatMap(([k,v])=>[$("dt",{},k),$("dd",{},v)]))]}
// Lays out a plan graph: `nodes` ([{id, state, attention}], in plan order) and `edges` ([{from, to}],
// from a task to one that depends on it). Tasks linked by edges, directly or through others, share a
// lane: a horizontal band, one per chain. Tasks linked to no other share an "independent" lane per
// status group. Lanes with a running task come first, then those with a task that needs someone (a
// decision, a failure, a review), then the rest, each group in plan order of the lanes' first tasks;
// a group's independent lane leads it, except the finished or planned one, which closes the drawing.
// Bands are padded so lanes stand further apart than rows. Within a chain's lane, each task goes one
// column right of the longest chain of tasks before it, and tasks stack from the top in plan order;
// an independent lane is a grid, filled left to right and then top to bottom, as many columns wide
// as fit `fit` pixels (at least 1, at most 4 or the widest chain's column count, whichever is more).
// A task moves only when its lane changes group, never within it, and not when a task is added to
// another lane. Columns line up across lanes. An edge that skips columns runs through a thin slot
// below the tasks of each column it crosses. Edges are smooth cubic curves from a task's right side
// to its dependent's left side. The plan validator forbids cycles; one found here is cut at its
// first task in plan order, so the layout always ends, and each edge that then points back (to a
// column at or left of its source) runs below its lane's tasks, on a channel of its own, through the
// gaps beside the columns. `order` lists the tasks as the eye reads them: lane by lane, a chain's
// column by column and top to bottom, a grid row by row.
// Returns {width, height, order, nodes: [{id, lane, layer, row, x, y, w, h}], edges: [{from, to, d, x1, y1, x2, y2}],
// lanes: [{index, y, h, independent, group (0 running, 1 needs someone, 2 the rest), label, ids, labelY}]}.
function graphLayout(nodes,edges,{w=184,h=58,gx=64,gy=16,pad=12,slot=6,turn=20,band=18,label=16,fit=Infinity}={}){
  const index=new Map();for(const n of nodes||[])if(n&&!index.has(n.id))index.set(n.id,index.size);
  const ids=[...index.keys()];if(!ids.length)return{width:0,height:0,order:[],nodes:[],edges:[],lanes:[]};
  const preds=new Map(ids.map(id=>[id,[]])),succs=new Map(ids.map(id=>[id,[]])),links=[],seen=new Set();
  for(const e of edges||[]){const k=JSON.stringify([e?.from,e?.to]);if(!e||e.from===e.to||!index.has(e.from)||!index.has(e.to)||seen.has(k))continue;
    seen.add(k);links.push(e);preds.get(e.to).push(e.from);succs.get(e.from).push(e.to)}
  links.sort((a,b)=>index.get(a.from)-index.get(b.from)||index.get(a.to)-index.get(b.to));
  // Longest-path layers, placing each task once every task before it is placed.
  const layer=new Map(),waiting=new Map(ids.map(id=>[id,preds.get(id).length]));
  let ready=ids.filter(id=>!waiting.get(id));
  while(layer.size<ids.length){
    if(!ready.length)ready=[ids.find(id=>!layer.has(id))]; // only cycles are left: cut one
    const next=[];
    for(const id of ready){if(layer.has(id))continue;
      layer.set(id,Math.max(0,...preds.get(id).filter(p=>layer.has(p)).map(p=>layer.get(p)+1)));
      for(const s of succs.get(id)){waiting.set(s,waiting.get(s)-1);if(!waiting.get(s)&&!layer.has(s))next.push(s)}}
    ready=next}
  // Lanes: the connected groups of linked tasks, and the tasks linked to no other by status group,
  // each collected in plan order. A lane goes in the group of its most pressing task.
  const info=new Map();for(const n of nodes||[])if(n&&!info.has(n.id))info.set(n.id,n);
  const urgency=id=>{const n=info.get(id);return n.state==="running"?0:["needs-decision","failed","awaiting-review"].includes(n.attention)?1:2};
  const group=new Map(ids.map(id=>[id,id])),root=id=>{while(group.get(id)!==id)id=group.get(id);return id};
  for(const e of links){const a=root(e.from),b=root(e.to);if(a!==b)group.set(index.get(a)<index.get(b)?b:a,index.get(a)<index.get(b)?a:b)}
  const linked=new Set(links.flatMap(e=>[e.from,e.to])),byKey=new Map(),lanes=[],laneOf=new Map();
  for(const id of ids){const key=linked.has(id)?"chain "+root(id):"alone "+urgency(id);
    if(!byKey.has(key)){byKey.set(key,{ids:[],independent:!linked.has(id)});lanes.push(byKey.get(key))}byKey.get(key).ids.push(id)}
  const names=["independent · running","independent · needs attention","independent"],lead=l=>l.independent?(l.group<2?-1:1):0;
  for(const lane of lanes){lane.group=Math.min(...lane.ids.map(urgency));lane.label=lane.independent?names[lane.group]:null}
  lanes.sort((a,b)=>a.group-b.group||lead(a)-lead(b));
  lanes.forEach((lane,i)=>{lane.index=i;for(const id of lane.ids)laneOf.set(id,i)});
  // Back edges need room for their turns beside the outer columns, and a channel each below their lane's tasks.
  const back=links.filter(e=>layer.get(e.to)<=layer.get(e.from)),side=back.length?turn:0,colX=l=>pad+side+l*(w+gx);
  const depthOf=lane=>Math.max(...lane.ids.map(id=>layer.get(id)))+1;
  const widest=Math.max(4,...lanes.filter(l=>!l.independent).map(depthOf)),fits=Math.floor((fit-2*(pad+side)+gx)/(w+gx));
  const across=Math.max(1,Math.min(widest,Number.isFinite(fits)?fits:widest));
  const at=new Map(),via=new Map(),slotY=new Map(),channel=new Map(),order=[];let y=0,width=0;
  for(const lane of lanes){
    // A chain's columns follow its layers; an independent lane wraps into a grid.
    const depth=lane.independent?Math.min(across,lane.ids.length):depthOf(lane),cols=Array.from({length:depth},()=>[]);
    lane.ids.forEach((id,i)=>cols[lane.independent?i%depth:layer.get(id)].push(id));
    // Slots go under each column's tasks, one per column an edge skips. A back edge takes none.
    const mine=links.filter(e=>laneOf.get(e.from)===lane.index),turns=mine.filter(e=>back.includes(e));
    for(const e of mine){via.set(e,[]);if(!turns.includes(e))for(let l=layer.get(e.from)+1;l<layer.get(e.to);l++){const v=" slot "+via.size+" "+l;cols[l].push(v);via.get(e).push([l,v])}}
    const first=y+band+(lane.independent?label:0),top=new Map();let tall=0;
    for(const c of cols){let cy=first;for(const id of c){top.set(id,cy);cy+=(index.has(id)?h:slot)+gy}tall=Math.max(tall,cy-gy-first)}
    for(const[v,t]of top)if(!index.has(v))slotY.set(v,t+slot/2);
    turns.forEach((e,k)=>channel.set(e,first+tall+gy+k*10));
    cols.forEach((c,l)=>c.filter(id=>index.has(id)).forEach((id,i)=>at.set(id,{id,lane:lane.index,layer:l,row:i,x:colX(l),y:top.get(id),w,h})));
    order.push(...(lane.independent?lane.ids:cols.flatMap(c=>c.filter(id=>index.has(id)))));
    const bottom=first+tall+(turns.length?gy+(turns.length-1)*10:0)+band;
    Object.assign(lane,{y,h:bottom-y,labelY:lane.independent?y+band+4:null});y=bottom;
    width=Math.max(width,2*(pad+side)+depth*w+(depth-1)*gx)}
  const curve=(x1,y1,x2,y2)=>{const dx=Math.max(24,Math.abs(x2-x1)/2);return"C"+(x1+dx)+" "+y1+" "+(x2-dx)+" "+y2+" "+x2+" "+y2};
  const path=e=>{const a=at.get(e.from),b=at.get(e.to),x1=a.x+w,y1=a.y+h/2,x2=b.x,y2=b.y+h/2;let d="M"+x1+" "+y1,x=x1,cy=y1;
    // Down beside the source's column, left along the channel, then up beside the target's column.
    if(channel.has(e)){const yb=channel.get(e);
      d+="C"+(x1+turn)+" "+y1+" "+(x1+turn)+" "+yb+" "+x1+" "+yb+"L"+x2+" "+yb+"C"+(x2-turn)+" "+yb+" "+(x2-turn)+" "+y2+" "+x2+" "+y2;
      return{from:e.from,to:e.to,x1,y1,x2,y2,d}}
    for(const[l,v]of via.get(e)){const vx=colX(l),vy=slotY.get(v);d+=curve(x,cy,vx,vy)+"L"+(vx+w)+" "+vy;x=vx+w;cy=vy}
    return{from:e.from,to:e.to,x1,y1,x2,y2,d:d+curve(x,cy,x2,y2)}};
  return{width,height:y,order,nodes:ids.map(id=>at.get(id)),edges:links.map(path),
    lanes:lanes.map(({index,y,h,independent,group,label,ids,labelY})=>({index,y,h,independent,group,label,ids,labelY}))}}
// The graph view of a section: one framed panel per run, each nested run right after the run whose
// task started it, indented under an accent line. A run with nothing planned or started is left out.
function graphView(sec){const byId=new Map(sec.runs.map(r=>[r.id,r])),kids=new Map(),order=[],seen=new Set();
  for(const r of sec.runs)if(r.parent&&byId.has(r.parent.run)){if(!kids.has(r.parent.run))kids.set(r.parent.run,[]);kids.get(r.parent.run).push(r)}
  const walk=(r,depth)=>{if(seen.has(r.id))return;seen.add(r.id);order.push([r,depth]);for(const k of kids.get(r.id)||[])walk(k,depth+1)};
  for(const r of sec.runs)if(!r.parent||!byId.has(r.parent.run))walk(r,0);for(const r of sec.runs)walk(r,0);
  const shown=order.filter(([r])=>r.graph?.nodes?.length);
  if(!shown.length)return $("p",{class:"muted gempty"},"Nothing planned or started with orch.mjs here. The tree view lists this section's sessions.");
  return $("div",{class:"graphs"},...shown.map(([r,depth])=>graphPanel(sec,r,depth)))}
// A run's panel: a one-line header (its goal, cut short with the whole goal in the tooltip, its short
// id, who delegated it, and a count of its tasks and of those needing attention), then its graph.
const NEEDS=[["needs-decision","needs decision","need decision"],["failed","failed","failed"],["awaiting-review","awaiting review","awaiting review"],["silent","silent","silent"]];
// Its graph wraps independent tasks to the width the panel will have: the board's, less the paddings
// and borders of the section, the panel list and the panel, and a nested panel's indent and accent.
function graphPanel(sec,r,depth){const nodes=r.graph.nodes,running=nodes.filter(n=>n.state==="running").length;
  const room=document.getElementById("runs")?.clientWidth,fit=room?room-88-(depth?depth*24+2:0):Infinity;
  const count=[nodes.length+(nodes.length===1?" task":" tasks"),running?running+" running":null,
    ...NEEDS.map(([kind,one,many])=>{const c=nodes.filter(n=>n.attention===kind).length;return c?c+" "+(c===1?one:many):null})].filter(Boolean).join(" · ");
  return $("div",{class:"gpanel"+(depth?" nested":""),"data-run":sec.id+"/"+r.id,role:"group","aria-label":"Plan of "+sectionTitle(r),...(depth?{style:"--depth:"+depth}:{})},
    $("h3",{class:"ghead",title:(r.goal||r.id)+"\nrun "+r.id},$("span",{class:"ggoal"},sectionTitle(r)),$("span",{class:"grun"},clip(r.id.replace(/^\d{8}-\d{6}-/,""),32)),
      r.parent?$("span",{class:"gfrom"},"delegated by "+r.parent.task):null,$("span",{class:"gcount"},count)),
    $("div",{class:"gwrap","data-run":sec.id+"/"+r.id},graphSvg(sec,r,fit)))}
// One run's graph as inline SVG. A node is colored by state like the tree's dots, dashed while only
// planned, outlined in its attention color, and marked "×N" after several attempts and "+N" for the
// tasks it delegated to a nested run. Choosing a node chooses its row (the click and key handlers).
// An edge is dashed until the task it starts from is integrated, then solid (`met`).
const $s=(t,a={},...kids)=>{const e=document.createElementNS("http://www.w3.org/2000/svg",t);for(const[k,v]of Object.entries(a))if(v!=null)e.setAttribute(k,v);
  for(const c of kids.flat())if(c!=null)e.append(c.nodeType?c:document.createTextNode(String(c)));return e};
const clip=(s,n)=>s.length>n?s.slice(0,n-1)+"…":s;
const nodeWord=n=>n.planned?(n.ready?"ready":"planned"):((n.state==="completed"&&n.phase)||(n.phase==="parked"&&"parked")||n.state||"not started").replace(/-/g," ");
function graphSvg(sec,r,fit=Infinity){const{nodes,edges}=r.graph,L=graphLayout(nodes,edges,{fit}),at=new Map(L.nodes.map(p=>[p.id,p])),byId=new Map(nodes.map(n=>[n.id,n]));
  const keyOf=n=>n.key?sec.id+"/"+n.key:null,hot=new Set(nodes.filter(n=>keyOf(n)&&keyOf(n)===sel).map(n=>n.id));
  // Drawn one unit to a pixel, at least as wide as its panel, so the lanes' bands span the panel.
  const svg=$s("svg",{class:"graph",width:L.width,height:L.height,role:"group","aria-label":"Plan graph: "+sectionTitle(r)});
  // One band per lane, every other one shaded, a thin line between them, and the labels of the lanes
  // of tasks linked to no other.
  for(const lane of L.lanes){svg.append($s("rect",{class:"glane"+(lane.index%2?" alt":""),x:0,y:lane.y,width:"100%",height:lane.h}));
    if(lane.index)svg.append($s("line",{class:"gdivide",x1:0,y1:lane.y,x2:"100%",y2:lane.y}));
    if(lane.independent)svg.append($s("text",{class:"glabel",x:12,y:lane.labelY},lane.label))}
  for(const e of L.edges){const c=(byId.get(e.from)?.phase==="integrated"?" met":"")+(hot.has(e.from)||hot.has(e.to)?" hot":"");
    svg.append($s("path",{class:"gedge"+c,d:e.d}),$s("path",{class:"garrow"+c,d:"M"+(e.x2-7)+" "+(e.y2-4)+"L"+e.x2+" "+e.y2+"L"+(e.x2-7)+" "+(e.y2+4)+"Z"}))}
  // Awaiting review has a color of its own, apart from the green of accepted and integrated work.
  // Nodes go in as the eye reads them (L.order), so Tab moves through them in that order.
  for(const n of L.order.map(id=>byId.get(id))){const p=at.get(n.id),k=keyOf(n),word=nodeWord(n),review=!n.planned&&n.phase==="awaiting-review";
    const dc=n.planned||!n.state?"":review?"d-review":dotClass({state:n.state,phase:n.phase});
    const tip=[n.id+(n.type?" ("+n.type+")":""),n.title,word+(n.attempts>1?" · "+n.attempts+" attempts":""),n.attention?"needs attention: "+n.attention.replace(/-/g," "):null,
      n.delegated?n.delegated+" task"+(n.delegated>1?"s":"")+" delegated to a nested run":null,k?null:"not started yet: nothing to show"].filter(Boolean);
    const badge=n.delegated?"+"+n.delegated:"",bw=10+badge.length*7;
    svg.append($s("g",{class:"gnode"+(dc?" "+dc:"")+(n.planned?" planned":"")+(k&&k===sel?" sel":""),transform:"translate("+p.x+" "+p.y+")",tabindex:"0",role:"button",
        "data-key":k,"data-node":sec.id+"/"+r.id+"/"+n.id,"aria-disabled":k?null:"true","aria-label":tip.join(", ")},
      $s("title",{},tip.join("\n")),
      n.attention?$s("rect",{class:"gattn a-"+n.attention,x:-4,y:-4,width:p.w+8,height:p.h+8,rx:10}):null,
      $s("rect",{class:"box",width:p.w,height:p.h,rx:7}),$s("circle",{class:"gdot",cx:13,cy:16,r:4}),
      $s("text",{class:"gid",x:24,y:20},clip(n.id,21)),
      $s("text",{class:"gsub",x:10,y:36},clip([n.agent,n.tier].filter(Boolean).join(" · ")||"agent not chosen",n.attempts>1?18:24)),
      n.attempts>1?$s("text",{class:"gsub",x:p.w-10,y:36,"text-anchor":"end"},"×"+n.attempts):null,
      $s("text",{class:"gword "+(n.planned||!n.state?"s-idle":review?"s-review":cls(outcome(n))),x:10,y:50},clip(word,26)),
      badge?$s("g",{class:"gbadge"},$s("rect",{x:p.w-bw+6,y:-7,width:bw,height:15,rx:7.5}),$s("text",{x:p.w+6-bw/2,y:4,"text-anchor":"middle"},badge)):null))}
  return svg}
// Where the details panel scrolls when it is rebuilt: a session just chosen opens at its newest
// events (the bottom), and a reader at the bottom (within 40 px) stays pinned there as events
// arrive; a reader who scrolled up keeps their place, and the jump buttons take them back down.
const atBottom=({scrollTop,scrollHeight,clientHeight})=>scrollTop+clientHeight>=scrollHeight-40;
const logScroll=(same,panel)=>!same||atBottom(panel)?"bottom":panel.scrollTop;
// The latest log fetched for each recently shown row, so a row paints at once when chosen. A
// row's log starts loading when the pointer reaches it, so it is usually ready by the click, and
// a row never has two loads at once.
const logs=new Map(),loading=new Map();
// The earlier attempt whose log and brief a row's panel shows, after a click on it in the
// Attempts list; a row not in it follows its current attempt. Each log is kept, and fetched, by its
// row and the number of the attempt it belongs to, so one attempt's log never shows as another's.
const attemptShown=new Map();
const shownAttempt=(key,t)=>{const n=attemptShown.get(key);return n&&n<=(t.attempt||0)?n:t.attempt||0};
const logAttempt=(key,t)=>t&&!t.native&&!t.main?shownAttempt(key,t):0;
const logKey=(key,t)=>{const n=logAttempt(key,t);return n?key+"@"+n:key};
const logSource=(t,n)=>t.native||t.main?(t.outDir?"api/transcript?file="+encodeURIComponent(t.outDir):null):"api/events?run="+encodeURIComponent(t.run)+"&task="+encodeURIComponent(t.id)+(n?"&attempt="+n:"");
// A log's fingerprint for the panel's change check: its length and a hash of every entry, since a
// log capped at 400 entries keeps its length as new entries push old ones out. Worked out once per log.
const prints=new WeakMap();
function logPrint(ev){if(!ev)return"loading";let p=prints.get(ev);if(p!=null)return p;let h=2166136261;
  for(const e of ev){const s=e.kind+"\u0000"+e.text+"\u0001";for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0}}
  p=ev.length+":"+h.toString(36);prints.set(ev,p);return p}
function loadLog(key,t){const n=logAttempt(key,t),lk=n?key+"@"+n:key,src=logSource(t,n);if(!src)return Promise.resolve([]);if(loading.has(lk))return loading.get(lk);
  const load=fetch(src).then(r=>r.json()).then(v=>v.events||[]).catch(()=>logs.get(lk)?.ev||[]).then(ev=>{loading.delete(lk);logs.delete(lk);
    logs.set(lk,{ev,at:Date.now()});if(logs.size>30)logs.delete(logs.keys().next().value);return ev});
  loading.set(lk,load);return load}
function preload(key){const t=taskAt(key),lk=logKey(key,t);if(t&&!loading.has(lk)&&!(Date.now()-(logs.get(lk)?.at||0)<3000))loadLog(key,t)}
async function detail(){
  if(!sel)return;const key=sel,[runId,taskId]=key.split("/");const run=state.find(r=>r.id===runId);const t=run?.tasks.find(x=>x.key===taskId);if(!t)return;
  const ext=t.native||t.main;
  // A newly chosen row paints at once, with the log it last had, before its fresh log arrives.
  const lk=logKey(key,t);
  if(document.getElementById("detail").dataset.sel!==key)paint(key,t,ext,logSource(t)?logs.get(lk)?.ev??null:[]);
  const ev=await loadLog(key,t);
  // A slower load for a row chosen earlier, or for another attempt of this row, must not repaint
  // the panel over the current one.
  const now=state.find(r=>r.id===runId)?.tasks.find(x=>x.key===taskId)||t;
  if(sel!==key||logKey(key,now)!==lk)return;
  paint(key,now,ext,ev);
}
// The panel's controls that keep focus across a repaint, found again as focusedOn finds the board's:
// an attempt line by its number, the Brief, "show attempt N", and the close button.
const PANEL_FOCUS=[[".att",["n"]],[".bsum",[]],[".linkish",[]],[".close",[]]];
// The final message as the panel shows it: without the orch-result block that the structured report
// above already shows. An invalid block stays, so the reader can see what is wrong with it.
const REPORT_BLOCK=/^[\t ]*```orch-result[\t ]*\r?\n[\s\S]*?^[\t ]*```[\t ]*(?=\r?$)/gm;
function shownMessage(t){const m=String(t.finalMessage||"");if(!t.report||t.report.invalid)return m;
  const blocks=[...m.matchAll(REPORT_BLOCK)],last=blocks.at(-1);return last?(m.slice(0,last.index)+m.slice(last.index+last[0].length)).trimEnd():m}
// An agent's message in the event log, with its orch-result block shortened: the structured report
// above shows it.
const saysText=x=>{const m=String(x??"");return m.replace(REPORT_BLOCK,"[orch-result block: see the report above]")};
// `ev` is null while the row's first log is still loading; it must be the log of the attempt the
// panel shows (logKey). `keep` holds the scroll position as it is, after a click inside the panel.
function paint(key,t,ext,ev,keep){
  // A task that orch.mjs started has receipts; its working directory and branch go in its Context line.
  const own=!ext&&!t.external&&(t.attempts||[]).length>0,n=own?shownAttempt(key,t):0,past=own&&n!==t.attempt;
  const sig=key+"@"+n+JSON.stringify(t)+logPrint(ev)+(own?briefSig(key,t,n):"");if(sig===lastDetail)return;
  const d=document.getElementById("detail");if(holding(d)){behind=true;return}lastDetail=sig;
  const to=keep&&d.dataset.sel===key?d.scrollTop:logScroll(d.dataset.sel===key,d);
  // A tool event with no output text gets no OUTPUT row.
  const rows=(ev||[]).filter(e=>e.kind!=="output"||String(e.text??"").trim()),message=t.finalMessage?shownMessage(t):"";
  const a=document.activeElement,focus=a&&d.dataset.sel===key&&d.contains(a)?focusedOn(d,PANEL_FOCUS):null;
  d.replaceChildren($("div",{class:"dhead"},$("h2",{},t.id+" · "+t.agent+" · ",$("span",{class:"state "+cls(t.phase==="parked"?"parked":t.state)},t.phase==="parked"?"parked":t.state)),
      $("button",{class:"close",title:"Close the details (Esc)","aria-label":"Close the details",onclick:closeDetail},"×")),
    $("dl",{},...[["state",(t.phase==="parked"?"parked":t.state)+(t.exitCode!=null?" (exit "+t.exitCode+")":"")],["phase",t.phase!==t.state&&t.phase!=="parked"?t.phase:null],["parked",t.parked?t.parked.waitsFor+" · watcher "+t.parked.watcher+(t.parked.lastCheckAt?" · checked "+timeText(t.parked.lastCheckAt):""):null],["health",t.health!=="ok"?t.health:null],["session",t.session],["model",t.model+(t.tier?" ("+t.tier+" tier)":"")],["why this agent",t.why],["attempt",t.attempt],["mode",t.mode],
      ["working dir",own?null:t.cd],["branch",own?null:t.branch],["tokens",fmt(t.tokensIn)+" in ("+fmt(t.tokensCached)+" cached) / "+fmt(t.tokensOut)+" out"],
      ["touched files",t.touchedFiles?t.touchedFiles.join("  "):null],[ext?"transcript":"artifacts",t.outDir]].filter(([,v])=>v!=null&&v!=="").flatMap(([k,v])=>[$("dt",{},k),$("dd",{},v)])),
    ...(own?[...contextView(t,n),...briefView(key,t,n),...attemptsView(key,t,n)]:[]),
    ...reportView(t),
    ...reviewView(t),
    ...(message?[$("h3",{},ext?"Latest message":"Final report"),$("div",{class:"final"},$("pre",{},message))]:[]),
    ...(t.main?[$("p",{class:"muted"},"The session that launched this run. Its counts cover the whole session and are not in the run's totals.")]:[]),
    ...(t.inbox?.messages?.length?[$("h3",{},"Messages ("+t.inbox.messages.length+")"),...t.inbox.messages.map(m=>$("div",{class:"msg"+(m.from==="user"?" you":"")},
      $("span",{class:"k"},(m.from==="user"?"you":"orchestrator")+" · "+new Date(m.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})+" · "+(m.read?"read":"not read yet")),$("pre",{},m.text+(m.images?"\n("+(m.images>1?m.images+" images":"1 image")+" attached)":"")),
      ...(m.replies||[]).map(r=>$("div",{class:"r"},$("span",{class:"k"},"reply · "+new Date(r.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})),rich(r.text)))))]:[]),
    $("h3",{},(past?"Events of attempt "+n:"Events")+(ev?" ("+rows.length+", newest last)"+(ext?", from its transcript":""):" (loading…)"),
      past?$("button",{type:"button",class:"linkish",onclick:()=>showAttempt(key,t.attempt)},"show attempt "+t.attempt):null),
    ...rows.map(e=>$("div",{class:"ev "+e.kind},$("span",{class:"k"},e.kind),e.kind==="reply"?rich(e.text):$("pre",{},e.kind==="says"?saysText(e.text):e.text))));
  d.dataset.sel=key;d.scrollTop=to==="bottom"?d.scrollHeight:to;
  if(focus)refocus(d,focus);
}
// The receipts of a task that orch.mjs started: what it was given (a Context line, and its brief,
// loaded when opened), what each attempt did, and what was accepted or rejected on what evidence.
// Main sessions, native sub-agents and outside agents have no receipts, so they get none of these
// sections, and a task gets only the sections it has something for.
const bytesText=n=>n<1024?n+" B":n<1048576?(n/1024).toFixed(n<10240?1:0)+" KB":(n/1048576).toFixed(1)+" MB";
const timeText=iso=>{const d=new Date(iso);if(isNaN(d))return"";const hm=d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  return d.toDateString()===new Date().toDateString()?hm:d.toLocaleDateString([],{month:"short",day:"numeric"})+" "+hm};
const shortSha=c=>String(c||"").slice(0,7);
// Paint the chosen row's panel again at once, from what is already loaded, after a click in it.
function repaint(key){const t=taskAt(key);if(!t||sel!==key)return;lastDetail="";paint(key,t,t.native||t.main,logSource(t)?logs.get(logKey(key,t))?.ev??null:[],true)}
// Show attempt n's log and brief in the row's panel; choosing the current attempt follows it again.
// An open Brief moves to that attempt, and loads it. "show attempt N" leaves the focus on its line.
function showAttempt(key,n){const t=taskAt(key);if(!t)return;const fromLink=document.activeElement?.matches?.(".linkish");
  if(n===t.attempt)attemptShown.delete(key);else attemptShown.set(key,n);
  if(briefOpen.has(key)){briefOpen.set(key,n);loadBrief(key,t,n,true)}
  repaint(key);if(fromLink)refocus(document.getElementById("detail"),".att.on");detail()}
// Briefs fetched for the panel, by run, task and attempt: {text, bytes}, {error}, or {} while it
// loads. For each row whose Brief is open, `briefOpen` holds the attempt it shows.
const briefs=new Map(),briefOpen=new Map();
const briefKey=(t,n)=>t.run+"/"+t.id+"/"+n;
const briefSig=(key,t,n)=>{const b=briefs.get(briefKey(t,n));return"|"+(briefOpen.get(key)===n)+"|"+(!b?"":b.text!=null?b.text.length:b.error||"loading")};
// Fetch attempt n's brief once. A failed fetch stays failed, and is shown, until the reader opens
// the Brief again or chooses another attempt (`retry`); nothing else fetches it again.
function loadBrief(key,t,n,retry){const k=briefKey(t,n),b=briefs.get(k);if(b&&!(retry&&b.error))return;
  briefs.delete(k);briefs.set(k,{});if(briefs.size>20)briefs.delete(briefs.keys().next().value);
  fetch("api/brief?run="+encodeURIComponent(t.run)+"&task="+encodeURIComponent(t.id)+"&attempt="+n)
    .then(async r=>{const v=await r.json().catch(()=>({}));briefs.set(k,r.ok&&typeof v.text==="string"?{text:v.text,bytes:v.bytes}:{error:v.error||"HTTP "+r.status})},
      ()=>{briefs.set(k,{error:"the dashboard is not reachable"})})
    .then(()=>repaint(key))}
// The reader opened or closed the Brief. The browser fires `toggle` for a <details> rebuilt open too;
// that one matches the state already kept, so only the reader's own change acts.
function toggleBrief(key,t,n,open){if(open===(briefOpen.get(key)===n))return;
  if(!open){briefOpen.delete(key);return}
  briefOpen.set(key,n);loadBrief(key,t,n,true);repaint(key)}
function briefView(key,t,n){const b=briefs.get(briefKey(t,n)),open=briefOpen.get(key)===n;
  const body=!open?null:b?.text!=null?$("div",{class:"final"},$("pre",{},b.text)):$("p",{class:"muted"},b?.error?"Not loaded: "+b.error+".":b?"Loading…":"Not loaded; close and open the Brief to load it.");
  return[$("details",{class:"brief",...(open?{open:""}:{}),ontoggle:e=>toggleBrief(key,t,n,e.currentTarget.open)},
    $("summary",{class:"bsum"},"Brief",t.attempt>1?$("span",{class:"muted"}," · attempt "+n):null),body)]}
// One line: the brief's size, whether the attempt resumed an earlier session (and which), how many
// messages the agent received, and where it works.
function contextView(t,n){const a=(t.attempts||[]).find(x=>x.n===n);
  const resumed=!a?null:!a.resumed?(a.n>1?"new session":null):"resumed "+(a.resumedAttempt?"attempt "+a.resumedAttempt+"'s session":"session")+(typeof a.resumed==="string"?" "+a.resumed.slice(0,8):"");
  const read=t.inbox?.read||0;
  const bits=[a?.briefBytes!=null?"brief "+bytesText(a.briefBytes):null,resumed,t.inbox?read+" message"+(read===1?"":"s")+" received":null,t.cd?t.cd+(t.branch?" @ "+t.branch:""):null].filter(Boolean);
  return bits.length?[$("p",{class:"ctx"},$("span",{class:"k"},"Context"),bits.join(" · "))]:[]}
// How an attempt ended, in words: completed, needs decision, parked, stopped, or failed with its error.
const attemptEnd=a=>a.state==="completed"?"completed":a.state==="needs-decision"?"needs decision":a.state==="running"||a.state==="stopped"||a.state==="parked"?a.state:(a.state||"unknown")+(a.error?": "+a.error:"");
// The attempts, newest first, one line each; choosing one shows its events (and brief) below.
function attemptsView(key,t,n){const list=t.attempts||[];if(!list.length)return[];
  return[$("h3",{},"Attempts"),$("div",{class:"attempts"},...list.map(a=>{const on=a.n===n,end=attemptEnd(a);
    const time=a.state==="running"&&a.n===t.attempt?t.elapsed:a.durationMs!=null?dur(a.durationMs):null;
    const tip=[on?"Its events are shown below":"Show this attempt's events",a.session?"session "+a.session:null,a.startedAt?"started "+timeText(a.startedAt):null,end].filter(Boolean).join("\n");
    return $("button",{type:"button",class:"att"+(on?" on":""),"data-n":String(a.n),"aria-pressed":String(on),title:tip,onclick:()=>showAttempt(key,a.n)},
      $("b",{},"#"+a.n),$("span",{class:"muted"},a.reason||"-"),$("span",{},[a.agent,a.model].filter(Boolean).join(" · ")||"-"),
      time?$("span",{class:"num"},time):null,$("span",{class:"num"},fmt(a.tokensIn)+" in / "+fmt(a.tokensOut)+" out"),
      $("span",{class:"end state "+cls(a.state)},end),a.outcome?$("span",{class:"muted"},"reported "+a.outcome):null)}))]}
// The coordinator's own receipts: the gates it reran (orch.mjs verify), its review rounds (verdict),
// and the acceptance or rejection, each with its commit, reviewer, time and note.
function reviewView(t){const vs=t.verifications||[],rs=t.reviewRounds||[],acc=t.acceptance||null;if(!vs.length&&!rs.length&&!acc)return[];
  const several=t.attempt>1,rows=[],note=s=>s?" — "+s:"";
  const verdict=(word,good)=>$("span",{class:"state "+(good===true?"s-completed":good===false?"s-bad":"s-running")},word);
  if(vs.length)rows.push(["verified",$("ul",{},...vs.map(v=>$("li",{},v.id?$("span",{class:"muted"},v.id+" "):null,verdict(v.passed?"pass":"fail",!!v.passed)," "+(v.cmd||"(no command)"),
    $("span",{class:"muted"}," · "+[v.timedOut?"timed out":v.exitCode!=null?"exit "+v.exitCode:v.signal||"exit unknown",v.commit?shortSha(v.commit)+(v.dirty?" dirty":""):null,
      several&&v.attempt?"attempt "+v.attempt:null,v.by?"by "+v.by:null,v.startedAt?timeText(v.startedAt):null].filter(Boolean).join(" · ")))))]);
  if(rs.length)rows.push(["review rounds",$("ul",{},...rs.map(r=>$("li",{},"round "+r.round+" · attempt "+r.attempt+" · ",verdict(r.verdict||"unknown",r.verdict==="clean"?true:r.verdict==="reject"?false:null),
    $("span",{class:"muted"}," · by "+(r.reviewer||"coordinator")+(r.at?" · "+timeText(r.at):"")+(r.verifications?.length?" · on "+r.verifications.join(", "):"")),note(r.note))))]);
  if(acc){const old=acc.attempt!=null&&acc.attempt!==t.attempt,yes=acc.verdict==="accepted";
    rows.push(["acceptance",[verdict(yes?"accepted":"rejected",yes)," attempt "+(acc.attempt??"?")+(yes&&acc.commit?" at "+shortSha(acc.commit):"")+(yes&&acc.by?" by "+acc.by:""),
      $("span",{class:"muted"},acc.at?" · "+timeText(acc.at):""),note(acc.note),old?$("span",{class:"muted"}," (an earlier attempt: it does not cover attempt "+t.attempt+")"):null]])}
  return[$("h3",{},"Verification and review"),$("dl",{class:"report"},...rows.flatMap(([k,v])=>[$("dt",{},k),$("dd",{},v)]))]}
async function limits(){try{const u=await (await fetch("api/usage")).json();
  document.getElementById("limits").replaceChildren(...["claude","codex"].map(k=>$("span",{class:"limit"+(u[k]&&u[k].max>=80?" hot":""),title:u[k]?u[k].full:"no reading yet"},
    $("b",{},k[0].toUpperCase()+k.slice(1))," "+(u[k]?u[k].short:"unknown"))))}catch{}}
// The message box for the chosen agent. It sits outside the details panel, which is rebuilt as
// events arrive, so typing survives redraws; each task keeps its own draft until it is sent.
// The send key arrives once, in the URL fragment that `orch.mjs dashboard --open` opens, and stays
// in this browser's storage for every tab of this dashboard.
// At load this runs before the message box is set up, so only a later fragment repaints the box.
const takeKey=()=>{const m=/(?:^|&)token=([0-9a-f]{48})(?:&|$)/.exec(location.hash.slice(1));if(!m)return false;
  try{localStorage.setItem("orchSendKey",m[1])}catch{}history.replaceState(null,"",location.pathname+location.search);return true};
takeKey();addEventListener("hashchange",()=>{if(takeKey())compose()});
const sendKey=()=>{try{return localStorage.getItem("orchSendKey")}catch{return null}};
const NO_KEY="This browser has no key for sending messages yet. Run `orch.mjs dashboard --open --new-tab` once; every tab of this dashboard can send after that.";
const drafts=new Map();let composeKey=null,sending=false,files=[];
const MAX_IMAGES=4,MAX_IMAGE_BYTES=5*1024*1024,IMAGE_TYPES=["image/png","image/jpeg","image/gif","image/webp"];
// Images waiting to go with the next message, shown as thumbnails that can be removed.
function showFiles(){const box=document.getElementById("compose-files");for(const img of box.querySelectorAll("img"))URL.revokeObjectURL(img.src);
  box.replaceChildren(...files.map((file,i)=>$("div",{class:"f",title:file.name||"pasted image"},$("img",{src:URL.createObjectURL(file),alt:file.name||"pasted image"}),
    $("button",{type:"button",title:"Remove this image","aria-label":"Remove this image",onclick:()=>{files=files.filter((_,j)=>j!==i);showFiles()}},"×"))));
  box.hidden=!files.length}
function addFiles(list){const status=document.getElementById("compose-status"),skipped=[];
  for(const file of list){if(!IMAGE_TYPES.includes(file.type))skipped.push((file.name||"a file")+" is not a PNG, JPEG, GIF or WebP image");
    else if(file.size>MAX_IMAGE_BYTES)skipped.push((file.name||"an image")+" is over 5 MB");else if(files.length>=MAX_IMAGES)skipped.push("at most "+MAX_IMAGES+" images go with one message");else files.push(file)}
  if(skipped.length){status.className="bad";status.textContent="Not attached: "+[...new Set(skipped)].join("; ")+"."}showFiles()}
const asBase64=file=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).slice(String(r.result).indexOf(",")+1));r.onerror=()=>reject(r.error);r.readAsDataURL(file)});
// An agent's answer as readable text: paragraphs, "- " bullets, `code`, **bold**, and links shown
// short (the full address is in the tooltip). Built from DOM nodes, never from HTML.
function linkLabel(url){try{const u=new URL(url),run=u.searchParams.get("dag_run_id"),dag=/\/dags\/([^/]+)/.exec(u.pathname)?.[1];
  if(dag)return dag+(run?" · "+run.replace(/\+00:00$/,""):"");
  const gh=u.host==="github.com"&&/^\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(u.pathname);if(gh)return gh[1]+"#"+gh[2]+(u.hash.startsWith("#discussion")||u.hash.startsWith("#issuecomment")?" (comment)":"");
  const path=u.pathname.replace(/\/$/,"");return u.host+(path.length>40?"/…"+path.slice(path.lastIndexOf("/")):path)}catch{return url}}
function inline(text){const out=[];const re=/(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|`([^`]+)`|\*\*([^*]+)\*\*/g;let at=0,m;
  while((m=re.exec(text))){if(m.index>at)out.push(text.slice(at,m.index));
    if(m[1])out.push($("a",{href:m[1],target:"_blank",rel:"noopener noreferrer",title:m[1]},linkLabel(m[1])));else if(m[2])out.push($("code",{},m[2]));else out.push($("strong",{},m[3]));at=re.lastIndex}
  if(at<text.length)out.push(text.slice(at));return out}
function rich(text){const box=$("div",{class:"rich"});let list=null,para=[];
  const flush=()=>{if(para.length){box.append($("p",{},...para.flatMap((line,i)=>[...(i?[$("br")]:[]),...inline(line)])));para=[]}};
  for(const line of String(text).split("\n")){const item=/^\s*[-*•]\s+(.*)$/.exec(line);
    if(item){flush();if(!list){list=$("ul");box.append(list)}list.append($("li",{},...inline(item[1])));continue}
    list=null;if(!line.trim())flush();else para.push(line.trim())}
  flush();return box}
// The agent's latest answer to a message from the user, highlighted above the queue until closed.
const closedReplies=new Set((()=>{try{return JSON.parse(localStorage.getItem("orchClosedReplies")||"[]")}catch{return[]}})());
function showReply(t){const box=document.getElementById("compose-reply"),r=t?.inbox?.lastReply,id=r&&t.key+"@"+r.time;
  if(!r||closedReplies.has(id)){box.replaceChildren();box.hidden=true;return}
  box.replaceChildren($("button",{type:"button",class:"x",title:"Close","aria-label":"Close the reply",onclick:()=>{closedReplies.add(id);
      try{localStorage.setItem("orchClosedReplies",JSON.stringify([...closedReplies].slice(-200)))}catch{}showReply(t)}},"×"),
    $("span",{class:"rh"},t.id+" replied · "+new Date(r.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})),rich(r.text));box.hidden=false}
// Messages sent but not yet read: they reach the agent after its next step.
function showQueue(t){const box=document.getElementById("compose-queue"),queued=(t?.inbox?.messages||[]).filter(m=>!m.read);
  box.replaceChildren(...(queued.length?[$("div",{class:"qh"},queued.length+" queued: the agent reads "+(queued.length>1?"them":"it")+" after its next step",
      $("button",{type:"button",class:"now",title:"Stop the agent's current shell command so it reads these now (never a commit, push or other publishing command)",onclick:()=>sendNow(t)},"Send now")),
    ...queued.map(m=>$("div",{class:"q",title:m.text},$("span",{class:"t"},(m.from==="user"?"you":"orchestrator")+" · "+new Date(m.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})),
      $("span",{class:"x"},m.text.replace(/\s+/g," ")+(m.images?" ("+(m.images>1?m.images+" images":"1 image")+")":""))))]:[]));
  box.hidden=!queued.length}
const taskAt=key=>{if(!key)return null;const[runId,taskKey]=key.split("/");return state.find(r=>r.id===runId)?.tasks.find(x=>x.key===taskKey)||null};
function compose(){const box=document.getElementById("compose"),area=document.getElementById("compose-text"),note=document.getElementById("compose-note"),
  status=document.getElementById("compose-status"),t=taskAt(sel);
  if(composeKey!==sel){if(composeKey!=null){if(area.value||files.length)drafts.set(composeKey,{text:area.value,files});else drafts.delete(composeKey)}
    const draft=drafts.get(sel);area.value=draft?.text||"";files=draft?.files||[];showFiles();status.textContent="";status.className="";status.title="";composeKey=sel}
  if(!t){box.hidden=true;document.documentElement.style.setProperty("--compose-h","0px");return}
  const why=t.main?"This is the session that launched the run: type in its own terminal."
    :t.external?"A command started this agent outside the orchestrator, so it takes no messages. Message the session or task that ran the command."
    :t.native?"This agent was started by its session's own sub-agent tool, which takes no messages from outside. Message the session or task that started it."
    :!["running","parked"].includes(outcome(t))?"This task is not running ("+outcome(t)+"). A message reaches only a running agent: ask its orchestrator to resume it.":"";
  document.getElementById("compose-title").textContent=why?"Messages":"Message "+t.id;
  note.textContent=why||(sendKey()?"":NO_KEY);note.hidden=!note.textContent;
  area.hidden=document.querySelector("#compose .crow").hidden=!!why;document.getElementById("compose-send").disabled=sending||!sendKey();box.hidden=false;
  showReply(t);showQueue(why?null:t);if(why)document.getElementById("compose-files").hidden=true;else showFiles();
  document.documentElement.style.setProperty("--compose-h",box.offsetHeight+"px")}
// Pushes a task's queued messages through by stopping its current command.
async function sendNow(t){const status=document.getElementById("compose-status");status.className="";status.textContent="Interrupting…";
  try{const r=await fetch("api/steer",{method:"POST",headers:{"content-type":"application/json","x-orch-token":sendKey()||""},body:JSON.stringify({run:t.run,task:t.id})});
    const v=await r.json().catch(()=>({}));
    if(r.ok){status.className=v.steer?.stopped?"ok":"warn";status.textContent=v.steer?.stopped?"Stopped `"+v.steer.stopped+"`"+(v.steer.seconds?" after "+dur(v.steer.seconds*1000):"")+" so it reads "+(v.queued>1?"them":"it")+" now.":"Not interrupted: "+v.steer?.waiting+"."}
    else{status.className="bad";status.textContent=(v.key==="rejected"?NO_KEY:v.error||"HTTP "+r.status)}}
  catch{status.className="bad";status.textContent="The dashboard is not reachable"}
  finally{lastState="";refresh().then(detail)}}
// Sends the box's text to the task the box belongs to, which is the one its draft was typed for.
async function sendMessage(e){e.preventDefault();const key=composeKey,t=taskAt(key),area=document.getElementById("compose-text"),button=document.getElementById("compose-send"),status=document.getElementById("compose-status");
  const typed=area.value,text=typed.trim(),attached=files;if(!t||(!text&&!attached.length)||sending||!sendKey())return;
  sending=true;button.disabled=true;status.className="";status.textContent="Sending…";
  try{const images=await Promise.all(attached.map(async file=>({data:await asBase64(file)})));
    const steer=document.getElementById("compose-steer").checked;
    const r=await fetch("api/send",{method:"POST",headers:{"content-type":"application/json","x-orch-token":sendKey()||""},body:JSON.stringify({run:t.run,task:t.id,text,images,steer})});
    const v=await r.json().catch(()=>({}));
    if(r.ok){if(composeKey===key&&area.value===typed)area.value="";if(composeKey===key&&files===attached){files=[];showFiles()}
      const draft=drafts.get(key);if(draft&&draft.text===typed&&draft.files===attached)drafts.delete(key);
      const at="Sent at "+new Date(v.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})+". ";
      status.className=v.reaches===false?"warn":"ok";
      status.textContent=at+(v.steer?.stopped?"Stopped `"+v.steer.stopped+"`"+(v.steer.seconds?" after "+dur(v.steer.seconds*1000):"")+" so it reads it now.":v.steer?.waiting?"It reads it after its current step: "+v.steer.waiting+".":v.delivery?v.delivery[0].toUpperCase()+v.delivery.slice(1)+".":"");
      status.title=at+(v.delivery||"")}
    else{if(v.key==="rejected")try{localStorage.removeItem("orchSendKey")}catch{}
      status.className="bad";status.textContent="Not sent: "+(v.key==="rejected"?NO_KEY:v.error||"HTTP "+r.status)}}
  catch{status.className="bad";status.textContent="Not sent: the dashboard is not reachable"}
  finally{sending=false;button.disabled=!sendKey();if(composeKey!==key){status.textContent="";status.className=""}lastState="";refresh().then(detail)}}
document.getElementById("compose").addEventListener("submit",sendMessage);
(()=>{const box=document.getElementById("compose-steer");try{box.checked=localStorage.getItem("orchSteer")!=="off"}catch{}
  box.addEventListener("change",()=>{try{localStorage.setItem("orchSteer",box.checked?"on":"off")}catch{}})})();
// Enter sends and Shift+Enter starts a new line, except while an input method is composing text.
document.getElementById("compose-text").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();document.getElementById("compose").requestSubmit()}
  else if(e.key==="Escape"){e.stopPropagation();e.target.blur()}});
document.getElementById("compose-text").addEventListener("paste",e=>{const images=[...(e.clipboardData?.files||[])].filter(f=>f.type.startsWith("image/"));if(images.length){e.preventDefault();addFiles(images)}});
document.getElementById("compose-attach").addEventListener("click",()=>document.getElementById("compose-file").click());
document.getElementById("compose-file").addEventListener("change",e=>{addFiles([...e.target.files]);e.target.value=""});
(()=>{const box=document.getElementById("compose"),hasFiles=e=>[...(e.dataTransfer?.types||[])].includes("Files");
  box.addEventListener("dragover",e=>{if(!hasFiles(e)||document.getElementById("compose-text").hidden)return;e.preventDefault();box.classList.add("drop")});
  box.addEventListener("dragleave",()=>box.classList.remove("drop"));
  box.addEventListener("drop",e=>{box.classList.remove("drop");if(!hasFiles(e)||document.getElementById("compose-text").hidden)return;e.preventDefault();addFiles([...e.dataTransfer.files])})})();
new ResizeObserver(()=>{const box=document.getElementById("compose");document.documentElement.style.setProperty("--compose-h",(box.hidden?0:box.offsetHeight)+"px")}).observe(document.getElementById("compose"));
// Jump to the top or bottom of the details panel; each button shows only when it would move.
(()=>{const d=document.getElementById("detail"),up=document.getElementById("jump-top"),down=document.getElementById("jump-bottom");
  const sync=()=>{up.hidden=d.scrollTop<40;down.hidden=atBottom(d)};
  up.onclick=()=>{d.scrollTop=0};down.onclick=()=>{d.scrollTop=d.scrollHeight};
  d.addEventListener("scroll",sync,{passive:true});new ResizeObserver(sync).observe(d);new MutationObserver(sync).observe(d,{childList:true});sync()})();
// Drag the divider to resize the details panel; the width is remembered in this browser.
(()=>{const main=document.querySelector("main"),sp=document.getElementById("splitter");
  const set=w=>{if(w)main.style.setProperty("--detail-w",w+"px");else main.style.removeProperty("--detail-w")};
  const saved=Number(localStorage.getItem("orchDetailWidth"));if(saved)set(saved);
  let dragging=false;
  sp.addEventListener("pointerdown",e=>{e.preventDefault();dragging=true;try{sp.setPointerCapture(e.pointerId)}catch{}sp.classList.add("drag");document.body.classList.add("resizing")});
  addEventListener("pointermove",e=>{if(!dragging)return;
    const w=Math.round(Math.min(Math.max(innerWidth-e.clientX-4,240),innerWidth-360));set(w);localStorage.setItem("orchDetailWidth",w)});
  const end=()=>{dragging=false;sp.classList.remove("drag");document.body.classList.remove("resizing")};
  addEventListener("pointerup",end);addEventListener("pointercancel",end);
  sp.addEventListener("dblclick",()=>{localStorage.removeItem("orchDetailWidth");set(0)})})();
// Waiting timers tick together once a second from their absolute start, between redraws too.
function dur(ms){const t=Math.max(0,Math.floor(ms/1000)),d=Math.floor(t/86400),h=Math.floor(t%86400/3600),m=Math.floor(t%3600/60),x=t%60,p=n=>String(n).padStart(2,"0");if(d>=365)return Math.floor(d/365)+"y "+Math.floor(d%365/30)+"mo";if(d>=30)return Math.floor(d/30)+"mo "+d%30+"d";if(d)return d+"d "+h+"h";return h?h+"h "+p(m)+"m":m?m+"m "+p(x)+"s":x+"s"}
function tick(){const now=Date.now();for(const el of document.querySelectorAll(".tick[data-since]"))el.textContent=dur(now-Number(el.dataset.since))}
setTimeout(()=>{tick();setInterval(tick,1000)},1000-Date.now()%1000);
// A new dashboard server reloads the page. Keep the chosen row, the panel and the typed drafts in
// this tab across that reload, so a restart only refreshes the page in place.
function keepState(){try{if(composeKey!=null){const area=document.getElementById("compose-text");if(area.value)drafts.set(composeKey,{text:area.value,files:[]});else drafts.delete(composeKey)}
  sessionStorage.setItem("orchKept",JSON.stringify({sel,drafts:[...drafts].map(([k,d])=>[k,d.text]).filter(([,t])=>t)}))}catch{}}
addEventListener("pagehide",keepState);
(()=>{let kept;try{kept=JSON.parse(sessionStorage.getItem("orchKept")||"null");sessionStorage.removeItem("orchKept")}catch{}
  if(!kept)return;for(const[k,text]of kept.drafts||[])drafts.set(k,{text,files:[]});
  if(kept.sel){sel=kept.sel;document.querySelector("main").classList.remove("no-detail")}})();
refresh().then(detail);setInterval(()=>soon(),2000);limits();setInterval(limits,30000);
// The server pushes "change" when an agent writes; refresh at once, one refresh at a time.
let refreshing=false,queued=false;
function soon(){if(refreshing){queued=true;return}refreshing=true;refresh().then(detail).finally(()=>{refreshing=false;if(queued){queued=false;soon()}})}
// A graph wraps its independent tasks to the board's width, so a resize redraws it once it settles.
let resized=null;addEventListener("resize",()=>{clearTimeout(resized);resized=setTimeout(()=>{if(graphShown.size){lastState="";soon()}},250)});
const presence=new EventSource("api/presence");
presence.addEventListener("change",soon);
function showEscalation(event){
  if(!("Notification" in window)||Notification.permission!=="granted")return;
  try{
    const item=JSON.parse(event.data),notice=new Notification("Agent Orchestrator needs attention",{
      body:item.text,tag:JSON.stringify([item.run,item.task,item.attempt,item.kind])});
    notice.onclick=()=>{window.focus();notice.close();refresh().then(()=>reveal(item.key))};
  }catch{}
}
presence.addEventListener("escalation",showEscalation);
