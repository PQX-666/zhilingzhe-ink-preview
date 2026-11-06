/* =========================================================
   点亮高手训练器 · 应用层
   依赖 data.js（内容数据层）。无框架、无构建、无依赖。
   ========================================================= */
(function () {
  'use strict';

  /* ============ 0. 工具 ============ */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function dayKey(d) { d = d || new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function nowStamp() { var d = new Date(); return dayKey(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function daysBetween(a, b) {
    var x = new Date(String(a).slice(0, 10) + 'T00:00:00');
    var y = new Date(String(b).slice(0, 10) + 'T00:00:00');
    if (isNaN(x) || isNaN(y)) return null;
    return Math.round((y - x) / 86400000);
  }
  function addDays(dateStr, n) {
    var d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return dayKey(d);
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  var DIM_KEYS = DIMS.map(function (d) { return d[0]; });

  /* ============ 1. 存储 ============ */
  var LSKEY = 'trainer.v2';
  var V1KEY = 'pdpTrainer.v1';

  function blankState() {
    return {
      v: 2,
      settings: { model: AI_DEFAULT_MODEL, apiPath: '/api/chat', theme: '' },
      archives: [],
      sessions: [],
      phrases: [],
      drills: {},
      certs: {},
      focus: '',
      createdAt: nowStamp()
    };
  }

  var S = (function () {
    try {
      var raw = localStorage.getItem(LSKEY);
      if (raw) {
        var o = JSON.parse(raw);
        var base = blankState();
        Object.keys(base).forEach(function (k) { if (o[k] === undefined) o[k] = base[k]; });
        return o;
      }
    } catch (e) { }
    return blankState();
  })();

  var saveTimer = null;
  function save(now) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    var run = function () {
      try {
        localStorage.setItem(LSKEY, JSON.stringify(S));
        return true;
      } catch (e) {
        toast('保存失败：浏览器存储可能已满。请先到「设置」导出 JSON 备份。');
        return false;
      }
    };
    if (now) return run();
    saveTimer = setTimeout(run, 260);
    return true;
  }

  /* 只存在于内存的临时状态（刷新即重置，不进 localStorage） */
  var T = {
    tab: 'today',
    chat: null,
    prepId: '',
    prepType: 'tiger',
    manualQ: '',
    flash: null,
    gate: 0,
    match: [null, null, null, null, null]
  };

  /* ============ 2. 提示条 ============ */
  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 2600);
  }

  function confirmBox(msg, onYes, yesLabel) {
    openModal(
      '<h2>确认</h2><p>' + esc(msg) + '</p>' +
      '<div class="row mt"><button class="btn primary" data-act="modal-yes">' + esc(yesLabel || '确定') + '</button>' +
      '<button class="btn ghost" data-act="close-modal">取消</button></div>'
    );
    modalYes = onYes;
  }
  var modalYes = null;

  function openModal(html) {
    var m = $('#modal');
    $('#modal-box').innerHTML = html;
    m.hidden = false;
  }
  function closeModal() {
    $('#modal').hidden = true;
    $('#modal-box').innerHTML = '';
    modalYes = null;
  }

  /* ============ 3. AI ============ */
  function buildSystemPrompt(persona, level, scenes) {
    var parts = [PROMPT_CORE];
    if (persona === 'any') parts.push(PROMPT_PERSONAS_ANY);
    else if (PROMPT_PERSONAS[persona]) parts.push(PROMPT_PERSONAS[persona]);
    parts.push(PROMPT_LEVELS[level] || PROMPT_LEVELS.easy);
    (scenes || []).forEach(function (i) { if (SCENES[i]) parts.push(PROMPT_SCENE(SCENES[i].n)); });
    parts.push(PROMPT_START);
    return parts.join('\n\n');
  }

  function trimHistory(msgs) {
    var max = 44;
    if (msgs.length <= max) return msgs.slice();
    return msgs.slice(msgs.length - max);
  }

  function streamChat(messages, onDelta, onThink) {
    var url = (S.settings.apiPath || '/api/chat').trim();
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: S.settings.model, messages: messages, stream: true })
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var msg = t.slice(0, 400);
          try { var j = JSON.parse(t); if (j.message) msg = j.message; else if (j.error) msg = j.error; } catch (e) { }
          throw new Error('接口返回 ' + res.status + '：' + msg);
        });
      }
      if (!res.body || !res.body.getReader) {
        return res.text().then(function (t) {
          var out = '';
          t.split('\n').forEach(function (line) {
            line = line.trim();
            if (line.indexOf('data:') !== 0) return;
            var d = line.slice(5).trim();
            if (!d || d === '[DONE]') return;
            try {
              var j = JSON.parse(d);
              var c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (c) { out += c; onDelta(c, out); }
            } catch (e) { }
          });
          return out;
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder('utf-8');
      var buf = '';
      var full = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return full;
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          lines.forEach(function (line) {
            line = line.trim();
            if (line.indexOf('data:') !== 0) return;
            var d = line.slice(5).trim();
            if (!d || d === '[DONE]') return;
            try {
              var j = JSON.parse(d);
              var delta = j.choices && j.choices[0] && j.choices[0].delta;
              if (delta && delta.reasoning_content && onThink) onThink(delta.reasoning_content);
              var c = delta && delta.content;
              if (c) { full += c; onDelta(c, full); }
            } catch (e) { }
          });
          return pump();
        });
      }
      return pump();
    });
  }

  /* 复盘解析：从结构化尾行抓六个分数 */
  function parseReview(text) {
    text = String(text || '');
    var dims = {};
    var line = '';
    var m = text.match(/【评分】([^\n]*)/);
    if (m) line = m[1];
    DIM_KEYS.forEach(function (k) {
      var probe = line || text;
      var r = new RegExp(k + '\\s*[=＝:：]\\s*([0-2])(?![0-9])');
      var mm = probe.match(r);
      if (!mm && line) mm = text.match(r);
      if (mm) dims[k] = parseInt(mm[1], 10);
    });
    var imp = '';
    var mi = text.match(/【最该改的一条】\s*([^\n]*)/);
    if (mi) imp = mi[1].replace(/[＿_\s]+/g, ' ').trim();
    var sum = 0, n = 0;
    DIM_KEYS.forEach(function (k) { if (dims[k] != null) { sum += dims[k]; n++; } });
    return { dims: dims, perfect: n === 6, total: n === 6 ? sum : null, improve: imp, raw: text };
  }

  /* ============ 4. 领域计算 ============ */
  function dimAvg(list) {
    var sum = {}, cnt = {};
    DIM_KEYS.forEach(function (k) { sum[k] = 0; cnt[k] = 0; });
    list.forEach(function (s) {
      if (!s.review || !s.review.dims) return;
      DIM_KEYS.forEach(function (k) {
        if (s.review.dims[k] != null) { sum[k] += s.review.dims[k]; cnt[k]++; }
      });
    });
    var out = {};
    DIM_KEYS.forEach(function (k) { out[k] = cnt[k] ? sum[k] / cnt[k] : null; });
    return out;
  }

  function scoredSessions() {
    return S.sessions.filter(function (s) { return s.review && s.review.perfect; });
  }

  function lowStreak() {
    var tail = scoredSessions().slice(-3);
    if (tail.length < 3) return [];
    return DIM_KEYS.filter(function (k) {
      return tail.every(function (s) { return s.review.dims[k] != null && s.review.dims[k] <= 1; });
    });
  }

  function nextTrainingDay() {
    for (var i = 0; i < DAYS.length; i++) {
      if (!S.drills[DAYS[i][0]]) return DAYS[i];
    }
    return null;
  }

  function recommendedDays() {
    var weak = lowStreak();
    var days = [];
    weak.forEach(function (k) {
      (DIM_TO_DAYS[k] || []).forEach(function (d) { if (days.indexOf(d) < 0) days.push(d); });
    });
    return { weak: weak, days: days.slice(0, 3).map(function (d) {
      for (var i = 0; i < DAYS.length; i++) if (DAYS[i][0] === d) return DAYS[i];
      return null;
    }).filter(Boolean) };
  }

  function followBoard() {
    var today = dayKey();
    var out = { overdue: [], due: [], week: [], stop: [], later: [] };
    S.archives.forEach(function (a) {
      var last = a.lastContact ? String(a.lastContact).slice(0, 10) : '';
      var gap = last ? daysBetween(last, today) : null;
      if (gap != null && gap >= 14 && !a.replied && a.result !== '成交') {
        out.stop.push({ a: a, gap: gap });
        return;
      }
      var nf = a.nextFollow ? String(a.nextFollow).slice(0, 10) : '';
      if (!nf) { out.later.push(a); return; }
      var d = daysBetween(today, nf);
      if (d == null) { out.later.push(a); return; }
      if (d < 0) out.overdue.push({ a: a, d: -d });
      else if (d === 0) out.due.push(a);
      else if (d <= 7) out.week.push({ a: a, d: d });
      else out.later.push(a);
    });
    return out;
  }

  function certProgress() {
    var doneDays = Object.keys(S.drills).filter(function (k) { return S.drills[k]; }).length;
    var sess = scoredSessions();
    return {
      doneDays: doneDays,
      totalDays: DAYS.length,
      sessions: S.sessions.length,
      l1: sess.filter(function (s) { return s.review.total >= 8; }).length,
      l2: sess.filter(function (s) {
        var d = s.review.dims;
        return s.review.total >= 10 && d['财务'] >= 1 && d['边界'] >= 1;
      }).length,
      phrases: S.phrases.length
    };
  }

  function trustAssets() {
    return {
      advisedNo: S.archives.filter(function (a) { return a.advisedNo; }).length,
      rejectedKeep: S.archives.filter(function (a) { return a.result === '明确拒绝' && a.keepInTouch; }).length,
      referrals: S.archives.filter(function (a) { return a.src === '转介绍'; }).length,
      refusals: S.archives.filter(function (a) { return a.result === '明确拒绝'; }).length
    };
  }

  function funnelData() {
    var A = S.archives;
    return [
      A.length,
      A.filter(function (a) { return a.deepTalk; }).length,
      A.filter(function (a) { return a.need && a.need.impact; }).length,
      A.filter(function (a) { return num(a.importance) >= 6 && num(a.confidence) >= 6; }).length,
      A.filter(function (a) { return (a.match5 || []).some(function (x) { return x != null && x !== ''; }); }).length,
      A.filter(function (a) { return a.result === '成交'; }).length
    ];
  }

  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  /* ============ 5. 小部件 ============ */
  function statCard(n, label, cls) {
    return '<div class="stat ' + (cls || '') + '"><div class="n">' + esc(n) + '</div><div class="l">' + esc(label) + '</div></div>';
  }
  function bar(pct, cls) {
    return '<div class="bar ' + (cls || '') + '"><i style="width:' + clamp(Math.round(pct), 0, 100) + '%"></i></div>';
  }
  function emptyBox(title, hint) {
    return '<div class="card" style="text-align:center;padding:30px 18px">' +
      '<div class="b" style="margin-bottom:4px">' + esc(title) + '</div>' +
      '<div class="small muted">' + esc(hint || '') + '</div></div>';
  }
  function scoreTag(total) {
    if (total == null) return '<span class="tag">未评分</span>';
    var v = total >= 10 ? 'ok' : (total >= 7 ? 'warn' : 'bad');
    return '<span class="tag ' + v + '">' + total + '/12</span>';
  }
  function typeTag(a) {
    if (!a || !a.type) return '';
    var t = typeOf(a.type);
    return '<span class="tag" style="background:' + t.bg + ';color:' + t.c + '">' + esc(t.n) + '</span>';
  }

  /* ============ 6. 视图：今天 ============ */
  function viewToday() {
    var b = followBoard();
    var tr = nextTrainingDay();
    var rec = recommendedDays();
    var c = certProgress();
    var ta = trustAssets();
    var h = [];

    h.push('<section class="home-hero"><p class="home-kicker">职领者 · 学习与成长</p><h1>学沟通 · 强能力 · 多练习</h1><p>从资料、方法到实战练习<br>陪你一步步成长</p></section>');
    h.push('<section class="home-path"><div class="home-path-head"><div><h2>我的学习路径</h2><p>先了解，再练习，慢慢找到自己的节奏</p></div><span class="home-seal">学</span></div><div class="home-steps"><div><i>一</i><b>找资料</b><small>了解内容</small></div><div><i>二</i><b>看手册</b><small>学习方法</small></div><div><i>三</i><b>开始练习</b><small>用在实战</small></div></div></section>');
    h.push('<section class="home-actions" aria-label="学习入口"><button data-act="tab" data-tab="library"><span class="home-icon"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 10 16 4l12 6-12 6L4 10Zm0 6 12 6 12-6M4 22l12 6 12-6"/></svg></span><strong>找资料</strong><small>话术、流程与实战素材</small><em>›</em></button><button data-act="tab" data-tab="manual"><span class="home-icon"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 27V7C12 4 7 4 3 6v19c5-2 9-2 13 2Zm0 0V7c4-3 9-3 13-1v19c-5-2-9-2-13 2Z"/></svg></span><strong>看手册</strong><small>查方法，找思路</small><em>›</em></button><button class="home-practice" data-act="tab" data-tab="drill"><span class="home-icon"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="14" cy="18" r="10"/><circle cx="14" cy="18" r="5"/><path d="m14 18 12-12m-4 0h4v4"/></svg></span><strong>开始练习</strong><small>练习对话与复盘</small><em>›</em></button></section>');
    h.push('<details class="home-records"' + (T.homeOpen ? ' open' : '') + '><summary>今日训练与我的记录</summary><div class="home-records-body">');
    h.push('<h1>今天</h1>');
    h.push('<p class="sub">' + esc(dayKey() + ' · ' + feedbackLine()) + '</p>');

    /* 只改一条 —— 纪律变成产品约束 */
    var lastScored = scoredSessions().slice(-1)[0];
    h.push('<div class="card accent">' +
      '<div class="tiny muted b" style="letter-spacing:.06em">本阶段只改这一条</div>');
    if (lastScored && (lastScored.review.improve || S.focus)) {
      h.push('<div class="b mt" style="font-size:15px;line-height:1.6">' + esc(S.focus || lastScored.review.improve) + '</div>');
      h.push('<div class="row mt"><button class="btn tiny-btn ghost" data-act="focus-edit">改一下</button>' +
        (lastScored.review.improve ? '<button class="btn tiny-btn ghost" data-act="focus-from-review">用复盘里那条</button>' : '') +
        '<button class="btn tiny-btn ghost" data-act="focus-clear">已完成，清空</button></div>');
    } else {
      h.push('<div class="small muted mt">还没有。练完一场并复盘后，「最该改的一条」会自动钉在这里。</div>');
      h.push('<div class="row mt"><button class="btn tiny-btn ghost" data-act="focus-edit">手动写一条</button></div>');
    }
    h.push('<div class="tiny muted mt">不要一次改三个问题。改到成为习惯，再改下一条。</div>');
    h.push('</div>');

    /* 今日训练 */
    h.push('<h2>今日训练</h2>');
    if (rec.weak.length) {
      h.push('<div class="msg warn">连续 3 场「' + esc(rec.weak.join('、')) + '」都 ≤1 分。先补这几项：</div>');
      rec.days.forEach(function (d) {
        h.push('<div class="card tight"><div class="spread"><div>' +
          '<div class="tiny muted">第 ' + d[0] + ' 天' + (S.drills[d[0]] ? ' · 已完成' : '') + '</div>' +
          '<div class="b">' + esc(d[2]) + '</div>' +
          '<div class="tiny muted mt">达标线：' + esc(d[4]) + '</div>' +
          '</div>' + trainBtn(d) + '</div></div>');
      });
    }
    if (tr) {
      h.push('<div class="card tight"><div class="spread"><div>' +
        '<div class="tiny muted">第 ' + tr[0] + ' 天 · 第 ' + (tr[1] + 1) + ' 周 · ' + esc(WEEKS[tr[1]].idea) + '</div>' +
        '<div class="b">' + esc(tr[2]) + '</div>' +
        '<div class="tiny muted mt">约 ' + tr[3] + ' 分钟 ／ 达标线：' + esc(tr[4]) + '</div>' +
        '</div>' + trainBtn(tr) + '</div></div>');
    } else {
      h.push('<div class="card ok tight b">28 天全部完成。往下走就是真实谈话了。</div>');
    }
    h.push('<details><summary>28 天全景 · 已完成 ' + c.doneDays + ' / ' + c.totalDays + '</summary><div class="body">');
    h.push(bar(c.doneDays / c.totalDays * 100, 'ok'));
    WEEKS.forEach(function (w, wi) {
      var tot = 0, dn = 0;
      DAYS.forEach(function (d) { if (d[1] === wi) { tot++; if (S.drills[d[0]]) dn++; } });
      h.push('<div class="row" style="justify-content:space-between;margin-top:8px"><span class="small b">' + esc(w.t) + '</span><span class="tiny muted">' + dn + '/' + tot + '</span></div>');
      h.push('<div class="chips mt" style="gap:5px">');
      DAYS.forEach(function (d) {
        if (d[1] !== wi) return;
        h.push('<button class="chip' + (S.drills[d[0]] ? '" aria-pressed="true' : '') + '" style="padding:4px 10px;font-size:12px" data-act="day-toggle" data-day="' + d[0] + '">' + d[0] + '</button>');
      });
      h.push('</div>');
      h.push('<div class="tiny muted mt">' + esc(w.tip) + '</div>');
    });
    h.push('<div class="tiny muted mt">' + esc(SIGNAL_WARN) + '</div>');
    h.push('</div></details>');

    /* 跟进看板 */
    h.push('<h2>跟进看板</h2>');
    if (b.stop.length) {
      h.push('<div class="card bad"><div class="b">按纪律，今天起停止主动联系。</div>' +
        '<ul class="dots mt">');
      b.stop.forEach(function (x) {
        h.push('<li>' + esc(x.a.name) + ' · 已 ' + x.gap + ' 天没有回复。不换渠道、不换人联系。不回复就是一个有效的答复。</li>');
      });
      h.push('</ul></div>');
    }
    if (b.overdue.length) {
      h.push('<div class="b small mt">逾期</div>');
      b.overdue.forEach(function (x) { h.push(followRow(x.a, '逾期 ' + x.d + ' 天', 'bad')); });
    }
    if (b.due.length) {
      h.push('<div class="b small mt">今天</div>');
      b.due.forEach(function (a) { h.push(followRow(a, '今天', 'accent')); });
    }
    if (b.week.length) {
      h.push('<div class="b small mt">本周内</div>');
      b.week.forEach(function (x) { h.push(followRow(x.a, x.d + ' 天后', '')); });
    }
    if (!b.overdue.length && !b.due.length && !b.week.length && !b.stop.length) {
      h.push('<div class="card small muted">没有排上日程的跟进。档案里填「下次跟进日」，就会出现在这里。</div>');
    }
    h.push('<div class="card tight"><div class="tiny muted">跟进节奏（手册 23.2）：谈话当天 → 第 2 天 → 约定回访日 → 第 7 天 → <b>第 14 天停止主动联系</b>。没有回复 ≠ 待处理任务。</div></div>');

    /* 认证进度 */
    h.push('<h2>认证进度</h2>');
    h.push('<div class="grid three">' +
      statCard(c.doneDays + '/' + c.totalDays, '训练营天数', 'accent') +
      statCard(c.sessions, '场次记录') +
      statCard(c.l1, '六维 ≥8 分') +
      statCard(c.l2, '六维 ≥10 且财务/边界≥1') +
      statCard(c.phrases, '话术库条数') +
      '</div>');
    CERTS.forEach(function (cert, i) {
      var pct = i === 0 ? (c.doneDays / 24 * 100) : (i === 1 ? (c.l2 / 10 * 100) : 0);
      h.push('<details class="mt"><summary>' + esc(cert.n) + ' <span class="tiny muted">能做：' + esc(cert.can) + '</span></summary><div class="body">');
      h.push(bar(pct, pct >= 100 ? 'ok' : ''));
      h.push('<ul class="dots">');
      cert.items.forEach(function (it) { h.push('<li><b>' + esc(it[0]) + '</b>：' + esc(it[1]) + '</li>'); });
      h.push('</ul></div></details>');
    });
    h.push('<div class="msg warn tiny">' + esc(FALSES_WARN) + '</div>');

    /* 信任资产 */
    h.push('<h2>信任资产</h2>');
    h.push('<p class="tiny muted" style="margin-top:-6px">不显示成交额。这里只看「我有没有变成推销机器」。</p>');
    h.push('<div class="grid three">' +
      statCard(ta.advisedNo, '主动建议「先别报」', 'good') +
      statCard(ta.rejectedKeep, '拒绝后还愿意聊的', 'good') +
      statCard(ta.referrals, '转介绍来源') +
      '</div>');
    h.push('<div class="card tight mt"><div class="tiny muted">' + esc(FUNNEL_HEALTHY) + '</div></div>');
    h.push('</div></details>');

    return h.join('');
  }

  function feedbackLine() {
    var s = S.sessions.length;
    if (!s) return '还没有场次记录';
    return '已记录 ' + s + ' 场';
  }

  function trainBtn(d) {
    var on = !!S.drills[d[0]];
    return '<button class="btn ' + (on ? 'ghost' : 'primary') + ' tiny-btn" data-act="day-toggle" data-day="' + d[0] + '">' +
      (on ? '已完成' : '打卡') + '</button>';
  }

  function followRow(a, label, cls) {
    return '<div class="card tight"><div class="spread"><div style="min-width:0">' +
      '<div class="row" style="gap:6px"><span class="b">' + esc(a.name || '未命名') + '</span>' + typeTag(a) +
      '<span class="tag ' + (cls || '') + '">' + esc(label) + '</span></div>' +
      '<div class="tiny muted mt">' + esc((a.result || '进行中') + (a.nextNote ? ' · ' + a.nextNote : '')) + '</div>' +
      '</div><button class="btn tiny-btn ghost" data-act="open-archive" data-id="' + a.id + '">打开</button></div></div>';
  }

  /* ============ 7. 视图：陪练 ============ */
  function viewDrill() {
    if (T.chat) return viewChat();
    if (T.flash) return viewFlash();
    var h = [];
    h.push('<h1>陪练</h1>');
    h.push('<p class="sub">AI 陪练、20 情境闪电战、真人陪练脚本。这里的每一场都能存成场次记录。</p>');

    h.push('<div class="card accent">' +
      '<div class="b">AI 陪练</div>' +
      '<div class="small muted mt">选人格和难度 → 直接在页面里对话 → 结束时点「一键复盘」，六维分数会自动存好。</div>' +
      (location.hostname.endsWith('.github.io') ? '<div class="small mt">公开试用版暂不支持 AI 陪练；其他练习可正常使用。</div>' : '<div class="row mt"><button class="btn primary" data-act="chat-setup">开始一场</button></div>') +
      '</div>');

    h.push('<div class="card">' +
      '<div class="b">20 情境闪电战</div>' +
      '<div class="small muted mt">不对话，只练条件反射：显示情境 → 30 秒内写下你的第一句 → 对照手册的标准处理。</div>' +
      '<div class="row mt"><button class="btn" data-act="flash-start">开始</button></div>' +
      '</div>');

    h.push('<h2>真人陪练脚本</h2>');
    h.push('<p class="tiny muted" style="margin-top:-6px">找同学照着念。练完按「出戏四步」复盘——第 4 步的「只挑一处」是硬规则。</p>');
    SCRIPTS.forEach(function (s) {
      var ty = typeOf(s.k);
      h.push('<details><summary>' + esc(s.title) + '</summary><div class="body">');
      h.push('<div class="small"><b>角色：</b>' + esc(s.role) + '</div>');
      h.push('<div class="b small mt">扮演规则</div><ul class="dots">');
      s.rules.forEach(function (r) { h.push('<li>' + esc(r) + '</li>'); });
      h.push('</ul>');
      h.push('<div class="b small">三档难度</div><div class="tw"><table><tr><th>难度</th><th>怎么演</th></tr>');
      s.levels.forEach(function (l) { h.push('<tr><td>' + esc(l[0]) + '</td><td>' + esc(l[1]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="b small">他会用的拒绝话</div><ul class="dots">');
      s.refuse.forEach(function (r, i) { h.push('<li>' + esc(r) + (s.warn && i === 4 ? ' <span class="tag warn">陷阱</span>' : '') + '</li>'); });
      h.push('</ul>');
      if (s.warn) h.push('<div class="msg warn">' + esc(s.warn) + '</div>');
      h.push('<div class="msg info">通过标准：' + esc(s.goal) + '</div>');
      h.push('</div></details>');
    });

    h.push('<h2>出戏四步</h2>');
    h.push('<div class="card"><ol style="margin:0;padding-left:19px;font-size:13.5px">');
    OUT_OF_ROLE.forEach(function (s) { h.push('<li style="margin-bottom:6px">' + esc(s) + '</li>'); });
    h.push('</ol><div class="msg warn mt">' + esc(OUT_OF_ROLE_RULE) + '</div></div>');

    return h.join('');
  }

  function viewChat() {
    var c = T.chat;
    var h = [];
    h.push('<h1>AI 陪练</h1>');
    var ty = c.persona === 'any' ? null : typeOf(c.persona);
    h.push('<p class="sub">' + esc((ty ? ty.n : '随机人格') + ' · ' + (LEVEL_NAMES[c.level] || '') +
      (c.scenes.length ? ' · 情境 ' + c.scenes.map(function (i) { return i + 1; }).join('/') : '')) + '</p>');

    h.push('<div class="chat-wrap" id="chat-wrap">');
    if (!c.messages.length) {
      h.push('<div class="bubble sys">你扮演推荐者，先说第一句话。AI 只回答你问的问题，不会替你推进流程。</div>');
    }
    c.messages.forEach(function (m) { h.push(bubbleHTML(m)); });
    if (c.streaming) {
      h.push('<div class="bubble ai" id="live-bubble"><span class="who">对方</span><span id="live-text"></span><span class="cursor"></span></div>');
    }
    h.push('</div>');

    h.push('<div class="composer no-print">' +
      '<textarea id="chat-input" rows="1" placeholder="' + (c.messages.length ? '继续说…' : '我先说明今天大概聊三十分钟，可以吗？') + '"' + (c.streaming ? ' disabled' : '') + '></textarea>' +
      '</div>');
    h.push('<div class="row no-print" style="margin-top:-2px">' +
      '<button class="btn primary" data-act="chat-send"' + (c.streaming ? ' disabled' : '') + '>发送</button>' +
      '<button class="btn tiny-btn ghost" data-act="chat-fix"' + (c.streaming ? ' disabled' : '') + '>出戏了</button>' +
      '<button class="btn tiny-btn ghost" data-act="chat-review"' + (c.streaming ? ' disabled' : '') + '>一键复盘</button>' +
      '<button class="btn tiny-btn danger" data-act="chat-quit">结束</button>' +
      '</div>');
    h.push('<div class="rounds mt">' + (c.messages.length ? '已 ' + Math.ceil(c.messages.length / 2) + ' 轮' : '') + '</div>');

    if (c.review) h.push(reviewCardHTML(c.review));
    return h.join('');
  }

  function bubbleHTML(m) {
    var cls = m.role === 'user' ? 'me' : 'ai';
    var who = m.role === 'user' ? '我' : '对方';
    var body = esc(m.content);
    if (m.role === 'user' && m.content === PROMPT_REVIEW) {
      cls = 'sys'; who = ''; body = '（请求复盘）';
    } else if (m.role === 'user' && m.content === PROMPT_FIX) {
      cls = 'sys'; who = ''; body = '（提醒对方回到人设）';
    } else if (m.role === 'assistant' && m.content.indexOf('【评分】') >= 0) {
      cls = 'sys'; who = ''; body = '（评估者的复盘，见下方评分卡）';
    }
    return '<div class="bubble ' + cls + '">' + (who ? '<span class="who">' + who + '</span>' : '') + body + '</div>';
  }

  function reviewCardHTML(rv) {
    var h = ['<div class="card accent mt" id="review-card">'];
    h.push('<div class="spread"><div class="b">复盘评分</div>' + scoreTag(rv.total) + '</div>');
    if (!rv.perfect) h.push('<div class="msg warn mt">没能完整解析出六个分数。下面是 AI 的原文，你可以手动把分数填进去。</div>');
    h.push('<div class="grid three mt">');
    DIM_KEYS.forEach(function (k) {
      var v = rv.dims[k];
      h.push('<div class="stat"><div class="l">' + esc(k) + '</div>' +
        '<input type="number" min="0" max="2" step="1" value="' + (v == null ? '' : v) + '" data-act="review-dim" data-dim="' + esc(k) + '" style="margin-top:4px">' +
        '</div>');
    });
    h.push('</div>');
    var verdict = '';
    var tot = rv.total;
    if (tot != null) {
      DIM_VERDICT.forEach(function (v) { if (tot >= v[0] && tot <= v[1]) verdict = v[2]; });
    }
    h.push('<div class="small mt"><b>判定：</b>' + esc(verdict || '分数不完整') + '</div>');
    h.push('<label class="f mt"><span>最该改的一条（具体动作，不写「要多倾听」）</span>' +
      '<input type="text" id="review-improve" value="' + esc(rv.improve || '') + '"></label>');
    h.push('<div class="row">' +
      '<button class="btn primary sm" data-act="review-save">保存这场</button>' +
      '<button class="btn sm ghost" data-act="review-raw">看原文</button>' +
      '</div>');
    if (rv.raw) h.push('<details class="mt"><summary>AI 复盘原文</summary><div class="body" style="white-space:pre-wrap">' + esc(rv.raw) + '</div></details>');
    h.push('<div class="tiny muted mt">AI 打分不能全信。判断标准只有一个：它有没有引用你的原话。没有引用的一律不看。</div>');
    h.push('</div>');
    return h.join('');
  }

  function viewFlash() {
    var f = T.flash;
    var h = ['<h1>20 情境闪电战</h1>'];
    if (f.phase === 'pick') {
      h.push('<p class="sub">点一个情境开始。第 9 个（长时间沉默）和第 20 个（「行吧，那就听你的」）最难。</p>');
      h.push('<div class="chips">');
      SCENES.forEach(function (s, i) {
        h.push('<button class="chip" data-act="flash-pick" data-i="' + i + '">' + (i + 1) + '. ' + esc(s.n.length > 14 ? s.n.slice(0, 14) + '…' : s.n) + (s.hard ? ' ★' : '') + '</button>');
      });
      h.push('</div>');
      h.push('<div class="row mt"><button class="btn ghost" data-act="flash-random">随机一个</button>' +
        '<button class="btn ghost" data-act="flash-back">返回</button></div>');
      if (f.done && f.done.length) {
        h.push('<h2>练过的</h2><div class="card small">' + f.done.map(function (i) { return (i + 1) + '. ' + esc(SCENES[i].n); }).join('<br>') + '</div>');
      }
      return h.join('');
    }
    var s = SCENES[f.i];
    h.push('<p class="sub">第 ' + (f.i + 1) + ' / ' + SCENES.length + ' 个' + (s.hard ? ' · ★ 最难档' : '') + '</p>');
    h.push('<div class="card accent"><div class="tiny muted">对方说</div><div class="b mt" style="font-size:19px;line-height:1.5">「' + esc(s.n) + '」</div></div>');
    if (f.phase === 'write') {
      h.push('<label class="f"><span>你的第一句（30 秒内，写下来）</span><textarea id="flash-input" rows="3" placeholder="不要想完美，写你当场真会说的那句"></textarea></label>');
      h.push('<div class="row"><button class="btn primary" data-act="flash-reveal">看标准处理</button>' +
        '<button class="btn ghost" data-act="flash-back">返回</button></div>');
      return h.join('');
    }
    h.push('<div class="card"><div class="tiny muted">你写的</div><div class="mt" style="white-space:pre-wrap">' + (f.answer ? esc(f.answer) : '<span class="muted">（空）</span>') + '</div></div>');
    h.push('<div class="card ok"><div class="b">标准处理</div><div class="mt" style="white-space:pre-wrap">' + esc(SCENE_FIX[f.i]) + '</div></div>');
    if (s.hard && s.why) h.push('<div class="msg warn">' + esc(s.why) + '</div>');
    h.push('<div class="row"><button class="btn primary" data-act="flash-next">下一个</button>' +
      '<button class="btn ghost" data-act="flash-back">返回列表</button></div>');
    return h.join('');
  }

  /* 20 情境的标准处理（全部来自手册已有的条目） */
  var SCENE_FIX = [
    '接受并结束。**明确拒绝不是待处理的异议，是一个有效的答案。**「收到，谢谢你直接说。是否需要我不再发送课程信息？」两句话内结束，不追加。',
    '**这时候不能报价。**报价要满足四个条件：需求已确认 + 影响已量化 + 替代已比较 + 意愿已过筛。缺一个，报价就是浪费。「先说到钱你就走，那我们先把钱放一边——你最近一次因为这件事卡住是什么时候？」',
    OBJ_HARD[0].right + '\n' + OBJ_HARD[0].say[0] + '\n（价值不清）' + OBJ_HARD[0].say[1] + '\n（现金不足）' + OBJ_HARD[0].say[2] + '\n' + OBJ_HARD[0].warn,
    OBJ_HARD[1].right + '\n' + OBJ_HARD[1].say[0],
    '这是事实，不要否认。「培训不是唯一途径」是手册里的第 9 条顾虑。正确做法是**共同比较六条路径，不贬低免费资源**，然后问：「这六条里，你最愿意先试哪一条？为什么？」' + PATHS_CLOSE,
    '先分清他反对的是钱、安全、机构，还是时间。**不要替学生做承诺，也不建议跟家里吵架或先斩后奏。**给书面资料，鼓励共同沟通。\n家长最常反对的不是钱，是「你又要花钱搞些没用的」——当学生说「学费里我自己出一部分」时，性质就变了。',
    '先给议程和判断权。「我讲的方式可能有问题。我换个顺序：先说结论，再说理由，中间你随时打断我。」\n' + INSTANT[0],
    '**不要辩解「我不是推销的」。**直接把利益关系说清楚：\n' + DISCLOSE_PAID + '\n' + DISCLOSE_FREE,
    SCENES[8].why,
    OBJECTIONS[11][2] + '。**不贬低朋友，邀请核实具体担忧。**「哪条意见最有证据？我们一起查。」',
    '见高风险话术对照表：' + RISK_PAIRS[0][0] + ' → ' + RISK_PAIRS[0][1],
    '猫头鹰型的标准答案：**至少说三次「我不知道，我需要确认」。**「系统层面的数据我没有，我不能编给你。我能给的是我自己的经历和往期学员的联系方式。」\n（如果他说「我回去查一下」——这不是拒绝，是流程。）',
    SITUATIONS[5].must + '\n把旧经验当核验清单，逐项对照：内容空泛、强制活动、师资变更、过度销售、退费困难、没有反馈，还是他自己没有练。',
    '专业能力是核心，我不会说表达能替代代码。我们只判断你未来真实场景是否需要。\n' + SITUATIONS[0].route + '\n停止条件：' + SITUATIONS[0].stop,
    OBJECTIONS[4][2] + '。「我不跟你保证什么，我给你三个可以查的东西：营业执照和备案、课程表和师资资料、上过课的同学的联系方式。」最该让他问的是「这个课有哪些地方不好」。',
    RISK_PAIRS[4][0] + ' → ' + RISK_PAIRS[4][1],
    '「它是自评量表，本人填的，结果受当时状态影响。它测的是行为倾向，不是能力高低。准确说法是『参考答案』，不是『诊断书』。」\n' + PDP_NOT_NEED + '\n' + PDP_CHAMELEON_NOTE,
    '这是红线里的「制造稀缺 / 沉没成本」。**「真有截止」和「用截止催单」是两件事。**\n' + COOLDOWN + '\n' + COOLDOWN_EXCEPT,
    '他已经在后悔了——这时候要做的不是挽留，是处理。' + COOLDOWN_WHY[0] + '\n把合同里的退费条件、扣费方式和到账时间拿出来，逐条讲清。这一单就算退掉，你也留住了一个会替你说好话的人：' + FOLLOWUP_WHY,
    SCENES[19].why + '\n' + TYPES[4].extra[0][1] + '\n' + TYPES[4].extra[1][1]
  ];

  /* ============ 8. 视图：准备 ============ */
  function viewPrep() {
    var h = [];
    h.push('<h1>准备</h1>');
    h.push('<p class="sub">见面前 3 分钟看一页。记不住不是问题，临场翻手机才是。</p>');

    /* 选人 */
    h.push('<div class="card tight"><div class="b small">给谁准备</div>');
    h.push('<div class="chips mt">');
    h.push('<button class="chip' + (T.prepId === '' && !T.prepType ? '" aria-pressed="true' : '') + '" data-act="prep-pick" data-id="">不指定，只看类型</button>');
    S.archives.forEach(function (a) {
      h.push('<button class="chip' + (T.prepId === a.id ? '" aria-pressed="true' : '') + '" data-act="prep-pick" data-id="' + a.id + '">' + esc(a.name || '未命名') + '</button>');
    });
    h.push('</div>');
    var typeChips = '<div class="chips mt">' + TYPES.map(function (t) {
      return '<button class="chip' + (T.prepType === t.k && !T.prepId ? '" aria-pressed="true' : '') + '" data-act="prep-type" data-k="' + t.k + '">' + esc(t.n) + '</button>';
    }).join('') + '</div>';
    h.push('<div class="tiny muted mt">或临时按类型：</div>' + typeChips);
    h.push('</div>');

    h.push(briefingHTML());

    /* 越界拦截器 */
    h.push('<h2>越界拦截器 · 这句话能说吗</h2>');
    h.push('<p class="tiny muted" style="margin-top:-6px">报价前、发消息前，先过一遍。命中就标红，并给出可用的替代说法。</p>');
    h.push('<div class="card"><label class="f"><span>你准备说的话</span>' +
      '<textarea id="gate-input" rows="3" placeholder="例：这个课我保证有效，今天不定就涨价了">' + esc(T.gateText || '') + '</textarea></label>' +
      '<div class="row"><button class="btn primary" data-act="gate-check">检查</button>' +
      '<button class="btn ghost" data-act="gate-clear">清空</button></div>' +
      '<div id="gate-out"></div></div>');
    h.push('<div class="card tight"><div class="tiny muted">' + esc(RED_SELFCHECK) + '</div></div>');

    /* 决策树 */
    h.push('<h2>前置闸门</h2>');
    h.push('<p class="tiny muted" style="margin-top:-6px">把线性判断链做成机械流程。任何一环不通过，就走对应出口，不靠临场感觉。</p>');
    h.push('<div class="card">');
    TREE.forEach(function (n, i) {
      var no = T.gate > i;
      var cur = T.gate === i;
      h.push('<div class="row" style="align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--line2)">' +
        '<span class="tag ' + (no ? 'ok' : (cur ? 'accent' : '')) + '">' + (i + 1) + '</span>' +
        '<div style="flex:1;min-width:0"><div class="b small">' + esc(n.q) + '</div>' +
        (n.sub ? '<div class="tiny muted">' + esc(n.sub) + '</div>' : '') +
        (cur && n.no ? '<div class="msg warn tiny mt" style="margin-bottom:0">不通过 → ' + esc(n.no) + '</div>' : '') +
        '</div></div>');
    });
    h.push('<div class="row mt"><button class="btn sm" data-act="gate-next">下一环</button>' +
      '<button class="btn sm ghost" data-act="gate-reset">重来</button></div>');
    h.push('<div class="tiny muted mt">' + esc(VETO) + ' —— 出现任一，直接停止推进。</div>');
    h.push('</div>');

    /* 五项匹配大字模式 */
    h.push('<h2>五项匹配 · 递给他自己点</h2>');
    h.push('<p class="tiny muted" style="margin-top:-6px">' + esc(MATCH5_RULE) + '</p>');
    h.push(matchHTML());

    /* 30 分钟节奏 */
    h.push('<h2>30 分钟节奏</h2>');
    h.push('<div class="tw"><table><tr><th>时间</th><th>节点</th><th>要拿到什么</th></tr>');
    RHYTHM.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>'); });
    h.push('</table></div>');
    h.push('<div class="card tight"><div class="b small">四条铁律</div><ul class="dots mt">');
    IRON.forEach(function (x) { h.push('<li>' + esc(x) + '</li>'); });
    h.push('</ul></div>');

    return h.join('');
  }

  function briefingHTML() {
    var a = T.prepId ? S.archives.filter(function (x) { return x.id === T.prepId; })[0] : null;
    var tk = a && a.type ? a.type : T.prepType;
    var ty = typeOf(tk);
    var h = ['<div class="card" id="briefing">'];
    if (a) {
      h.push('<div class="spread"><div><div class="b" style="font-size:17px">' + esc(a.name || '未命名') +
        '<span class="muted small"> · ' + esc([a.grade, a.major].filter(Boolean).join(' ')) + '</span></div>' +
        '<div class="tiny muted mt">第 ' + ((a.meetCount || 1)) + ' 次见面 · ' + esc(a.date || '') + '</div></div>' + typeTag(a) + '</div>');
      if (a.typeBasis) h.push('<div class="tiny muted mt">判断依据：' + esc(a.typeBasis) + '</div>');
      h.push('<hr>');
      h.push('<dl class="kv">');
      h.push('<dt>上次走到</dt><dd>' + esc(a.stageNote || '—') + '</dd>');
      h.push('<dt>重要性/信心</dt><dd>' + esc(num(a.importance) + ' / ' + num(a.confidence)) + '</dd>');
      h.push('<dt>上次的顾虑</dt><dd>' + esc(a.objection || '—') + '</dd>');
      h.push('<dt>这次下一步</dt><dd>' + esc(a.nextNote || '—') + '</dd>');
      h.push('</dl>');
    } else {
      h.push('<div class="spread"><div class="b" style="font-size:17px">临时对象 · 按类型准备</div>' + '<span class="tag" style="background:' + ty.bg + ';color:' + ty.c + '">' + esc(ty.n) + '</span></div>');
      h.push('<div class="tiny muted mt">' + esc(ty.sum) + ' ／ 核心恐惧：' + esc(ty.fear) + '</div>');
    }

    h.push('<div class="card accent mt" style="margin:12px 0 0"><div class="tiny b muted">⚠ 本场只改一条</div>' +
      '<div class="b mt">' + esc(S.focus || '（还没设。复盘里点「用复盘里那条」，或回今天页手动写一条）') + '</div></div>');

    h.push('<div class="grid two mt">');
    h.push('<div class="card tight"><div class="tiny muted">破冰</div><div class="small mt">' + esc(ty.ice) + '</div></div>');
    h.push('<div class="card tight"><div class="tiny muted">痛点入口</div><div class="small mt">' + esc(ty.pain) + '</div></div>');
    h.push('<div class="card tight"><div class="tiny muted">最容易反感</div><div class="small mt">' + esc(ty.hate) + '</div></div>');
    h.push('<div class="card tight"><div class="tiny muted">成交方式</div><div class="small mt">' + esc(ty.close) + '</div></div>');
    h.push('</div>');

    h.push('<div class="card bad"><div class="tiny b">✕ 绝对不说</div>' +
      '<div class="small mt">「' + esc(ty.taboo) + '」</div>' +
      '<div class="tiny mt">' + esc(ty.ban.join(' ／ ')) + '</div></div>');

    h.push('<div class="card tight"><div class="tiny muted">从性格到需求，用这句过渡</div>' +
      '<div class="small mt">' + esc((TRANSITION_Q.filter(function (x) { return NAMES_TO_KEY[x[0]] === tk; })[0] || ['', ty.qs[0]])[1]) + '</div></div>');

    h.push('<div class="card tight"><div class="tiny muted">这一型的精准问题（挑 3 个就够）</div><ul class="dots mt">');
    ty.qs.slice(0, 4).forEach(function (q) { h.push('<li>' + esc(q) + '</li>'); });
    h.push('</ul></div>');

    h.push('<div class="card tight"><div class="tiny muted">这次走哪几个节点</div><div class="row mt">');
    NODES.forEach(function (n, i) {
      h.push('<span class="tag">' + (i + 1) + ' ' + esc(n[0]) + '</span>');
    });
    h.push('</div><div class="tiny muted mt">三个不能因类型改变的问法：' + esc(NODES_FIXED.join('、')) + '</div></div>');

    h.push('<div class="card ok"><div class="tiny b">开场自检</div><ul class="dots mt">');
    RED_ASK.forEach(function (q) { h.push('<li>' + esc(q) + '</li>'); });
    h.push('</ul></div>');

    h.push('<div class="row no-print"><button class="btn primary sm" data-act="print">打印这一页</button>' +
      '<button class="btn sm" data-act="copy-brief">复制成备忘录</button></div>');
    h.push('</div>');
    return h.join('');
  }
  var NAMES_TO_KEY = { '老虎': 'tiger', '孔雀': 'peacock', '考拉': 'koala', '猫头鹰': 'owl', '变色龙': 'chameleon' };

  function matchHTML() {
    var h = ['<div class="card">'];
    MATCH5.forEach(function (m, i) {
      h.push('<div style="padding:10px 0;border-bottom:1px solid var(--line2)">' +
        '<div class="b">' + (i + 1) + '. ' + esc(m[0]) + '</div>' +
        '<div class="tiny muted">0 分 ' + esc(m[1]) + ' ／ 1 分 ' + esc(m[2]) + ' ／ 2 分 ' + esc(m[3]) + '</div>' +
        '<div class="chips mt">');
      [0, 1, 2].forEach(function (v) {
        h.push('<button class="chip' + (T.match[i] === v ? '" aria-pressed="true' : '') + '" data-act="match-set" data-i="' + i + '" data-v="' + v + '">' + v + ' 分</button>');
      });
      h.push('</div></div>');
    });
    var given = T.match.filter(function (x) { return x != null; }).length;
    var sum = T.match.reduce(function (a, b) { return a + (b || 0); }, 0);
    h.push('<div class="mt b">');
    if (given < 5) h.push('还差 ' + (5 - given) + ' 项，五项都要由他自己说分数和理由。');
    else {
      var vd = MATCH5_VERDICT.filter(function (v) { return sum >= v[0] && sum <= v[1]; })[0];
      h.push('合计 ' + sum + ' / 10 → ' + esc(vd ? vd[2] : ''));
    }
    h.push('</div>');
    h.push('<div class="row mt"><button class="btn sm ghost" data-act="match-reset">重来</button>' +
      '<button class="btn sm" data-act="match-intro">念开场白</button></div>');
    h.push('<div class="tiny muted mt">' + esc(MATCH5_INTRO) + '</div>');
    h.push('</div>');
    return h.join('');
  }

  /* ============ 9. 视图：档案 ============ */
  function viewArchive() {
    if (T.archId) return viewArchiveDetail(T.archId);
    var h = ['<h1>档案</h1>'];
    h.push('<p class="sub">一个学生 = 一份档案。档案驱动简报，简报驱动谈话，复盘回流成下一场训练。</p>');

    h.push('<div class="row mb">' +
      '<button class="btn primary" data-act="arch-new">新建档案</button>' +
      '<button class="btn ghost" data-act="data-panel">数据与备份</button>' +
      '<button class="btn ghost" data-act="funnel">转化漏斗</button>' +
      '</div>');

    if (!S.archives.length) {
      h.push(emptyBox('还没有档案', '新建一份，或先到「陪练」练一场。'));
      return h.join('');
    }

    h.push('<div class="grid two">');
    S.archives.slice().sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); }).forEach(function (a) {
      var n = S.sessions.filter(function (s) { return s.archiveId === a.id; }).length;
      var resTag = a.result === '成交' ? 'ok' : (a.result === '明确拒绝' ? 'bad' : (a.result ? 'warn' : ''));
      h.push('<div class="card tight"><div class="spread"><div style="min-width:0">' +
        '<div class="row" style="gap:6px"><span class="b">' + esc(a.name || '未命名') + '</span>' + typeTag(a) +
        (a.result ? '<span class="tag ' + resTag + '">' + esc(a.result) + '</span>' : '') + '</div>' +
        '<div class="tiny muted mt">' + esc([a.grade, a.major, a.src].filter(Boolean).join(' · ') || '—') + '</div>' +
        '<div class="tiny muted">' + (n ? n + ' 场记录' : '暂无场次') + (a.nextFollow ? ' · 下次 ' + esc(a.nextFollow) : '') + '</div>' +
        '</div><button class="btn tiny-btn" data-act="open-archive" data-id="' + a.id + '">打开</button></div></div>');
    });
    h.push('</div>');

    h.push('<h2>话术库</h2>');
    h.push(phraseHTML());

    h.push('<h2>全部场次</h2>');
    if (!S.sessions.length) {
      h.push('<div class="msg info small">还没有场次。到「陪练」练一场，或点「一键复盘」。</div>');
    } else {
      h.push('<div class="tw"><table><tr><th>时间</th><th>对象</th><th>人格/难度</th><th>六维</th><th></th></tr>');
      S.sessions.slice().reverse().forEach(function (s) {
        var nm = s.archiveName || (s.persona === 'any' ? '随机' : (s.persona ? typeOf(s.persona).n : '—'));
        h.push('<tr><td>' + esc(String(s.createdAt).slice(0, 16)) + '</td>' +
          '<td>' + esc(nm) + '</td>' +
          '<td>' + esc((LEVEL_NAMES[s.level] || s.level || '—') + (s.model === 'v1' ? ' · v1' : '')) + '</td>' +
          '<td>' + scoreTag(s.review && s.review.perfect ? s.review.total : null) + '</td>' +
          '<td style="white-space:nowrap">' +
          (s.messages && s.messages.length ? '<button class="btn tiny-btn ghost" data-act="session-view" data-id="' + s.id + '">看对话</button> ' : '') +
          '<button class="btn tiny-btn ghost" data-act="session-del" data-id="' + s.id + '">删</button></td></tr>');
      });
      h.push('</table></div>');
    }
    return h.join('');
  }

  function sessionView(id) {
    var s = S.sessions.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    var h = [];
    if (s.review && s.review.perfect) {
      h.push('<div class="card tight"><div class="b small">六维</div><div class="row mt">' +
        DIM_KEYS.map(function (k) {
          var v = s.review.dims[k];
          return '<span class="tag ' + (v <= 1 ? 'bad' : (v === 2 ? 'ok' : 'warn')) + '">' + k + ' ' + v + '</span>';
        }).join('') + scoreTag(s.review.total) + '</div>' +
        (s.review.improve ? '<div class="small mt">最该改的一条：' + esc(s.review.improve) + '</div>' : '') + '</div>');
    }
    h.push('<div class="chat-wrap">');
    (s.messages || []).forEach(function (m) { h.push(bubbleHTML(m)); });
    h.push('</div>');
    if (s.review && s.review.raw) h.push('<details><summary>AI 复盘原文</summary><div class="body" style="white-space:pre-wrap">' + esc(s.review.raw) + '</div></details>');
    openModal('<h2>' + esc(s.archiveName || '场次记录') + '</h2>' + h.join('') +
      '<div class="row mt"><button class="btn" data-act="close-modal">关闭</button></div>');
  }


  function viewArchiveDetail(id) {
    var a = S.archives.filter(function (x) { return x.id === id; })[0];
    if (!a) { T.archId = ''; return viewArchive(); }
    a.need = a.need || {}; a.match5 = a.match5 || [null, null, null, null, null]; a.finance = a.finance || {};
    var h = ['<div class="row mb"><button class="btn tiny-btn ghost" data-act="arch-back">← 全部档案</button>' +
      '<button class="btn tiny-btn danger" data-act="arch-del" data-id="' + a.id + '">删除</button></div>'];
    h.push('<h1>' + esc(a.name || '未命名') + '</h1>');
    h.push('<p class="sub">' + esc([a.grade, a.major, a.src].filter(Boolean).join(' · ') || '基本信息还没填') + '</p>');

    h.push('<div id="arch-form">');
    a.needOwner = a.needOwner || {};

    h.push(group('基本信息', [
      fText('称呼', 'name', a.name, '小林'),
      '<div class="inline">' + fText('年级', 'grade', a.grade, '大二') + fText('专业', 'major', a.major, '计算机') + '</div>',
      '<div class="inline">' + fText('认识渠道', 'src', a.src, '宿舍走访 / 转介绍') + fText('谈话日期', 'date', a.date, '', 'date') + '</div>',
      '<div class="inline">' + fText('最近联系日', 'lastContact', a.lastContact, '', 'date') + fText('下次跟进日', 'nextFollow', a.nextFollow, '', 'date') + '</div>',
      fCheck('他回复过我（用于第 14 天停联判断）', 'replied', a.replied)
    ], true));

    h.push(group('类型判断', [
      '<label class="f"><span>测评结果 / 我的判断</span><select data-field="type">' +
      '<option value="">未判断</option>' +
      TYPES.map(function (t) { return '<option value="' + t.k + '"' + (a.type === t.k ? ' selected' : '') + '>' + esc(t.n) + '</option>'; }).join('') +
      '</select></label>',
      fArea('依据（具体行为，不写「感觉像」）', 'typeBasis', a.typeBasis, '连续追问了三次具体数字')
    ]));

    h.push(group('需求记录（必须用他的原话）', [
      fArea('最想改善的场景', 'need.scene', a.need.scene, '课堂汇报，一紧张就逻辑乱'),
      fArea('最近一次发生', 'need.last', a.need.last, '上周三的项目汇报，讲到第二页卡住了'),
      '<div class="inline">' + fText('频率（一个数字）', 'need.freq', a.need.freq, '过去一个月 3 次') + fText('强度 0-10', 'need.intensity', a.need.intensity, '7') + '</div>',
      fArea('具体后果（成绩/机会/关系/时间/情绪，有什么证据）', 'need.impact', a.need.impact, '老师说重点不清楚，扣了分'),
      fArea('资源层 · 他已经有什么（同伴/老师/方法）', 'need.resource', a.need.resource, '有演讲社团，但没人给反馈')
    ], true));
    h.push('<div class="msg info tiny" style="margin:-4px 0 14px">' + esc(RESOURCE_NOTE) + '<br>' + esc(NEED_CHECK) + '</div>');

    /* 影响量化引导器：每一层都要标出「这句是他说的，还是我说的」 */
    h.push('<details' + (a.need.scene ? ' open' : '') + '><summary>影响量化引导器 · 五层是谁说的</summary><div class="body">' +
      '<div class="tiny muted mb">逐层标一下。全是「我」的那一层，就是你自己引导出来的抽象词——它不是他的需求。</div>');
    NEED_LAYERS.forEach(function (L) {
      var v = a.needOwner[L[0]] || '他';
      h.push('<div class="spread" style="padding:7px 0;border-bottom:1px solid var(--line2);align-items:center">' +
        '<span class="small"><b>' + esc(L[1]) + '</b><span class="tiny muted">' + esc(L[2]) + '</span></span>' +
        '<span class="chips">' + ['他', '我'].map(function (o) {
          return '<button class="chip" style="padding:4px 12px;font-size:12px" aria-pressed="' + (v === o) + '" data-act="need-owner" data-k="' + L[0] + '" data-v="' + o + '">' + (o === '他' ? '他说的' : '我说的') + '</button>';
        }).join('') + '</span></div>');
    });
    h.push('<div id="need-audit" class="mt">' + needAuditHTML(a) + '</div>');
    h.push('</div></details>');

    h.push(group('两个分数', [
      '<div class="inline">' + fText('重要性 /10', 'importance', a.importance, '7') + fText('信心 /10', 'confidence', a.confidence, '4') + '</div>',
      fArea('为什么不是更低一分', 'why', a.why, '因为下个月还有比赛答辩')
    ]));

    h.push(group('替代路径', [
      '<label class="f"><span>他倾向先试哪一条</span><select data-field="path"><option value="">未问</option>' +
      PATHS.map(function (p) { return '<option value="' + esc(p[0]) + '"' + (a.path === p[0] ? ' selected' : '') + '>' + esc(p[0]) + '</option>'; }).join('') +
      '</select></label>',
      fText('为什么', 'pathWhy', a.pathWhy, '离得近，不要钱')
    ]));

    h.push(group('五项匹配（他自评）', MATCH5.map(function (m, i) {
      return '<label class="f"><span>' + esc(m[0]) + '</span><select data-field="match5.' + i + '">' +
        '<option value="">—</option>' +
        [0, 1, 2].map(function (v) { return '<option value="' + v + '"' + (num(a.match5[i]) === v && a.match5[i] !== null && a.match5[i] !== '' && a.match5[i] !== undefined ? ' selected' : '') + '>' + v + '</option>'; }).join('') +
        '</select></label>';
    }).join('') + '<div class="tiny muted">' + esc(MATCH5_RULE) + '</div>'));

    h.push(group('财务四问', FINANCE4.map(function (f) {
      return '<label class="f"><span>' + esc(f[0]) + '：' + esc(f[1]) + '</span>' +
        '<input type="text" data-field="finance.' + esc(f[0]) + '" value="' + esc(a.finance[f[0]] || '') + '"></label>';
    }).join('') + '<div class="msg warn tiny">' + esc(FINANCE_NOTE[1]) + '</div>'));

    h.push(group('顾虑', [
      fArea('顾虑原文', 'objection', a.objection, '「我怕我坚持不下来」'),
      '<label class="f"><span>分类</span><select data-field="objectionType"><option value="">未分类</option>' +
      ['价格', '价值', '安全', '时间', '不愿（不好意思拒绝）'].map(function (x) { return '<option' + (a.objectionType === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') +
      '</select></label>',
      fArea('真实原因', 'realReason', a.realReason, '不是钱，是怕自己又半途而废')
    ]));

    h.push(group('结果与下一步', [
      '<label class="f"><span>结果</span><select data-field="result"><option value="">进行中</option>' +
      ['成交', '需时间考虑', '明确拒绝', '暂缓'].map(function (x) { return '<option' + (a.result === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') +
      '</select></label>',
      fCheck('我主动建议过「先别报」', 'advisedNo', a.advisedNo),
      fCheck('他拒绝后还愿意保持联系', 'keepInTouch', a.keepInTouch),
      fCheck('坐下来谈超过 20 分钟', 'deepTalk', a.deepTalk),
      '<label class="f"><span>上次走到哪个节点</span><select data-field="stageNote"><option value="">—</option>' +
      NODES.map(function (n) { return '<option' + (a.stageNote === n[0] ? ' selected' : '') + '>' + esc(n[0]) + '</option>'; }).join('') +
      '</select></label>',
      fText('下一步谁发起 / 何时', 'nextNote', a.nextNote, '他周三前回复我，我只发资料不催')
    ]));

    h.push(group('自我改进', [
      fArea('我这场最该改的一条（写具体动作）', 'improve', a.improve, '我说完第 3 个问题没有复述就问了第 4 个')
    ]));

    h.push('</div>');

    h.push('<div class="row no-print mt"><button class="btn primary" data-act="arch-save">保存</button>' +
      '<button class="btn ghost" data-act="prep-from-arch" data-id="' + a.id + '">生成战前简报</button>' +
      '<button class="btn ghost" data-act="drill-for-arch" data-id="' + a.id + '">照这个类型练一场</button></div>');
    h.push('<div class="tiny muted mt">' + esc(ARCHIVE_DISCIPLINE[1]) + '</div>');

    h.push('<h2>场次记录与六维趋势</h2>');
    h.push(trendHTML(a.id));

    h.push('<h2>这个人的话术</h2>');
    h.push(phraseHTML(a.id));

    h.push('<h2>危险信号</h2>');
    h.push('<div class="card"><div class="tiny muted">出现以下任一情况，直接停止推进：</div><ul class="dots mt">');
    RED_STOP.forEach(function (x) { h.push('<li>' + esc(x) + '</li>'); });
    h.push('</ul></div>');

    return h.join('');
  }

  function group(title, inner, open) {
    var body = Array.isArray(inner) ? inner.join('') : String(inner == null ? '' : inner);
    return '<details' + (open ? ' open' : '') + '><summary>' + esc(title) + '</summary><div class="body">' + body + '</div></details>';
  }

  /* 五层：事件 / 频率 / 强度 / 后果 / 资源 —— 对应档案里的字段 */
  var NEED_LAYERS = [
    ['scene', '事件', ' 一个具体的时间点'],
    ['freq', '频率', ' 一个数字'],
    ['intensity', '强度', ' 一个分数'],
    ['impact', '后果', ' 一个具体损失'],
    ['resource', '资源', ' 他已有什么']
  ];

  function needAuditHTML(a) {
    var filled = [], mine = [];
    NEED_LAYERS.forEach(function (L) {
      var val = a.need[L[0]];
      if (val == null || String(val).trim() === '') return;
      filled.push(L[1]);
      if ((a.needOwner && a.needOwner[L[0]]) === '我') mine.push(L[1]);
    });
    if (!filled.length) {
      return '<div class="msg info small" style="margin:0">五层都还空着。先问他，别先写。</div>';
    }
    if (mine.length === filled.length) {
      return '<div class="msg bad small" style="margin:0"><b>你还没有拿到他自己的数字。</b>已填的 ' + filled.length +
        ' 层全是你自己的说法。这不是他的需求，是你的假设——后面所有匹配都会建在这个假设上。</div>';
    }
    if (mine.length) {
      return '<div class="msg warn small" style="margin:0">已填 ' + filled.length + ' 层，其中 ' + mine.length +
        ' 层是你说的（' + esc(mine.join('、')) + '）。这几层回去要补问，或者从记录里删掉。</div>';
    }
    return '<div class="msg ok small" style="margin:0">已填 ' + filled.length + ' 层，全部来自他嘴里。这是可以拿去做匹配的需求。</div>';
  }
  function fText(label, field, val, ph, type) {
    return '<label class="f"><span>' + esc(label) + '</span><input type="' + (type || 'text') + '" data-field="' + esc(field) + '" value="' + esc(val == null ? '' : val) + '" placeholder="' + esc(ph || '') + '"></label>';
  }
  function fArea(label, field, val, ph) {
    return '<label class="f"><span>' + esc(label) + '</span><textarea data-field="' + esc(field) + '" rows="2" placeholder="' + esc(ph || '') + '">' + esc(val == null ? '' : val) + '</textarea></label>';
  }
  function fCheck(label, field, val) {
    return '<label class="check"><input type="checkbox" data-field="' + esc(field) + '"' + (val ? ' checked' : '') + '><span>' + esc(label) + '</span></label>';
  }

  function trendHTML(archId) {
    var list = S.sessions.filter(function (s) {
      return (!archId || s.archiveId === archId) && s.review && s.review.perfect;
    }).slice(-16);
    var h = [];
    if (!list.length) return '<div class="msg info small">还没有可用的六维评分。练一场并点「一键复盘」就会出现在这里。</div>';
    h.push('<div class="tw"><table><tr><th>日期</th><th>对象</th><th>' + DIM_KEYS.join('</th><th>') + '</th><th>合计</th><th>最该改的一条</th></tr>');
    list.slice().reverse().forEach(function (s) {
      h.push('<tr><td>' + esc(String(s.createdAt).slice(0, 16)) + '</td>' +
        '<td>' + esc(s.archiveName || (s.persona === 'any' ? '随机' : typeOf(s.persona).n)) + '</td>' +
        DIM_KEYS.map(function (k) {
          var v = s.review.dims[k];
          var cls = v == null ? '' : (v <= 1 ? 'bad' : (v === 2 ? 'ok' : 'warn'));
          return '<td><span class="tag ' + cls + '">' + (v == null ? '—' : v) + '</span></td>';
        }).join('') +
        '<td>' + scoreTag(s.review.total) + '</td><td>' + esc(s.review.improve || '') + '</td></tr>');
    });
    h.push('</table></div>');
    h.push('<div class="card tight"><div class="tiny muted">不看总分，看每一维的走向。</div></div>');
    h.push('<canvas id="trend" width="820" height="230" style="width:100%;height:auto;border:1px solid var(--line);border-radius:var(--radius,10px)"></canvas>');
    requestAnimationFrame(function () { drawTrend(list); });
    return h.join('');
  }

  function drawTrend(list) {
    var cv = $('#trend');
    if (!cv || !cv.getContext) return;
    var g = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var PL = 34, PR = 12, PT = 14, PB = 22;
    g.clearRect(0, 0, W, H);
    var css = getComputedStyle(document.documentElement);
    var line = css.getPropertyValue('--line').trim() || '#ddd';
    var ink3 = css.getPropertyValue('--ink3').trim() || '#888';
    g.strokeStyle = line; g.fillStyle = ink3; g.font = '11px sans-serif'; g.lineWidth = 1;
    for (var v = 0; v <= 2; v++) {
      var y = PT + (H - PT - PB) * (1 - v / 2);
      g.beginPath(); g.moveTo(PL, y); g.lineTo(W - PR, y); g.stroke();
      g.fillText(String(v), 12, y + 4);
    }
    var n = list.length;
    var step = n > 1 ? (W - PL - PR) / (n - 1) : 0;
    var colors = ['#c2410c', '#b45309', '#1e7a4b', '#1d6fa5', '#6b3fa0', '#a16207'];
    DIM_KEYS.forEach(function (k, ki) {
      g.strokeStyle = colors[ki % colors.length];
      g.lineWidth = 1.8;
      g.beginPath();
      var started = false;
      list.forEach(function (s, i) {
        var v = s.review.dims[k];
        if (v == null) return;
        var x = PL + step * i;
        var y = PT + (H - PT - PB) * (1 - v / 2);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      });
      g.stroke();
      list.forEach(function (s, i) {
        var v = s.review.dims[k];
        if (v == null) return;
        var x = PL + step * i, y = PT + (H - PT - PB) * (1 - v / 2);
        g.fillStyle = colors[ki % colors.length];
        g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fill();
      });
    });
    g.fillStyle = ink3; g.font = '11px sans-serif';
    DIM_KEYS.forEach(function (k, ki) {
      var x = PL + ki * ((W - PL - PR) / 6) + 6;
      g.fillStyle = colors[ki % colors.length];
      g.fillRect(x, H - 12, 8, 8);
      g.fillStyle = ink3;
      g.fillText(k, x + 11, H - 4);
    });
  }

  function phraseHTML(archId) {
    var list = S.phrases.filter(function (p) { return !archId || p.archiveId === archId; });
    var h = ['<div class="row mb"><button class="btn sm primary" data-act="phrase-new"' + (archId ? ' data-arch="' + archId + '"' : '') + '>加一条</button>' +
      '<button class="btn sm ghost" data-act="phrase-guide">模板与纪律</button></div>'];
    if (!list.length) {
      h.push('<div class="msg info small">只记真实发生过的，不记「我觉得应该这么说」。而且必须记反例。</div>');
      return h.join('');
    }
    h.push('<div class="grid two">');
    list.slice().reverse().forEach(function (p) {
      h.push('<div class="card tight"><div class="tiny muted">' + esc(p.scene) + '</div>' +
        '<div class="small mt"><b>当时：</b>' + esc(p.then) + '</div>' +
        '<div class="small"><b>更好：</b>' + esc(p.better) + '</div>' +
        '<div class="row mt" style="gap:5px"><span class="tag">' + esc(p.type || '—') + '</span>' +
        '<span class="tiny muted">' + esc(p.src || '') + '</span>' +
        '<button class="btn tiny-btn ghost" style="margin-left:auto" data-act="phrase-del" data-id="' + p.id + '">删除</button></div></div>');
    });
    h.push('</div>');
    return h.join('');
  }

  function viewFunnel() {
    var f = funnelData();
    var labels = FUNNEL_STAGES.slice();
    var h = ['<div class="row mb"><button class="btn tiny-btn ghost" data-act="arch-back">← 返回</button></div>'];
    h.push('<h1>转化漏斗</h1>');
    h.push('<p class="sub">用途不是算转化率，是找出你卡在哪一步。</p>');
    if (!S.archives.length) return h.join(emptyBox('还没有档案数据', '先建几份档案。'));

    var top = Math.max(1, f[0]);
    h.push('<div class="card">');
    labels.forEach(function (l, i) {
      h.push('<div class="mt"><div class="spread"><span class="small b">' + esc(l) + '</span><span class="small">' + f[i] + '</span></div>' +
        bar(f[i] / top * 100) + '</div>');
    });
    h.push('</div>');

    h.push('<h2>每一步的流失</h2>');
    h.push('<div class="tw"><table><tr><th>环节</th><th>流失</th></tr>');
    FUNNEL_LOSS.forEach(function (l, i) {
      var lost = Math.max(0, f[i] - f[i + 1]);
      h.push('<tr><td>' + esc(l) + '</td><td>' + (f[i] ? Math.round(lost / f[i] * 100) + '%（' + lost + ' 人）' : '—') + '</td></tr>');
    });
    h.push('</table></div>');
    h.push('<div class="card tight"><div class="small">' + esc(FUNNEL_WHY) + '</div></div>');

    var refusals = trustAssets().refusals;
    var rate = S.archives.length ? Math.round(refusals / S.archives.length * 100) : 0;
    h.push('<h2>健康度</h2>');
    h.push('<div class="card ' + (rate >= 30 && rate <= 50 ? 'ok' : 'warn') + '">' +
      '<div class="b">明确拒绝占 ' + rate + '%（' + refusals + ' / ' + S.archives.length + '）</div>' +
      '<div class="small mt">' + esc(FUNNEL_HEALTHY) + '</div></div>');

    h.push('<h2>风险出口</h2>');
    h.push('<div class="card"><div class="small muted">' + FUNNEL_EXTRA.map(esc).join(' ／ ') + ' —— 这两项也是你的质量指标。</div></div>');
    return h.join('');
  }

  /* ============ 10. 视图：手册 ============ */
  var MANUAL = [
    { n: '五型速查', f: function () {
      var h = ['<div class="tw"><table><tr><th>类型</th><th>核心恐惧</th><th>痛点入口</th><th>最容易反感</th><th>成交方式</th><th>一句话禁忌</th></tr>'];
      TYPES.forEach(function (t) {
        h.push('<tr><td style="color:' + t.c + '">' + esc(t.n) + '</td><td>' + esc(t.fear) + '</td><td>' + esc(t.pain) + '</td><td>' + esc(t.hate) + '</td><td>' + esc(t.close) + '</td><td>' + esc(t.taboo) + '</td></tr>');
      });
      h.push('</table></div>');
      h.push('<div class="tw"><table><tr><th>类型</th><th>破冰</th><th>备注</th></tr>');
      TYPES.forEach(function (t) {
        h.push('<tr><td>' + esc(t.n) + '</td><td>' + esc(t.ice) + '</td><td>' + esc(t.memo) + '</td></tr>');
      });
      h.push('</table></div>');
      h.push('<div class="msg warn">' + esc(PDP_NOT_NEED) + '<br>' + esc(PDP_CHAMELEON_NOTE) + '</div>');
      return h.join('');
    } },
    { n: '五型识别 12 项观察', f: function () {
      var h = ['<div class="tw"><table><tr><th>观察维度</th><th>老虎</th><th>孔雀</th><th>考拉</th><th>猫头鹰</th></tr>'];
      IDENTIFY.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td><td>' + esc(r[4]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg info">变色龙判据：五组分数最高与最低相差小于 2 分，且没有一组明显突出。</div>');
      return h.join('');
    } },
    { n: '13 节点 + 30 分钟节奏', f: function () {
      var h = ['<div class="tw"><table><tr><th>节点</th><th>要拿到什么</th><th>卡住了就问</th></tr>'];
      NODES.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="tw"><table><tr><th>时间</th><th>节点</th><th>目标</th></tr>');
      RHYTHM.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<ul class="dots">' + IRON.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      h.push('<div class="msg warn">三个不能因类型改变的问法：' + esc(NODES_FIXED.join('、')) + '（横向可比）</div>');
      return h.join('');
    } },
    { n: '五型节点问法对照', f: function () {
      var h = ['<div class="tw"><table><tr><th>节点</th><th>老虎</th><th>孔雀</th><th>考拉</th><th>猫头鹰</th><th>变色龙</th></tr>'];
      var keys = ['tiger', 'peacock', 'koala', 'owl', 'chameleon'];
      var idx = 0;
      NODES.forEach(function (nd, i) {
        if (NODES_FIXED.indexOf(nd[0]) >= 0) return;
        h.push('<tr><td>' + esc(nd[0]) + '</td>' + keys.map(function (k) { return '<td>' + esc(NODE_BY_TYPE[k][idx]) + '</td>'; }).join('') + '</tr>');
        idx++;
      });
      h.push('</table></div>');
      return h.join('');
    } },
    { n: '影响量化五层 + 题库', f: function () {
      var h = [];
      PROBE5.forEach(function (p) { h.push('<div class="card tight"><div class="b">' + esc(p.n) + '</div><div class="small mt">' + esc(p.q) + '</div><div class="tiny muted">要拿到：' + esc(p.get) + '</div></div>'); });
      h.push('<div class="msg warn">' + esc(RESOURCE_NOTE) + '<br>' + esc(NEED_CHECK) + '</div>');
      PROBE_BANK.forEach(function (b) {
        h.push('<details><summary>' + esc(b.n) + ' <span class="tiny muted">' + b.qs.length + ' 问</span></summary><div class="body">');
        h.push('<ul class="dots">' + b.qs.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>');
        if (b.warn) h.push('<div class="msg warn tiny">' + esc(b.warn) + '</div>');
        h.push('</div></details>');
      });
      return h.join('');
    } },
    { n: '13 条顾虑 · 五步处理', f: function () {
      var h = [];
      h.push('<div class="card tight"><div class="b small">五步</div><div class="row mt">' + OBJ_STEPS.map(function (s) { return '<span class="tag accent">' + esc(s) + '</span>'; }).join('<span class="muted">→</span>') + '</div>');
      h.push('<ul class="dots mt">' + OBJ_STEP_DESC.map(function (d) { return '<li><b>' + esc(d[0]) + '</b>：' + esc(d[1]) + '</li>'; }).join('') + '</ul>');
      h.push('<div class="msg warn tiny">' + esc(OBJ_WARN) + '</div></div>');
      h.push('<div class="tw"><table><tr><th>他说</th><th>先分清</th><th>关键回应</th><th>回问</th></tr>');
      OBJECTIONS.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg bad tiny">' + esc(OBJ_LAST_NOTE) + '</div>');
      OBJ_HARD.forEach(function (o) {
        h.push('<details class="mt"><summary>' + esc(o.n) + '　<span class="tiny muted">' + esc(o.right) + '</span></summary><div class="body">');
        h.push('<div class="msg bad tiny">常见错误：' + esc(o.wrong) + '</div>');
        h.push('<ul class="dots">' + o.say.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>');
        if (o.warn) h.push('<div class="msg warn tiny">' + esc(o.warn) + '</div>');
        h.push('</div></details>');
      });
      h.push('<div class="tw mt"><table><tr><th>类型</th><th>调整回应顺序</th></tr>');
      OBJ_BY_TYPE.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg warn tiny">' + esc(OBJ_KOALA_NOTE) + '</div>');
      return h.join('');
    } },
    { n: '六条替代路径 + 课程四讲', f: function () {
      var h = ['<div class="tw"><table><tr><th>路径</th><th>适合谁</th><th>好处</th><th>代价</th></tr>'];
      PATHS.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg info">' + esc(PATHS_CLOSE) + '</div>');
      h.push('<div class="tw"><table><tr><th>要讲清</th><th>内容</th><th>来源</th></tr>');
      COURSE_3.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg warn tiny">' + esc(PRICE_NOTE) + '</div>');
      h.push('<div class="card"><div class="b small">价值陈述公式</div><div class="small mt">' + esc(VALUE_FORMULA) + '</div>' +
        '<div class="msg bad tiny mt">✕ ' + esc(VALUE_BAD) + '</div>' +
        '<div class="msg ok tiny">✓ ' + esc(VALUE_GOOD) + '</div></div>');
      return h.join('');
    } },
    { n: '五项匹配 + 财务四问', f: function () {
      var h = ['<div class="tw"><table><tr><th>维度</th><th>0</th><th>1</th><th>2</th></tr>'];
      MATCH5.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg info tiny">' + esc(MATCH5_RULE) + '</div>');
      h.push('<ul class="dots">' + MATCH5_VERDICT.map(function (v) { return '<li>' + v[0] + '–' + v[1] + ' 分 → ' + esc(v[2]) + '</li>'; }).join('') + '</ul>');
      h.push('<div class="tw"><table><tr><th>财务四问</th><th>问什么</th></tr>');
      FINANCE4.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg warn tiny">' + FINANCE_NOTE.map(esc).join('<br>') + '</div>');
      return h.join('');
    } },
    { n: '主动不推荐 + 现场决策树', f: function () {
      var h = ['<ul class="dots">' + NOT_RECOMMEND.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'];
      h.push('<div class="msg warn tiny">' + esc(NOT_RECOMMEND_6) + '</div>');
      h.push('<div class="msg info tiny">' + esc(POLITE_CHECK) + '</div>');
      TREE.forEach(function (n, i) {
        h.push('<div class="card tight"><div class="b small">' + (i + 1) + '. ' + esc(n.q) + '</div>' +
          (n.sub ? '<div class="tiny muted">' + esc(n.sub) + '</div>' : '') +
          (n.no ? '<div class="small mt">不通过 → ' + esc(n.no) + '</div>' : '') + '</div>');
      });
      h.push('<h3>三个即时判断</h3>');
      INSTANT.forEach(function (x) { h.push('<div class="card tight"><div class="b small">' + esc(x[0]) + '</div><div class="small mt">' + esc(x[1]) + '</div></div>'); });
      return h.join('');
    } },
    { n: '八种学生情境路线', f: function () {
      var h = ['<ul class="dots">' + SITUATION_FIRST.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'];
      h.push('<div class="msg warn tiny">' + esc(SITUATION_RULE) + '</div>');
      SITUATIONS.forEach(function (s) {
        h.push('<details><summary>' + esc(s.n) + '</summary><div class="body">');
        h.push('<div class="small"><b>状态：</b>' + esc(s.state) + '</div>');
        h.push('<div class="small mt"><b>要问的：</b>' + esc(s.q) + '</div>');
        h.push('<div class="small mt"><b>路线：</b>' + esc(s.route) + '</div>');
        h.push('<div class="msg info tiny mt">必须说出口：' + esc(s.must) + '</div>');
        h.push('<div class="msg bad tiny">停止条件：' + esc(s.stop) + '</div>');
        if (s.warn) h.push('<div class="msg warn tiny">' + esc(s.warn) + '</div>');
        h.push('</div></details>');
      });
      return h.join('');
    } },
    { n: '七类需求训练卡', f: function () {
      var h = [];
      CARDS7.forEach(function (c) {
        h.push('<details><summary>' + esc(c.n) + '　<span class="tiny muted">' + esc(c.goal) + '</span></summary><div class="body">');
        h.push('<div class="small"><b>最低可行练习：</b>' + esc(c.min) + '</div>');
        h.push('<div class="small mt"><b>值得付费的情况：</b>' + esc(c.worth) + '</div>');
        h.push('<div class="msg bad tiny mt">不需要付费的情况：' + esc(c.notneed) + '</div>');
        h.push('</div></details>');
      });
      h.push('<div class="msg info tiny">' + esc(CARDS7_NOTE) + '</div>');
      return h.join('');
    } },
    { n: '课程价值条目索引', f: function () {
      var h = ['<p class="small muted">' + esc(VALUE_INDEX_HOW) + '</p>'];
      h.push('<div class="tw"><table><tr><th>他说</th><th>调这几条</th></tr>');
      VALUE_INDEX.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'); });
      h.push('</table></div>');
      return h.join('');
    } },
    { n: '红线与合规', f: function () {
      var h = [];
      h.push('<div class="card"><div class="b small">随时自问</div><ul class="dots mt">' + RED_ASK.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>');
      h.push('<div class="tw"><table><tr><th>类别</th><th>例子</th></tr>');
      RED_SAY.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="card ok"><div class="b small">必须做到的四件事</div><ul class="dots mt">' + RED_MUST.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>');
      h.push('<div class="card bad"><div class="b small">出现以下任一，直接停止推进</div><ul class="dots mt">' + RED_STOP.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>');
      h.push('<h3>九条必须删除的做法</h3>');
      RED_DELETE.forEach(function (r, i) {
        h.push('<details><summary>' + (i + 1) + '. ' + esc(r[0]) + '</summary><div class="body">' + esc(r[1]) + '</div></details>');
      });
      h.push('<div class="msg warn tiny">' + esc(RED_SELFCHECK) + '</div>');
      h.push('<h3>高风险话术对照</h3>');
      h.push('<div class="tw"><table><tr><th>✕ 不说</th><th>✓ 改成</th></tr>');
      RISK_PAIRS.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg warn tiny">' + esc(RISK_PAIRS_NOTE) + '</div>');
      return h.join('');
    } },
    { n: '知情决定七项 + 冷静期', f: function () {
      var h = ['<div class="tw"><table><tr><th>项目</th><th>必须讲清</th></tr>'];
      INFORMED7.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg warn tiny">' + esc(INFORMED5_NOTE) + '</div>');
      h.push('<div class="card accent"><div class="b small">二十四小时冷静期</div><div class="small mt">' + esc(COOLDOWN) + '</div>' +
        '<ul class="dots mt">' + COOLDOWN_WHY.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
        '<div class="tiny muted">' + esc(COOLDOWN_EXCEPT) + '</div></div>');
      h.push('<div class="card"><div class="b small">透明披露（报价前必须说）</div>' +
        '<div class="small mt">' + esc(DISCLOSE_PAID) + '</div><div class="small mt">' + esc(DISCLOSE_FREE) + '</div></div>');
      return h.join('');
    } },
    { n: '家长沟通五步', f: function () {
      var h = ['<div class="tw"><table><tr><th>#</th><th>做什么</th></tr>'];
      PARENT5.forEach(function (r, i) { h.push('<tr><td>' + (i + 1) + '</td><td><b>' + esc(r[0]) + '</b>' + (r[1] !== '—' ? '：' + esc(r[1]) : '') + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg info tiny">' + esc(PARENT4_KEY) + '</div>');
      h.push('<div class="card ok"><div class="b small">可以对家长说的话</div><div class="small mt">' + esc(PARENT_SAY) + '</div></div>');
      PARENT_WRONG.forEach(function (w) { h.push('<div class="msg bad tiny"><b>' + esc(w[0]) + '</b>：' + esc(w[1]) + '</div>'); });
      h.push('<div class="msg warn tiny">' + esc(PARENT_RED) + '</div>');
      h.push('<div class="small mt">' + esc(PARENT_IF_NO) + '</div>');
      return h.join('');
    } },
    { n: '个人经历的正确讲法', f: function () {
      var h = ['<div class="card accent"><div class="small">' + esc(EXP_FORMULA) + '</div></div>'];
      h.push('<ul class="dots">' + EXP_RULES.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      h.push('<div class="msg info tiny">' + esc(EXP_SELFCHECK) + '</div>');
      return h.join('');
    } },
    { n: '三套完整脚本', f: function () {
      var h = [];
      SCRIPT_3.forEach(function (s) {
        h.push('<details><summary>' + esc(s.n) + '　<span class="tiny muted">' + esc(s.use) + '</span></summary><div class="body">');
        h.push('<div class="chat-wrap">');
        s.lines.forEach(function (l) {
          h.push('<div class="bubble ' + (l[0] === '你' ? 'me' : 'ai') + '"><span class="who">' + esc(l[0]) + '</span>' + esc(l[1]) + '</div>');
        });
        h.push('</div>');
        if (s.end) h.push('<div class="msg warn tiny mt">' + esc(s.end) + '</div>');
        h.push('</div></details>');
      });
      return h.join('');
    } },
    { n: 'OARS · 提问与反映', f: function () {
      var h = ['<div class="tw"><table><tr><th>技巧</th><th>英文</th><th>做什么</th><th>例</th></tr>'];
      OARS.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="card tight"><div class="small">' + OARS_AFFIRM.map(esc).join('<br>') + '</div></div>');
      h.push('<div class="card tight"><div class="small">' + OARS_REFLECT.map(esc).join('<br>') + '</div></div>');
      h.push('<div class="msg info tiny">' + esc(OARS_RATIO) + '</div>');
      h.push('<h3>降低反感的七个细节</h3><ul class="dots">' + REDUCE_HATE.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      return h.join('');
    } },
    { n: '理解 PDP 与解读纪律', f: function () {
      var h = ['<div class="tw"><table><tr><th>维度</th><th>英文</th><th>含义</th></tr>'];
      PDP_DIMS.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<h3>常见误读 → 正确说法</h3><div class="tw"><table><tr><th>✕</th><th>✓</th></tr>');
      PDP_MISREAD.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg warn tiny">' + esc(PDP_CHAMELEON_NOTE) + '</div>');
      h.push('<h3>解读四步法</h3>');
      READ4.forEach(function (r, i) { h.push('<div class="card tight"><div class="b small">' + (i + 1) + '. ' + esc(r[0]) + '</div><div class="small mt">' + esc(r[1]) + '</div></div>'); });
      h.push('<h3>解读禁忌</h3><ul class="dots">' + READ_TABOO.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      h.push('<h3>结果反馈四句式</h3><div class="card tight"><ul class="dots">');
      FEEDBACK4.forEach(function (r) { h.push('<li><b>' + esc(r[0]) + '</b>：' + esc(r[1]) + '</li>'); });
      h.push('</ul></div>');
      h.push('<h3>测评使用</h3><div class="card tight"><div class="small">' + esc(MEASURE_PERMISSION) + '</div><div class="small mt">' + esc(MEASURE_REFUSE) + '</div><div class="tiny muted mt">' + esc(MEASURE_SCORE) + '</div></div>');
      h.push('<div class="tw"><table><tr><th>组</th><th>题号</th><th>维度</th></tr>');
      MEASURE_GROUPS.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg warn tiny">质量问题：' + MEASURE_QUALITY.map(esc).join(' ／ ') + '<br>' + esc(MEASURE_REDO) + '</div>');
      return h.join('');
    } },
    { n: '混合型与停止信号', f: function () {
      var h = ['<div class="tw"><table><tr><th>组合</th><th>优势</th><th>沟通顺序</th><th>风险</th></tr>'];
      MIXED.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg info tiny">' + esc(MIXED_SHIFT) + '</div>');
      h.push('<h3>该停止谈类型了</h3><ul class="dots">' + STOP_TYPES.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      h.push('<div class="msg warn tiny">' + esc(STOP_TYPES_WHY) + '</div>');
      return h.join('');
    } },
    { n: '六维评分 · 复盘 · 认证', f: function () {
      var h = ['<div class="tw"><table><tr><th>维度</th><th>0</th><th>1</th><th>2</th></tr>'];
      DIMS.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<ul class="dots">' + DIM_VERDICT.map(function (v) { return '<li>' + v[0] + '–' + v[1] + ' 分 → ' + esc(v[2]) + '</li>'; }).join('') + '</ul>');
      h.push('<div class="msg bad tiny">否决项：' + esc(VETO) + '</div>');
      h.push('<h3>复盘的三个层次</h3>');
      REVIEW_LEVELS.forEach(function (r) { h.push('<div class="card tight"><div class="b small">' + esc(r[0]) + '</div><div class="small mt">' + esc(r[1]) + '</div><div class="tiny muted mt">' + esc(r[2]) + '</div></div>'); });
      h.push('<div class="msg warn tiny">' + esc(REVIEW_LEVEL_WARN) + '</div>');
      h.push('<h3>复盘三步</h3><ul class="dots">' + REVIEW_STEPS.map(function (r) { return '<li><b>' + esc(r[0]) + '</b>：' + esc(r[1]) + '</li>'; }).join('') + '</ul>');
      h.push('<div class="msg info tiny">' + esc(REVIEW_ONE_RULE) + '</div>');
      h.push('<div class="msg warn tiny">' + esc(RECORD_CONSENT) + '</div>');
      h.push('<h3>十项复盘清单</h3><ul class="dots">' + REVIEW_CHECK.map(function (x, i) { return '<li>' + (i + 1) + '. ' + esc(x) + '</li>'; }).join('') + '</ul>');
      h.push('<div class="msg warn tiny">' + esc(REVIEW_CHECK_SHARP) + '</div>');
      h.push('<h3>三级认证</h3>');
      CERTS.forEach(function (c) {
        h.push('<details><summary>' + esc(c.n) + '　<span class="tiny muted">能做：' + esc(c.can) + '</span></summary><div class="body"><ul class="dots">');
        c.items.forEach(function (it) { h.push('<li><b>' + esc(it[0]) + '</b>：' + esc(it[1]) + '</li>'); });
        h.push('</ul><div class="tiny muted">不能做：' + esc(c.cannot) + '</div></div></details>');
      });
      h.push('<h3>六种「假通过」</h3><div class="tw"><table><tr><th>现象</th><th>看起来</th><th>真相</th></tr>');
      FALSES.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg warn tiny">' + esc(FALSES_WARN) + '</div>');
      h.push('<div class="msg info tiny">' + esc(TEACH_NOTE) + '</div>');
      return h.join('');
    } },
    { n: '跟进节奏 + 90 天 + 消息模板', f: function () {
      var h = ['<div class="tw"><table><tr><th>阶段</th><th>时点</th><th>做什么</th><th>不要</th></tr>'];
      FOLLOWUP.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<ul class="dots">' + FOLLOWUP_RULES.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      h.push('<div class="msg info tiny">' + esc(FOLLOWUP_WHY) + '</div>');
      h.push('<h3>三条标准消息</h3>');
      MSG_TEMPLATES.forEach(function (m) { h.push('<div class="card tight"><div class="b small">' + esc(m.n) + '</div><div class="small mt">' + esc(m.t) + '</div></div>'); });
      h.push('<h3>90 天转化计划</h3><div class="tw"><table><tr><th>时点</th><th>做什么</th></tr>');
      DAYS90.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg info tiny">' + esc(DAYS90_NOTE) + '</div>');
      return h.join('');
    } },
    { n: '话术库模板 + 数据纪律 + 档案字段', f: function () {
      var h = ['<div class="tw"><table><tr><th>栏目</th><th>怎么写</th></tr>'];
      Object.keys(PHRASE_TEMPLATE).forEach(function (k) { h.push('<tr><td>' + esc(k) + '</td><td>' + esc(PHRASE_TEMPLATE[k]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<ul class="dots">' + PHRASE_RULES.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      h.push('<div class="msg info tiny">' + esc(PHRASE_WHY) + '</div>');
      h.push('<h3>数据使用纪律</h3><ul class="dots">' + DATA_RULES.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      h.push('<div class="msg warn tiny">' + esc(DATA_RULE_5) + '</div>');
      h.push('<h3>个案档案字段</h3><div class="tw"><table><tr><th>分组</th><th>字段</th></tr>');
      ARCHIVE_FIELDS.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<ul class="dots">' + ARCHIVE_DISCIPLINE.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      return h.join('');
    } },
    { n: '28 天训练营总表', f: function () {
      var h = [];
      WEEKS.forEach(function (w, wi) {
        h.push('<div class="card tight"><div class="b">' + esc(w.t) + '</div><div class="small muted">' + esc(w.s) + '</div></div>');
        h.push('<div class="tw"><table><tr><th>天</th><th>动作</th><th>分钟</th><th>达标线</th></tr>');
        DAYS.forEach(function (d) {
          if (d[1] !== wi) return;
          h.push('<tr><td>' + d[0] + '</td><td>' + esc(d[2]) + '</td><td>' + d[3] + '</td><td>' + esc(d[4]) + '</td></tr>');
        });
        h.push('</table></div>');
        h.push('<div class="msg warn tiny">' + esc(w.tip) + '</div>');
      });
      h.push('<h3>训练信号</h3><div class="tw"><table><tr><th>阶段</th><th>你会感觉</th><th>说明</th></tr>');
      SIGNALS.forEach(function (r) { h.push('<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>'); });
      h.push('</table></div>');
      h.push('<div class="msg info tiny">' + esc(SIGNAL_WARN) + '</div>');
      return h.join('');
    } },
    { n: '20 个压力情境 + 标准处理', f: function () {
      var h = ['<p class="small muted">第 9 个和第 20 个最难。第 9 个考你能不能忍住不说话；第 20 个考你能不能识别「配合」和「决定」的区别。</p>'];
      SCENES.forEach(function (s, i) {
        h.push('<details' + (s.hard ? ' open' : '') + '><summary>' + (i + 1) + '. ' + esc(s.n) + (s.hard ? '　<span class="tag bad">最难</span>' : '') + '</summary><div class="body">');
        if (s.why) h.push('<div class="msg warn tiny">' + esc(s.why) + '</div>');
        h.push('<div class="small" style="white-space:pre-wrap">' + esc(SCENE_FIX[i]) + '</div>');
        h.push('</div></details>');
      });
      return h.join('');
    } }
  ];

  function manualIndex() {
    if (T.manualIdx) return T.manualIdx;
    var idx = [];
    MANUAL.forEach(function (sec, si) {
      var text = String(sec.f()).replace(/<[^>]+>/g, ' ');
      idx.push({ si: si, n: sec.n, text: text });
    });
    T.manualIdx = idx;
    return idx;
  }

  function supplementaryContent(query) {
    var extras = Array.isArray(window.ZL_SUPPLEMENTS) ? window.ZL_SUPPLEMENTS : [];
    var q = String(query || '').trim().toLowerCase();
    var selected = extras.filter(function (x) { return !q || [x.title,x.summary,x.source,(x.points||[]).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0; });
    if (!selected.length) return '';
    var h = ['<div class="section-note"><h2>新资料补充</h2><p class="small muted">根据新资料整理，保留出处，详细内容可查看资料库。</p></div>'];
    selected.forEach(function (x) {
      h.push('<details class="extra-chapter"><summary>' + esc(x.title) + '</summary><div class="body"><p>' + esc(x.summary) + '</p><ul class="dots">' + (x.points||[]).map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul><p class="tiny muted">' + esc(x.source) + ' · ' + esc(x.status) + '</p>' + (x.resourceId ? '<button class="btn ghost sm" data-act="supplement-resource" data-id="' + esc(x.resourceId) + '">查看相关资料</button>' : '') + '</div></details>');
    });
    return h.join('');
  }

  function viewManual() {
    var h = ['<h1>手册</h1>'];
    h.push('<p class="sub">全部 ' + MANUAL.length + ' 个板块，跨板块搜索。</p>');
    h.push('<div class="searchbar"><input type="text" id="manual-q" placeholder="搜「爸妈」「太贵」「资源层」「猫头鹰」…" value="' + esc(T.manualQ) + '">' +
      (T.manualQ ? '<button class="btn ghost sm" data-act="manual-clear">清空</button>' : '') + '</div>');

    if (!T.manualQ.trim()) h.push('<section class="manual-intro"><span>沟通手册</span><h2>从你遇到的场景开始</h2><p>保留原手册全部内容，选一个问题，就能找到相应的方法。</p><div class="manual-shortcuts"><button data-act="manual-goto" data-si="0">了解沟通风格 <span>›</span></button><button data-act="manual-goto" data-si="2">梳理交流流程 <span>›</span></button><button data-act="manual-goto" data-si="5">回应常见顾虑 <span>›</span></button><button data-act="manual-goto" data-si="16">查看完整脚本 <span>›</span></button></div></section><h2 class="manual-index-title">全部手册章节 <small>25 个板块</small></h2>');

    if (T.manualQ.trim()) {
      var q = T.manualQ.trim();
      var ql = q.toLowerCase();
      /* 同义词：查询词与它的同义词构成一个 OR 组，组之间是 AND */
      var groups = [];
      Object.keys(SYN).forEach(function (k) {
        if (q.indexOf(k) >= 0) groups.push(SYN[k].split(/\s+/));
      });
      if (!groups.length) groups.push([q]);
      var hits = [];
      manualIndex().forEach(function (s) {
        var hay = s.text.toLowerCase();
        var ok = groups.every(function (g) {
          return g.some(function (t) { return hay.indexOf(t.toLowerCase()) >= 0; });
        });
        if (!ok) return;
        var pos = hay.indexOf(ql);
        if (pos < 0 && groups.length) pos = hay.indexOf(groups[0][0].toLowerCase());
        var snip = '';
        if (pos >= 0) snip = s.text.slice(Math.max(0, pos - 26), pos + 96).replace(/\s+/g, ' ').trim();
        hits.push({ s: s, snip: snip || s.text.slice(0, 110).replace(/\s+/g, ' ').trim() });
      });
      h.push('<div class="card tight"><div class="small">共 ' + hits.length + ' 条，在 ' + new Set(hits.map(function (x) { return x.s.si; })).size + ' 个板块里。</div></div>');
      hits.forEach(function (x) {
        h.push('<div class="card tight"><div class="sec tiny b" style="color:var(--accent)">' + esc(x.s.n) + '</div>' +
          '<div class="small mt">…' + hl(x.snip, [q].concat(groups.reduce(function (a, g) { return a.concat(g); }, []))) + '…</div>' +
          '<div class="row mt"><button class="btn tiny-btn ghost" data-act="manual-goto" data-si="' + x.s.si + '">打开这一节</button></div></div>');
      });
      var supplementalHits = supplementaryContent(q);
      if (supplementalHits) h.push(supplementalHits);
      if (!hits.length && !supplementalHits) h.push(emptyBox('没找到', '换个说法试试，比如把「爸妈」换成「父母」。'));
      return h.join('');
    }

    h.push('<details class="extra-group"><summary>新资料补充 · 6 个主题</summary><div class="body">' + supplementaryContent('') + '</div></details>');
    MANUAL.forEach(function (sec, i) {
      h.push('<details' + ' data-sec="' + i + '"><summary>' + esc(sec.n) + '</summary><div class="body">' + sec.f() + '</div></details>');
    });
    return h.join('');
  }
  var SYN = { '爸妈': '父母', '爹妈': '父母', '价格': '太贵 费用', '钱': '费用 太贵', '紧张': '紧张 舞台', '内向': '考拉 安静', '贵': '太贵 费用', '拒绝': '拒绝 结束' };
  function hl(text, terms) {
    var out = esc(text);
    terms.forEach(function (t) {
      if (!t) return;
      try {
        out = out.replace(new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>');
      } catch (e) { }
    });
    return out;
  }

  /* ============ 11. 路由 ============ */
  var TABS = [
    ['today', '今天', '◉'],
    ['drill', '陪练', '◈'],
    ['prep', '准备', '▤'],
    ['archive', '档案', '▣'],
    ['manual', '手册', '≡'],
    ['library', '资料库', '▤']
  ];

  function renderNav() {
    $('#tabs').innerHTML = TABS.map(function (t) {
      return '<button data-act="tab" data-tab="' + t[0] + '" aria-current="' + (T.tab === t[0]) + '">' +
        '<span class="ico">' + t[2] + '</span><span>' + t[1] + '</span></button>';
    }).join('');
  }

  function render() {
    var currentHome = document.querySelector('details.home-records');
    if (currentHome) T.homeOpen = currentHome.open;
    var v = $('#view');
    var h = '';
    try {
      if (T.tab === 'today') h = viewToday();
      else if (T.tab === 'drill') h = viewDrill();
      else if (T.tab === 'prep') h = viewPrep();
      else if (T.tab === 'archive') h = T.archId ? viewArchiveDetail(T.archId) : (T.funnelView ? viewFunnel() : viewArchive());
      else if (T.tab === 'library') h = '';
      else h = viewManual();
    } catch (e) {
      h = '<div class="msg bad">渲染出错：' + esc(e && e.message || e) + '</div>';
      if (window.console) console.error(e);
    }
    v.innerHTML = h;
    if (T.tab === 'library' && window.ZLLibrary) window.ZLLibrary.render(v);
    renderNav();
    bindForm();
    if (T.tab === 'drill' && T.chat && T.chat.streaming) scrollChat();
  }

  function go(tab) {
    if (T.tab === tab) {
      if (tab === 'archive' && (T.archId || T.funnelView)) { T.archId = ''; T.funnelView = false; render(); }
      else if (tab === 'drill' && (T.chat || T.flash)) { T.chat = null; T.flash = null; render(); }
      else window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    T.tab = tab;
    T.archId = '';
    T.funnelView = false;
    render();
    window.scrollTo({ top: 0, behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' });
  }

  function scrollChat() {
    var el = $('#live-bubble');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'end' });
  }

  /* ============ 12. 表单双向绑定 ============ */
  function setPath(obj, path, val) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var k = parts[i];
      if (cur[k] == null) cur[k] = (/^\d+$/.test(parts[i + 1]) ? [] : {});
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = val;
  }

  var bound = false;
  function bindForm() {
    if (bound) return;
    bound = true;
    var v = $('#view');
    v.addEventListener('input', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute) return;
      var path = el.getAttribute('data-field');
      if (!path) return;
      var obj = currentFormObj();
      if (!obj) return;
      var val;
      if (el.type === 'checkbox') val = el.checked;
      else if (el.getAttribute('data-num') === '1') val = el.value === '' ? '' : num(el.value);
      else val = el.value;
      setPath(obj, path, val);
      obj.updatedAt = nowStamp();
      save();
    });
    v.addEventListener('change', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute) return;
      var path = el.getAttribute('data-field');
      if (!path) return;
      var obj = currentFormObj();
      if (!obj) return;
      setPath(obj, path, el.type === 'checkbox' ? el.checked : el.value);
      obj.updatedAt = nowStamp();
      save(true);
    });
    v.addEventListener('keydown', function (e) {
      if (e.target && e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
      if (e.target && e.target.id === 'manual-q' && e.key === 'Enter') {
        T.manualQ = e.target.value;
        render();
        var q = $('#manual-q'); if (q) { q.focus(); }
      }
    });
    v.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'manual-q') {
        T.manualQ = e.target.value;
        clearTimeout(T._mq);
        T._mq = setTimeout(function () {
          var val = T.manualQ;
          render();
          var q = $('#manual-q'); if (q) { q.focus(); q.setSelectionRange(val.length, val.length); }
        }, 320);
      }
      if (e.target && e.target.id === 'chat-input') {
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(150, e.target.scrollHeight) + 'px';
      }
      if (e.target && e.target.id === 'review-improve') T.improveTouched = true;
    });
  }

  function currentFormObj() {
    if (T.tab === 'archive' && T.archId) {
      return S.archives.filter(function (x) { return x.id === T.archId; })[0];
    }
    return null;
  }

  /* ============ 13. 动作 ============ */
  var ACT = {
    theme: function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      S.settings.theme = next; save();
      var meta = document.querySelector('meta[name="theme-color"]:not([media])');
      if (meta) meta.setAttribute('content', next === 'dark' ? '#0f1115' : '#faf7f2');
    },
    settings: settingsModal,
    'close-modal': closeModal,
    'modal-yes': function () { var f = modalYes; closeModal(); if (f) f(); },

    tab: function (el) { go(el.getAttribute('data-tab')); },

    'day-toggle': function (el) {
      var d = parseInt(el.getAttribute('data-day'), 10);
      if (S.drills[d]) delete S.drills[d]; else { S.drills[d] = true; toast('第 ' + d + ' 天 · 完成'); }
      save(true); render();
    },

    'focus-edit': function () {
      openModal('<h2>本阶段只改这一条</h2><p class="small muted">写一个具体动作，不写「要多倾听」。</p>' +
        '<label class="f"><span>改进项</span><textarea id="focus-input" rows="3">' + esc(S.focus || '') + '</textarea></label>' +
        '<div class="row"><button class="btn primary" data-act="focus-save">保存</button><button class="btn ghost" data-act="close-modal">取消</button></div>');
    },
    'focus-save': function () {
      S.focus = ($('#focus-input') || {}).value || '';
      save(true); closeModal(); render(); toast('已更新');
    },
    'focus-from-review': function () {
      var last = scoredSessions().slice(-1)[0];
      if (last && last.review.improve) { S.focus = last.review.improve; save(true); render(); toast('已钉上'); }
    },
    'focus-clear': function () {
      confirmBox('清空这一条？改到成为习惯再换下一条。', function () { S.focus = ''; save(true); render(); }, '清空');
    },

    /* ---- 陪练 ---- */
    'chat-setup': function () {
      T.chat = { persona: 'tiger', level: 'hard', scenes: [], messages: [], streaming: false, review: null, id: uid(), createdAt: nowStamp(), archiveId: '' };
      chatSetupModal();
    },
    'chat-config': function () { if (T.chat) chatSetupModal(); },
    'chat-start': function () { closeModal(); render(); var i = $('#chat-input'); if (i) i.focus(); },
    'chat-persona': function (el) { T.chat.persona = el.getAttribute('data-k'); chatSetupModal(); },
    'chat-level': function (el) { T.chat.level = el.getAttribute('data-k'); chatSetupModal(); },
    'chat-scene': function (el) {
      var i = parseInt(el.getAttribute('data-i'), 10);
      var arr = T.chat.scenes;
      var p = arr.indexOf(i);
      if (p >= 0) arr.splice(p, 1); else arr.push(i);
      chatSetupModal();
    },
    'chat-send': function () { sendChat(); },
    'chat-fix': function () { sendChat(PROMPT_FIX); },
    'chat-review': function () { sendChat(PROMPT_REVIEW, true); },
    'chat-quit': function () {
      confirmBox('结束这一场？没复盘的对话也会存成一条场次记录。', function () {
        if (T.chat.messages.length) persistChat(false);
        T.chat = null; render();
      }, '结束');
    },
    'chat-copy': function () {
      var txt = T.chat.messages.map(function (m) { return (m.role === 'user' ? '我：' : '对方：') + m.content; }).join('\n\n');
      copyText(txt);
    },

    'flash-start': function () { T.flash = { phase: 'pick', i: 0, answer: '', done: [] }; render(); },
    'flash-back': function () { T.flash = null; render(); },
    'flash-pick': function (el) {
      T.flash.i = parseInt(el.getAttribute('data-i'), 10);
      T.flash.phase = 'write'; T.flash.answer = '';
      render();
      var i = $('#flash-input'); if (i) i.focus();
    },
    'flash-random': function () {
      T.flash.i = Math.floor(Math.random() * SCENES.length);
      T.flash.phase = 'write'; T.flash.answer = '';
      render();
    },
    'flash-reveal': function () {
      T.flash.answer = ($('#flash-input') || {}).value || '';
      if (T.flash.done.indexOf(T.flash.i) < 0) T.flash.done.push(T.flash.i);
      T.flash.phase = 'show'; render();
    },
    'flash-next': function () {
      var n = (T.flash.i + 1) % SCENES.length;
      T.flash.i = n; T.flash.phase = 'write'; T.flash.answer = '';
      render();
      var i = $('#flash-input'); if (i) i.focus();
    },

    /* ---- 复盘卡 ---- */
    'review-dim': function () { },
    'review-save': function () {
      var c = T.chat;
      if (!c || !c.review) return;
      /* 以 AI 解析出来的分数为底，用你在输入框里改过的值覆盖 */
      var dims = {};
      DIM_KEYS.forEach(function (k) { if (c.review.dims[k] != null) dims[k] = c.review.dims[k]; });
      DIM_KEYS.forEach(function (k) {
        var el = $('[data-act="review-dim"][data-dim="' + k + '"]');
        var v = el ? parseInt(el.value, 10) : NaN;
        if (!isNaN(v)) dims[k] = clamp(v, 0, 2);
      });
      var sum = 0, n = 0;
      DIM_KEYS.forEach(function (k) { if (dims[k] != null) { sum += dims[k]; n++; } });
      var impEl = $('#review-improve');
      var imp = impEl ? impEl.value : '';
      if (!imp && !T.improveTouched) imp = c.review.improve || '';
      c.review.dims = dims;
      c.review.perfect = n === 6;
      c.review.total = n === 6 ? sum : null;
      c.review.improve = imp;
      persistChat(true);
      if (imp) S.focus = imp;
      save(true);
      toast('已保存这场记录');
      T.chat = null; T.tab = 'archive'; T.archId = ''; render();
    },
    'review-raw': function () {
      var c = T.chat;
      if (!c || !c.review) return;
      openModal('<h2>AI 复盘原文</h2><div class="small" style="white-space:pre-wrap">' + esc(c.review.raw) + '</div>' +
        '<div class="row mt"><button class="btn" data-act="close-modal">关闭</button></div>');
    },

    /* ---- 准备 ---- */
    'prep-pick': function (el) { T.prepId = el.getAttribute('data-id'); render(); },
    'prep-type': function (el) { T.prepType = el.getAttribute('data-k'); T.prepId = ''; render(); },
    print: function () { window.print(); },
    'copy-brief': function () {
      var a = T.prepId ? S.archives.filter(function (x) { return x.id === T.prepId; })[0] : null;
      var ty = typeOf(a && a.type ? a.type : T.prepType);
      var lines = [];
      lines.push((a ? a.name : '临时对象') + ' · ' + ty.n + (a && a.typeBasis ? '（依据：' + a.typeBasis + '）' : ''));
      lines.push('');
      lines.push('⚠ 本场只改一条：' + (S.focus || '（未设）'));
      lines.push('');
      if (a) {
        lines.push('上次走到：' + (a.stageNote || '—'));
        lines.push('重要性/信心：' + num(a.importance) + ' / ' + num(a.confidence));
        lines.push('上次的顾虑：' + (a.objection || '—'));
        lines.push('这次下一步：' + (a.nextNote || '—'));
        lines.push('');
      }
      lines.push('破冰：' + ty.ice);
      lines.push('痛点切入：' + ty.pain);
      lines.push('最容易反感：' + ty.hate);
      lines.push('成交方式：' + ty.close);
      lines.push('');
      lines.push('✕ 绝对不说：「' + ty.taboo + '」／' + ty.ban.join('／'));
      lines.push('');
      lines.push('精准问题：');
      ty.qs.slice(0, 4).forEach(function (q) { lines.push('  · ' + q); });
      lines.push('');
      lines.push('30 分钟节奏：');
      RHYTHM.forEach(function (r) { lines.push('  ' + r[0] + ' ' + r[1] + ' — ' + r[2]); });
      lines.push('');
      lines.push('开场自检：' + RED_ASK.join(' / '));
      copyText(lines.join('\n'));
    },
    'gate-check': function () {
      var txt = ($('#gate-input') || {}).value || '';
      T.gateText = txt;
      var out = [];
      if (!txt.trim()) { $('#gate-out').innerHTML = '<div class="msg info small mt">先写一句要说的话。</div>'; return; }
      var hit = [];
      TRIPWIRES.forEach(function (t) { if (t.p.test(txt)) hit.push(t); });
      if (hit.length) {
        out.push('<div class="msg bad mt">命中 ' + hit.length + ' 处。这句话不能说，或者说出口责任在你。</div>');
        hit.forEach(function (t) {
          out.push('<div class="card bad tight"><div class="b small">' + esc(t.n) + '</div>' +
            '<div class="small mt">' + esc(t.why) + '</div>' +
            '<div class="msg ok tiny mt">改成：' + esc(t.fix) + '</div></div>');
        });
      } else {
        out.push('<div class="msg ok mt">没有命中红线模式库。但模式库只覆盖已知的几类，不能替代判断。</div>');
      }
      out.push('<div class="card tight mt"><div class="tiny muted">自检三问</div><ul class="dots mt" style="margin-bottom:0">' +
        RED_ASK.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul></div>');
      out.push('<div class="card tight"><div class="tiny muted">必须做到的四件事</div><ul class="dots mt" style="margin-bottom:0">' +
        RED_MUST.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul></div>');
      $('#gate-out').innerHTML = out.join('');
    },
    'gate-clear': function () { T.gateText = ''; render(); },
    'gate-next': function () { T.gate = Math.min(TREE.length - 1, T.gate + 1); render(); },
    'gate-reset': function () { T.gate = 0; render(); },
    'match-set': function (el) {
      var i = parseInt(el.getAttribute('data-i'), 10);
      var v = parseInt(el.getAttribute('data-v'), 10);
      T.match[i] = (T.match[i] === v ? null : v);
      render();
    },
    'match-reset': function () { T.match = [null, null, null, null, null]; render(); },
    'match-intro': function () {
      openModal('<h2>念给他听</h2><div style="font-size:16px;line-height:1.8">' + esc(MATCH5_INTRO) + '</div>' +
        '<div class="row mt"><button class="btn" data-act="close-modal">知道了</button></div>');
    },

    /* ---- 档案 ---- */
    'arch-new': function () {
      var a = {
        id: uid(), createdAt: nowStamp(), updatedAt: nowStamp(), meetCount: 1,
        name: '', grade: '', major: '', src: '', date: dayKey(), lastContact: dayKey(), nextFollow: '',
        type: '', typeBasis: '', need: {}, importance: '', confidence: '', why: '',
        path: '', pathWhy: '', match5: [null, null, null, null, null], finance: {},
        objection: '', objectionType: '', realReason: '', result: '',
        advisedNo: false, keepInTouch: false, deepTalk: false,
        stageNote: '', nextNote: '', improve: ''
      };
      S.archives.push(a);
      save(true);
      T.archId = a.id;
      render();
    },
    'open-archive': function (el) { T.archId = el.getAttribute('data-id'); T.funnelView = false; render(); window.scrollTo({ top: 0 }); },
    'arch-back': function () { T.archId = ''; T.funnelView = false; render(); },
    'arch-save': function () {
      var a = currentFormObj();
      if (!a) return;
      a.updatedAt = nowStamp();
      save(true);
      toast('已保存');
      render();
    },
    'arch-del': function (el) {
      var id = el.getAttribute('data-id');
      var a = S.archives.filter(function (x) { return x.id === id; })[0];
      confirmBox('删除「' + (a ? a.name || '未命名' : '') + '」？这条档案的场次记录会保留，但不再关联。', function () {
        S.archives = S.archives.filter(function (x) { return x.id !== id; });
        save(true); T.archId = ''; render(); toast('已删除');
      }, '删除');
    },
    'prep-from-arch': function (el) { T.prepId = el.getAttribute('data-id'); T.tab = 'prep'; render(); window.scrollTo({ top: 0 }); },
    'drill-for-arch': function (el) {
      var a = S.archives.filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
      if (!a) return;
      T.chat = { persona: a.type || 'tiger', level: 'hard', scenes: [], messages: [], streaming: false, review: null, id: uid(), createdAt: nowStamp(), archiveId: a.id, archiveName: a.name };
      T.tab = 'drill';
      render();
      chatSetupModal();
    },
    funnel: function () { T.funnelView = true; T.archId = ''; render(); window.scrollTo({ top: 0 }); },

    'phrase-new': function (el) {
      var archId = el.getAttribute('data-arch') || '';
      openModal('<h2>加一条话术</h2>' +
        '<label class="f"><span>场景</span><input id="ph-scene" placeholder="对方说「我怕坚持不下来」"></label>' +
        '<label class="f"><span>当时怎么处理的（含效果）</span><textarea id="ph-then" rows="2" placeholder="直接讲了课程有打卡机制（效果：对方没有回应）"></textarea></label>' +
        '<label class="f"><span>更好的处理</span><textarea id="ph-better" rows="2" placeholder="先问「什么安排让你过去坚持成功过」，再决定讲不讲机制"></textarea></label>' +
        '<div class="inline"><label class="f"><span>适用类型</span><input id="ph-type" placeholder="考拉、变色龙"></label>' +
        '<label class="f"><span>来源</span><input id="ph-src" value="' + esc(dayKey()) + '"></label></div>' +
        '<div class="row"><button class="btn primary" data-act="phrase-save" data-arch="' + esc(archId) + '">保存</button>' +
        '<button class="btn ghost" data-act="close-modal">取消</button></div>');
    },
    'phrase-save': function (el) {
      var p = {
        id: uid(), archiveId: el.getAttribute('data-arch') || '',
        scene: ($('#ph-scene') || {}).value || '',
        then: ($('#ph-then') || {}).value || '',
        better: ($('#ph-better') || {}).value || '',
        type: ($('#ph-type') || {}).value || '',
        src: ($('#ph-src') || {}).value || ''
      };
      if (!p.scene) { toast('场景不能空'); return; }
      S.phrases.push(p); save(true); closeModal(); render(); toast('已加入话术库');
    },
    'phrase-del': function (el) {
      var id = el.getAttribute('data-id');
      S.phrases = S.phrases.filter(function (p) { return p.id !== id; });
      save(true); render();
    },
    'phrase-guide': function () {
      openModal('<h2>话术库纪律</h2><ul class="dots">' + PHRASE_RULES.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
        '<div class="msg info tiny">' + esc(PHRASE_WHY) + '</div><div class="row mt"><button class="btn" data-act="close-modal">关闭</button></div>');
    },

    'data-panel': dataModal,
    'need-owner': function (el) {
      var a = currentFormObj();
      if (!a) return;
      var k = el.getAttribute('data-k');
      var v = el.getAttribute('data-v');
      a.needOwner = a.needOwner || {};
      a.needOwner[k] = v;
      a.updatedAt = nowStamp();
      save(true);
      var box = el.parentNode;
      if (box && box.querySelectorAll) {
        $$('[data-act="need-owner"]', box).forEach(function (b) {
          b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === v));
        });
      }
      var out = $('#need-audit');
      if (out) out.innerHTML = needAuditHTML(a);
    },
    'session-view': function (el) { sessionView(el.getAttribute('data-id')); },
    'session-del': function (el) {
      var id = el.getAttribute('data-id');
      confirmBox('删除这条场次记录？', function () {
        S.sessions = S.sessions.filter(function (x) { return x.id !== id; });
        save(true); render(); toast('已删除');
      }, '删除');
    },
    export: exportJSON,
    import: importJSON,
    'migrate-v1': migrateV1,
    wipe: wipeAll,

    'supplement-resource': function (el) { var id = el.getAttribute('data-id'); go('library'); if (window.ZLLibrary) window.ZLLibrary.open($('#view'), id); },
    'manual-clear': function () { T.manualQ = ''; render(); },
    'manual-goto': function (el) {
      T.manualQ = '';
      render();
      var i = el.getAttribute('data-si');
      var d = document.querySelector('details[data-sec="' + i + '"]');
      if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); }
    }
  };

  function chatSetupModal() {
    var c = T.chat;
    var h = ['<h2>这一场怎么练</h2>', '<p class="small muted">AI 对话会发送至 DeepSeek，请使用虚构情境，避免输入真实个人信息。</p>'];
    h.push('<label class="f"><span>对手人格</span></label><div class="chips">');
    TYPES.forEach(function (t) {
      h.push('<button class="chip' + (c.persona === t.k ? '" aria-pressed="true' : '') + '" data-act="chat-persona" data-k="' + t.k + '">' + esc(t.n) + '</button>');
    });
    h.push('<button class="chip' + (c.persona === 'any' ? '" aria-pressed="true' : '') + '" data-act="chat-persona" data-k="any">随机（不告诉你）</button></div>');
    var ty = c.persona === 'any' ? null : typeOf(c.persona);
    if (ty) h.push('<div class="tiny muted mt">' + esc(ty.sum) + ' ／ 核心恐惧：' + esc(ty.fear) + '</div>');
    h.push('<label class="f mt"><span>难度</span></label><div class="chips">');
    ['easy', 'mid', 'hard'].forEach(function (k) {
      h.push('<button class="chip' + (c.level === k ? '" aria-pressed="true' : '') + '" data-act="chat-level" data-k="' + k + '">' + esc(LEVEL_NAMES[k]) + '</button>');
    });
    h.push('</div>');
    h.push('<label class="f mt"><span>重点情境（可多选，也可以不选）</span></label><div class="chips" style="max-height:190px;overflow:auto">');
    SCENES.forEach(function (s, i) {
      h.push('<button class="chip' + (c.scenes.indexOf(i) >= 0 ? '" aria-pressed="true' : '') + '" style="font-size:12px;padding:5px 10px" data-act="chat-scene" data-i="' + i + '">' + (i + 1) + '. ' + esc(s.n.length > 12 ? s.n.slice(0, 12) + '…' : s.n) + (s.hard ? '★' : '') + '</button>');
    });
    h.push('</div>');
    h.push('<div class="msg info small mt">你扮演推荐者，AI 只回答你问的问题，不会替你推进流程。练到一半 AI 变配合了，点「出戏了」。</div>');
    h.push('<div class="row"><button class="btn primary" data-act="chat-start">开始对话</button>' +
      '<button class="btn ghost" data-act="close-modal">取消</button></div>');
    openModal(h.join(''));
  }

  function settingsModal() {
    var h = ['<h2>设置与数据</h2>'];
    h.push('<label class="f"><span>模型</span><select data-act="set-model">' +
      AI_MODELS.map(function (m) { return '<option value="' + m[0] + '"' + (S.settings.model === m[0] ? ' selected' : '') + '>' + esc(m[0]) + ' — ' + esc(m[1]) + '</option>'; }).join('') +
      '</select></label>');
    h.push('<label class="f"><span>接口路径（默认 /api/chat）</span><input type="text" data-act="set-path" value="' + esc(S.settings.apiPath) + '"></label>');
    h.push('<div class="msg info small">API key 只存在服务端。别人打开你的网址看不到它。</div>');
    h.push('<hr>');
    h.push('<div class="b small">数据</div>');
    h.push('<div class="small muted mt">' + S.archives.length + ' 份档案 · ' + S.sessions.length + ' 场记录 · ' + S.phrases.length + ' 条话术。数据存在这台设备的浏览器里，换设备不会跟着走——所以要定期导出。</div>');
    h.push('<div class="row mt"><button class="btn" data-act="export">导出 JSON</button>' +
      '<button class="btn" data-act="import">导入 JSON</button>' +
      '<button class="btn ghost" data-act="migrate-v1">从 v1 导入</button></div>');
    h.push('<div class="row mt"><button class="btn danger sm" data-act="wipe">清空全部数据</button></div>');
    h.push('<hr>');
    h.push('<div class="tiny muted">' + esc(ARCHIVE_DISCIPLINE[2]) + '<br>' + esc(DATA_RULES[1]) + '</div>');
    h.push('<div class="row mt"><button class="btn" data-act="close-modal">关闭</button></div>');
    openModal(h.join(''));
  }

  function dataModal() { settingsModal(); }

  /* 变更：select / input 上的 data-act 在设置里用 change 事件 */
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var a = el.getAttribute('data-act');
    if (a === 'set-model') { S.settings.model = el.value; save(true); toast('已切换模型'); }
    if (a === 'set-path') { S.settings.apiPath = el.value; save(true); }
  });

  /* ============ 14. 对话流程 ============ */
  function sendChat(text, isReview) {
    var c = T.chat;
    if (!c || c.streaming) return;
    var input = $('#chat-input');
    var msg = text != null ? text : (input ? input.value : '').trim();
    if (!msg) return;
    if (text == null && input) { input.value = ''; input.style.height = 'auto'; }

    c.messages.push({ role: 'user', content: msg });
    c.streaming = true;
    render();

    var msgs = [{ role: 'system', content: buildSystemPrompt(c.persona, c.level, c.scenes) }].concat(trimHistory(c.messages));
    var bubble = $('#live-text');
    var acc = '';

    streamChat(msgs, function (delta, full) {
      acc = full;
      if (!bubble) bubble = $('#live-text');
      if (bubble) bubble.textContent = acc;
      var wrap = $('#chat-wrap');
      if (wrap) wrap.scrollTop = wrap.scrollHeight;
      var lb = $('#live-bubble');
      if (lb && lb.scrollIntoView) lb.scrollIntoView({ block: 'nearest' });
    }).then(function (full) {
      c.messages.push({ role: 'assistant', content: full || acc || '（空回复）' });
      c.streaming = false;
      if (isReview) {
        c.review = parseReview(full || acc);
        T.improveTouched = false;
        save(true);
        render();
        var rc = $('#review-card');
        if (rc) rc.scrollIntoView({ block: 'center' });
      } else {
        render();
        save();
        var i = $('#chat-input'); if (i) i.focus();
      }
    }).catch(function (err) {
      c.streaming = false;
      c.messages.push({ role: 'assistant', content: '（接口出错）' });
      render();
      var m = String(err && err.message || err);
      var hint = '';
      if (/Failed to fetch|NetworkError|load failed/i.test(m)) {
        hint = '<br>本地打开 HTML 文件时没有 /api/chat。请用 <b>vercel dev</b> 启动，或部署后再用。';
      }
      openModal('<h2>接口出错</h2><div class="msg bad small">' + esc(m) + hint + '</div>' +
        '<div class="row mt"><button class="btn" data-act="close-modal">关闭</button></div>');
    });
  }

  function persistChat(scored) {
    var c = T.chat;
    if (!c || !c.messages.length) return;
    var rec = {
      id: c.id,
      createdAt: c.createdAt,
      archiveId: c.archiveId || '',
      archiveName: c.archiveName || '',
      persona: c.persona,
      level: c.level,
      scenes: c.scenes.slice(),
      model: S.settings.model,
      messages: c.messages.slice(-80),
      review: c.review ? {
        dims: c.review.dims, total: c.review.total, perfect: c.review.perfect,
        improve: c.review.improve, raw: String(c.review.raw || '').slice(0, 6000)
      } : null
    };
    var i = S.sessions.map(function (s) { return s.id; }).indexOf(c.id);
    if (i >= 0) S.sessions[i] = rec; else S.sessions.push(rec);
    if (c.archiveId) {
      var a = S.archives.filter(function (x) { return x.id === c.archiveId; })[0];
      if (a) a.updatedAt = nowStamp();
    }
    save(true);
  }

  /* 关掉页面前，把没复盘完的对话也留一条记录 */
  function autosaveOnUnload() {
    if (T.chat && T.chat.messages.length && !T.chat.streaming) persistChat(false);
  }
  window.addEventListener('beforeunload', function () { autosaveOnUnload(); save(true); });

  /* ============ 15. 导入导出 ============ */
  function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('已复制'); }, function () { fallbackCopy(txt); });
    } else fallbackCopy(txt);
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败，请手动选中'); }
    document.body.removeChild(ta);
  }

  function exportJSON() {
    var blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '点亮高手训练器-' + dayKey() + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 500);
    toast('已导出');
  }

  function importJSON() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var o = JSON.parse(r.result);
          if (!o || typeof o !== 'object') throw new Error('不是有效的 JSON');
          mergeState(o);
          toast('导入完成');
        } catch (e) { toast('导入失败：' + e.message); }
      };
      r.readAsText(f);
    };
    inp.click();
  }

  function mergeState(o) {
    var ids = {};
    S.archives.forEach(function (a) { ids[a.id] = true; });
    (o.archives || []).forEach(function (a) {
      if (!a.id) a.id = uid();
      if (ids[a.id]) a.id = uid();
      ids[a.id] = true;
      S.archives.push(a);
    });
    var sids = {};
    S.sessions.forEach(function (s) { sids[s.id] = true; });
    (o.sessions || []).forEach(function (s) {
      if (!s.id) s.id = uid();
      if (sids[s.id]) s.id = uid();
      sids[s.id] = true;
      S.sessions.push(s);
    });
    (o.phrases || []).forEach(function (p) { if (!p.id) p.id = uid(); S.phrases.push(p); });
    if (o.drills) Object.keys(o.drills).forEach(function (k) { if (o.drills[k]) S.drills[k] = true; });
    save(true);
    render();
  }

  function migrateV1() {
    var raw;
    try { raw = localStorage.getItem(V1KEY); } catch (e) { }
    if (!raw) { toast('这台设备上没找到 v1 的数据'); return; }
    var o;
    try { o = JSON.parse(raw); } catch (e) { toast('v1 数据解析失败'); return; }
    var nDays = 0, nRec = 0;
    if (o.done) {
      Object.keys(o.done).forEach(function (k) {
        if (o.done[k]) { S.drills[k] = true; nDays++; }
      });
    }
    (o.records || []).forEach(function (r) {
      var dims = {};
      if (r.dims && r.dims.length) {
        DIM_KEYS.forEach(function (k, i) { if (r.dims[i] != null) (dims[k] = r.dims[i]); });
      }
      var sum = 0, n = 0;
      DIM_KEYS.forEach(function (k) { if (dims[k] != null) { sum += dims[k]; n++; } });
      S.sessions.push({
        id: 'v1-' + (r.id || uid()),
        createdAt: r.date || nowStamp(),
        archiveId: '', archiveName: '',
        persona: r.type || '', level: r.w || '', scenes: [],
        model: 'v1', messages: [],
        review: {
          dims: dims, total: n === 6 ? sum : null, perfect: n === 6,
          improve: r.note || '', raw: '（从 v1 导入）' + (r.note || '')
        }
      });
      nRec++;
    });
    save(true);
    render();
    openModal('<h2>v1 导入完成</h2><div class="small">导入 ' + nDays + ' 天打卡、' + nRec + ' 条复盘记录。v1 的原始数据没有被改动。</div>' +
      '<div class="row mt"><button class="btn primary" data-act="close-modal">好</button></div>');
  }

  function wipeAll() {
    confirmBox('清空这台设备上的全部档案、场次和话术？建议先导出 JSON。', function () {
      try { localStorage.removeItem(LSKEY); } catch (e) { }
      S = blankState();
      T.archId = ''; T.chat = null; T.flash = null;
      save(true); render(); toast('已清空');
    }, '清空');
  }

  /* ============ 16. 事件委托 ============ */
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute('data-act')) {
        var name = el.getAttribute('data-act');
        if (name === 'review-dim' || name === 'set-model' || name === 'set-path') return;
        var fn = ACT[name];
        if (fn) { e.preventDefault(); fn(el); }
        return;
      }
      el = el.parentNode;
    }
  });


  /* ============ 17. 启动 ============ */
  function init() {
    var t = S.settings.theme;
    if (!t) {
      t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0f1115' : '#faf7f2');
    render();
    window.addEventListener('resize', function () {
      if (T.tab === 'archive' && T.archId) {
        var list = S.sessions.filter(function (s) { return s.archiveId === T.archId && s.review && s.review.perfect; }).slice(-16);
        if (list.length) drawTrend(list);
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
