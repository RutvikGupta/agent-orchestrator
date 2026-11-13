const $=(t,a={},...kids)=>{const e=document.createElement(t);for(const[k,v]of Object.entries(a)){if(k==="class")e.className=v;else if(k.startsWith("on"))e.addEventListener(k.slice(2),v);else e.setAttribute(k,v)}
for(const c of kids.flat())if(c!=null)e.append(c.nodeType?c:document.createTextNode(String(c)));return e};
const fmt=n=>n==null?"-":n<1000?String(n):n<1e6?(n/1000).toFixed(n<1e4?1:0)+"k":(n/1e6).toFixed(1)+"M";
const outcome=t=>t.phase==="parked"?"parked":t.closed&&t.state==="idle"?"completed":t.state;
const exitedLabel=t=>outcome(t);
const cls=s=>s==="running"?"s-running":s==="needs-decision"?"s-ask":s==="completed"?"s-completed":s==="prepared"||s==="closed"||s==="idle"||s==="parked"?"s-idle":"s-bad";
// The attempt of its task that started an agent, once the task has had more than one.
const startedIn=(x,parent)=>x.taskAgent&&x.taskAttempt&&parent?.attempt>1?x.taskAttempt:null;
let sel=null,state=[],lastState="",lastDetail="",server=null;const IND=18,GUTTER=10; // GUTTER: room left of the tree for the rows' grips
// A row with sub-agents opens while any agent under it runs and closes once none do; clicking its
// arrow, or the row itself, overrides that until the running state under it changes.
const manual=new Map(),live=new Map();
// The rows that are open without a click: a running agent, or a main session, with a running row
// somewhere under it. A finished agent's sub-agents stay closed, on every load too, even while one
// of them still runs: its row then says how many rows are hidden and how many of those run.
const autoOpen=tasks=>{const byKey=new Map(tasks.map(t=>[t.key,t])),open=new Set();
  for(const t of tasks)if(t.state==="running")for(let p=t.parentKey;p;p=byKey.get(p)?.parentKey){const up=byKey.get(p);if(up&&(up.main||up.state==="running"))open.add(p)}
  return open};
const isOpen=k=>{const a=!!live.get(k),m=manual.get(k);if(m&&m.auto===a)return m.open;manual.delete(k);return a};
// Sections whose older rows (finished and quiet a while; the server flags them) are shown, until
// "hide older" is clicked or the page reloads.
const olderShown=new Set();
// The order rule for what the user dragged. A list is the board's sections, or the rows under one
// parent in one section. A drop remembers, for its list, the automatic order (the server's) of the
// list's keys at that moment and the user's order: `memo` is {auto, order}. The user's order shows
// while the automatic order still has the same keys in the same order; any change there (an item
// moved, appeared or left) makes the memory invalid, and the list shows the automatic order again.
const sameOrder=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((k,i)=>k===b[i]);
// Keys are distinct strings; anything else in a memory (it comes from storage) is never sorted or shown.
const isKeys=a=>Array.isArray(a)&&a.every(k=>typeof k==="string")&&new Set(a).size===a.length;
const sameKeys=(a,b)=>isKeys(a)&&isKeys(b)&&sameOrder([...a].sort(),[...b].sort());
function heldOrder(auto,memo){const order=memo?.order;
  const valid=sameOrder(auto,memo?.auto)&&sameKeys(order,auto);
  return{keys:[...(valid?order:auto)],valid}}
// The well-formed memories in what storage held: an object of lists, each with `auto` and `order`
// holding the same distinct string keys. Everything else is dropped, so stored data never breaks a draw.
function validOrders(v){const out={};if(!v||typeof v!=="object"||Array.isArray(v))return out;
  for(const[n,m]of Object.entries(v))if(m&&typeof m==="object"&&sameKeys(m.auto,m.order))out[n]={auto:[...m.auto],order:[...m.order]};
  return out}
// A list's name: "sections", or the section's id and the parent's key ("" for the top level).
const listName=(runId,parentKey)=>JSON.stringify([runId,parentKey||""]);
const sameParent=(a,b)=>(a.parentKey||"")===(b.parentKey||"");
// The memories still valid on this board; the others are forgotten, each list on its own.
function keptOrders(board,memos){const auto=new Map([["sections",board.map(r=>r.id)]]),kept={};
  for(const run of board)for(const t of run.tasks||[]){const n=listName(run.id,t.parentKey);if(!auto.has(n))auto.set(n,[]);auto.get(n).push(t.key)}
  for(const[n,memo]of Object.entries(memos||{}))if(auto.has(n)&&heldOrder(auto.get(n),memo).valid)kept[n]=memo;
  return kept}
const sectionOrder=(board,memos)=>{const h=heldOrder(board.map(r=>r.id),memos?.sections),byId=new Map(board.map(r=>[r.id,r]));return h.valid?h.keys.map(id=>byId.get(id)):board};
// A section's rows in tree order, with the rows under each parent in their held order, so a row
// moves with every row under it. With no held order the server's rows stand as they are.
function treeRows(run,memos){const tasks=run.tasks||[],byKey=new Map(tasks.map(t=>[t.key,t])),kids=new Map(),out=[];let held=false;
  for(const t of tasks){const p=t.parentKey||"";if(!kids.has(p))kids.set(p,[]);kids.get(p).push(t.key)}
  const walk=p=>{const auto=kids.get(p);if(!auto)return;const h=heldOrder(auto,memos?.[listName(run.id,p)]);held||=h.valid;for(const k of h.keys){out.push(byKey.get(k));walk(k)}};
  walk("");return held&&out.length===tasks.length?out:tasks}
// Where a dragged row lands over the row `over`: before or after the row with the same parent that
// holds `over` (that row itself, or one under it, which puts it after that row's subtree). Null when
// there is none: a row never changes parent or section, and the main session row never moves.
function rowTarget(tasks,key,over,after){const byKey=new Map(tasks.map(t=>[t.key,t])),t=byKey.get(key);if(!t||t.main)return null;
  let at=byKey.get(over),deep=false;while(at&&!sameParent(at,t)){at=byKey.get(at.parentKey);deep=true}
  return!at||at.main||at.key===key?null:{target:at.key,after:deep||!!after}}
// `keys` with `key` moved to just before, or after, `target`.
const moveKey=(keys,key,target,after)=>{const rest=keys.filter(k=>k!==key),at=rest.indexOf(target);if(at<0||rest.length===keys.length)return keys;rest.splice(at+(after?1:0),0,key);return rest};
// What a drop leaves remembered for its list, given the list's automatic and shown orders: undefined
// when the drop changes nothing, null (forget) when it gives back the automatic order, else a memo.
function dropMemo(auto,shown,key,target,after){const next=moveKey(shown,key,target,after);
  return sameOrder(next,shown)?undefined:sameOrder(next,auto)?null:{auto:[...auto],order:next}}
