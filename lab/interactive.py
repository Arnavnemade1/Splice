#!/usr/bin/env python3
"""
Splice Model Mind Lab — interactive report renderer.

render_interactive(model, results, elapsed) turns one `mindlab.py report` run
into a self-contained, explorable HTML page: saliency you can toggle, a logit
lens you scrub layer by layer, hoverable patching / knockout heatmaps, a
concept-injection stepper, and neuron/head importance bars — for ANY model
and prompt. This is the artifact-quality report folded back into the tool, so
every run emits its own explorable page rather than a static dump.

Self-contained: one HTML string, embedded JSON, no external assets. Palette is
colorblind-validated and theme-aware (follows the viewer's light/dark).
"""

from __future__ import annotations

import json
import time
from typing import Any

TEMPLATE = r"""<!doctype html><meta charset="utf-8">
<title>Model Mind Lab — __MODEL__</title>
<style>
  :root{
    --paper:#FBFBF9;--card:#FFFFFF;--ink:#1B1F23;--mut:#68707A;--line:#E7E5E0;--grid:#EEEDE9;
    --teal:#0D9488;--indigo:#6D4AC4;--copper:#B45309;--focus:#0D9488;
    --heatLo:230,244,241;--heatHi:11,93,84;
    --serif:"Iowan Old Style","Palatino Nova",Palatino,Georgia,serif;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,monospace;
  }
  @media (prefers-color-scheme:dark){:root{
    --paper:#16191C;--card:#1D2125;--ink:#E8EAEA;--mut:#99A1A8;--line:#2A2F34;--grid:#23282C;
    --teal:#2FA091;--indigo:#9B7FE8;--copper:#C97F2E;--heatLo:29,41,40;--heatHi:92,213,196;
  }}
  :root[data-theme="dark"]{
    --paper:#16191C;--card:#1D2125;--ink:#E8EAEA;--mut:#99A1A8;--line:#2A2F34;--grid:#23282C;
    --teal:#2FA091;--indigo:#9B7FE8;--copper:#C97F2E;--heatLo:29,41,40;--heatHi:92,213,196;
  }
  :root[data-theme="light"]{
    --paper:#FBFBF9;--card:#FFFFFF;--ink:#1B1F23;--mut:#68707A;--line:#E7E5E0;--grid:#EEEDE9;
    --teal:#0D9488;--indigo:#6D4AC4;--copper:#B45309;--heatLo:230,244,241;--heatHi:11,93,84;
  }
  *{box-sizing:border-box;margin:0}
  body{background:var(--paper);color:var(--ink);font:16px/1.62 var(--sans)}
  main{max-width:900px;margin:0 auto;padding:44px 20px 80px}
  .kicker{font-family:var(--mono);font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--teal);font-weight:600}
  h1{font-family:var(--serif);font-size:clamp(28px,5vw,42px);line-height:1.12;letter-spacing:-.015em;text-wrap:balance;font-weight:600;margin-top:10px}
  .meta{display:flex;gap:14px;flex-wrap:wrap;margin-top:16px;color:var(--mut);font-family:var(--mono);font-size:12px}
  .meta b{color:var(--ink);font-weight:600}
  nav{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--paper) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);margin:30px -20px 0;padding:9px 20px;display:flex;gap:5px;overflow-x:auto}
  nav a{color:var(--mut);text-decoration:none;font-size:12.5px;padding:5px 10px;border-radius:999px;white-space:nowrap}
  nav a:hover,nav a:focus-visible{color:var(--ink);background:var(--card);outline:2px solid transparent}
  section{margin-top:52px;scroll-margin-top:60px}
  .fig{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--teal);font-weight:600}
  h2{font-family:var(--serif);font-size:24px;font-weight:600;margin-top:5px;letter-spacing:-.005em;text-wrap:balance}
  .what{color:var(--mut);font-size:14.5px;max-width:70ch;margin-top:7px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:16px}
  .sub{color:var(--mut);font-size:13.5px}
  .chips{display:flex;flex-wrap:wrap;gap:5px}
  .chip{font-family:var(--mono);font-size:13.5px;padding:5px 8px;border-radius:7px;border:1px solid var(--line);white-space:pre;cursor:default}
  .pred{color:var(--teal);font-weight:700;border-color:var(--teal)}
  .seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}
  .seg button{font:600 13px var(--sans);padding:7px 13px;border:0;background:transparent;color:var(--mut);cursor:pointer}
  .seg button[aria-pressed="true"]{background:var(--teal);color:var(--card)}
  .seg button:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
  .bars{display:grid;grid-template-columns:minmax(74px,auto) 1fr minmax(64px,auto);gap:6px 12px;align-items:center;margin-top:12px;font-variant-numeric:tabular-nums}
  .rowlbl{font-family:var(--mono);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .track{height:12px;background:color-mix(in srgb,var(--line) 55%,transparent);border-radius:4px;position:relative}
  .fill{position:absolute;inset:0 auto 0 0;border-radius:4px;background:var(--teal);min-width:2px}
  .fill.neg{background:var(--copper)}.fill.indigo{background:var(--indigo)}
  .val{font-family:var(--mono);font-size:12px;color:var(--mut);text-align:right}
  .note{color:var(--mut);font-size:13px;margin-top:12px;max-width:72ch}
  .annot{color:var(--teal);font-weight:600}
  input[type=range]{width:100%;accent-color:var(--teal)}
  svg{display:block;width:100%;height:auto;overflow:visible}svg text{font-family:var(--mono);fill:var(--mut)}
  .gridline{stroke:var(--grid);stroke-width:1}
  .heat{display:grid;gap:2px;margin-top:14px}
  .cell{aspect-ratio:1;border-radius:2px;min-width:0}
  .cell:hover{outline:2px solid var(--ink);outline-offset:-1px}
  .xlab{font-family:var(--mono);font-size:9.5px;color:var(--mut);writing-mode:vertical-rl;transform:rotate(180deg);justify-self:center;max-height:76px;overflow:hidden}
  .ylab{font-family:var(--mono);font-size:10px;color:var(--mut);align-self:center;text-align:right;padding-right:5px}
  .steer-text{font-family:var(--serif);font-size:17.5px;line-height:1.7;margin-top:14px;min-height:5em}
  .steer-text .lead{color:var(--mut)}
  .alpha-axis{position:relative;height:32px;margin-top:16px}
  .alpha-rail{position:absolute;top:14px;left:0;right:0;height:4px;background:var(--line);border-radius:99px}
  .alpha-band{position:absolute;top:11px;height:10px;border-radius:99px;background:color-mix(in srgb,var(--teal) 22%,transparent)}
  .alpha-dot{position:absolute;top:8px;width:16px;height:16px;border-radius:50%;background:var(--teal);border:2px solid var(--card);transform:translateX(-50%);transition:left .25s}
  .bandlbl{position:absolute;top:-7px;font-family:var(--mono);font-size:10px;color:var(--teal)}
  canvas{width:100%;max-width:380px;border-radius:6px;image-rendering:pixelated}
  .duo{display:grid;gap:20px;grid-template-columns:1fr}@media(min-width:700px){.duo{grid-template-columns:1fr 1fr}}
  .gauge{height:14px;border-radius:99px;background:color-mix(in srgb,var(--line) 55%,transparent);overflow:hidden;margin-top:8px}
  .gauge>div{height:100%;background:linear-gradient(90deg,var(--teal),var(--indigo));border-radius:99px}
  details{margin-top:12px}summary{cursor:pointer;color:var(--mut);font-size:13px}
  table{border-collapse:collapse;font-size:12.5px;margin-top:8px;font-variant-numeric:tabular-nums;width:100%}
  th,td{text-align:left;padding:4px 9px;border-bottom:1px solid var(--line)}
  th{color:var(--mut);font-weight:600;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.04em}
  .mono{font-family:var(--mono)}
  #tip{position:fixed;z-index:20;pointer-events:none;background:var(--ink);color:var(--paper);font:12px/1.5 var(--mono);padding:6px 9px;border-radius:6px;opacity:0;transition:opacity .12s;max-width:320px}
  .legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--mut);margin-top:10px}
  .lg{display:inline-flex;align-items:center;gap:6px}.sw{width:11px;height:11px;border-radius:3px}
  footer{margin-top:64px;border-top:1px solid var(--line);padding-top:18px;color:var(--mut);font-size:13px;max-width:80ch}
  @media(prefers-reduced-motion:reduce){.alpha-dot{transition:none}}
</style>
<main>
  <div class="kicker">Splice · Model Mind Lab · lab/mindlab.py report --interactive</div>
  <h1 id="headline"></h1>
  <div class="meta" id="meta"></div>
  <nav aria-label="Experiments">
    <a href="#f1">1 · Jacobian</a><a href="#f2">2 · Logit lens</a><a href="#f3">3 · Patching</a>
    <a href="#f4">4 · Injection</a><a href="#f5">5 · Induction</a><a href="#f6">6 · Ablation</a><a href="#f7">7 · Knockout</a><a href="#f8">8 · Reasoning</a>
  </nav>

  <section id="f1"><div class="fig">Fig. 1 · The Jacobian space</div>
    <h2>Which words carry the prediction</h2>
    <p class="what">∂ logit(prediction) / ∂ input-embedding, by autograd — the local linear map of the whole
    network. Darker = more leverage. Toggle the measure; hover for exact values.</p>
    <div class="card"><div class="seg" role="group" aria-label="Measure">
      <button id="m-sal" aria-pressed="true">‖gradient‖</button><button id="m-ixg" aria-pressed="false">input × grad</button></div>
      <div class="chips" id="jchips" style="margin-top:15px"></div><div class="bars" id="jbars"></div>
      <p class="note" id="jnote"></p></div></section>

  <section id="f2"><div class="fig">Fig. 2 · Logit lens</div>
    <h2>The answer crystallizing, layer by layer</h2>
    <p class="what">The residual stream after each block, decoded through the model's own readout. Drag the
    scrubber to watch the prediction form.</p>
    <div class="card"><label class="rowlbl" for="ls">layer <b id="ls-v" class="mono">emb</b> — drag to think</label>
      <input type="range" id="ls" min="0" value="0" step="1">
      <div class="duo" style="margin-top:12px"><div><div class="sub">top guesses at this depth</div><div class="bars" id="lbars"></div></div>
      <div><div class="sub">p(answer) through the stack</div><svg id="lsvg" viewBox="0 0 380 168" role="img" aria-label="answer probability by layer"></svg></div></div></div></section>

  <section id="f3"><div class="fig">Fig. 3 · Activation patching</div>
    <h2>Where the computation lives</h2>
    <p class="what">Swap the clean run's residual stream into the corrupted run, one (layer × position) cell
    at a time; colour = how much of the right answer returns. Hover any cell.</p>
    <div class="card"><div class="sub" id="p3sub"></div><div style="overflow-x:auto"><div class="heat" id="pheat"></div></div>
      <p class="note">Metric: normalized recovery of logit(answer) − logit(foil); 1.0 = fully restored.</p></div></section>

  <section id="f4"><div class="fig">Fig. 4 · Concept injection</div>
    <h2>Pushing a concept into the stream</h2>
    <p class="what">A concept vector (concept − control prompts) added during generation. Step the strength:
    nothing… drift… a sweet spot where it surfaces… then the thought dissolves.</p>
    <div class="card"><div class="seg" role="group" aria-label="strength" id="aseg"></div>
      <div class="alpha-axis" aria-hidden="true"><div class="alpha-rail"></div><div class="alpha-band" id="aband"></div>
        <span class="bandlbl" id="ablbl">sweet spot</span><div class="alpha-dot" id="adot"></div></div>
      <p class="steer-text" id="stext"></p><p class="note" id="snote"></p></div></section>

  <section id="f5"><div class="fig">Fig. 5 · Induction heads</div>
    <h2>The machinery of in-context learning</h2>
    <p class="what">A repeated random sequence. Induction heads attend from each token back to the one
    <em>after</em> its previous occurrence — the off-diagonal stripe.</p>
    <div class="card"><div class="duo"><div><div class="sub" id="a5sub"></div>
      <canvas id="attn" width="50" height="50" style="margin-top:10px"></canvas></div>
      <div><div class="sub">prefix-matching score, top heads</div><div class="bars" id="hbars"></div></div></div></div></section>

  <section id="f6"><div class="fig">Fig. 6 · Neuron ablation &amp; superposition</div>
    <h2>How distributed is the fact?</h2>
    <p class="what">Attribution = activation × gradient for every MLP neuron (one backward pass); the top few
    are confirmed by actually zeroing them. The gauge is the participation ratio — the effective number of
    neurons carrying the prediction.</p>
    <div class="card"><div class="sub" id="absub"></div>
      <div class="gauge"><div id="abgauge"></div></div><div class="note" id="abgnote"></div>
      <div class="legend"><span class="lg"><span class="sw" style="background:var(--teal)"></span>supports prediction (ablating lowers it)</span>
        <span class="lg"><span class="sw" style="background:var(--copper)"></span>opposes it (ablating raises it)</span></div>
      <div class="bars" id="abbars" style="margin-top:10px"></div></div></section>

  <section id="f7"><div class="fig">Fig. 7 · Attention-head knockout</div>
    <h2>Which heads cause the answer</h2>
    <p class="what">Every head is zeroed one at a time and the answer's logit lead re-measured — the causal
    complement to Fig. 5. Teal heads support the answer; copper heads oppose it. Hover any cell.</p>
    <div class="card"><div class="sub" id="kosub"></div><div style="overflow-x:auto"><div class="heat" id="koheat"></div></div>
      <div class="legend"><span class="lg"><span class="sw" style="background:var(--teal)"></span>supports answer</span>
        <span class="lg"><span class="sw" style="background:var(--copper)"></span>opposes answer</span></div>
      <div class="bars" id="kobars" style="margin-top:12px"></div></div></section>

  <section id="f8"><div class="fig">Fig. 8 · Multi-hop reasoning</div>
    <h2>Watching a two-step thought form</h2>
    <p class="what">A two-hop question (Dallas → its state → that state's capital). The last-position residual is
    decoded at every layer: if the model reasons internally, the intermediate <em>bridge</em> concept rises in
    the middle layers <em>before</em> the final answer — even though the bridge is never the output.</p>
    <div class="card"><div class="sub" id="r8sub"></div>
      <div class="legend"><span class="lg"><span class="sw" style="background:var(--indigo)"></span>bridge (intermediate step)</span>
        <span class="lg"><span class="sw" style="background:var(--teal)"></span>answer</span></div>
      <svg id="rsvg" viewBox="0 0 640 250" role="img" aria-label="bridge and answer probability by layer"></svg>
      <p class="note" id="rnote"></p></div></section>

  <footer id="foot"></footer>
</main>
<div id="tip" role="status"></div>
<script>
const DATA = __DATA__, MODEL = "__MODEL__", ELAPSED = __ELAPSED__;
const $ = (s)=>document.querySelector(s);
const esc = (s)=>{const d=document.createElement("i");d.textContent=s;return d.innerHTML;};
const tip = $("#tip");
function showTip(e,t){tip.innerHTML=t;tip.style.opacity=1;const w=tip.offsetWidth;
  tip.style.left=Math.min(innerWidth-w-8,e.clientX+14)+"px";tip.style.top=(e.clientY+14)+"px";}
function hideTip(){tip.style.opacity=0;}
const css=(v)=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function heat(t){const lo=css("--heatLo").split(",").map(Number),hi=css("--heatHi").split(",").map(Number);
  t=Math.max(0,Math.min(1,t));const c=lo.map((l,i)=>Math.round(l+(hi[i]-l)*t));return `rgb(${c[0]},${c[1]},${c[2]})`;}
function rgb(v){return css(v).match(/\d+/g)?.map(Number)||[0,0,0];}
function diverge(t){ // -1..+1 → copper .. neutral .. teal
  const neu=rgb("--card"), pos=rgb("--teal"), neg=rgb("--copper");
  const a=Math.min(1,Math.abs(t)), tgt=t>=0?pos:neg;
  const c=neu.map((n,i)=>Math.round(n+(tgt[i]-n)*a));return `rgb(${c[0]},${c[1]},${c[2]})`;}

$("#headline").textContent = `Watching ${MODEL} think`;
$("#meta").innerHTML = `<span>model <b>${esc(MODEL)}</b></span><span>runtime <b>${ELAPSED.toFixed(1)}s, CPU</b></span>`+
  `<span>methods <b>RESEARCH.md · NOVEL.md</b></span><span>scope <b>local weights only</b></span>`;
$("#foot").innerHTML = `<b>Honest scope.</b> Every experiment ran on locally held open weights (${esc(MODEL)}). `+
  `Nothing here probes a hosted model's internals. Reproduce: <span class="mono">python3 mindlab.py report --interactive</span>.`;

// ── Fig 1: Jacobian ──
const J=DATA.jacobian; let jm="sal";
function drawJ(){
  const vals=jm==="sal"?J.saliency:J.input_x_grad, mag=vals.map(Math.abs), hi=Math.max(...mag)||1;
  $("#jchips").innerHTML="";
  J.tokens.forEach((t,i)=>{const el=document.createElement("span");el.className="chip";el.textContent=t;
    const s=mag[i]/hi;
    el.style.background=(jm==="ixg"&&vals[i]<0)?`color-mix(in srgb,var(--copper) ${Math.round(s*80)}%,var(--card))`:heat(s*0.92);
    el.style.color=s>0.55?css("--card"):"";
    el.onmousemove=(e)=>showTip(e,`${JSON.stringify(t)}  ‖∂/∂emb‖ ${J.saliency[i]} · in×grad ${J.input_x_grad[i]}`);
    el.onmouseleave=hideTip;$("#jchips").appendChild(el);});
  const pc=document.createElement("span");pc.className="chip pred";pc.textContent="→"+J.predicted+` (p=${J.predicted_prob})`;$("#jchips").appendChild(pc);
  const order=[...J.tokens.keys()].sort((a,b)=>mag[b]-mag[a]).slice(0,6);
  $("#jbars").innerHTML=order.map(i=>`<span class="rowlbl">${esc(J.tokens[i])}</span>
    <div class="track"><div class="fill ${vals[i]<0?"neg":""}" style="width:${(mag[i]/hi*100).toFixed(1)}%"></div></div>
    <span class="val">${vals[i]}</span>`).join("");
  const tmix=[...J.dominant_token_mix].sort((a,b)=>Math.abs(b.weight)-Math.abs(a.weight)).slice(0,3);
  $("#jnote").innerHTML=`One sensitivity mode carries <b>${Math.round(J.dominant_mode_energy*100)}%</b> of the Jacobian's energy — led by `+
    tmix.map(t=>`<span class="mono">${esc(t.token.trim())}</span>`).join(", ")+`. The same SVD Splice runs over its own scorer.`;
}
$("#m-sal").onclick=()=>{jm="sal";$("#m-sal").setAttribute("aria-pressed","true");$("#m-ixg").setAttribute("aria-pressed","false");drawJ();};
$("#m-ixg").onclick=()=>{jm="ixg";$("#m-ixg").setAttribute("aria-pressed","true");$("#m-sal").setAttribute("aria-pressed","false");drawJ();};

// ── Fig 2: Logit lens ──
const L=DATA.lens, P=L.layers.map(l=>l.answer_prob), NL=L.layers.length, maxP=Math.max(...P,1e-6);
$("#ls").max=NL-1;
function lsvg(active){const W=380,H=168,pl=34,pb=22,pt=10,pr=10;
  const X=i=>pl+(W-pl-pr)*i/(NL-1), Y=p=>H-pb-(H-pb-pt)*(p/(maxP*1.08));let s="";
  for(const g of [0,0.05,0.1,0.15,0.2]) if(g<=maxP*1.08) s+=`<line class="gridline" x1="${pl}" x2="${W-pr}" y1="${Y(g)}" y2="${Y(g)}"/><text x="4" y="${Y(g)+3}">${g}</text>`;
  s+=`<polyline fill="none" stroke="var(--teal)" stroke-width="2" points="${P.map((p,i)=>X(i)+","+Y(p)).join(" ")}"/>`;
  if(L.crystallized_at!=null) s+=`<line x1="${X(L.crystallized_at)}" x2="${X(L.crystallized_at)}" y1="${pt}" y2="${H-pb}" stroke="var(--copper)" stroke-dasharray="3 3" stroke-width="1.5"/><text x="${X(L.crystallized_at)+4}" y="${pt+8}" fill="var(--copper)">top-1</text>`;
  P.forEach((p,i)=>s+=`<circle cx="${X(i)}" cy="${Y(p)}" r="${i===active?6:2.5}" fill="var(--teal)" ${i===active?'stroke="var(--card)" stroke-width="2"':""}/>`);
  return s+`<text x="${pl}" y="${H-5}">emb</text><text x="${W-pr-12}" y="${H-5}">L${NL-1}</text>`;}
function drawL(){const i=+$("#ls").value, ly=L.layers[i], hi=Math.max(ly.top[0].prob,1e-6);
  $("#ls-v").textContent=i===0?"emb":"L"+i;
  $("#lbars").innerHTML=ly.top.map(t=>`<span class="rowlbl">${esc(t.token)}</span>
    <div class="track"><div class="fill" style="width:${(t.prob/hi*100).toFixed(1)}%"></div></div><span class="val">${t.prob}</span>`).join("")+
    `<span class="rowlbl" style="color:var(--mut)">${esc(L.answer)}</span><div class="track"><div class="fill" style="width:${(ly.answer_prob/maxP*100).toFixed(1)}%;opacity:.5"></div></div><span class="val">rank ${ly.answer_rank}</span>`;
  $("#lsvg").innerHTML=lsvg(i);}
$("#ls").oninput=drawL;

// ── Fig 3: Patching ──
const PT=DATA.patch, nP=PT.tokens.length;
$("#p3sub").innerHTML=`clean “${esc(PT.clean)}” → <b class="annot">${esc(PT.answer)}</b> · strongest cell: layer ${PT.best.layer}, token <span class="mono">${esc(PT.best.token)}</span> (recovery ${PT.best.recovery})`;
const pe=$("#pheat");pe.style.gridTemplateColumns=`42px repeat(${nP},minmax(16px,1fr))`;
pe.innerHTML=`<div></div>`+PT.tokens.map(t=>`<div class="xlab">${esc(t)}</div>`).join("")+
  PT.recovery.map((row,l)=>`<div class="ylab">L${l}</div>`+row.map((r,p)=>`<div class="cell" data-l="${l}" data-p="${p}" style="background:${heat(Math.max(0,r))}"></div>`).join("")).join("");
pe.addEventListener("mousemove",e=>{const c=e.target.closest(".cell");if(!c)return hideTip();
  showTip(e,`layer ${c.dataset.l} · ${JSON.stringify(PT.tokens[+c.dataset.p])} → recovery ${PT.recovery[+c.dataset.l][+c.dataset.p]}`);});
pe.addEventListener("mouseleave",hideTip);

// ── Fig 4: Steering ──
const S=DATA.steer, alphas=S.sweep.map(x=>x.alpha), maxA=Math.max(...alphas);
$("#snote").innerHTML=`concept <b class="annot">${esc(S.concept)}</b> at layer ${S.layer} · ‖v‖=${S.vector_norm}. Same seed every run — only the injected vector changes.`;
$("#aseg").innerHTML=S.sweep.map((x,i)=>`<button data-i="${i}" aria-pressed="${i===0}">α ${x.alpha}</button>`).join("");
$("#aband").style.left=(10/maxA*100)+"%";$("#aband").style.width=((20-10)/maxA*100)+"%";$("#ablbl").style.left=(10/maxA*100)+"%";
function drawS(i){[...$("#aseg").children].forEach((b,j)=>b.setAttribute("aria-pressed",j===i));
  $("#adot").style.left=(alphas[i]/maxA*100)+"%";
  $("#stext").innerHTML=`<span class="lead">${esc(S.baseline_prompt)}</span> ${esc(S.sweep[i].text)}`;}
$("#aseg").addEventListener("click",e=>{const b=e.target.closest("button");if(b)drawS(+b.dataset.i);});
drawS(0);

// ── Fig 5: Induction ──
const A=DATA.attention, G=A.best_head_grid, gn=G.length;
$("#a5sub").innerHTML=`attention pattern · ${esc(A.best_head)} (hover)`;
const cv=$("#attn"),ctx=cv.getContext("2d");
function drawA(){const img=ctx.createImageData(gn,gn);
  for(let i=0;i<gn;i++)for(let j=0;j<gn;j++){const c=heat(Math.min(1,G[i][j]/0.35)).match(/\d+/g).map(Number),o=(i*gn+j)*4;
    img.data[o]=c[0];img.data[o+1]=c[1];img.data[o+2]=c[2];img.data[o+3]=255;}ctx.putImageData(img,0,0);}
cv.addEventListener("mousemove",e=>{const r=cv.getBoundingClientRect(),j=Math.floor((e.clientX-r.left)/r.width*gn),i=Math.floor((e.clientY-r.top)/r.height*gn);
  if(G[i]&&G[i][j]!=null)showTip(e,`from token ${i} → token ${j}: ${G[i][j]}`);});
cv.addEventListener("mouseleave",hideTip);
const hHi=A.top_heads[0].induction_score;
$("#hbars").innerHTML=A.top_heads.map(h=>`<span class="rowlbl">${h.head}</span>
  <div class="track"><div class="fill" style="width:${(h.induction_score/hHi*100).toFixed(1)}%"></div></div><span class="val">${h.induction_score}</span>`).join("");

// ── Fig 6: Ablation ──
const AB=DATA.ablation;
$("#absub").innerHTML=`predicting <b class="annot">${esc(AB.predicted)}</b> from the layer-${AB.layer} MLP (${AB.n_neurons} neurons)`;
$("#abgauge").style.width=Math.max(2,AB.concentration*100).toFixed(1)+"%";
$("#abgnote").innerHTML=`Effectively <b>${AB.effective_neurons}</b> of ${AB.n_neurons} neurons carry it (participation ratio) — `+
  `${AB.effective_neurons<20?"highly localized":AB.effective_neurons<100?"moderately localized":"broadly superposed"}.`;
const abHi=Math.max(...AB.top_neurons.map(n=>Math.abs(n.attribution)))||1;
$("#abbars").innerHTML=AB.top_neurons.map(n=>`<span class="rowlbl" title="ablating shifts logit by ${n.ablation_delta_logit}">#${n.neuron}</span>
  <div class="track"><div class="fill ${n.attribution<0?"neg":""}" style="width:${(Math.abs(n.attribution)/abHi*100).toFixed(1)}%"></div></div>
  <span class="val">${n.attribution>=0?"+":""}${n.attribution}</span>`).join("");

// ── Fig 7: Knockout ──
const KO=DATA.knockout;
$("#kosub").innerHTML=`baseline logit(${esc(KO.answer.trim())}) − logit(${esc(KO.foil.trim())}) = ${KO.baseline_logit_diff} · most causal head: <b class="annot">${KO.top_heads[0].head}</b> (${KO.top_heads[0].importance})`;
const koAbs=Math.max(...KO.importance.flat().map(Math.abs))||1, ke=$("#koheat");
ke.style.gridTemplateColumns=`34px repeat(${KO.n_head},minmax(15px,1fr))`;
ke.innerHTML=`<div></div>`+Array.from({length:KO.n_head},(_,h)=>`<div class="xlab">H${h}</div>`).join("")+
  KO.importance.map((row,l)=>`<div class="ylab">L${l}</div>`+row.map((v,h)=>`<div class="cell" data-l="${l}" data-h="${h}" style="background:${diverge(v/koAbs)}"></div>`).join("")).join("");
ke.addEventListener("mousemove",e=>{const c=e.target.closest(".cell");if(!c)return hideTip();
  const v=KO.importance[+c.dataset.l][+c.dataset.h];showTip(e,`L${c.dataset.l}.H${c.dataset.h} · ${v>=0?"supports +":"opposes "}${v}`);});
ke.addEventListener("mouseleave",hideTip);
const koHi=Math.max(...KO.top_heads.map(h=>Math.abs(h.importance)))||1;
$("#kobars").innerHTML=KO.top_heads.map(h=>`<span class="rowlbl">${h.head}</span>
  <div class="track"><div class="fill ${h.importance<0?"neg":""}" style="width:${(Math.abs(h.importance)/koHi*100).toFixed(1)}%"></div></div>
  <span class="val">${h.importance>=0?"+":""}${h.importance}</span>`).join("");

// ── Fig 8: Multi-hop reasoning ──
const R=DATA.reasoning, RL=R.layers, nR=RL.length;
const rMax=Math.max(...RL.map(l=>Math.max(l.bridge_prob,l.answer_prob)),1e-4);
$("#r8sub").innerHTML=`“${esc(R.prompt)}” · bridge <b class="mono">${esc(R.bridge)}</b> → answer <b class="mono">${esc(R.answer)}</b> · `+
  (R.multihop_signature?`<span class="pill ok">multi-hop signature</span>`:`<span class="pill warn">no clean signature</span>`);
function rsvg(){const W=640,H=250,l=46,r=14,t=14,b=32;
  const X=i=>l+(W-l-r)*i/(nR-1), Y=p=>H-b-(H-b-t)*p/(rMax*1.08);let s="";
  for(const g of [0,rMax/2,rMax]){s+=`<line class="gridline" x1="${l}" x2="${W-r}" y1="${Y(g)}" y2="${Y(g)}"/><text x="${l-6}" y="${Y(g)+3}" text-anchor="end">${g.toFixed(3)}</text>`;}
  const line=(key,col)=>`<polyline fill="none" stroke="${col}" stroke-width="2.5" points="${RL.map((v,i)=>X(i)+","+Y(v[key])).join(" ")}"/>`+
    RL.map((v,i)=>`<circle cx="${X(i)}" cy="${Y(v[key])}" r="2.5" fill="${col}" data-t="layer ${v.layer}: ${key==='bridge_prob'?esc(R.bridge):esc(R.answer)} p=${v[key]} (rank ${key==='bridge_prob'?v.bridge_rank:v.answer_rank})"></circle>`).join("");
  s+=line("bridge_prob",css("--indigo"))+line("answer_prob",css("--teal"));
  // peak markers
  s+=`<line x1="${X(R.bridge_peak_layer)}" x2="${X(R.bridge_peak_layer)}" y1="${t}" y2="${H-b}" stroke="var(--indigo)" stroke-dasharray="3 3" stroke-width="1"/>`;
  s+=`<line x1="${X(R.answer_peak_layer)}" x2="${X(R.answer_peak_layer)}" y1="${t}" y2="${H-b}" stroke="var(--teal)" stroke-dasharray="3 3" stroke-width="1"/>`;
  s+=`<text x="${l}" y="${H-8}">L0</text><text x="${W-r}" y="${H-8}" text-anchor="end">L${nR-1}</text>`;
  s+=`<text x="14" y="${t+6}" transform="rotate(-90 14 ${H/2})" text-anchor="middle">probability</text>`;return s;}
function drawR(){$("#rsvg").innerHTML=rsvg();
  $("#rsvg").querySelectorAll("circle").forEach(c=>{c.onmousemove=(e)=>showTip(e,c.dataset.t);c.onmouseleave=hideTip;});}
$("#rnote").innerHTML = R.interpretation.map(esc).join(" ");

function render(){drawJ();drawL();drawA();drawR();
  $("#pheat").querySelectorAll(".cell").forEach(c=>c.style.background=heat(Math.max(0,PT.recovery[+c.dataset.l][+c.dataset.p])));
  $("#koheat").querySelectorAll(".cell").forEach(c=>c.style.background=diverge(KO.importance[+c.dataset.l][+c.dataset.h]/koAbs));}
render();
new MutationObserver(render).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});
</script>
"""


