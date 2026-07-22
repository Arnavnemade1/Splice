/* Splice research page — renders the Model Mind Lab data as live visualizations
   on the site's cinematic-dark palette. All data is embedded (no fetch). */
(() => {
  const DATA = JSON.parse(document.getElementById('rdata').textContent);
  const $ = (s) => document.querySelector(s);
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => { const d = document.createElement('i'); d.textContent = String(s); return d.innerHTML; };
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const tip = $('#rtip');
  const showTip = (e, t) => { tip.innerHTML = t; tip.style.opacity = 1; const w = tip.offsetWidth;
    tip.style.left = Math.min(innerWidth - w - 8, e.clientX + 14) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; };
  const hideTip = () => { tip.style.opacity = 0; };
  const pM = (p) => p >= 1000 ? (p / 1000).toFixed(p % 1000 ? 1 : 0) + 'B' : p + 'M';
  // sequential teal heat on the dark ground
  function heat(t) { t = Math.max(0, Math.min(1, t)); return `rgba(103,232,195,${(0.05 + 0.85 * t).toFixed(3)})`; }
  // diverging: amber (neg) ↔ faint ↔ teal (pos)
  function diverge(t) { const a = Math.min(1, Math.abs(t));
    return t >= 0 ? `rgba(103,232,195,${(0.06 + 0.8 * a).toFixed(3)})` : `rgba(244,176,106,${(0.06 + 0.8 * a).toFixed(3)})`; }

  // ── Models lineup ──
  (function models() {
    const wrap = $('#models');
    const fams = [['GPT-2', 'trained separately per size'], ['Pythia', 'one recipe, a true scale ladder']];
    const maxP = Math.max(...DATA.models.map(m => m.params));
    fams.forEach(([fam, note]) => {
      const rows = DATA.models.filter(m => m.family === fam).map(m => `
        <div class="modelrow">
          <span class="mname">${esc(m.name)}</span>
          <div class="mbar"><i style="width:${Math.max(4, Math.sqrt(m.params / maxP) * 100).toFixed(1)}%"></i></div>
          <span class="mval">${pM(m.params)}</span>
        </div>`).join('');
      wrap.appendChild(el(`<div><div class="fam-label"><span>${esc(fam)}</span><span>${esc(note)}</span></div>${rows}</div>`));
    });
  })();

  // ── The lab: 8 experiments ──
  const M = DATA.mlab;
  const experiments = [
    { id: 'jacobian', name: 'Jacobian', title: 'Which words carry the prediction',
      what: '∂ logit / ∂ input-embedding, by autograd — the local linear map of the whole network. Darker tokens have more leverage over the prediction.',
      note: 'The model-side sibling of the exact Jacobian Splice reads off its own action scorer.',
      render: renderJacobian },
    { id: 'lens', name: 'Logit lens', title: 'The answer crystallizing, layer by layer',
      what: 'The residual stream after each block, decoded through the model\'s own readout. Drag the scrubber to watch the prediction form.',
      note: 'Early layers guess syntax; the answer snaps to top-1 only in the late layers.',
      render: renderLens },
    { id: 'patch', name: 'Patching', title: 'Where the computation lives',
      what: 'Swap the clean run\'s residual stream into a corrupted run, one (layer × position) cell at a time. Colour = how much of the right answer returns.',
      note: 'Causal tracing on the indirect-object task — the bright cells localize the circuit.',
      render: renderPatch },
    { id: 'steer', name: 'Injection', title: 'Pushing a concept into the stream',
      what: 'A concept vector (concept minus control prompts) added during generation. Step the strength: nothing, drift, a sweet spot where it surfaces, then dissolution.',
      note: 'The protocol behind Anthropic\'s concept-injection introspection experiments.',
      render: renderSteer },
    { id: 'attention', name: 'Induction', title: 'The machinery of in-context learning',
      what: 'A repeated random sequence. Induction heads attend from each token back to the one after its previous occurrence — the off-diagonal stripe.',
      note: 'Recovers the documented induction heads that implement in-context learning.',
      render: renderAttention },
    { id: 'ablation', name: 'Ablation', title: 'How distributed is the fact?',
      what: 'Attribution = activation × gradient for every MLP neuron; the top few are confirmed by actually zeroing them. The gauge is the effective number of neurons carrying the prediction.',
      note: 'A superposition measure: is a fact localized to a handful of neurons or smeared across thousands?',
      render: renderAblation },
    { id: 'knockout', name: 'Knockout', title: 'Which heads cause the answer',
      what: 'Every attention head is zeroed one at a time and the answer\'s logit lead re-measured. Teal heads support the answer; amber heads oppose it.',
      note: 'The causal complement to the induction scan — recovers the name-mover and negative heads.',
      render: renderKnockout },
    { id: 'reasoning', name: 'Reasoning', title: 'Watching a two-step thought form',
      what: 'A two-hop question (Dallas → its state → that state\'s capital). If the model reasons internally, the intermediate bridge concept rises in the middle layers before the answer — even though the bridge is never the output.',
      note: 'On gpt2-large the bridge (Texas) peaks in the mid-layers before the answer (Austin) — the internal two-step, visible. gpt2-small shows no such signature.',
      render: renderReasoning },
  ];

  const tabsEl = $('#tabs');
  experiments.forEach((x, i) => {
    const b = el(`<button class="tab" role="tab" aria-selected="${i === 0}" id="tab-${x.id}"><span class="tnum">${String(i + 1).padStart(2, '0')}</span>${esc(x.name)}</button>`);
    b.addEventListener('click', () => select(i));
    tabsEl.appendChild(b);
  });
  function select(i) {
    experiments.forEach((x, j) => document.getElementById('tab-' + x.id).setAttribute('aria-selected', j === i));
    const x = experiments[i];
    $('#figtitle').textContent = x.title;
    $('#figwhat').textContent = x.what;
    $('#fignote').textContent = x.note;
    const body = $('#figbody'); body.innerHTML = '';
    x.render(body);
  }

  const clean = (s) => String(s).replace(/[|].*$/, '').trim();

  function renderJacobian(body) {
    const J = M.jacobian, mag = J.saliency.map(Math.abs), hi = Math.max(...mag) || 1;
    const chips = el('<div class="chips"></div>');
    J.tokens.forEach((t, i) => {
      const s = mag[i] / hi;
      const c = el(`<span class="chip" style="background:${heat(s * 0.92)};${s > 0.5 ? 'color:#05221b;border-color:transparent' : ''}">${esc(t)}</span>`);
      c.addEventListener('mousemove', (e) => showTip(e, `${JSON.stringify(t)} · ‖∂/∂emb‖ ${J.saliency[i]}`));
      c.addEventListener('mouseleave', hideTip); chips.appendChild(c);
    });
    chips.appendChild(el(`<span class="chip pred-chip">→ ${esc(J.predicted)} (p=${J.predicted_prob})</span>`));
    body.appendChild(chips);
    const order = [...J.tokens.keys()].sort((a, b) => mag[b] - mag[a]).slice(0, 6);
    body.appendChild(el(`<div class="bars">${order.map(i => `<span class="rowlbl">${esc(J.tokens[i])}</span><div class="track"><div class="fill" style="width:${(mag[i] / hi * 100).toFixed(1)}%"></div></div><span class="val">${J.saliency[i]}</span>`).join('')}</div>`));
  }

  function renderLens(body) {
    const L = M.lens, P = L.layers.map(l => l.answer_prob), NL = L.layers.length, maxP = Math.max(...P, 1e-4);
    const wrap = el(`<div><label class="rowlbl" style="color:var(--ink-2)">layer <b id="lv" style="color:#fff">emb</b> — drag to think</label>
      <input type="range" id="lslider" min="0" max="${NL - 1}" value="0" step="1" style="width:100%;accent-color:var(--accent);margin:8px 0 4px">
      <div class="duo"><div><div class="subline">top guesses at this depth</div><div class="bars" id="lbars"></div></div>
      <div><div class="subline">p(<span style="font-family:var(--mono)">${esc(clean(L.answer))}</span>) through the stack</div><svg id="lsvg" viewBox="0 0 360 170"></svg></div></div></div>`);
    body.appendChild(wrap);
    const X = i => 34 + (360 - 44) * i / (NL - 1), Y = p => 150 - (150 - 12) * (p / (maxP * 1.08));
    function draw() {
      const i = +$('#lslider').value, ly = L.layers[i], hi = Math.max(ly.top[0].prob, 1e-4);
      $('#lv').textContent = i === 0 ? 'emb' : 'L' + i;
      $('#lbars').innerHTML = ly.top.map(t => `<span class="rowlbl">${esc(t.token)}</span><div class="track"><div class="fill" style="width:${(t.prob / hi * 100).toFixed(1)}%"></div></div><span class="val">${t.prob}</span>`).join('');
      let s = '';
      for (const g of [0, 0.1, 0.2, 0.3]) if (g <= maxP * 1.08) s += `<line class="gl" x1="34" x2="350" y1="${Y(g)}" y2="${Y(g)}"/><text x="4" y="${Y(g) + 3}" font-size="9">${g}</text>`;
      s += `<polyline fill="none" stroke="${css('--s-teal')}" stroke-width="2" points="${P.map((p, k) => X(k) + ',' + Y(p)).join(' ')}"/>`;
      if (L.crystallized_at != null) s += `<line x1="${X(L.crystallized_at)}" x2="${X(L.crystallized_at)}" y1="12" y2="150" stroke="${css('--s-amber')}" stroke-dasharray="3 3" stroke-width="1.3"/><text x="${X(L.crystallized_at) + 3}" y="20" fill="${css('--s-amber')}" font-size="9">top-1</text>`;
      s += `<circle cx="${X(i)}" cy="${Y(P[i])}" r="5" fill="${css('--s-teal')}" stroke="var(--bg)" stroke-width="2"/>`;
      s += `<text x="34" y="166" font-size="9">emb</text><text x="338" y="166" font-size="9">L${NL - 1}</text>`;
      $('#lsvg').innerHTML = s;
    }
    $('#lslider').addEventListener('input', draw); draw();
  }

  function renderPatch(body) {
    const P = M.patch, n = P.tokens.length;
    body.appendChild(el(`<div class="subline">clean “${esc(P.clean)}” → <b style="color:var(--s-teal)">${esc(P.answer)}</b> · strongest cell: layer ${P.best.layer}, token <span style="font-family:var(--mono)">${esc(P.best.token)}</span> (recovery ${P.best.recovery})</div>`));
    const heatEl = el(`<div class="heat" style="grid-template-columns:34px repeat(${n},minmax(12px,1fr))"></div>`);
    heatEl.innerHTML = `<div></div>` + P.tokens.map(t => `<div class="xlab">${esc(t)}</div>`).join('') +
      P.recovery.map((row, l) => `<div class="ylab">L${l}</div>` + row.map((r, p) => `<div class="cell" data-l="${l}" data-p="${p}" style="background:${heat(Math.max(0, r))}"></div>`).join('')).join('');
    heatEl.addEventListener('mousemove', e => { const c = e.target.closest('.cell'); if (!c) return hideTip();
      showTip(e, `L${c.dataset.l} · ${JSON.stringify(P.tokens[+c.dataset.p])} → recovery ${P.recovery[+c.dataset.l][+c.dataset.p]}`); });
    heatEl.addEventListener('mouseleave', hideTip);
    body.appendChild(el('<div style="overflow-x:auto;margin-top:14px"></div>')).appendChild(heatEl);
  }

  function renderSteer(body) {
    const S = M.steer, alphas = S.sweep.map(x => x.alpha);
    body.appendChild(el(`<div class="subline">concept <b style="color:var(--s-teal)">${esc(S.concept)}</b> · ‖v‖=${S.vector_norm} · prompt “${esc(S.baseline_prompt)}”</div>`));
    const seg = el(`<div class="seg" style="margin-top:14px">${S.sweep.map((x, i) => `<button data-i="${i}" aria-pressed="${i === 0}">α ${x.alpha}</button>`).join('')}</div>`);
    const quote = el('<p class="steer-quote"></p>');
    const draw = i => { [...seg.children].forEach((b, j) => b.setAttribute('aria-pressed', j === i));
      quote.innerHTML = `<span class="lead">${esc(S.baseline_prompt)}</span> ${esc(S.sweep[i].text)}`; };
    seg.addEventListener('click', e => { const b = e.target.closest('button'); if (b) draw(+b.dataset.i); });
    body.appendChild(seg); body.appendChild(quote); draw(0);
  }

  function renderAttention(body) {
    const A = M.attention, G = A.best_head_grid, gn = G.length;
    const duo = el(`<div class="duo"><div><div class="subline">attention pattern · ${esc(A.best_head)} (hover)</div><canvas id="attncv" width="${gn}" height="${gn}" style="margin-top:10px"></canvas></div>
      <div><div class="subline">prefix-matching score, top heads</div><div class="bars" id="hbars"></div></div></div>`);
    body.appendChild(duo);
    const cv = $('#attncv'), ctx = cv.getContext('2d'), img = ctx.createImageData(gn, gn);
    for (let i = 0; i < gn; i++) for (let j = 0; j < gn; j++) {
      const m = Math.min(1, G[i][j] / 0.35), o = (i * gn + j) * 4;
      img.data[o] = 103; img.data[o + 1] = 232; img.data[o + 2] = 195; img.data[o + 3] = Math.round(20 + 235 * m);
    }
    ctx.putImageData(img, 0, 0);
    cv.addEventListener('mousemove', e => { const r = cv.getBoundingClientRect(), j = Math.floor((e.clientX - r.left) / r.width * gn), i = Math.floor((e.clientY - r.top) / r.height * gn);
      if (G[i] && G[i][j] != null) showTip(e, `token ${i} → token ${j}: ${G[i][j]}`); });
    cv.addEventListener('mouseleave', hideTip);
    const hi = A.top_heads[0].induction_score;
    $('#hbars').innerHTML = A.top_heads.map(h => `<span class="rowlbl">${esc(h.head)}</span><div class="track"><div class="fill" style="width:${(h.induction_score / hi * 100).toFixed(1)}%"></div></div><span class="val">${h.induction_score}</span>`).join('');
  }

  function renderAblation(body) {
    const A = M.ablation, hi = Math.max(...A.top_neurons.map(n => Math.abs(n.attribution))) || 1;
    body.appendChild(el(`<div class="subline">predicting <b style="color:var(--s-teal)">${esc(A.predicted)}</b> from the layer-${A.layer} MLP (${A.n_neurons} neurons)</div>`));
    body.appendChild(el(`<div class="gauge" style="margin-top:12px"><i style="width:${Math.max(2, A.concentration * 100).toFixed(1)}%"></i></div>`));
    body.appendChild(el(`<div class="fignote" style="border:0;padding:0;margin-top:8px;color:var(--ink-2)">Effectively <b style="color:#fff">${A.effective_neurons}</b> of ${A.n_neurons} neurons carry it (participation ratio) — ${A.effective_neurons < 100 ? 'moderately localized' : 'broadly superposed'}.</div>`));
    body.appendChild(el(`<div class="vlegend"><span class="lg"><span class="sw" style="background:var(--s-teal)"></span>supports (ablating lowers it)</span><span class="lg"><span class="sw" style="background:var(--s-amber)"></span>opposes (ablating raises it)</span></div>`));
    body.appendChild(el(`<div class="bars">${A.top_neurons.map(n => `<span class="rowlbl" title="ablation Δlogit ${n.ablation_delta_logit}">#${n.neuron}</span><div class="track"><div class="fill ${n.attribution < 0 ? 'amber' : ''}" style="width:${(Math.abs(n.attribution) / hi * 100).toFixed(1)}%"></div></div><span class="val">${n.attribution >= 0 ? '+' : ''}${n.attribution}</span>`).join('')}</div>`));
  }

  function renderKnockout(body) {
    const K = M.knockout, abs = Math.max(...K.importance.flat().map(Math.abs)) || 1, hi = Math.max(...K.top_heads.map(h => Math.abs(h.importance))) || 1;
    body.appendChild(el(`<div class="subline">baseline logit(${esc(clean(K.answer))}) − logit(${esc(clean(K.foil))}) = ${K.baseline_logit_diff} · most causal head <b style="color:var(--s-teal)">${esc(K.top_heads[0].head)}</b> (${K.top_heads[0].importance})</div>`));
    const heatEl = el(`<div class="heat" style="grid-template-columns:30px repeat(${K.n_head},minmax(10px,1fr))"></div>`);
    heatEl.innerHTML = `<div></div>` + Array.from({ length: K.n_head }, (_, h) => `<div class="xlab">H${h}</div>`).join('') +
      K.importance.map((row, l) => `<div class="ylab">L${l}</div>` + row.map((v, h) => `<div class="cell" data-l="${l}" data-h="${h}" style="background:${diverge(v / abs)}"></div>`).join('')).join('');
    heatEl.addEventListener('mousemove', e => { const c = e.target.closest('.cell'); if (!c) return hideTip();
      const v = K.importance[+c.dataset.l][+c.dataset.h]; showTip(e, `L${c.dataset.l}.H${c.dataset.h} · ${v >= 0 ? 'supports +' : 'opposes '}${v}`); });
    heatEl.addEventListener('mouseleave', hideTip);
    body.appendChild(el('<div style="overflow-x:auto;margin-top:14px"></div>')).appendChild(heatEl);
    body.appendChild(el(`<div class="vlegend"><span class="lg"><span class="sw" style="background:var(--s-teal)"></span>supports answer</span><span class="lg"><span class="sw" style="background:var(--s-amber)"></span>opposes answer</span></div>`));
    body.appendChild(el(`<div class="bars">${K.top_heads.map(h => `<span class="rowlbl">${esc(h.head)}</span><div class="track"><div class="fill ${h.importance < 0 ? 'amber' : ''}" style="width:${(Math.abs(h.importance) / hi * 100).toFixed(1)}%"></div></div><span class="val">${h.importance >= 0 ? '+' : ''}${h.importance}</span>`).join('')}</div>`));
  }

  function renderReasoning(body) {
    const R = M.reasoning, RL = R.layers, nR = RL.length, mx = Math.max(...RL.map(l => Math.max(l.bridge_prob, l.answer_prob)), 1e-4);
    body.appendChild(el(`<div class="subline">“${esc(R.prompt)}” · bridge <b style="font-family:var(--mono);color:var(--s-sky)">${esc(clean(R.bridge))}</b> → answer <b style="font-family:var(--mono);color:var(--s-teal)">${esc(clean(R.answer))}</b> · <span class="tag ${R.multihop_signature ? 'ok' : 'warn'}">${R.multihop_signature ? 'multi-hop signature' : 'no clean signature'}</span></div>`));
    body.appendChild(el(`<div class="vlegend"><span class="lg"><span class="sw" style="background:var(--s-sky)"></span>bridge (intermediate step)</span><span class="lg"><span class="sw" style="background:var(--s-teal)"></span>answer</span></div>`));
    const svg = el('<svg viewBox="0 0 640 250" style="margin-top:12px"></svg>');
    const X = i => 46 + (640 - 60) * i / (nR - 1), Y = p => 218 - (218 - 14) * p / (mx * 1.08);
    let s = '';
    for (const g of [0, mx / 2, mx]) s += `<line class="gl" x1="46" x2="626" y1="${Y(g)}" y2="${Y(g)}"/><text x="40" y="${Y(g) + 3}" text-anchor="end" font-size="9">${g.toFixed(3)}</text>`;
    const line = (key, col) => `<polyline fill="none" stroke="${col}" stroke-width="2.5" points="${RL.map((v, i) => X(i) + ',' + Y(v[key])).join(' ')}"/>`;
    s += line('bridge_prob', css('--s-sky')) + line('answer_prob', css('--s-teal'));
    s += `<line x1="${X(R.bridge_peak_layer)}" x2="${X(R.bridge_peak_layer)}" y1="14" y2="218" stroke="${css('--s-sky')}" stroke-dasharray="3 3" stroke-width="1"/><text x="${X(R.bridge_peak_layer) + 3}" y="24" fill="${css('--s-sky')}" font-size="9">bridge peak</text>`;
    s += `<line x1="${X(R.answer_peak_layer)}" x2="${X(R.answer_peak_layer)}" y1="14" y2="218" stroke="${css('--s-teal')}" stroke-dasharray="3 3" stroke-width="1"/>`;
    RL.forEach((v, i) => { s += `<circle cx="${X(i)}" cy="${Y(v.bridge_prob)}" r="2.5" fill="${css('--s-sky')}" data-t="L${v.layer}: ${esc(clean(R.bridge))} p=${v.bridge_prob} (r${v.bridge_rank})"/>`;
      s += `<circle cx="${X(i)}" cy="${Y(v.answer_prob)}" r="2.5" fill="${css('--s-teal')}" data-t="L${v.layer}: ${esc(clean(R.answer))} p=${v.answer_prob} (r${v.answer_rank})"/>`; });
    s += `<text x="46" y="242" font-size="9">L0</text><text x="626" y="242" text-anchor="end" font-size="9">L${nR - 1}</text>`;
    svg.innerHTML = s; body.appendChild(svg);
    svg.querySelectorAll('circle').forEach(c => { c.addEventListener('mousemove', e => showTip(e, c.dataset.t)); c.addEventListener('mouseleave', hideTip); });
    body.appendChild(el(`<div class="keyline">${esc(R.interpretation ? R.interpretation[1] : (R.multihop_signature ? 'The bridge peaks before the answer — the intermediate step surfaces internally before the model commits.' : ''))}</div>`));
  }

  select(0);

  // ── Findings ──
  const S = DATA.scaling, F = $('#findings');

  // Finding 1: scale buys confidence, not robustness (family toggle)
  (function f1() {
    const card = el(`<div class="finding">
      <h3>Scale buys confidence, not robustness</h3>
      <p class="lead-in">From the smallest model to the largest, mean confidence and decision margins roughly double — yet not one prediction survives every single-token deletion, at any size. Bigger, surer models are just as flippable.</p>
      <div class="fam-toggle seg" id="f1seg"><button data-f="gpt2" aria-pressed="true">GPT-2 family</button><button data-f="pythia" aria-pressed="false">Pythia ladder</button></div>
      <svg id="f1svg" viewBox="0 0 640 250"></svg>
      <div style="overflow-x:auto"><table class="findtable" id="f1tbl"></table></div>
      <div class="keyline">On both families, up to 1B parameters: confidence climbs, robustness doesn't. A model's certainty is not a proxy for how robust its decision is — which is exactly why external verification doesn't become unnecessary as models grow.</div>
    </div>`);
    F.appendChild(card);
    const trends = { gpt2: S.calibration_gpt2, pythia: S.calibration_pythia };
    function draw(fam) {
      [...card.querySelectorAll('#f1seg button')].forEach(b => b.setAttribute('aria-pressed', b.dataset.f === fam));
      const T = trends[fam], base = T[0];
      const series = [
        { key: 'mean_confidence', col: css('--s-teal'), lbl: 'confidence' },
        { key: 'mean_margin', col: css('--s-sky'), lbl: 'margin' },
        { key: 'mean_flips', col: css('--s-amber'), lbl: 'fragility' },
      ].map(s => ({ ...s, idx: T.map(m => m[s.key] / base[s.key]) }));
      const xs = T.map(m => Math.log10(m.params * 1e6)), xmin = Math.min(...xs) - 0.05, xmax = Math.max(...xs) + 0.05;
      const ymax = Math.max(2.2, ...series.flatMap(s => s.idx)) ;
      const X = v => 46 + (640 - 90) * (v - xmin) / (xmax - xmin), Y = v => 214 - (214 - 16) * (v - 0.8) / (ymax - 0.8);
      let s = '';
      for (const g of [1, 1.5, 2]) s += `<line class="gl" x1="46" x2="606" y1="${Y(g)}" y2="${Y(g)}"/><text x="40" y="${Y(g) + 3}" text-anchor="end" font-size="9">${g}×</text>`;
      s += `<line x1="46" x2="606" y1="${Y(1)}" y2="${Y(1)}" stroke="var(--line-2)" stroke-dasharray="2 3"/>`;
      T.forEach((m, i) => s += `<text x="${X(xs[i])}" y="232" text-anchor="middle" font-size="9">${esc(m.model.replace('EleutherAI/', '').replace('gpt2', 'GPT-2').replace('distilGPT-2', 'distil'))}</text><text x="${X(xs[i])}" y="243" text-anchor="middle" font-size="8" opacity="0.6">${pM(m.params)}</text>`);
      series.forEach(ser => {
        s += `<polyline fill="none" stroke="${ser.col}" stroke-width="2.5" points="${ser.idx.map((v, i) => X(xs[i]) + ',' + Y(v)).join(' ')}"/>`;
        ser.idx.forEach((v, i) => s += `<circle cx="${X(xs[i])}" cy="${Y(v)}" r="3.5" fill="${ser.col}"/>`);
        const last = ser.idx.length - 1;
        s += `<text x="${X(xs[last]) + 8}" y="${Y(ser.idx[last]) + 3}" fill="${ser.col}" font-size="10" font-weight="600">${ser.idx[last].toFixed(2)}×</text>`;
      });
      card.querySelector('#f1svg').innerHTML = s;
      card.querySelector('#f1tbl').innerHTML = `<tr><th>model</th><th>mean conf.</th><th>mean margin</th><th>fragile @ top conf.</th><th>conf↔robustness r</th></tr>` +
        T.map(m => `<tr><td>${esc(m.model.replace('EleutherAI/', ''))}</td><td class="up">${m.mean_confidence}</td><td class="up">${m.mean_margin}</td><td class="flat">${Math.round(m.fragile * 100)}%</td><td>${m.spearman_conf_flipdist}</td></tr>`).join('');
    }
    card.querySelector('#f1seg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) draw(b.dataset.f); });
    draw('gpt2');
  })();

  // Finding 2: multi-hop reasoning emerges with scale
  (function f2() {
    const R = M.reasoning, RL = R.layers, nR = RL.length, mx = Math.max(...RL.map(l => Math.max(l.bridge_prob, l.answer_prob)), 1e-4);
    const card = el(`<div class="finding">
      <h3>Multi-hop reasoning emerges with scale</h3>
      <p class="lead-in">Asked a two-hop question, gpt2-large computes the intermediate step internally: the bridge concept <span style="font-family:var(--mono);color:var(--s-sky)">${esc(clean(R.bridge))}</span> peaks in the mid-layers, then fades as the answer <span style="font-family:var(--mono);color:var(--s-teal)">${esc(clean(R.answer))}</span> takes over — a two-step thought, visible. gpt2-small shows no such signature; it just pattern-matches.</p>
      <svg id="f2svg" viewBox="0 0 640 240" style="margin-top:8px"></svg>
      <div class="keyline">The capability appears with size — and the internal trace is richer than the output: neither model even says the answer out loud, yet the large one is provably doing the reasoning.</div>
    </div>`);
    F.appendChild(card);
    const X = i => 46 + (640 - 60) * i / (nR - 1), Y = p => 208 - (208 - 14) * p / (mx * 1.08);
    let s = '';
    for (const g of [0, mx / 2, mx]) s += `<line class="gl" x1="46" x2="626" y1="${Y(g)}" y2="${Y(g)}"/><text x="40" y="${Y(g) + 3}" text-anchor="end" font-size="9">${g.toFixed(3)}</text>`;
    s += `<polyline fill="none" stroke="${css('--s-sky')}" stroke-width="2.5" points="${RL.map((v, i) => X(i) + ',' + Y(v.bridge_prob)).join(' ')}"/>`;
    s += `<polyline fill="none" stroke="${css('--s-teal')}" stroke-width="2.5" points="${RL.map((v, i) => X(i) + ',' + Y(v.answer_prob)).join(' ')}"/>`;
    s += `<line x1="${X(R.bridge_peak_layer)}" x2="${X(R.bridge_peak_layer)}" y1="14" y2="208" stroke="${css('--s-sky')}" stroke-dasharray="3 3" stroke-width="1"/><text x="${X(R.bridge_peak_layer) + 3}" y="24" fill="${css('--s-sky')}" font-size="9">bridge peak (L${R.bridge_peak_layer})</text>`;
    s += `<line x1="${X(R.answer_peak_layer)}" x2="${X(R.answer_peak_layer)}" y1="14" y2="208" stroke="${css('--s-teal')}" stroke-dasharray="3 3" stroke-width="1"/><text x="${X(R.answer_peak_layer) - 3}" y="24" text-anchor="end" fill="${css('--s-teal')}" font-size="9">answer peak</text>`;
    s += `<text x="46" y="230" font-size="9">L0 (input)</text><text x="626" y="230" text-anchor="end" font-size="9">L${nR - 1} (output)</text>`;
    card.querySelector('#f2svg').innerHTML = s;
  })();

  // Finding 3: facts are U-shaped and scale-invariant
  (function f3() {
    const G = S.localization_gpt2, card = el(`<div class="finding">
      <h3>Facts are held in a U — and it doesn't move with scale</h3>
      <p class="lead-in">How many neurons carry a fact, layer by layer? The profile is U-shaped: concentrated near the input and output layers, broadly superposed through the middle. And the share of a layer devoted to the fact stays roughly constant (~20%) even as models grow 25× wider and deeper.</p>
      <svg id="f3svg" viewBox="0 0 640 240" style="margin-top:8px"></svg>
      <div class="vlegend" id="f3leg"></div>
      <div class="keyline">Universal U-shape, scale-invariant fractional superposition — bigger models spread facts across proportionally the same slice of a larger layer, not into fewer relative neurons.</div>
    </div>`);
    F.appendChild(card);
    const cols = [css('--s-teal'), css('--s-sky'), css('--s-violet'), css('--s-amber')];
    const shown = G.slice(0, 4);
    const maxLen = Math.max(...shown.map(m => m.per_layer.length));
    const maxV = Math.max(...shown.flatMap(m => m.per_layer));
    const X = (i, len) => 46 + (640 - 60) * i / (len - 1), Y = v => 208 - (208 - 14) * v / (maxV * 1.05);
    let s = '';
    for (const g of [0, Math.round(maxV / 2), Math.round(maxV)]) s += `<line class="gl" x1="46" x2="626" y1="${Y(g)}" y2="${Y(g)}"/><text x="40" y="${Y(g) + 3}" text-anchor="end" font-size="9">${g}</text>`;
    shown.forEach((m, k) => { s += `<polyline fill="none" stroke="${cols[k]}" stroke-width="2" opacity="0.9" points="${m.per_layer.map((v, i) => X(i, m.per_layer.length) + ',' + Y(v)).join(' ')}"/>`; });
    s += `<text x="46" y="230" font-size="9">input →</text><text x="626" y="230" text-anchor="end" font-size="9">→ output</text>`;
    s += `<text x="330" y="230" text-anchor="middle" font-size="9">depth (normalized)</text>`;
    card.querySelector('#f3svg').innerHTML = s;
    card.querySelector('#f3leg').innerHTML = shown.map((m, k) => `<span class="lg"><span class="sw" style="background:${cols[k]}"></span>${esc(m.model)} · ${Math.round(m.mean_fraction * 100)}% of layer</span>`).join('');
  })();
})();