// The memories, kept in this browser so a redraw and a reload keep them. Every draw reads them from
// memory; they load from storage once, at startup, and each change is written back when storage
// takes it, so a full or blocked storage leaves dragging working until the page reloads.
let orders=(()=>{try{return validOrders(JSON.parse(localStorage.getItem("orchOrder")||"{}"))}catch{return{}}})();
const saveOrders=()=>{try{Object.keys(orders).length?localStorage.setItem("orchOrder",JSON.stringify(orders)):localStorage.removeItem("orchOrder")}catch{}};
// On every new board: forget the lists whose automatic order changed, and give back the rest.
function boardOrders(){const kept=keptOrders(state,orders);if(Object.keys(kept).length!==Object.keys(orders).length){orders=kept;saveOrders()}return orders}
// Rows are rebuilt when data changes; starting every pulse at the page timeline's origin keeps
// rebuilt dots in step instead of restarting their beat.
// Rows that changed place glide from their old position to the new one (rising or dropping), and
// new rows fade in, instead of the order jumping.
const slide=(root,before)=>{if(!before.size||matchMedia("(prefers-reduced-motion: reduce)").matches)return;
  for(const b of root.querySelectorAll("tbody.session")){const old=before.get(b.dataset.key),dy=old==null?null:old-b.getBoundingClientRect().top;
    if(dy==null)b.animate([{opacity:0},{opacity:1}],{duration:350,easing:"ease-out"});
    else if(Math.abs(dy)>1)b.animate([{transform:"translateY("+dy+"px)"},{transform:"none"}],{duration:550,easing:"cubic-bezier(.2,.8,.2,1)"})}};
const syncPulses=root=>{for(const d of root.querySelectorAll(".dot.d-run"))for(const a of d.getAnimations())a.startTime=0};
const dotClass=t=>{const s=outcome(t);return s==="running"?"d-run":s==="needs-decision"?"d-ask":s==="completed"?"d-ok":s==="idle"||s==="prepared"||s==="closed"||s==="parked"?"":"d-bad"};
const sectionTitle=run=>run.goal||run.id.replace(/^\d{8}-\d{6}-/,"");
// A session's activity line, after a short marker while it is stuck on one failing command.
const nowText=t=>(t.stuck?"stuck: `"+(t.stuck.command.length>30?t.stuck.command.slice(0,29)+"…":t.stuck.command)+"` failed "+t.stuck.failures+"× · ":"")+(t.now||"");
// Choosing a row marks it and paints its details at once from the board already loaded; the table and
// the row's log refresh behind it.
function choose(el){if(!el)return;sel=el.dataset.key;
  for(const b of document.querySelectorAll("tbody.session.sel"))b.classList.remove("sel");el.classList.add("sel");
  compose();document.querySelector("main").classList.remove("no-detail");detail();lastState="";refresh()}
// Choose a session from the attention lane as its row would be chosen, opening the rows above it
// (an open stays until the running state under that row changes) and scrolling its row into view.
function reveal(key){const[runId,taskKey]=key.split("/"),run=state.find(r=>r.id===runId),byKey=new Map((run?.tasks||[]).map(t=>[t.key,t]));
  for(let p=byKey.get(taskKey)?.parentKey;p;p=byKey.get(p)?.parentKey){const k=runId+"/"+p;if(!isOpen(k))manual.set(k,{open:true,auto:!!live.get(k)})}
  sel=key;compose();lastState="";document.querySelector("main").classList.remove("no-detail");
  const at='[data-key="'+CSS.escape(key)+'"]';
  refresh().then(()=>{document.querySelector("tbody.session"+at)?.scrollIntoView({block:"nearest",inline:"nearest"});return detail()})}
// Close the details panel: the table takes the full width until a session is chosen again.
function closeDetail(){sel=null;lastDetail="";lastState="";document.querySelector("main").classList.add("no-detail");refresh()}
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&sel&&!e.target?.closest?.("#compose"))closeDetail()});
// Clicking anywhere on a row with sub-agents opens it; clicking it again while it is chosen closes it.
function toggleRow(row){const k=row?.dataset.key;if(!k||!row.querySelector(".caret[data-key]"))return;
  const open=sel===k?!isOpen(k):true;if(open!==isOpen(k))manual.set(k,{open,auto:!!live.get(k)})}
const pick=row=>{toggleRow(row);choose(row)};
document.getElementById("runs").addEventListener("click",e=>{if(e.target.closest(".grip"))return;const cr=e.target.closest(".caret[data-key]");
  if(cr){const k=cr.dataset.key;manual.set(k,{open:!isOpen(k),auto:!!live.get(k)});lastState="";refresh();return}
  const ob=e.target.closest(".older[data-run]");if(ob){const r=ob.dataset.run;if(!olderShown.delete(r))olderShown.add(r);redrawSection(r);return}
  if(!getSelection().isCollapsed)return;const a=e.target.closest(".attn[data-key]");if(a)reveal(a.dataset.key);else pick(e.target.closest("tbody.session"))});
