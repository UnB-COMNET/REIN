/* Módulos: the REIN services and their session logs. */
(() => {
  'use strict';
  const R = window.REIN, M = R.model, $ = R.$, $$ = R.$$, G = window.gsap;
  const exp = $('[data-slot="experiments"]'), mods = $('[data-slot="modules"]');
  const esc = R.esc, icon = R.icon;
  const clock = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || min));
  const word = a => ({ ok: 'Normal', warn: 'Degradado', down: 'Fora' }[a] || 'Normal');
  const stateIcon = a => a === 'down' ? icon('i-x') : a === 'warn' ? icon('i-bolt') : icon('i-check');
  let motion = null, inspectMotion = null, cycleMotion = null, signalMotion = null, timelineWidth = 0;
  const timelineSize = new ResizeObserver(entries => { timelineWidth = entries[0]?.contentRect.width || 0; });

  function entrance(root) {
    motion?.revert();
    if (R.reduced.matches || !G) return;
    motion = G.context(() => {
      const tl = G.timeline({ defaults: { ease: 'power3.out', duration: .65 } });
      const surfaces=root.querySelectorAll('[data-enter]'), paths=root.querySelectorAll('[data-draw]');
      if(surfaces.length)tl.from(surfaces, { y: 18, autoAlpha: 0, stagger: .075, clearProps: 'transform,opacity,visibility' });
      if(paths.length)tl.from(paths, { strokeDashoffset: 1, duration: .95, ease: 'power2.inOut' }, .18);
    }, root);
  }
  function changePanel(el, html) {
    inspectMotion?.revert();
    el.innerHTML = html;
    if (!R.reduced.matches && G) inspectMotion = G.context(() => {
      G.from(el.children, { y: 9, autoAlpha: 0, duration: .4, stagger: .035, ease: 'power3.out', clearProps: 'transform,opacity,visibility' });
    }, el);
  }
  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); R.toast(label || 'Copiado.'); }
    catch { R.toast('Não foi possível copiar. Selecione o texto e copie manualmente.'); }
  }
  function download(name, body) {
    const href = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = href; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  const segmented = (name, options, current, attr) => `<div class="st-segment" role="group" aria-label="${name}" style="--count:${options.length};--selected:${Math.max(0, options.findIndex(([v]) => v === current))}"><i aria-hidden="true"></i>${options.map(([v, label]) => `<button type="button" ${attr}="${v}" aria-pressed="${v === current}">${label}</button>`).join('')}</div>`;

  // --------------------------------------------------------------- experiment plan
  // Experiments moved to experiments.js; this file keeps the Módulos page.

  // --------------------------------------------------------------- service constellation
  const SERVICES = [
    {id:'profiler',name:'Intent profiler',short:'Profiler',verb:'Compreende',icon:'i-chat',port:5300,source:'Profiler',intro:'Profiling e tradução para Nile.',description:'Contextualiza o pedido no inventário, consulta exemplos e traduz os requisitos para Nile. A implantação acontece depois da sua aprovação.'},
    {id:'deployer',name:'Deployer',short:'Deployer',verb:'Implanta',icon:'i-deployer',port:5000,source:'Deployer',intro:'Validação e implantação de fluxos.',description:'Valida sintaxe e capacidade, reconstrói o grafo do ONOS e instala os fluxos. Quando necessário, recebe pedidos de recálculo do supervisor.'},
    {id:'supervisor',name:'Supervisor',short:'Supervisor',verb:'Acompanha',icon:'i-shield',port:5151,source:'Supervisor',intro:'Monitoramento e detecção de desvios.',description:'Acompanha cada fluxo, identifica desvios de vazão e latência e solicita um novo caminho quando a intent deixa de ser atendida.'}
  ];
  const baseLogs={Profiler:[['14:20:08','Index: 6.412 examples, 914 skeletons'],['14:20:09','Model qwen3.6 awake at gpu.mfcaetano.lan:8000'],['14:26:40','POST /profile thread q1, 3 steps, 1,7 s'],['14:28:10','q1 approved, sent to deployer']],Deployer:[['14:20:02','Grammar loaded from nile.lark'],['14:20:03','ONOS graph: 4 devices, 8 links'],['14:28:11',"POST /deploy q1 200: add service('cdn-qoe'), server ds0"],['14:28:12','6 flows installed']],Supervisor:[['14:20:05','SUPERVISOR_MODE=threshold'],['14:28:13','Monitor started for 192.168.0.2'],['14:31:04','Latency s0-s1 132 ms above limit','warn'],['14:31:05','POST /deploy/recalculate']]};
  let moduleId='profiler', moduleTab='overview', logQuery='', cyclePlaying=false;
  const service=()=>SERVICES.find(x=>x.id===moduleId);
  function facts(s) {
    if(s.id==='profiler')return [['Endereço','127.0.0.1:5300'],['Modelo',R.state.model],['RAG','NEAT: 256.913 pares, 914 esqueletos'],['Seeds REIN','data/seeds_rein.tsv'],['Decodificação restrita','Desligada'],['Endpoints','/profile (SSE), /profile/<thread>/resume, /models, /events']];
    if(s.id==='deployer')return [['Endereço','127.0.0.1:5000'],['Intents instaladas',M.intents.filter(i=>i.state==='deployed').length],['Grafo do ONOS',`${R.switches().length} switches, ${M.links.length} links`],['Validação','Lark / nile.lark'],['Respostas','400: sintaxe / 422: não executável'],['Endpoints','/deploy, /deploy/recalculate, /capabilities, /intents, /metrics']];
    return [['Endereço','127.0.0.1:5151'],['Modo','threshold'],['Monitores',R.clientsList().map(c=>c.ip).join(', ')||'nenhum'],['Limite de RTT','200 ms'],['LLM','gpu.mfcaetano.lan:8000'],['Endpoints','/supervise, /metrics, /metrics/reset, /metrics/degrade']];
  }
  function logs(s) {
    const fresh=M.events.filter(e=>e.source===s.source).slice(-12).map(e=>[e.time,e.text,e.tone]);
    const asks=s.id==='profiler'?M.chat.slice(5).filter(m=>m.role==='user').map(m=>[m.time,`POST /profile "${m.text.slice(0,80)}"`]):[];
    const live=R.api?.logs?.[s.id]; // the service's own log (docker logs) when the testbed is online
    return (live||[...baseLogs[s.source],...fresh,...asks]).filter(row=>row.join(' ').toLocaleLowerCase().includes(logQuery.toLocaleLowerCase()));
  }
  function logRows(s, previewOnly=false) {
    const rows=logs(s);return (previewOnly?rows.slice(-4):rows).map(([t,text,tone])=>`<div class="st-log-row" data-level="${tone==='warn'?'warn':tone==='down'?'error':'info'}"><time>${esc(t)}</time><span>${tone==='warn'?'Aviso':tone==='down'?'Erro':'Info'}</span><code>${esc(text)}</code></div>`).join('')||'<p class="st-empty">Nenhum registro corresponde à busca.</p>';
  }
  function modulePanel() {
    const s=service();
    if(moduleTab==='logs')return `<div class="st-log-view"><div class="st-detail-toolbar"><label class="st-search">${icon('i-search')}<input type="search" data-log-search aria-label="Buscar no log" placeholder="Buscar no log" value="${esc(logQuery)}"></label><button class="st-button" data-module-action="copy-logs">${icon('i-copy')}Copiar log</button></div><div class="st-log-full" data-log-rows>${logRows(s)}</div><p class="st-small-note">Registros ilustrativos e eventos desta sessão.</p></div>`;
    if(moduleTab==='config')return `<div class="st-configuration"><div class="st-detail-toolbar"><div><h3>Configuração do serviço</h3><p>Parâmetros disponíveis nesta demonstração.</p></div><button class="st-icon-button" data-module-action="copy-config" aria-label="Copiar configuração" title="Copiar configuração">${icon('i-copy')}</button></div><dl class="st-facts">${facts(s).map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${s.id==='deployer'?`<h3 class="st-cap-heading">Capacidades</h3><ul class="st-capabilities">${[["add service('cdn-qoe')",'Executa','ok'],["set bandwidth('max', …)",'Em teste','warn'],['allow / block','Não executa','neutral'],['add middlebox','Não executa','neutral'],['start / end date','Não executa','neutral']].map(([a,b,c])=>`<li><code>${esc(a)}</code><span data-state="${c}">${c==='ok'?icon('i-check'):c==='warn'?icon('i-info'):icon('i-minus')}${b}</span></li>`).join('')}</ul>`:''}</div>`;
    return `<div class="st-overview"><section class="st-module-story"><span class="st-caption">${s.verb} a intenção</span><h3>${s.intro}</h3><p>${s.description}</p><dl class="st-module-facts">${facts(s).slice(1,3).map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl><button class="st-text-button" data-module-tab="config">Ver configuração ${icon('i-chevron-right')}</button></section><section class="st-recent"><div><h3>Atividade recente</h3><button class="st-icon-button" data-module-tab="logs" aria-label="Abrir log completo" title="Abrir log completo">${icon('i-chevron-right')}</button></div><div data-log-rows>${logRows(s,true)}</div><p class="st-small-note">Dados de demonstração</p></section></div>`;
  }
  function renderModules(animate=false) {
    mods.innerHTML=`<div class="st-modules"><section class="st-service-stage" data-enter><div class="st-service-heading"><div><span class="st-caption">Ciclo da intent</span><h2>Serviços do REIN</h2></div><button class="st-button" data-module-action="cycle">${icon('i-play')}<span>Observar ciclo</span></button></div><div class="st-constellation" role="tablist" aria-label="Serviços do REIN"><div class="st-service-wire" aria-hidden="true"><i data-cycle-line></i><b data-cycle-packet></b></div>${SERVICES.map(s=>`<button class="st-service" type="button" id="service-${s.id}" role="tab" aria-controls="service-detail" aria-selected="${s.id===moduleId}" tabindex="${s.id===moduleId?0:-1}" data-service="${s.id}"><span class="st-service-object">${icon(s.icon)}<i class="st-service-check">${icon('i-check')}</i></span><strong>${s.short}</strong><span>${s.verb}</span><small>Ativo <i></i> :${s.port}</small></button>`).join('')}</div><div class="st-cycle-caption" data-cycle-caption aria-live="polite">Selecione um serviço para inspecionar sua configuração.</div></section><section class="st-module-detail" role="tabpanel" id="service-detail" aria-labelledby="service-${moduleId}" data-enter><header class="st-module-detail-head"><div><h2 data-service-title>${service().name}</h2><button class="st-endpoint" data-module-action="copy-address" title="Copiar endereço">127.0.0.1:<span data-service-port>${service().port}</span>${icon('i-copy')}</button></div><span class="st-health">${icon('i-check')}Ativo na demonstração</span></header><div class="st-module-tabs" role="tablist" aria-label="Inspeção do módulo"><i data-module-indicator aria-hidden="true"></i>${[['overview','Visão geral'],['config','Configuração'],['logs','Log da sessão']].map(([v,t],i)=>`<button role="tab" id="service-tab-${v}" aria-controls="service-content" aria-selected="${moduleTab===v}" tabindex="${moduleTab===v?0:-1}" data-module-tab="${v}">${t}</button>`).join('')}</div><div id="service-content" role="tabpanel" aria-labelledby="service-tab-${moduleTab}" data-module-content>${modulePanel()}</div></section></div>`;
    positionModuleIndicator(false);if(animate)entrance(mods);
  }
  function positionModuleIndicator(animate=true) {
    const el=$('.st-module-tabs [aria-selected="true"]',mods),ind=$('[data-module-indicator]',mods);if(!el||!ind)return;
    const properties={x:el.offsetLeft,width:el.offsetWidth};
    if(animate&&!R.reduced.matches&&G)G.to(ind,{...properties,duration:.4,ease:'power3.out',overwrite:true});else if(G)G.set(ind,properties);else{ind.style.left=`${el.offsetLeft}px`;ind.style.width=`${el.offsetWidth}px`;}
  }
  function selectService(id) {
    stopCycle();moduleId=id;logQuery='';
    $$('.st-service',mods).forEach(b=>{const active=b.dataset.service===id;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;});
    $('#service-detail',mods).setAttribute('aria-labelledby',`service-${id}`);
    $('[data-service-title]',mods).textContent=service().name;$('[data-service-port]',mods).textContent=service().port;
    changePanel($('[data-module-content]',mods),modulePanel());
  }
  function selectModuleTab(tab) {
    moduleTab=tab;logQuery='';
    $$('.st-module-tabs button',mods).forEach(b=>{const active=b.dataset.moduleTab===tab;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;});
    $('#service-content',mods).setAttribute('aria-labelledby',`service-tab-${tab}`);
    positionModuleIndicator();changePanel($('[data-module-content]',mods),modulePanel());
  }
  function stopCycle() {
    cycleMotion?.revert();cycleMotion=null;cyclePlaying=false;
    const b=$('[data-module-action="cycle"]',mods);if(b)b.innerHTML=icon('i-play')+'<span>Observar ciclo</span>';
    $$('.st-service',mods).forEach(el=>el.classList.remove('is-processing'));
    const caption=$('[data-cycle-caption]',mods);if(caption)caption.textContent='Selecione um serviço para inspecionar sua configuração.';
  }
  function playCycle() {
    if(cyclePlaying){stopCycle();return;}cycleMotion?.revert();cyclePlaying=true;
    const b=$('[data-module-action="cycle"]',mods);b.innerHTML='<span class="st-stop"></span><span>Parar prévia</span>';
    const stages=$$('.st-service',mods),caption=$('[data-cycle-caption]',mods),line=$('[data-cycle-line]',mods),packet=$('[data-cycle-packet]',mods);
    const states=['O profiler contextualiza e traduz o pedido.','O deployer valida a Nile e instala os fluxos.','O supervisor acompanha e detecta desvios.'];
    const show=i=>{stages.forEach((s,k)=>s.classList.toggle('is-processing',k===i));caption.textContent=states[i];};
    if(!G||R.reduced.matches){show(2);b.innerHTML=icon('i-refresh')+'<span>Rever ciclo</span>';cyclePlaying=false;return;}
    cycleMotion=G.context(()=>{
      const tl=G.timeline({onComplete:()=>{cyclePlaying=false;b.innerHTML=icon('i-refresh')+'<span>Rever ciclo</span>';caption.textContent='Ciclo concluído. O supervisor mantém a observação.';stages.forEach(s=>s.classList.remove('is-processing'));G.set(stages.map(s=>s.querySelector('.st-service-object')),{clearProps:'transform'});}});
      tl.set(line,{scaleX:0,transformOrigin:'left'}).set(packet,{x:0,autoAlpha:0});
      stages.forEach((s,i)=>{tl.call(()=>show(i),[],i*1.3).fromTo(s.querySelector('.st-service-object'),{y:0,scale:1},{y:-6,scale:1.04,duration:.5,ease:'power2.out',yoyo:true,repeat:1},i*1.3);});
      tl.to(line,{scaleX:1,duration:2.6,ease:'power1.inOut'},.5).to(packet,{autoAlpha:1,duration:.15},.5).to(packet,{x:()=>line.parentElement.clientWidth-8,duration:2.6,ease:'power1.inOut'},.5).to(packet,{autoAlpha:0,duration:.3},3.1);
    },mods);
  }
  mods.addEventListener('click',e=>{
    const s=e.target.closest('[data-service]');if(s){selectService(s.dataset.service);return;}
    const tab=e.target.closest('[data-module-tab]');if(tab){selectModuleTab(tab.dataset.moduleTab);return;}
    const action=e.target.closest('[data-module-action]')?.dataset.moduleAction;
    if(action==='cycle')playCycle();
    if(action==='copy-address')copy(`127.0.0.1:${service().port}`,'Endereço copiado.');
    if(action==='copy-config')copy(JSON.stringify(Object.fromEntries(facts(service())),null,2),'Configuração copiada.');
    if(action==='copy-logs')copy(logs(service()).map(row=>row.slice(0,2).join('  ')).join('\n'),'Log copiado.');
  });
  mods.addEventListener('input',e=>{if(e.target.matches('[data-log-search]')){logQuery=e.target.value;$('[data-log-rows]',mods).innerHTML=logRows(service());}});
  mods.addEventListener('keydown',e=>{const tab=e.target.closest('[role="tab"]');if(!tab)return;const list=tab.closest('[role="tablist"]'),items=$$('[role="tab"]',list);let k=items.indexOf(tab);if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();k=e.key==='Home'?0:e.key==='End'?items.length-1:(k+(e.key==='ArrowRight'?1:-1)+items.length)%items.length;items[k].click();items[k].focus();});
  R.on((type,d)=>{
    if(type==='page'){
      motion?.revert();inspectMotion?.revert();signalMotion?.kill();stopCycle();
      
      if(d.page==='modulos')renderModules(true);
    }
    if(['log','chat','intent'].includes(type)&&R.page==='modulos'&&moduleTab!=='config') {const box=$('[data-log-rows]',mods);if(box)box.innerHTML=logRows(service(),moduleTab==='overview');}
  });
  R.reduced.addEventListener('change',()=>{motion?.revert();inspectMotion?.revert();signalMotion?.kill();stopCycle();const signal=$('[data-signal]',exp);if(G&&signal)G.set(signal,{clearProps:'transform'});});
  addEventListener('resize',()=>{if(R.page==='modulos')positionModuleIndicator(false);});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCycle();});
  // Native button feedback and page-scoped timelines avoid permanent animation loops.
})();
