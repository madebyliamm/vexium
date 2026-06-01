(function () {
  // Style can go in head immediately
  const style = document.createElement('style');
  style.textContent = `
    #tgOverlay {
      display:none;position:fixed;inset:0;z-index:9999;
      background:rgba(0,0,0,.85);backdrop-filter:blur(16px);
      align-items:center;justify-content:center;padding:24px;
    }
    #tgOverlay.show{display:flex}
    @keyframes tgIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
    .tg-box{
      background:#0f0f0f;border:1px solid rgba(255,255,255,.08);
      border-radius:22px;padding:40px 36px 36px;max-width:500px;width:100%;
      text-align:center;box-shadow:0 40px 100px rgba(0,0,0,.8);
      animation:tgIn .28s cubic-bezier(.16,1,.3,1);
    }
    .tg-badge{
      display:inline-flex;align-items:center;gap:6px;
      background:rgba(239,68,68,.1);color:rgba(239,68,68,.85);
      font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
      padding:4px 12px;border-radius:99px;margin-bottom:18px;
    }
    .tg-box h2{font-size:clamp(22px,3.5vw,30px);font-weight:800;letter-spacing:-.04em;margin:0 0 10px;color:#fff}
    .tg-box p{font-size:14px;color:rgba(255,255,255,.45);line-height:1.65;margin:0 0 28px}
    .tg-plans{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
    .tg-plan{
      background:rgba(255,255,255,.05);border-radius:14px;padding:18px 12px 16px;
      text-decoration:none;color:#fff;display:block;
      transition:background .15s,transform .15s;
    }
    .tg-plan:hover{background:rgba(255,255,255,.09);transform:translateY(-2px)}
    .tg-plan.featured{background:#fff;color:#000}
    .tg-plan.featured:hover{background:#efefef}
    .tg-plan-name{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;opacity:.5;margin-bottom:8px}
    .tg-plan-price{font-size:26px;font-weight:800;letter-spacing:-.05em;line-height:1}
    .tg-plan-price span{font-size:11px;font-weight:500;opacity:.45;letter-spacing:0}
    .tg-plan-tag{font-size:10px;margin-top:7px;opacity:.4;line-height:1.4}
    .tg-plan-cta{
      display:block;margin-top:14px;padding:8px;
      background:rgba(255,255,255,.1);border-radius:8px;
      font-size:12px;font-weight:700;
    }
    .tg-plan.featured .tg-plan-cta{background:rgba(0,0,0,.1)}
    @media(max-width:460px){.tg-plans{grid-template-columns:1fr}.tg-box{padding:28px 20px 24px}}
  `;
  document.head.appendChild(style);

  // Inject overlay HTML once body is ready
  function injectOverlay() {
    if (document.getElementById('tgOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'tgOverlay';
    overlay.innerHTML = `
      <div class="tg-box">
        <div class="tg-badge">Trial ended</div>
        <h2>Your free trial has ended</h2>
        <p>You built something great — keep going.<br>Your projects stay exactly as they are.</p>
        <div class="tg-plans">
          <a href="settings.html?tab=billing&plan=starter" class="tg-plan">
            <div class="tg-plan-name">Starter</div>
            <div class="tg-plan-price">$12<span>/mo</span></div>
            <div class="tg-plan-tag">3 sites · Custom domain</div>
            <div class="tg-plan-cta">Get Starter</div>
          </a>
          <a href="settings.html?tab=billing&plan=pro" class="tg-plan featured">
            <div class="tg-plan-name">Pro</div>
            <div class="tg-plan-price">$29<span>/mo</span></div>
            <div class="tg-plan-tag">Unlimited · Payments</div>
            <div class="tg-plan-cta">Get Pro</div>
          </a>
          <a href="settings.html?tab=billing&plan=max" class="tg-plan">
            <div class="tg-plan-name">Max</div>
            <div class="tg-plan-price">$79<span>/mo</span></div>
            <div class="tg-plan-tag">White-label · Clients</div>
            <div class="tg-plan-cta">Get Max</div>
          </a>
        </div>
        <a href="index.html" style="display:inline-block;margin-top:24px;opacity:.4;transition:opacity .15s" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='.4'">
          <img src="vexium_logo.png" width="28" height="28" style="border-radius:7px;display:block"/>
        </a>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  if (document.body) {
    injectOverlay();
  } else {
    document.addEventListener('DOMContentLoaded', injectOverlay);
  }

  window.checkTrialGuard = async function (sb, userId) {
    if (!sb || !userId) return;
    try {
      const { data } = await sb.from('profiles')
        .select('plan, trial_ends_at')
        .eq('id', userId).single();
      if (!data || data.plan !== 'trial') return;
      if (!data.trial_ends_at) return;
      if (new Date(data.trial_ends_at) > new Date()) return;
      injectOverlay();
      document.getElementById('tgOverlay').classList.add('show');
    } catch (e) {}
  };
})();