document.getElementById("runs").addEventListener("pointerover",e=>{const row=e.target.closest("tbody.session");if(row&&row.dataset.key!==sel)preload(row.dataset.key)});
document.getElementById("runs").addEventListener("focusin",e=>{if(refocusing)return;const row=e.target.closest("tbody.session");if(row&&row.dataset.key!==sel)preload(row.dataset.key)});
document.getElementById("runs").addEventListener("keydown",e=>{if(e.key!=="Enter")return;const a=e.target.closest(".attn[data-key]");if(a)return reveal(a.dataset.key);
  pick(e.target.closest("tbody.session"))});
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
// Hold a panel still while the user presses in it, drags a section or row in it (`dragged`), or has
// text selected in it, so an update does not wipe the selection or the drag; it catches up after.
let pressed=null,behind=false;
let dragged=null;
const holding=el=>{if(pressed&&el.contains(pressed)||dragged&&el.contains(dragged.el))return true;const s=getSelection();return !!s&&!s.isCollapsed&&el.contains(s.anchorNode)};
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
  // Reads overlap (a click, a push and the timer all start one). One that started earlier but answers
  // after a newer one is dropped, so the board never steps back to a state before a message was stored.
  const mine=refresh.sent=(refresh.sent||0)+1;
  let text,heavy={running:0,waiting:0},stale=null;try{const r=await fetch("api/state"),v=r.headers.get("x-orch-server");if(server&&v&&v!==server){keepState();location.reload();return}server=v;heavy=JSON.parse(r.headers.get("x-orch-heavy")||"null")||heavy;text=await r.text();stale=staleNote(r,text)}catch{const st=document.getElementById("stamp");st.className="live off";st.textContent="disconnected";st.title="is orch.mjs dashboard still running?";return}
  if(mine<(refresh.applied||0))return;refresh.applied=mine;
  // The mark follows every answer, whether or not the board changed: a green dot while the board is
  // current, red "stale: <reason>" while it is a cached one (or the server has none to send yet).
  const st=document.getElementById("stamp"),now=new Date().toLocaleTimeString();
  if(stale){st.className="live off";st.textContent="stale: "+(stale.why.length>100?stale.why.slice(0,99)+"…":stale.why);
    st.title=(stale.failed?"no board from the server":"showing a cached board"+(stale.age==null?"":", "+dur(stale.age*1000)+" old"))+": "+stale.why+" · checked "+now}
  else{st.className="live";st.textContent="";st.title="updated "+now}
  if(stale?.failed)return; // an error body is not a board: the one on the page stays
  const heavyText=" · heavy: "+heavy.running+" running, "+heavy.waiting+" waiting";
  const grand=document.getElementById("grand");grand.textContent=grand.textContent.replace(/ · heavy:.*$/, "")+heavyText;
  if(text===lastState)return;if(holding(document.getElementById("runs"))){behind=true;return}lastState=text;state=JSON.parse(text);
  let tin=0,tout=0,running=0;
  const root=document.getElementById("runs");
  const before=new Map([...root.querySelectorAll("tbody.session")].map(b=>[b.dataset.key,b.getBoundingClientRect().top]));
  // The board keeps its focus across the redraw.
  const focus=focusedOn(root);
  root.replaceChildren();
  if(!state.length)root.append($("p",{class:"muted empty"},"No runs active recently."));
  // The attention lane: what needs someone now across every section, in the server's order (most
  // urgent kind first, then the longest waiting); shown only when something does. Items addressed
  // to the user come first and alone make the header's count; items an agent must act on (`to` is
  // "agent") follow, muted, each "for" that agent. An item whose agent is gone is the user's.
  const lane=state.flatMap(run=>(run.attention||[]).map(a=>({...a,run,k:run.id+"/"+a.key}))).sort((a,b)=>a.rank-b.rank||a.sinceMs-b.sinceMs);
  const forUser=lane.filter(a=>a.to!=="agent"),theirs=lane.filter(a=>a.to==="agent");
  const need=document.getElementById("need");need.hidden=!forUser.length;need.textContent=forUser.length+(forUser.length===1?" needs":" need")+" attention";
  const attn=a=>$("div",{class:"attn a-"+a.kind+(a.to==="agent"?" for-agent":"")+(sel===a.k?" sel":""),"data-key":a.k,tabindex:"0",role:"button",title:a.reason,...(a.to==="agent"?{style:"opacity:.6"}:{})},
    $("span",{class:"tag",...(a.kind==="question"?{style:"color:var(--ask)",title:"Asked while it keeps working: answer in the box under its details"}:{})},a.label),$("b",a.name?{title:"task "+a.id}:{},a.name||a.id),$("span",{class:"where",...(a.runId?{title:"run "+a.runId}:{})},a.runGoal||(a.runId?a.runId.replace(/^\d{8}-\d{6}-/,""):sectionTitle(a.run))),
    a.sinceMs?$("span",{class:"tick","data-since":String(a.sinceMs),title:"waiting since "+new Date(a.sinceMs).toLocaleTimeString()},dur(Date.now()-a.sinceMs)):null,
    $("span",{class:"why"},a.reason.replace(/^(waiting|no events for) [^·]+(· )?/,"")),
    a.to==="agent"?$("span",{class:"muted",style:"flex:none",title:"It reaches "+a.agent+" through its inbox or its wait; you get it only if that agent is gone"},"for "+a.agent)
      :a.gone&&a.agent?$("span",{style:"flex:none;color:var(--bad)",title:a.agent+" is gone: "+a.gone},a.agent+" is gone"):null);
  if(lane.length)root.append($("div",{class:"lane"},...(forUser.length?[$("h2",{},"Needs attention"),...forUser.map(attn)]:[]),
    ...(theirs.length?[$("h2",{class:"muted",title:"Agents are told about these; none needs you"},"For agents"),...theirs.map(attn)]:[])));
  tick();
  for(const run of sectionOrder(state,boardOrders())){tin+=run.totals.tokensIn;tout+=run.totals.tokensOut;running+=run.totals.running;root.append(sectionView(run))}
  refocus(root,focus);
  syncPulses(root);
  slide(root,before);
  document.getElementById("grand").textContent=running+" running · "+fmt(tin)+" in / "+fmt(tout)+" out"+heavyText;
  compose();
}
// What a read of the board says about itself. The server marks a cached board (it could not rebuild one)
// with x-orch-stale, its age in seconds, and x-orch-error, the first line of why. A refusal (503 while the
// first board builds, 500 with nothing cached) has an error for a body, not a board. Null for a fresh board.
function staleNote(r,body){const age=r.headers.get("x-orch-stale"),head=r.headers.get("x-orch-error"),refused=r.ok===false;if(!refused&&age==null&&head==null)return null;
  let why=String(head||"");
  if(!why.trim()&&refused){try{why=String(JSON.parse(body)?.error||"")}catch{why=String(body||"")}}
  why=why.split("\n")[0].trim()||(refused?"HTTP "+r.status:"cached board");
  const n=age==null||age===""?NaN:Number(age);return{why,age:Number.isFinite(n)?n:null,failed:refused}}