def render_interactive(model_name: str, results: dict[str, Any], elapsed_s: float) -> str:
    """One report run -> a self-contained, explorable HTML page."""
    payload = json.dumps(results).replace("</", "<\\/")  # never close the script tag early
    return (TEMPLATE
            .replace("__DATA__", payload)
            .replace("__MODEL__", model_name)
            .replace("__ELAPSED__", f"{elapsed_s:.2f}"))


# ─── probes.py interactive report ────────────────────────────────────────────

PROBES_TEMPLATE = r"""<!doctype html><meta charset="utf-8">
<title>Model Mind Lab — probes — __MODEL__</title>
<style>
  :root{
    --paper:#FBFBF9;--card:#FFFFFF;--ink:#1B1F23;--mut:#68707A;--line:#E7E5E0;--grid:#EEEDE9;
    --teal:#0D9488;--indigo:#6D4AC4;--copper:#B45309;--focus:#0D9488;
    --heatLo:230,244,241;--heatHi:11,93,84;
    --serif:"Iowan Old Style","Palatino Nova",Palatino,Georgia,serif;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,monospace;
  }
  @media (prefers-color-scheme:dark){:root{
    --paper:#16191C;--card:#1D2125;--ink:#E8EAEA;--mut:#99A1A8;--line:#2A2F34;--grid:#23282C;
    --teal:#2FA091;--indigo:#9B7FE8;--copper:#C97F2E;--heatLo:29,41,40;--heatHi:92,213,196;}}
  :root[data-theme="dark"]{--paper:#16191C;--card:#1D2125;--ink:#E8EAEA;--mut:#99A1A8;--line:#2A2F34;--grid:#23282C;--teal:#2FA091;--indigo:#9B7FE8;--copper:#C97F2E;--heatLo:29,41,40;--heatHi:92,213,196;}
  :root[data-theme="light"]{--paper:#FBFBF9;--card:#FFFFFF;--ink:#1B1F23;--mut:#68707A;--line:#E7E5E0;--grid:#EEEDE9;--teal:#0D9488;--indigo:#6D4AC4;--copper:#B45309;--heatLo:230,244,241;--heatHi:11,93,84;}
  *{box-sizing:border-box;margin:0}body{background:var(--paper);color:var(--ink);font:16px/1.62 var(--sans)}
  main{max-width:900px;margin:0 auto;padding:44px 20px 80px}
  .kicker{font-family:var(--mono);font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--teal);font-weight:600}
  h1{font-family:var(--serif);font-size:clamp(28px,5vw,42px);line-height:1.12;letter-spacing:-.015em;text-wrap:balance;font-weight:600;margin-top:10px}
  .meta{display:flex;gap:14px;flex-wrap:wrap;margin-top:16px;color:var(--mut);font-family:var(--mono);font-size:12px}.meta b{color:var(--ink);font-weight:600}
  nav{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--paper) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);margin:30px -20px 0;padding:9px 20px;display:flex;gap:5px;overflow-x:auto}
  nav a{color:var(--mut);text-decoration:none;font-size:12.5px;padding:5px 10px;border-radius:999px;white-space:nowrap}
  nav a:hover,nav a:focus-visible{color:var(--ink);background:var(--card);outline:2px solid transparent}
  section{margin-top:52px;scroll-margin-top:60px}
  .fig{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--teal);font-weight:600}
  h2{font-family:var(--serif);font-size:24px;font-weight:600;margin-top:5px;letter-spacing:-.005em;text-wrap:balance}
  .what{color:var(--mut);font-size:14.5px;max-width:70ch;margin-top:7px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:16px}
  .sub{color:var(--mut);font-size:13.5px}
  .bars{display:grid;grid-template-columns:minmax(90px,auto) 1fr minmax(64px,auto);gap:6px 12px;align-items:center;margin-top:12px;font-variant-numeric:tabular-nums}
  .rowlbl{font-family:var(--mono);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .track{height:12px;background:color-mix(in srgb,var(--line) 55%,transparent);border-radius:4px;position:relative}
  .fill{position:absolute;inset:0 auto 0 0;border-radius:4px;background:var(--teal);min-width:2px}.fill.neg{background:var(--copper)}
  .val{font-family:var(--mono);font-size:12px;color:var(--mut);text-align:right}
  .note{color:var(--mut);font-size:13px;margin-top:12px;max-width:72ch}.annot{color:var(--teal);font-weight:600}
  svg{display:block;width:100%;height:auto;overflow:visible}svg text{font-family:var(--mono);fill:var(--mut)}
  .gridline{stroke:var(--grid);stroke-width:1}
  .heat{display:grid;gap:2px;margin-top:12px}.cell{aspect-ratio:1;border-radius:2px;min-width:0}.cell:hover{outline:2px solid var(--ink);outline-offset:-1px}
  .ylab{font-family:var(--mono);font-size:10px;color:var(--mut);align-self:center;text-align:right;padding-right:5px}
  .pill{display:inline-block;font-family:var(--mono);font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}
  .pill.warn{color:var(--copper);border-color:var(--copper)}.pill.ok{color:var(--teal);border-color:var(--teal)}
  table{border-collapse:collapse;font-size:12.5px;margin-top:8px;font-variant-numeric:tabular-nums;width:100%}
  th,td{text-align:right;padding:4px 9px;border-bottom:1px solid var(--line)}th:first-child,td:first-child{text-align:left}
  th{color:var(--mut);font-weight:600;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.04em}.mono{font-family:var(--mono)}
  .legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--mut);margin-top:10px}.lg{display:inline-flex;align-items:center;gap:6px}.sw{width:11px;height:11px;border-radius:3px}
  #tip{position:fixed;z-index:20;pointer-events:none;background:var(--ink);color:var(--paper);font:12px/1.5 var(--mono);padding:6px 9px;border-radius:6px;opacity:0;transition:opacity .12s;max-width:320px}
  footer{margin-top:64px;border-top:1px solid var(--line);padding-top:18px;color:var(--mut);font-size:13px;max-width:80ch}
</style>
<main>
  <div class="kicker">Splice · Model Mind Lab · probes.py all --interactive</div>
  <h1 id="headline"></h1>
  <div class="meta" id="meta"></div>
  <nav aria-label="Probes"><a href="#p1">1 · Decision geometry</a><a href="#p2">2 · Calibration</a>
    <a href="#p3">3 · Concept transport</a><a href="#p4">4 · Localization</a></nav>

  <section id="p1"><div class="fig">Probe 1 · Decision geometry</div>
    <h2>Splice's instrument, pointed at the model</h2>
    <p class="what">The battery Splice runs over its own action scorer, computed for the model's next-token
    decision: per-token flip distance (embedding-space margin to the boundary) and which deletions flip the
    answer. Hover the tokens.</p>
    <div class="card"><div class="sub" id="g-sub"></div><div id="g-chips" class="legend" style="margin-top:10px"></div>
      <div class="bars" id="g-bars"></div><p class="note" id="g-note"></p></div></section>

  <section id="p2"><div class="fig">Probe 2 · Confidence vs fragility</div>
    <h2>Is the model calibrated to its own fragility?</h2>
    <p class="what">Each dot is a prompt: confidence (x) vs how many single-token deletions flip the answer (y).
    A relationship would mean confidence tracks robustness. Hover any dot.</p>
    <div class="card"><div class="sub" id="c-sub"></div><svg id="c-svg" viewBox="0 0 640 300" role="img" aria-label="confidence vs deletion flips"></svg>
      <p class="note" id="c-note"></p></div></section>

  <section id="p3"><div class="fig">Probe 3 · Concept transport</div>
    <h2>Is a concept one direction, or twelve?</h2>
    <p class="what">The concept vector built at every layer, then compared across layers (cosine). A band-diagonal
    matrix means the direction rotates smoothly with depth. Hover any cell.</p>
    <div class="card"><div class="sub" id="t-sub"></div><div style="overflow-x:auto"><div class="heat" id="t-heat"></div></div>
      <p class="note" id="t-note"></p></div></section>

  <section id="p4"><div class="fig">Probe 4 · Localization</div>
    <h2>Where in the network the fact lives</h2>
    <p class="what">Effective-neuron count (participation ratio) of the prediction at each layer — low = a handful
    of neurons carry it, high = smeared across the layer. Plus the causally important attention heads.</p>
    <div class="card"><div class="sub" id="l-sub"></div>
      <svg id="l-svg" viewBox="0 0 640 240" role="img" aria-label="effective neurons by layer"></svg>
      <p class="note" id="l-note"></p>
      <div class="sub" style="margin-top:14px">most causal attention heads (knockout on the indirect-object task)</div>
      <div class="bars" id="l-heads"></div>
      <div class="legend"><span class="lg"><span class="sw" style="background:var(--teal)"></span>supports the answer</span>
        <span class="lg"><span class="sw" style="background:var(--copper)"></span>opposes it</span></div></div></section>

  <footer id="foot"></footer>
</main>
<div id="tip" role="status"></div>
<script>
const DATA = __DATA__, MODEL = "__MODEL__", ELAPSED = __ELAPSED__;
const $ = (s)=>document.querySelector(s);
const esc = (s)=>{const d=document.createElement("i");d.textContent=String(s);return d.innerHTML;};
const tip = $("#tip");
function showTip(e,t){tip.innerHTML=t;tip.style.opacity=1;const w=tip.offsetWidth;tip.style.left=Math.min(innerWidth-w-8,e.clientX+14)+"px";tip.style.top=(e.clientY+14)+"px";}
function hideTip(){tip.style.opacity=0;}
const css=(v)=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function heat(t){const lo=css("--heatLo").split(",").map(Number),hi=css("--heatHi").split(",").map(Number);t=Math.max(0,Math.min(1,t));const c=lo.map((l,i)=>Math.round(l+(hi[i]-l)*t));return `rgb(${c[0]},${c[1]},${c[2]})`;}

$("#headline").textContent = `Probing how ${MODEL} decides`;
$("#meta").innerHTML = `<span>model <b>${esc(MODEL)}</b></span><span>runtime <b>${ELAPSED.toFixed(1)}s, CPU</b></span><span>method <b>NOVEL.md</b></span><span>scope <b>local weights only</b></span>`;
$("#foot").innerHTML = `<b>Honest scope.</b> Novel syntheses of standard ingredients on locally held weights (${esc(MODEL)}), not new interpretability primitives. Reproduce: <span class="mono">python3 probes.py all --interactive</span>.`;

// Probe 1: geometry
const G=DATA.geometry;
$("#g-sub").innerHTML = `“${esc(G.prompt)}” → <b class="annot">${esc(G.predicted)}</b> over ${esc(G.runner_up)} · margin ${G.margin} · effective dimension ${G.effective_dimension} · ${G.robust_to_deletion?'<span class="pill ok">robust</span>':'<span class="pill warn">fragile</span>'}`;
$("#g-chips").innerHTML = G.per_token.map(t=>{
  const flips=t.deletion_flips, fd=t.flip_distance;
  const bg = flips?`color-mix(in srgb,var(--copper) 55%,var(--card))`:heat(fd!=null?Math.max(0,1-Math.min(1,fd)):0.1);
  return `<span class="pill" style="border-color:transparent;background:${bg}" title="flip distance ${fd}; ${flips?'deleting flips to '+esc(t.deletion_new_top):'deletion keeps the answer'}">${esc(t.token)}</span>`;}).join("");
const withFd = G.per_token.filter(t=>t.flip_distance!=null).sort((a,b)=>a.flip_distance-b.flip_distance).slice(0,6);
const fdHi = Math.max(...withFd.map(t=>t.flip_distance))||1;
$("#g-bars").innerHTML = withFd.map(t=>`<span class="rowlbl">${esc(t.token)}</span>
  <div class="track"><div class="fill ${t.deletion_flips?'neg':''}" style="width:${(t.flip_distance/fdHi*100).toFixed(1)}%"></div></div>
  <span class="val">${t.flip_distance}</span>`).join("");
$("#g-note").innerHTML = G.interpretation.map(esc).join(" ");

// Probe 2: calibration scatter
const C=DATA.calibrate, pts=C.points, maxF=Math.max(...pts.map(p=>p.deletion_flips),1), xMax=Math.max(...pts.map(p=>p.confidence),0.1)*1.05;
$("#c-sub").innerHTML = `${C.prompts} prompts · confidence↔margin r = <b>${C.confidence_vs_margin_r}</b> · confidence↔flip-distance r = <b>${C.confidence_vs_flipdist_r}</b>`;
function scatter(){const W=640,H=300,l=46,r=16,t=14,b=40;
  const X=c=>l+(W-l-r)*c/xMax, Y=f=>H-b-(H-b-t)*f/maxF;let s="";
  for(let f=0;f<=maxF;f+=Math.ceil(maxF/5)){s+=`<line class="gridline" x1="${l}" x2="${W-r}" y1="${Y(f)}" y2="${Y(f)}"/><text x="${l-6}" y="${Y(f)+3}" text-anchor="end">${f}</text>`;}
  s+=`<text x="${l}" y="${H-8}">conf 0</text><text x="${W-r}" y="${H-8}" text-anchor="end">${xMax.toFixed(2)}</text>`;
  s+=`<text x="14" y="${t+6}" transform="rotate(-90 14 ${H/2})" text-anchor="middle">deletion flips</text>`;
  pts.forEach((p,i)=>{const jit=((i*53)%9-4)*1.1;
    s+=`<circle cx="${X(p.confidence)}" cy="${Y(p.deletion_flips)+jit}" r="4" fill="var(--copper)" fill-opacity="0.55" data-t="${esc(p.prompt)} → ${esc(p.predicted)} · conf ${p.confidence} · ${p.deletion_flips} flips"></circle>`;});
  return s;}
function drawScatter(){$("#c-svg").innerHTML=scatter();
  $("#c-svg").querySelectorAll("circle").forEach(c=>{c.onmousemove=(e)=>showTip(e,c.dataset.t);c.onmouseleave=hideTip;});}
$("#c-note").innerHTML = C.interpretation.map(esc).join(" ");

// Probe 3: transport alignment matrix
const T=DATA.transport, AL=T.alignment, nL=AL.length;
$("#t-sub").innerHTML = `concept <b class="annot">${esc(T.concept)}</b> · mean adjacent-layer cosine ${T.mean_adjacent_alignment} · promotes: ${esc((T.concept_tokens||[]).slice(0,5).join(", "))}`;
const th=$("#t-heat");th.style.gridTemplateColumns=`30px repeat(${nL},minmax(15px,1fr))`;
th.innerHTML=`<div></div>`+AL.map((_,j)=>`<div class="ylab" style="writing-mode:vertical-rl;transform:rotate(180deg);text-align:left">L${j}</div>`).join("")+
  AL.map((row,i)=>`<div class="ylab">L${i}</div>`+row.map((v,j)=>`<div class="cell" data-i="${i}" data-j="${j}" style="background:${heat(Math.max(0,v))}"></div>`).join("")).join("");
th.addEventListener("mousemove",e=>{const c=e.target.closest(".cell");if(!c)return hideTip();showTip(e,`cos(v_L${c.dataset.i}, v_L${c.dataset.j}) = ${AL[+c.dataset.i][+c.dataset.j]}`);});
th.addEventListener("mouseleave",hideTip);
$("#t-note").innerHTML = T.interpretation.map(esc).join(" ");

// Probe 4: localization profile + heads
const Lz=DATA.localization, eff=Lz.per_layer.map(p=>p.effective_neurons), nLz=eff.length, maxE=Math.max(...eff);
$("#l-sub").innerHTML = `predicting <b class="annot">${esc(Lz.predicted)}</b> · ${Lz.n_neurons_per_layer} neurons/layer · most localized at layer ${Lz.most_localized_layer.layer} (${Lz.most_localized_layer.effective_neurons} effective)`;
function locSvg(){const W=640,H=240,l=46,r=14,t=14,b=32;
  const X=i=>l+(W-l-r)*i/(nLz-1),Y=v=>H-b-(H-b-t)*v/(maxE*1.05);let s="";
  for(const g of [0,Math.round(maxE/2),Math.round(maxE)]) s+=`<line class="gridline" x1="${l}" x2="${W-r}" y1="${Y(g)}" y2="${Y(g)}"/><text x="${l-6}" y="${Y(g)+3}" text-anchor="end">${g}</text>`;
  s+=`<polyline fill="none" stroke="var(--teal)" stroke-width="2.5" points="${eff.map((v,i)=>X(i)+","+Y(v)).join(" ")}"/>`;
  eff.forEach((v,i)=>s+=`<circle cx="${X(i)}" cy="${Y(v)}" r="3.5" fill="var(--teal)" data-t="layer ${i}: ${v} effective neurons"></circle>`);
  s+=`<text x="${l}" y="${H-8}">L0 (input)</text><text x="${W-r}" y="${H-8}" text-anchor="end">L${nLz-1} (output)</text>`;
  s+=`<text x="14" y="${t+6}" transform="rotate(-90 14 ${H/2})" text-anchor="middle">effective neurons</text>`;return s;}
function drawLoc(){$("#l-svg").innerHTML=locSvg();
  $("#l-svg").querySelectorAll("circle").forEach(c=>{c.onmousemove=(e)=>showTip(e,c.dataset.t);c.onmouseleave=hideTip;});}
const hHi=Math.max(...Lz.top_causal_heads.map(h=>Math.abs(h.importance)))||1;
$("#l-heads").innerHTML=Lz.top_causal_heads.map(h=>`<span class="rowlbl">${h.head}</span>
  <div class="track"><div class="fill ${h.importance<0?'neg':''}" style="width:${(Math.abs(h.importance)/hHi*100).toFixed(1)}%"></div></div>
  <span class="val">${h.importance>=0?'+':''}${h.importance}</span>`).join("");
$("#l-note").innerHTML = Lz.interpretation.map(esc).join(" ");

function render(){drawScatter();drawLoc();
  $("#t-heat").querySelectorAll(".cell").forEach(c=>c.style.background=heat(Math.max(0,AL[+c.dataset.i][+c.dataset.j])));
  // g-chips + heat re-tint on theme change
  $("#g-chips").innerHTML=$("#g-chips").innerHTML;}
render();
new MutationObserver(()=>{drawScatter();drawLoc();$("#t-heat").querySelectorAll(".cell").forEach(c=>c.style.background=heat(Math.max(0,AL[+c.dataset.i][+c.dataset.j])));
  $("#g-chips").querySelectorAll(".pill").forEach((p,idx)=>{const t=G.per_token[idx];p.style.background=t.deletion_flips?`color-mix(in srgb,var(--copper) 55%,var(--card))`:heat(t.flip_distance!=null?Math.max(0,1-Math.min(1,t.flip_distance)):0.1);});
}).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});
</script>
"""


def render_probes_interactive(model_name: str, results: dict[str, Any], elapsed_s: float) -> str:
    """One `probes.py all` run -> a self-contained, explorable HTML page."""
    payload = json.dumps(results).replace("</", "<\\/")
    return (PROBES_TEMPLATE
            .replace("__DATA__", payload)
            .replace("__MODEL__", model_name)
            .replace("__ELAPSED__", f"{elapsed_s:.2f}"))