// One section of the board: its header and its session tree. A task that `rename` named shows its name,
// with its id in the tooltip; the id stays the row's key. Only orch.mjs tasks have names.
function sectionView(run){
  const by=run.orchestrator?.agent?("launched by "+run.orchestrator.agent+(run.orchestrator.sessionId?" session "+run.orchestrator.sessionId.slice(0,8):"")):"";
  // One <tbody> per session, so its row and its activity line hover and select as one item.
  const byKey=new Map(run.tasks.map(t=>[t.key,t])),open=autoOpen(run.tasks);
  for(const t of run.tasks)live.set(run.id+"/"+t.key,open.has(t.key));
  // Older rows stay folded away unless the section shows them; the chosen session and the rows
  // above it always show. Arrows and "+N hidden" count only the rows listed.
  const chosen=new Set();if(sel?.startsWith(run.id+"/"))for(let k=sel.slice(run.id.length+1);k;k=byKey.get(k)?.parentKey)chosen.add(k);
  const older=new Set(run.tasks.filter(t=>t.older&&!chosen.has(t.key))),showOlder=olderShown.has(run.id);
  // Rows in their held order (treeRows), each with a grip while another row under its parent is listed.
  const listed=treeRows(run,orders).filter(t=>showOlder||!older.has(t)),kids=new Map(),below=new Map(),busy=new Map(),tops=listed.filter(t=>!t.parentKey).length;
  for(const t of listed){if(t.parentKey)kids.set(t.parentKey,(kids.get(t.parentKey)||0)+1);for(let p=t.parentKey;p;p=byKey.get(p)?.parentKey){below.set(p,(below.get(p)||0)+1);if(t.state==="running")busy.set(p,(busy.get(p)||0)+1)}}
  const hiddenBy=t=>{for(let p=t.parentKey;p;p=byKey.get(p)?.parentKey)if(!isOpen(run.id+"/"+p))return true;return false};
  const rows=listed.filter(t=>!hiddenBy(t)).map(t=>{
    const key=run.id+"/"+t.key,c="session"+(sel===key?" sel":"")+(t.closed?" closed":""),nk=kids.get(t.key)||0,nd=below.get(t.key)||0,shut=nk>0&&!isOpen(key);
    const indent=w=>({class:"name",style:"padding-left:"+(GUTTER+6+t.depth*IND+w)+"px;--pad:"+(GUTTER+4+t.depth*IND)+"px;--gw:"+(t.depth*IND)+"px"});
    const movable=!t.main&&(t.parentKey?kids.get(t.parentKey):tops)>1;
    return $("tbody",{class:c,"data-key":key,tabindex:"0"},$("tr",{},
      $("td",{...indent(0),title:t.native&&t.parent!=="orchestrator"?"started by "+t.parent:""},
        movable?$("span",{class:"grip",draggable:"true",title:"Drag to move this row among the rows beside it","aria-hidden":"true"}):null,
        nk?$("span",{class:"caret","data-key":key,title:shut?"expand":"collapse"},shut?"▶":"▼"):$("span",{class:"caret blank"}),
        $("span",{class:"dot "+dotClass(t),title:outcome(t)}),t.main?$("b",{},"main session"):t.name?$("span",{title:"task "+t.id},t.name):t.id,
        t.scopeViolations?.length?$("span",{class:"warn",title:"changed outside its planned files:\n"+t.scopeViolations.join("\n")},"⚠"):null,
        t.inbox?.unread>0?$("span",{class:"mail",title:"messages the agent has not read yet:\n"+(t.inbox.unreadMessages||[]).map(m=>new Date(m.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})+"  "+senderOf(m)+": "+m.text).join("\n")},"✉ "+t.inbox.unread+" waiting"):null,
        shut&&nd?$("span",{class:"more"},"+"+nd+" hidden"+(busy.get(t.key)?" · "+busy.get(t.key)+" running":"")):null),$("td",{title:(t.command?"$ "+t.command+"\n":"")+(t.why||"")},t.kind||t.agent),$("td",{},t.modelLabel),$("td",{},t.mode),
      $("td",{class:"state "+cls(outcome(t))},exitedLabel(t)+(outcome(t)==="running"?t.interrupting?" · resuming":t.idle?" · idle":"":"")+(t.attempt>1?" · "+t.attempt+" attempts":"")+(startedIn(t,byKey.get(t.parentKey))?" · attempt "+startedIn(t,byKey.get(t.parentKey)):"")),$("td",{class:"num"},t.elapsed),$("td",{class:"num"},t.steps),
      $("td",{class:"num"},(t.tokensExact?"":"~")+fmt(t.tokensIn)),$("td",{class:"num"},(t.tokensExact?"":"~")+fmt(t.tokensOut)),
      $("td",{},t.session?t.session.slice(0,8):"-")),
      $("tr",{class:"nowrow"},$("td",{...indent(32),colspan:"10"},nowText(t))))});
  // The run's goal as its title, with a short status after it; run id, launcher, and branch are in the tooltip.
  const clock=ms=>{const d=new Date(ms),t=d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});return d.toDateString()===new Date().toDateString()?t:d.toLocaleDateString([],{month:"short",day:"numeric"})+" "+t};
  const tt=run.totals,ap=tt.exact?"":"~",started=clock(Date.parse(run.createdAt)),awaiting=(run.attention||[]).filter(a=>a.kind==="awaiting-review").length;
  const summary=[tt.running?tt.running+" running":null,tt.finished?tt.finished+" finished":null,awaiting?awaiting+" awaiting review":null,ap+fmt(tt.tokensIn)+" in / "+ap+fmt(tt.tokensOut)+" out","started "+started,!run.running&&run.activeMs?"last active "+clock(run.activeMs):null].filter(Boolean).join(" · ");
  const tip=[[run.id,by,[(run.repo||"").split("/").pop(),run.baseBranch].filter(Boolean).join(" @ ")].filter(Boolean).join(" · "),...((run.runs||[]).length>1?["runs:",...run.runs.map(r=>"  "+(r.goal||r.id))]:[]),"token counts leave out the main session"].join("\n");
  const toggle=older.size?$("button",{class:"older","data-run":run.id,title:showOlder?"fold away the finished rows that have been quiet a while":"list the finished rows that have been quiet a while"},showOlder?"hide older":"show "+older.size+" older"):null;
  return $("div",{class:"run","data-run":run.id},$("h2",{title:tip},state.length>1?$("span",{class:"grip",draggable:"true",title:"Drag to move this section","aria-hidden":"true"}):null,sectionTitle(run),$("span",{class:"sub"}," · "+summary),toggle),
    $("table",{},$("thead",{},$("tr",{},$("th",{},"task"),$("th",{},"agent"),$("th",{},"model"),$("th",{},"mode"),$("th",{},"state"),$("th",{class:"num"},"elapsed"),
      $("th",{class:"num"},"steps"),$("th",{class:"num"},"tokens in"),$("th",{class:"num"},"out"),$("th",{},"session"))),...(rows.length?rows:[$("tbody",{},$("tr",{},$("td",{colspan:"10",class:"muted"},older.size?"every row is older; show them from the header":"no tasks yet")))])),
  )}
// A redraw replaces every element of the board. The one that had focus (a tree row by its task key,
// an attention item, or a section's "older" toggle) is found again and focused without scrolling, so
// Tab and Enter keep working. Focus outside the board, such as in the message box, is never taken.
// The details panel passes its own `keys` (PANEL_FOCUS).
const FOCUS_KEYS=[["tbody.session",["key"]],[".attn",["key"]],[".older",["run"]]];
function focusedOn(root,keys=FOCUS_KEYS){const a=document.activeElement;if(!a||a===root||!root.contains(a))return null;
  const hit=keys.find(([s])=>a.matches(s));
  return hit?hit[0]+hit[1].map(k=>"[data-"+k+'="'+CSS.escape(a.dataset[k]??"")+'"]').join(""):null}
let refocusing=false; // the focusin handler leaves a refocused row's log alone
function refocus(root,selector){const el=selector&&root.querySelector(selector);if(!el||document.activeElement===el)return;
  refocusing=true;try{el.focus({preventScroll:true})}finally{refocusing=false}}
// A section's own toggle redraws just that section from the board already loaded, even while text
// is selected elsewhere on the board, which holds every other redraw back.
function redrawSection(id){const root=document.getElementById("runs"),run=state.find(r=>r.id===id),old=root.querySelector('.run[data-run="'+CSS.escape(id)+'"]');
  if(!run||!old){lastState="";refresh();return}
  const focus=focusedOn(root),fresh=sectionView(run);old.replaceWith(fresh);refocus(root,focus);syncPulses(fresh)}
// The agent's structured report (its orch-result block) and the files it changed outside its plan.
// Each check shows the evidence `orch.mjs result` saved for it: the last matching run in the
// agent's log, as in "pass · ran, exit 0". A check reported as passing without a successful run is
// marked as a warning, as `result` warns. The dashboard only reads saved evidence.
const evidenceWords=e=>e.notCommand?'not a command':!e.ran?"NOT FOUND in the log":e.exitCode===0?"ran, exit 0":"exit "+(e.exitCode??"unknown");
const checkWarning=c=>{const e=c?.evidence;if(c?.result!=="pass"||!e||e.exitCode===0)return null;
  return e.notCommand?"reported pass, but is not a command":!e.ran?"reported pass, but no matching run is in the log":e.exitCode==null?"reported pass, but the log has no exit code for its last run":"reported pass, but its last run exited "+e.exitCode};
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
const logSource=(t,n)=>t.agentLog&&n===(t.attempt||0)?"api/transcript?file="+encodeURIComponent(t.agentLog):t.native||t.main?(t.outDir?"api/transcript?file="+encodeURIComponent(t.outDir):null):"api/events?run="+encodeURIComponent(t.run)+"&task="+encodeURIComponent(t.id)+(n?"&attempt="+n:"");
// A log's fingerprint for the panel's change check: its length and a hash of every entry, since a
// log capped at 400 entries keeps its length as new entries push old ones out. Worked out once per log.
const prints=new WeakMap();
function logPrint(ev){if(!ev)return"loading";let p=prints.get(ev);if(p!=null)return p;let h=2166136261;
  for(const e of ev){const s=e.kind+"\u0000"+e.text+"\u0001";for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0}}
  p=ev.length+":"+h.toString(36);prints.set(ev,p);return p}
function loadLog(key,t){const n=logAttempt(key,t),lk=n?key+"@"+n:key,src=logSource(t,n);if(!src)return Promise.resolve([]);if(loading.has(lk))return loading.get(lk);
  if(t.external||src.startsWith("api/transcript")&&t.agentLog)return loadTranscript(lk,t,src);
  const load=fetch(src).then(r=>r.json()).then(v=>v.events||[]).catch(()=>logs.get(lk)?.ev||[]).then(ev=>{loading.delete(lk);logs.delete(lk);
    logs.set(lk,{ev,at:Date.now()});if(logs.size>30)logs.delete(logs.keys().next().value);return ev});
  loading.set(lk,load);return load}
// An outside agent's events come from its own transcript (api/transcript, the same 400 events as a native
// agent's log), whether a skill's script or a task's own shell started it. Kept from successful reads
// only: a read that fails keeps what an earlier one gave, is marked in `logFailed`, and is tried again
// at the next refresh. A finished agent's transcript no longer changes, so a good read is fetched again
// only when the board says it was active since.
const logFailed=new Set();
function loadTranscript(lk,t,src){
  const hit=logs.get(lk);if(hit&&t.state!=="running"&&hit.active===t.lastActiveMs)return Promise.resolve(hit.ev);
  const load=fetch(src).then(r=>{if(r.ok===false)throw new Error("HTTP "+r.status);return r.json()}).then(v=>{if(!Array.isArray(v?.events))throw new Error("no events");return v.events})
    .then(ev=>{logFailed.delete(lk);logs.delete(lk);logs.set(lk,{ev,at:Date.now(),active:t.lastActiveMs});if(logs.size>30)logs.delete(logs.keys().next().value);return ev},
      ()=>{logFailed.add(lk);return logs.get(lk)?.ev||[]})
    .finally(()=>loading.delete(lk));
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
// an attempt line by its number, an agent the task started by its row, the Brief, "show attempt N", and
// the close button.
const PANEL_FOCUS=[[".att",["n"]],[".agentlink",["key"]],[".bsum",[]],[".linkish",[]],[".close",[]]];
// The final message as the panel shows it: without the orch-result block that the structured report
// above already shows. An invalid block stays, so the reader can see what is wrong with it.
const REPORT_BLOCK=/^[\t ]*```orch-result[\t ]*\r?\n[\s\S]*?^[\t ]*```[\t ]*(?=\r?$)/gm;
function shownMessage(t){const m=String(t.finalMessage||"");if(!t.report||t.report.invalid)return m;
  const blocks=[...m.matchAll(REPORT_BLOCK)],last=blocks.at(-1);return last?(m.slice(0,last.index)+m.slice(last.index+last[0].length)).trimEnd():m}
// An agent's message in the event log, with its orch-result block shortened: the structured report
// above shows it.
const saysText=x=>{const m=String(x??"");return m.replace(REPORT_BLOCK,"[orch-result block: see the report above]")};
// A tool event with no output text gets no OUTPUT row.
const eventRows=ev=>(ev||[]).filter(e=>e.kind!=="output"||String(e.text??"").trim());
const eventView=e=>$("div",{class:"ev "+e.kind},$("span",{class:"k"},e.kind),e.kind==="reply"?rich(e.text):$("pre",{},e.kind==="says"?saysText(e.text):e.text));
// The agents that a task's own shell started, as one line in its details: each links to its row, which
// the board lists under the task. After a resume, an agent says which attempt it started in.
const agentList=(key,t)=>(state.find(r=>r.id===key.split("/")[0])?.tasks||[]).filter(x=>x.taskAgent&&x.parentKey===t.key);
function agentsView(key,t){const list=agentList(key,t);if(!list.length)return[];
  return[$("p",{class:"ctx"},$("span",{class:"k"},"Agents it started"),
    ...list.flatMap((x,i)=>[i?", ":"",$("button",{type:"button",class:"agentlink","data-key":key.split("/")[0]+"/"+x.key,title:"Show its row and its events",onclick:()=>reveal(key.split("/")[0]+"/"+x.key)},
      x.kind+" · "+(x.model||"model unknown")+" · "+x.state+(startedIn(x,t)?" · attempt "+startedIn(x,t):""))]))]}
// `ev` is null while the row's first log is still loading; it must be the log of the attempt the
// panel shows (logKey). `keep` holds the scroll position as it is, after a click inside the panel.
function paint(key,t,ext,ev,keep){
  // A task that orch.mjs started has receipts; its working directory and branch go in its Context line.
  const own=!ext&&!t.external&&(t.attempts||[]).length>0,n=own?shownAttempt(key,t):0,past=own&&n!==t.attempt;
  const lk=logKey(key,t),src=logSource(t,n),failed=t.external&&logFailed.has(lk),good=logs.get(lk)?.ev;
  const up=t.taskAgent?state.find(r=>r.id===key.split("/")[0])?.tasks.find(x=>x.key===t.parentKey):null; // the task that started this agent
  const sig=key+"@"+n+JSON.stringify(t)+logPrint(ev)+(failed?"!":"")+"|"+agentList(key,t).map(x=>x.key+x.state+x.model+x.taskAttempt).join()+(up?up.attempt:"")+(own?briefSig(key,t,n):"")+"|"+pendingSig(key);if(sig===lastDetail)return;
  const d=document.getElementById("detail");if(holding(d)){behind=true;return}lastDetail=sig;
  const to=keep&&d.dataset.sel===key?d.scrollTop:logScroll(d.dataset.sel===key,d);
  const rows=eventRows(ev),message=t.finalMessage?shownMessage(t):"";
  const a=document.activeElement,focus=a&&d.dataset.sel===key&&d.contains(a)?focusedOn(d,PANEL_FOCUS):null;
  d.replaceChildren($("div",{class:"dhead"},$("h2",{},(t.name||t.id)+" · "+t.agent+" · ",$("span",{class:"state "+cls(t.phase==="parked"?"parked":t.state)},t.phase==="parked"?"parked":t.state)),
      $("button",{class:"close",title:"Close the details (Esc)","aria-label":"Close the details",onclick:closeDetail},"×")),
    $("dl",{},...[["id",t.name?t.id:null],["earlier names",[...new Set((t.names||[]).map(n=>n&&n.name).filter(n=>n&&n!==t.name))].join(", ")],["state",(t.phase==="parked"?"parked":t.state)+(t.exitCode!=null?" (exit "+t.exitCode+")":"")],["phase",t.phase!==t.state&&t.phase!=="parked"?t.phase:null],["parked",t.parked?t.parked.waitsFor+" · watcher "+t.parked.watcher+(t.parked.lastCheckAt?" · checked "+timeText(t.parked.lastCheckAt):""):null],["health",t.health!=="ok"?t.health:null],["session",t.session],["model",t.model?t.model+(t.tier?" ("+t.tier+" tier)":""):t.command?"none":null],["command",t.command?"$ "+t.command:null],["runs",t.runs?t.runs.map(a=>a.kind+" · "+(a.modelLabel||"model not known yet")+" · "+a.state+(a.session?" · "+a.session.slice(0,8):"")).join("\n"):null],["why this agent",t.why],["attempt",t.attempt],["started in",startedIn(t,up)?"attempt "+startedIn(t,up)+" of its task":null],["mode",t.mode],
      ["working dir",own?null:t.cd],["branch",own?null:t.branch],["tokens",fmt(t.tokensIn)+" in ("+fmt(t.tokensCached)+" cached) / "+fmt(t.tokensOut)+" out"],
      ["touched files",t.touchedFiles?t.touchedFiles.join("  "):null],[ext?"transcript":"artifacts",t.outDir]].filter(([,v])=>v!=null&&v!=="").flatMap(([k,v])=>[$("dt",{},k),$("dd",{},v)])),
    ...agentsView(key,t),
    ...(own?[...contextView(t,n),...briefView(key,t,n),...attemptsView(key,t,n)]:[]),
    ...reportView(t),
    ...reviewView(t),
    ...(message?[$("h3",{},ext?"Latest message":"Final report"),$("div",{class:"final"},$("pre",{},message))]:[]),
    ...(t.main?[$("p",{class:"muted"},"The session that launched this run. Its counts cover the whole session and are not in the run's totals.")]:[]),
    ...messagesView(key,t),
    $("h3",{},t.external&&!src?"Events: its transcript was not found":failed&&!good?"Events: could not be read, trying again"
        :(past?"Events of attempt "+n:"Events")+(ev?" ("+rows.length+", newest last)"+(ext?", from its transcript":"")+(failed?"; the latest read failed, trying again":""):" (loading…)"),
      past?$("button",{type:"button",class:"linkish",onclick:()=>showAttempt(key,t.attempt)},"show attempt "+t.attempt):null),
    ...rows.map(eventView));
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
// A message sent from this page is in its task's thread at once, before the server has answered. It is
// "sending" until the reply gives its id, "queued" after that, and leaves this list once the board
// lists a message with that id: the board's copy shows from then on, "queued" until the agent has read
// it and "read" after. A send that fails stays, "not sent" with its error, until it is sent again or
// dismissed. Kept by task key, oldest first: {lid, text, images, at, known (the ids the board listed
// when it was sent), status, id, claim, error, stamp (the server's time), since (when it was queued
// here), unsure (the failure may still have stored it)}.
const pending=new Map(),INBOX_WINDOW=20;let pendingSeq=0;
const serverMessages=t=>t?.inbox?.messages||[];
// Every unread message (the board does not cap it, unlike `messages`), and who sent a message: the board's
// name for it, or one made from `from` when the board gives none.
const unreadList=t=>t?.inbox?.unreadMessages||[];
const senderOf=m=>m.sender||(m.from==="user"?"you":"orchestrator");
const hhmm=when=>new Date(when).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const imageCount=n=>n>1?n+" images":"1 image";
// Does the board's list show this entry? By its id once the reply gave one. Before that, by the message
// it matched while the send was in flight (a read can land between the server storing a message and its
// reply). A full list whose oldest message is newer than the entry has pushed it out of view: it is stored.
const landed=(e,list,unread=[])=>e.id?list.some(m=>m.id===e.id)||unread.some(m=>m.id===e.id)||(list.length>=INBOX_WINDOW&&Date.parse(list[0].time)>Date.parse(e.stamp)):!!e.claim&&(list.some(m=>m.id===e.claim)||unread.some(m=>m.id===e.claim));
const shownLocal=(key,t)=>{const list=serverMessages(t),unread=unreadList(t);return(pending.get(key)||[]).filter(e=>!landed(e,list,unread))};
const pendingSig=key=>(pending.get(key)||[]).map(e=>[e.lid,e.status,e.id,e.claim,e.error].join(":")).join();
// After each read of the board: let a send still in flight claim the message the board already lists for
// it (the same text and images, from the user, not listed when it was sent and not another entry's),
// drop each queued entry the board now lists, and forget the tasks that are gone.
function settle(){for(const[key,list]of pending){const t=taskAt(key);if(!t){pending.delete(key);continue}
  const sent=serverMessages(t),unread=unreadList(t),msgs=[...sent,...unread.filter(u=>!sent.some(m=>m.id===u.id))],taken=new Set(list.map(e=>e.id||e.claim).filter(Boolean));
  for(const e of list){if(e.id||!(e.status!=="failed"||e.unsure)||(e.claim&&msgs.some(m=>m.id===e.claim)))continue;
    const m=msgs.find(m=>m.from==="user"&&!taken.has(m.id)&&!e.known.has(m.id)&&(m.images||0)===e.images&&m.text===e.text.slice(0,2000));
    e.claim=m?m.id:null;if(m)taken.add(m.id)}
  const rest=list.filter(e=>!(e.id&&landed(e,sent,unread)));
  if(rest.length)pending.set(key,rest);else pending.delete(key)}}
function addPending(key,t,text,images){
  const list=(pending.get(key)||[]).filter(e=>!(e.status==="failed"&&e.text===text&&e.images===images)),
    e={lid:++pendingSeq,text,images,at:Date.now(),known:new Set(serverMessages(t).map(m=>m.id)),status:"sending",id:null,claim:null,error:null,stamp:null,since:null,unsure:false};
  list.push(e);pending.set(key,list.slice(-50));return e}
// The reply's id and time. From here the id decides: a message the board matched meanwhile under
// another id was a lookalike, not this one.
function queuedAs(e,v){e.status="queued";e.id=v.id??null;e.stamp=v.time||null;e.since=Date.now();const at=Date.parse(v.time);if(!isNaN(at))e.at=at}
// A refusal means the server stored nothing; a lost connection may have lost only the reply.
function failedAs(e,error,unsure){e.status="failed";e.error=error;e.unsure=!!unsure;if(!unsure)e.claim=null}
function dismiss(key,lid){const list=(pending.get(key)||[]).filter(e=>e.lid!==lid);if(list.length)pending.set(key,list);else pending.delete(key);touched(key)}
// Redraw what shows a task's own messages (its queue under the details, and its thread in the panel).
function touched(key){if(sel!==key)return;compose();repaint(key)}
// The task's thread: the board's messages, then those sent from this page that it does not list yet.
function messagesView(key,t){const sent=serverMessages(t),mine=shownLocal(key,t);if(!sent.length&&!mine.length)return[];
  const word={sending:"sending…",queued:"queued",failed:"failed"},pic=n=>n?"\n("+imageCount(n)+" attached)":"";
  return[$("h3",{},"Messages ("+(sent.length+mine.length)+")"),...sent.map(m=>$("div",{class:"msg"+(m.from==="user"?" you":"")},
      $("span",{class:"k"},(m.from==="user"?"you":"orchestrator")+" · "+hhmm(m.time)+" · "+(m.read?"read":"queued")),$("pre",{},m.text+pic(m.images)),
      ...(m.replies||[]).map(r=>$("div",{class:"r"},$("span",{class:"k"},"reply · "+hhmm(r.time)),rich(r.text))))),
    ...mine.map(e=>$("div",{class:"msg you "+e.status,"data-lid":String(e.lid)},$("span",{class:"k"},"you · "+hhmm(e.at)+" · "+word[e.status]),$("pre",{},e.text+pic(e.images)),
      e.status==="failed"?$("div",{style:"grid-column:2"},$("span",{class:"state s-bad"},"Not sent: "+e.error+" "),
        $("button",{type:"button",class:"linkish",onclick:()=>dismiss(key,e.lid)},"dismiss")):null))]}
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
    $("span",{class:"rh"},(t.name||t.id)+" replied · "+new Date(r.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})),rich(r.text));box.hidden=false}
// The messages that wait for the agent, above the message box: every unread message on the board, oldest
// first, then those sent from this page that the board does not list yet ("sending" until the server
// answers). A line under the heading says when the agent will read them (the board's `delivery`). Once a
// queued one has waited unread for 30 seconds and the board gives no such line, one says how to interrupt; `hintDue` is when the one
// waiting longest reaches that, and the one-second ticker redraws the box then.
const HINT="the agent is mid-step; use steer to interrupt",HINT_MS=30000;let hintDue=null;
// Whether the waiting list is collapsed to its heading. One choice for every agent, kept in this
// browser, so a long queue does not push the log out of view each time a row is chosen.
const queueShut=()=>{try{return localStorage.getItem("orchQueueShut")==="1"}catch{return false}};
const setQueueShut=v=>{try{v?localStorage.setItem("orchQueueShut","1"):localStorage.removeItem("orchQueueShut")}catch{}};
function queueRows(t,key){const rows=unreadList(t).map(m=>({sender:senderOf(m),time:m.time,text:m.text,images:m.images,status:"queued",since:Date.parse(m.time)}));
  for(const e of t&&key?shownLocal(key,t):[])if(e.status!=="failed")rows.push({sender:"you",time:e.at,text:e.text,images:e.images,status:e.status,since:e.status==="queued"?e.since:NaN});
  return rows}
function showQueue(t,key){const box=document.getElementById("compose-queue"),rows=queueRows(t,key),queued=rows.filter(r=>r.status==="queued"),
    oldest=Math.min(...queued.map(r=>r.since).filter(Number.isFinite)),due=Number.isFinite(oldest)?oldest+HINT_MS:null,late=due!=null&&Date.now()>=due,when=t?.inbox?.delivery?.text;
  hintDue=due!=null&&!late?due:null;
  const shut=queueShut();
  box.replaceChildren(...(rows.length?[$("div",{class:"qh"},
      $("button",{type:"button",class:"qt "+(shut?"shut":"open"),"aria-expanded":String(!shut),"aria-label":shut?"Show the waiting messages":"Hide the waiting messages",title:shut?"Show the waiting messages":"Hide the waiting messages; the count stays",onclick:()=>{setQueueShut(!shut);showQueue(t,key)}}),
      "Waiting for the agent ("+rows.length+")",
      queued.length?$("button",{type:"button",class:"now",title:"Stop the agent's current shell command so it reads these now (never a commit, push or other publishing command). Not in a shell command: its session is stopped and resumed with them.",onclick:()=>sendNow(t)},"Send now"):null),
    ...(when&&!shut?[$("p",{class:"muted qd"},when)]:[]),
    ...(late&&!when&&!shut?[$("p",{class:"muted qhint"},HINT)]:[]),
    ...(shut?[]:[$("div",{class:"ql"},...rows.map(m=>{const at=new Date(m.time).getTime();
      return $("div",{class:"q",title:m.text},$("span",{class:"t"},m.sender+" · "+hhmm(m.time)+(m.status==="sending"?" · sending…":" · "),
          ...(m.status==="sending"?[]:[$("span",{class:"waited","data-since":String(at)},"waited "+dur(Date.now()-at))])),
        $("span",{class:"x"},m.text.trim()+(m.images?" ("+imageCount(m.images)+")":"")))}))])]:[]));
  box.hidden=!rows.length}
const taskAt=key=>{if(!key)return null;const[runId,taskKey]=key.split("/");return state.find(r=>r.id===runId)?.tasks.find(x=>x.key===taskKey)||null};
function compose(){settle(); // every read of the board ends here, so what it lists settles the sends still in flight
  const box=document.getElementById("compose"),area=document.getElementById("compose-text"),note=document.getElementById("compose-note"),
  status=document.getElementById("compose-status"),t=taskAt(sel);
  if(composeKey!==sel){if(composeKey!=null){if(area.value||files.length)drafts.set(composeKey,{text:area.value,files});else drafts.delete(composeKey)}
    const draft=drafts.get(sel);area.value=draft?.text||"";files=draft?.files||[];showFiles();status.textContent="";status.className="";status.title="";composeKey=sel}
  if(!t){box.hidden=true;document.documentElement.style.setProperty("--compose-h","0px");return}
  const why=t.main?"This is the session that launched the run: type in its own terminal."
    :t.external?"A command started this agent outside the orchestrator, so it takes no messages. Message the session or task that ran the command."
    :t.native?"This agent was started by its session's own sub-agent tool, which takes no messages from outside. Message the session or task that started it."
    :!["running","parked"].includes(outcome(t))?"This task is not running ("+outcome(t)+"). A message reaches only a running agent: ask its orchestrator to resume it.":"";
  document.getElementById("compose-title").textContent=why?"Messages":"Message "+(t.name||t.id);
  note.textContent=why||(sendKey()?"":NO_KEY);note.hidden=!note.textContent;
  area.hidden=document.querySelector("#compose .crow").hidden=!!why;document.getElementById("compose-send").disabled=sending||!sendKey();box.hidden=false;
  showReply(t);showQueue(why?null:t,sel);if(why)document.getElementById("compose-files").hidden=true;else showFiles();
  document.documentElement.style.setProperty("--compose-h",box.offsetHeight+"px")}
// What the server did to make the agent read now (the `steer` of a send or Send now answer), as a status class and
// a phrase: it stopped a shell command, or stopped the session and is resuming it with the messages (also what a
// message to a task that waits on its own background command gets, with no Interrupt option), or did neither and
// `lead` starts the reason. `many` is true when more than one message waits. Null when the answer has no steer.
function steerSays(s,many,lead){
  if(s?.stopped)return{cls:"ok",text:"Stopped `"+s.stopped+"`"+(s.seconds?" after "+dur(s.seconds*1000):"")+" so it reads "+(many?"them":"it")+" now."};
  if(s?.resuming&&s.busy)return{cls:"ok",text:s.note||"Another interrupt is already resuming its session."};
  if(s?.resuming)return{cls:"ok",text:"Interrupted: the agent "+(s.doing||"was not in a shell command")+", so its session is resuming with "+(many?"the messages":"the message")+"."};
  if(s?.waiting)return{cls:"warn",text:lead+s.waiting+"."};
  return null}
// Pushes a task's queued messages through: stops its current shell command, or stops and resumes its session.
async function sendNow(t){const status=document.getElementById("compose-status");status.className="";status.textContent="Interrupting…";
  try{const r=await fetch("api/steer",{method:"POST",headers:{"content-type":"application/json","x-orch-token":sendKey()||""},body:JSON.stringify({run:t.run,task:t.id})});
    const v=await r.json().catch(()=>({}));
    if(r.ok){const say=steerSays(v.steer,v.queued>1,"Not interrupted: ")||{cls:"warn",text:"Not interrupted."};status.className=say.cls;status.textContent=say.text}
    else{status.className="bad";status.textContent=(v.key==="rejected"?NO_KEY:v.error||"HTTP "+r.status)}}
  catch{status.className="bad";status.textContent="The dashboard is not reachable"}
  finally{lastState="";refresh().then(detail)}}
// Sends the box's text to the task the box belongs to, which is the one its draft was typed for.
async function sendMessage(e){e.preventDefault();const key=composeKey,t=taskAt(key),area=document.getElementById("compose-text"),button=document.getElementById("compose-send"),status=document.getElementById("compose-status");
  const typed=area.value,text=typed.trim(),attached=files;if(!t||(!text&&!attached.length)||sending||!sendKey())return;
  sending=true;button.disabled=true;status.className="";status.textContent="Sending…";
  // The message is in the task's thread before anything is awaited. The box keeps its text until the
  // server has it, so a failed send loses nothing; the reply (or the failure) updates the thread's copy.
  const entry=addPending(key,t,text,attached.length);touched(key);
  try{const images=await Promise.all(attached.map(async file=>({data:await asBase64(file)})));
    const steer=document.getElementById("compose-steer").checked;
    const r=await fetch("api/send",{method:"POST",headers:{"content-type":"application/json","x-orch-token":sendKey()||""},body:JSON.stringify({run:t.run,task:t.id,text,images,steer})});
    const v=await r.json().catch(()=>({}));
    if(r.ok){queuedAs(entry,v);settle();if(composeKey===key&&area.value===typed)area.value="";if(composeKey===key&&files===attached){files=[];showFiles()}
      const draft=drafts.get(key);if(draft&&draft.text===typed&&draft.files===attached)drafts.delete(key);
      const at="Sent at "+new Date(v.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})+". ";
      const say=steerSays(v.steer,false,"It reads it after its current step: ");
      status.className=say?say.cls:v.reaches===false?"warn":"ok";
      status.textContent=at+(say?say.text:v.delivery?v.delivery[0].toUpperCase()+v.delivery.slice(1)+".":"");
      status.title=at+(v.delivery||"")}
    else{if(v.key==="rejected")try{localStorage.removeItem("orchSendKey")}catch{}
      const why=v.key==="rejected"?NO_KEY:v.error||"HTTP "+r.status;failedAs(entry,why);
      status.className="bad";status.textContent="Not sent: "+why}}
  catch{if(entry.status==="sending"){failedAs(entry,"the dashboard is not reachable",true);status.className="bad";status.textContent="Not sent: the dashboard is not reachable"}}
  finally{sending=false;button.disabled=!sendKey();if(composeKey!==key){status.textContent="";status.className=""}lastState="";touched(key);refresh().then(detail)}}
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
// Dragging a section by the grip in its header, or a row by the grip at its start, among the items of
// its list (the order rule is described above `heldOrder`). Only a grip is draggable, so clicks, arrows, text
// selection and the message box's image drop work as before. The board holds still while a drag
// runs (`holding`), a line marks where the item would land, and the board catches up after the drop.
let dropMark=null; // `dragged` is with the press hold, near the top
const DRAG_TYPE="application/x-orch-order"; // not text, so no text field takes the drop
function markDrop(el,after){if(dropMark&&(dropMark.el!==el||dropMark.after!==after))dropMark.el.classList.remove("drop-before","drop-after");
  dropMark=el?{el,after}:null;if(el)el.classList.add(after?"drop-after":"drop-before")}
// The last row drawn for `key`'s subtree in its section, where a line after it is drawn.
function blockEnd(sec,run,key){const rows=[...sec.querySelectorAll("tbody.session")],byKey=new Map(run.tasks.map(t=>[t.key,t]));
  const under=k=>{for(let p=byKey.get(k)?.parentKey;p;p=byKey.get(p)?.parentKey)if(p===key)return true;return false};
  let i=rows.findIndex(b=>b.dataset.key===run.id+"/"+key);if(i<0)return null;while(rows[i+1]&&under(rows[i+1].dataset.key.split("/")[1]))i++;return rows[i]}
const lowerHalf=(e,el)=>{const r=el.getBoundingClientRect();return e.clientY>r.top+r.height/2};
// Where the dragged item would land under the pointer: {mark, after, target}, or null where it cannot.
function dropAt(e){const d=dragged,el=e.target?.closest?.(d?.kind==="section"?".run[data-run]":"tbody.session[data-key]");if(!d||!el)return null;
  if(d.kind==="section"){if(el.dataset.run===d.run)return null;const after=lowerHalf(e,el);return{mark:el,after,target:el.dataset.run}}
  const[runId,over]=el.dataset.key.split("/"),run=state.find(r=>r.id===runId);if(runId!==d.run||!run)return null;
  const at=rowTarget(run.tasks,d.key,over,lowerHalf(e,el));if(!at)return null;
  const sec=el.closest(".run[data-run]"),mark=at.after?blockEnd(sec,run,at.target):sec.querySelector('tbody.session[data-key="'+CSS.escape(run.id+"/"+at.target)+'"]');
  return mark?{mark,...at}:null}
// Remember what a drop changed for its list; true when it changed the order shown.
function dropOrder(d,at){const all={...orders};let name="sections",memo;
  if(d.kind==="section")memo=dropMemo(state.map(r=>r.id),sectionOrder(state,all).map(r=>r.id),d.run,at.target,at.after);
  else{const run=state.find(r=>r.id===d.run),t=run?.tasks.find(x=>x.key===d.key);if(!t)return false;name=listName(d.run,t.parentKey);
    const same=x=>sameParent(x,t);memo=dropMemo(run.tasks.filter(same).map(x=>x.key),treeRows(run,all).filter(same).map(x=>x.key),d.key,at.target,at.after)}
  if(memo===undefined)return false;if(memo)all[name]=memo;else delete all[name];orders=all;saveOrders();return true}
function endDrag(changed){markDrop(null);for(const el of document.getElementById("runs").querySelectorAll(".dragging"))el.classList.remove("dragging");
  dragged=null;pressed=null;if(changed){behind=true;lastState=""}setTimeout(()=>catchUp(),0)}
(()=>{const root=document.getElementById("runs");
  root.addEventListener("dragstart",e=>{const g=e.target?.closest?.(".grip");if(!g)return; // other drags, such as selected text, stay the browser's
    const row=g.closest("tbody.session[data-key]"),sec=g.closest(".run[data-run]");if(!sec)return;
    if(row){const[run,key]=row.dataset.key.split("/");dragged={kind:"row",run,key,el:row}}else dragged={kind:"section",run:sec.dataset.run,el:sec};
    e.dataTransfer.effectAllowed="move";e.dataTransfer.setData(DRAG_TYPE,dragged.run+"/"+(dragged.key||""));
    const shown=row||g.parentNode,r=shown.getBoundingClientRect();try{e.dataTransfer.setDragImage(shown,e.clientX-r.left,e.clientY-r.top)}catch{}
    // The item fades while it moves, a row with every row under it.
    const run=state.find(x=>x.id===dragged.run),byKey=new Map((run?.tasks||[]).map(t=>[t.key,t]));
    const moves=k=>{for(let p=k;p;p=byKey.get(p)?.parentKey)if(p===dragged.key)return true;return false};
    if(row){for(const b of sec.querySelectorAll("tbody.session"))if(moves(b.dataset.key.split("/")[1]))b.classList.add("dragging")}else sec.classList.add("dragging")});
  const over=e=>{if(!dragged)return;const at=dropAt(e);markDrop(at?.mark,at?.after);if(!at)return;e.preventDefault();e.dataTransfer.dropEffect="move"};
  root.addEventListener("dragenter",over);root.addEventListener("dragover",over);
  // Out over the rest of the page, the line goes; `dragleave` cannot tell, as it fires between cells too.
  document.addEventListener("dragover",e=>{if(dragged&&!root.contains(e.target))markDrop(null)});
  root.addEventListener("drop",e=>{if(!dragged)return;const at=dropAt(e);if(!at)return;e.preventDefault();endDrag(dropOrder(dragged,at))});
  root.addEventListener("dragend",()=>{if(dragged)endDrag(false)})})();
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
function tick(){const now=Date.now();for(const el of document.querySelectorAll(".tick[data-since],.waited[data-since]"))el.textContent=(el.classList.contains("waited")?"waited ":"")+dur(now-Number(el.dataset.since));
  if(hintDue!=null&&now>=hintDue)compose()}
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
