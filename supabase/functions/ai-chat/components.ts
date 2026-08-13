// Vertly Component Library
// Pre-built, production-quality section HTML the AI adapts (colors/copy/fonts) rather than improvising from scratch.
// Scoped class names (vxc-XX__) so multiple components can coexist on one page without collisions.

export interface VxComponent {
  id: string;
  name: string;
  category: 'hero' | 'features' | 'pricing' | 'testimonials' | 'cta' | 'nav' | 'footer' | 'accent' | 'dataviz' | 'flair';
  tags: string[];
  description: string;
  html: string;
}

// ════════════════════════════════════════════════════════════════
// HEROES
// ════════════════════════════════════════════════════════════════

const HERO_RADIANT_CENTER: VxComponent = {
  id: 'hero-radiant-center',
  name: 'Radiant Center',
  category: 'hero',
  tags: ['dark', 'animated', 'orbs', 'gradient-text', 'social-proof'],
  description: 'Dark bg with three slow-floating ambient orbs, centered headline with gradient-text accent, live badge with pulse dot, dual CTA, avatar-stack social proof. Best for SaaS, startups, modern products.',
  html: `<section class="vxc-h1">
  <style>
    .vxc-h1{min-height:100vh;background:#06060a;display:flex;align-items:center;justify-content:center;text-align:center;position:relative;overflow:hidden;padding:120px 24px}
    .vxc-h1__orb{position:absolute;border-radius:50%;filter:blur(120px);pointer-events:none;animation:vxcH1Float 14s ease-in-out infinite}
    .vxc-h1__orb--1{width:600px;height:600px;background:radial-gradient(circle,#6d28d9,transparent);top:-220px;left:-160px}
    .vxc-h1__orb--2{width:520px;height:520px;background:radial-gradient(circle,#1d4ed8,transparent);bottom:-180px;right:-120px;animation-delay:4s}
    .vxc-h1__orb--3{width:360px;height:360px;background:radial-gradient(circle,#0e7490,transparent);top:48%;left:58%;animation-delay:8s}
    @keyframes vxcH1Float{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(40px,-30px) scale(1.06)}66%{transform:translate(-25px,35px) scale(.94)}}
    .vxc-h1__inner{position:relative;z-index:2;max-width:860px;margin:0 auto}
    .vxc-h1__badge{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.09);border-radius:100px;padding:6px 16px 6px 10px;font-size:13px;color:rgba(255,255,255,.65);margin-bottom:36px;backdrop-filter:blur(12px)}
    .vxc-h1__dot{width:8px;height:8px;background:#22c55e;border-radius:50%;box-shadow:0 0 0 0 rgba(34,197,94,.5);animation:vxcH1Pulse 2s ease-out infinite}
    @keyframes vxcH1Pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
    .vxc-h1 h1{font-size:clamp(52px,7.5vw,92px);font-weight:900;line-height:1.03;letter-spacing:-.04em;color:#fff;margin:0 0 24px}
    .vxc-h1__grad{background:linear-gradient(130deg,#a78bfa 0%,#60a5fa 45%,#34d399 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
    .vxc-h1 p{font-size:clamp(16px,2.2vw,20px);color:rgba(255,255,255,.5);max-width:520px;margin:0 auto 44px;line-height:1.75}
    .vxc-h1__btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
    .vxc-h1__cta{background:#fff;color:#050508;border:none;border-radius:12px;padding:14px 28px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px;transition:transform .2s cubic-bezier(.34,1.56,.64,1),box-shadow .2s;letter-spacing:-.01em}
    .vxc-h1__cta:hover{transform:translateY(-3px) scale(1.01);box-shadow:0 16px 48px rgba(255,255,255,.15)}
    .vxc-h1__ghost{background:rgba(255,255,255,.08);color:rgba(255,255,255,.75);border-radius:12px;padding:14px 28px;font-size:15px;font-weight:500;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px;transition:background .2s,color .2s}
    .vxc-h1__ghost:hover{background:rgba(255,255,255,.13);color:#fff}
    .vxc-h1__proof{margin-top:60px;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap}
    .vxc-h1__avs{display:flex}
    .vxc-h1__av{width:30px;height:30px;border-radius:50%;border:2px solid #06060a;margin-left:-8px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff}
    .vxc-h1__av:first-child{margin-left:0}
    .vxc-h1__av--a{background:#7c3aed}.vxc-h1__av--b{background:#2563eb}.vxc-h1__av--c{background:#0891b2}.vxc-h1__av--d{background:#16a34a}.vxc-h1__av--e{background:#dc2626}
    .vxc-h1__stars{color:#fbbf24;font-size:13px;letter-spacing:2px}
    .vxc-h1__prooftxt{font-size:13px;color:rgba(255,255,255,.38)}
    @keyframes vxcH1In{from{transform:translateY(28px)}to{transform:translateY(0)}}
    .vxc-h1__badge{animation:vxcH1In .6s cubic-bezier(.16,1,.3,1) .05s both}
    .vxc-h1 h1{animation:vxcH1In .7s cubic-bezier(.16,1,.3,1) .1s both}
    .vxc-h1 p{animation:vxcH1In .7s cubic-bezier(.16,1,.3,1) .2s both}
    .vxc-h1__btns{animation:vxcH1In .7s cubic-bezier(.16,1,.3,1) .3s both}
    .vxc-h1__proof{animation:vxcH1In .7s cubic-bezier(.16,1,.3,1) .4s both}
  </style>
  <div class="vxc-h1__orb vxc-h1__orb--1"></div>
  <div class="vxc-h1__orb vxc-h1__orb--2"></div>
  <div class="vxc-h1__orb vxc-h1__orb--3"></div>
  <div class="vxc-h1__inner">
    <div class="vxc-h1__badge"><span class="vxc-h1__dot"></span>Just launched — see what's new</div>
    <h1>The smarter way to<br><span class="vxc-h1__grad">grow your business</span></h1>
    <p>Stop piecing together tools that don't talk to each other. Everything you need, beautifully unified and ready to go.</p>
    <div class="vxc-h1__btns">
      <a href="#" class="vxc-h1__cta">Start for free →</a>
      <a href="#" class="vxc-h1__ghost">Watch demo</a>
    </div>
    <div class="vxc-h1__proof">
      <div class="vxc-h1__avs">
        <div class="vxc-h1__av vxc-h1__av--a">JM</div>
        <div class="vxc-h1__av vxc-h1__av--b">SK</div>
        <div class="vxc-h1__av vxc-h1__av--c">AL</div>
        <div class="vxc-h1__av vxc-h1__av--d">TR</div>
        <div class="vxc-h1__av vxc-h1__av--e">PC</div>
      </div>
      <span class="vxc-h1__stars">★★★★★</span>
      <span class="vxc-h1__prooftxt">Trusted by 3,200+ businesses</span>
    </div>
  </div>
</section>`
};

const HERO_PRODUCT_SPLIT: VxComponent = {
  id: 'hero-product-split',
  name: 'Product Split',
  category: 'hero',
  tags: ['dark', 'split-layout', 'mockup', 'logos'],
  description: 'Dark two-column hero: headline/copy/CTAs on the left, a CSS-only browser-chrome mockup with fake product UI on the right, greyscale logo strip beneath. Best for SaaS/product-led tools.',
  html: `<section class="vxc-h2">
  <style>
    .vxc-h2{background:#08080d;padding:140px 24px 100px;position:relative;overflow:hidden}
    .vxc-h2__glow{position:absolute;top:20%;right:-10%;width:600px;height:600px;background:radial-gradient(circle,rgba(99,102,241,.18),transparent 70%);filter:blur(60px);pointer-events:none}
    .vxc-h2__wrap{max-width:1240px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center;position:relative;z-index:2}
    @media(max-width:900px){.vxc-h2__wrap{grid-template-columns:1fr}}
    .vxc-h2__tag{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#818cf8;background:rgba(99,102,241,.12);padding:6px 14px;border-radius:8px;margin-bottom:28px}
    .vxc-h2 h1{font-size:clamp(40px,5.5vw,62px);font-weight:800;line-height:1.08;letter-spacing:-.03em;color:#fff;margin:0 0 22px}
    .vxc-h2 p{font-size:18px;line-height:1.7;color:rgba(255,255,255,.5);max-width:460px;margin:0 0 36px}
    .vxc-h2__btns{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:56px}
    .vxc-h2__cta{background:#6366f1;color:#fff;border:none;border-radius:11px;padding:15px 28px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px;transition:transform .2s,box-shadow .2s}
    .vxc-h2__cta:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(99,102,241,.4)}
    .vxc-h2__ghost{background:rgba(255,255,255,.09);color:#fff;border-radius:11px;padding:15px 28px;font-size:15px;font-weight:500;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:10px;transition:background .2s}
    .vxc-h2__ghost:hover{background:rgba(255,255,255,.14)}
    .vxc-h2__ghost:hover{background:rgba(255,255,255,.09)}
    .vxc-h2__playdot{width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;font-size:9px}
    .vxc-h2__logos{display:flex;align-items:center;gap:32px;flex-wrap:wrap;opacity:.4}
    .vxc-h2__logos span{font-size:13px;font-weight:700;letter-spacing:.02em;color:#fff}
    .vxc-h2__logolabel{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.3);margin-bottom:16px}
    .vxc-h2__mock{background:#0e0e16;border-radius:16px;overflow:hidden;box-shadow:0 40px 100px rgba(0,0,0,.5);transform:rotate(1deg)}
    .vxc-h2__mockbar{display:flex;align-items:center;gap:6px;padding:14px 16px;background:#13131d;border-bottom:1px solid rgba(255,255,255,.05)}
    .vxc-h2__mockdot{width:10px;height:10px;border-radius:50%}
    .vxc-h2__mockdot--r{background:#ff5f57}.vxc-h2__mockdot--y{background:#febc2e}.vxc-h2__mockdot--g{background:#28c840}
    .vxc-h2__mockurl{margin-left:14px;background:rgba(255,255,255,.06);border-radius:6px;padding:5px 14px;font-size:11px;color:rgba(255,255,255,.4);font-family:monospace}
    .vxc-h2__mockbody{padding:28px;display:grid;gap:14px}
    .vxc-h2__mockrow{display:flex;gap:14px;align-items:center}
    .vxc-h2__mockcard{background:rgba(255,255,255,.04);border-radius:10px;padding:18px;flex:1}
    .vxc-h2__mockline{height:9px;border-radius:4px;background:rgba(255,255,255,.1);margin-bottom:8px}
    .vxc-h2__mockchart{height:90px;border-radius:10px;background:linear-gradient(180deg,rgba(99,102,241,.25),rgba(99,102,241,.02));position:relative;overflow:hidden}
    .vxc-h2__mockchart::after{content:'';position:absolute;inset:0;background:linear-gradient(105deg,transparent 40%,rgba(99,102,241,.5) 50%,transparent 60%);background-size:250% 100%;animation:vxcH2Shimmer 3.5s ease-in-out infinite}
    @keyframes vxcH2Shimmer{0%{background-position:150% 0}100%{background-position:-50% 0}}
    @keyframes vxcH2In{from{transform:translateY(26px)}to{transform:translateY(0)}}
    .vxc-h2__col{animation:vxcH2In .7s cubic-bezier(.16,1,.3,1) both}
    .vxc-h2__mock{animation:vxcH2In .8s cubic-bezier(.16,1,.3,1) .15s both}
  </style>
  <div class="vxc-h2__glow"></div>
  <div class="vxc-h2__wrap">
    <div class="vxc-h2__col">
      <span class="vxc-h2__tag">New · Workflow Automation</span>
      <h1>Run your operations on autopilot</h1>
      <p>Connect your tools, automate the busywork, and watch your team focus on what actually moves the needle.</p>
      <div class="vxc-h2__btns">
        <a href="#" class="vxc-h2__cta">Get started free</a>
        <a href="#" class="vxc-h2__ghost"><span class="vxc-h2__playdot">▶</span>Watch a 2-min demo</a>
      </div>
      <div class="vxc-h2__logolabel">Trusted by teams at</div>
      <div class="vxc-h2__logos">
        <span>Northwind</span><span>Brightline</span><span>Cascade Co.</span><span>Hubble</span>
      </div>
    </div>
    <div class="vxc-h2__mock">
      <div class="vxc-h2__mockbar">
        <div class="vxc-h2__mockdot vxc-h2__mockdot--r"></div>
        <div class="vxc-h2__mockdot vxc-h2__mockdot--y"></div>
        <div class="vxc-h2__mockdot vxc-h2__mockdot--g"></div>
        <div class="vxc-h2__mockurl">app.yourproduct.com/dashboard</div>
      </div>
      <div class="vxc-h2__mockbody">
        <div class="vxc-h2__mockrow">
          <div class="vxc-h2__mockcard"><div class="vxc-h2__mockline" style="width:60%"></div><div class="vxc-h2__mockline" style="width:40%;opacity:.5"></div></div>
          <div class="vxc-h2__mockcard"><div class="vxc-h2__mockline" style="width:50%"></div><div class="vxc-h2__mockline" style="width:70%;opacity:.5"></div></div>
        </div>
        <div class="vxc-h2__mockchart"></div>
      </div>
    </div>
  </div>
</section>`
};

const HERO_EDITORIAL: VxComponent = {
  id: 'hero-editorial',
  name: 'Editorial Statement',
  category: 'hero',
  tags: ['light', 'minimal', 'typography', 'agency'],
  description: 'Light/cream background, type-driven layout with massive display headline, single accent word, near-zero decoration. Best for agencies, personal brands, bold consumer brands.',
  html: `<section class="vxc-h3">
  <style>
    .vxc-h3{background:#f7f5f0;padding:clamp(100px,16vw,200px) 24px;position:relative}
    .vxc-h3__wrap{max-width:1100px;margin:0 auto}
    .vxc-h3__eyebrow{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#0a0a0f;opacity:.45;margin-bottom:28px;font-weight:600}
    .vxc-h3 h1{font-size:clamp(56px,9vw,128px);font-weight:800;line-height:.98;letter-spacing:-.045em;color:#0a0a0f;margin:0}
    .vxc-h3__accent{font-style:italic;font-weight:400;color:#b45309}
    .vxc-h3__row{display:flex;justify-content:space-between;align-items:flex-end;gap:40px;margin-top:56px;flex-wrap:wrap}
    .vxc-h3 p{font-size:18px;line-height:1.7;color:rgba(10,10,15,.55);max-width:380px;margin:0}
    .vxc-h3__link{font-size:16px;font-weight:600;color:#0a0a0f;text-decoration:none;display:inline-flex;align-items:center;gap:10px;border-bottom:2px solid #0a0a0f;padding-bottom:4px;transition:gap .2s,opacity .2s}
    .vxc-h3__link:hover{gap:16px}
    @keyframes vxcH3In{from{transform:translateY(22px)}to{transform:translateY(0)}}
    .vxc-h3__eyebrow{animation:vxcH3In .6s cubic-bezier(.16,1,.3,1) both}
    .vxc-h3 h1{animation:vxcH3In .8s cubic-bezier(.16,1,.3,1) .08s both}
    .vxc-h3__row{animation:vxcH3In .8s cubic-bezier(.16,1,.3,1) .2s both}
  </style>
  <div class="vxc-h3__wrap">
    <div class="vxc-h3__eyebrow">Independent design studio — est. 2019</div>
    <h1>We build brands<br>that feel <span class="vxc-h3__accent">inevitable</span></h1>
    <div class="vxc-h3__row">
      <p>Strategy, identity, and digital design for companies who refuse to look like everyone else.</p>
      <a href="#" class="vxc-h3__link">View our work →</a>
    </div>
  </div>
</section>`
};

const HERO_GRID_GLOW: VxComponent = {
  id: 'hero-grid-glow',
  name: 'Grid Glow',
  category: 'hero',
  tags: ['dark', 'grid-pattern', 'metrics', 'centered'],
  description: 'Dark hero with a subtle dot-grid texture and center glow, bold centered headline, and a horizontal metrics band beneath the CTA. Best for B2B/data products that want to lead with credibility.',
  html: `<section class="vxc-h4">
  <style>
    .vxc-h4{background:#08080c;padding:150px 24px 0;text-align:center;position:relative;overflow:hidden}
    .vxc-h4__grid{position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.07) 1px,transparent 1px);background-size:34px 34px;-webkit-mask-image:radial-gradient(ellipse 60% 50% at 50% 30%,#000 40%,transparent 80%);mask-image:radial-gradient(ellipse 60% 50% at 50% 30%,#000 40%,transparent 80%)}
    .vxc-h4__glow{position:absolute;top:-100px;left:50%;transform:translateX(-50%);width:900px;height:500px;background:radial-gradient(ellipse,rgba(56,189,248,.16),transparent 70%);filter:blur(40px);pointer-events:none}
    .vxc-h4__inner{position:relative;z-index:2;max-width:760px;margin:0 auto}
    .vxc-h4__badge{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#7dd3fc;background:rgba(56,189,248,.16);padding:7px 16px;border-radius:100px;margin-bottom:32px}
    .vxc-h4 h1{font-size:clamp(44px,6.5vw,76px);font-weight:800;line-height:1.08;letter-spacing:-.035em;color:#fff;margin:0 0 22px}
    .vxc-h4 p{font-size:18px;line-height:1.7;color:rgba(255,255,255,.48);max-width:480px;margin:0 auto 40px}
    .vxc-h4__cta{background:linear-gradient(135deg,#38bdf8,#6366f1);color:#fff;border:none;border-radius:11px;padding:16px 34px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px;transition:transform .2s,box-shadow .2s}
    .vxc-h4__cta:hover{transform:translateY(-3px);box-shadow:0 16px 44px rgba(56,189,248,.35)}
    .vxc-h4__metrics{position:relative;z-index:2;max-width:880px;margin:88px auto 0;display:grid;grid-template-columns:repeat(4,1fr);gap:2px;background:rgba(255,255,255,.06);border-radius:18px;overflow:hidden}
    @media(max-width:760px){.vxc-h4__metrics{grid-template-columns:repeat(2,1fr)}}
    .vxc-h4__metric{padding:36px 20px;text-align:center;background:#0c0c14}
    .vxc-h4__num{font-size:clamp(28px,3.5vw,38px);font-weight:800;color:#fff;letter-spacing:-.02em;margin-bottom:6px}
    .vxc-h4__lbl{font-size:13px;color:rgba(255,255,255,.4)}
    @keyframes vxcH4In{from{transform:translateY(24px)}to{transform:translateY(0)}}
    .vxc-h4__badge{animation:vxcH4In .6s cubic-bezier(.16,1,.3,1) both}
    .vxc-h4 h1{animation:vxcH4In .7s cubic-bezier(.16,1,.3,1) .08s both}
    .vxc-h4 p{animation:vxcH4In .7s cubic-bezier(.16,1,.3,1) .16s both}
    .vxc-h4__cta{animation:vxcH4In .7s cubic-bezier(.16,1,.3,1) .24s both}
  </style>
  <div class="vxc-h4__grid"></div>
  <div class="vxc-h4__glow"></div>
  <div class="vxc-h4__inner">
    <span class="vxc-h4__badge">Now supporting real-time sync</span>
    <h1>Every metric that matters, in one place</h1>
    <p>Connect your stack once and get a live, unified view of the numbers that actually drive decisions.</p>
    <a href="#" class="vxc-h4__cta">See it live →</a>
  </div>
  <div class="vxc-h4__metrics">
    <div class="vxc-h4__metric"><div class="vxc-h4__num">$2.4B</div><div class="vxc-h4__lbl">Processed annually</div></div>
    <div class="vxc-h4__metric"><div class="vxc-h4__num">99.98%</div><div class="vxc-h4__lbl">Uptime SLA</div></div>
    <div class="vxc-h4__metric"><div class="vxc-h4__num">11,400+</div><div class="vxc-h4__lbl">Companies onboard</div></div>
    <div class="vxc-h4__metric"><div class="vxc-h4__num">4 min</div><div class="vxc-h4__lbl">Average setup time</div></div>
  </div>
</section>`
};

const HERO_GRADIENT_WASH: VxComponent = {
  id: 'hero-gradient-wash',
  name: 'Gradient Wash',
  category: 'hero',
  tags: ['dark', 'gradient', 'texture', 'bold'],
  description: 'Rich layered gradient background (deep indigo to near-black) with grain texture overlay, centered content, single bold CTA. Best for consumer apps and brands wanting an immersive, premium feel.',
  html: `<section class="vxc-h5">
  <style>
    .vxc-h5{min-height:92vh;display:flex;align-items:center;justify-content:center;text-align:center;position:relative;overflow:hidden;padding:100px 24px;background:radial-gradient(ellipse 1200px 800px at 50% -10%,#3730a3 0%,#1e1b4b 35%,#0a0a14 75%)}
    .vxc-h5__noise{position:absolute;inset:0;opacity:.05;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");pointer-events:none}
    .vxc-h5__inner{position:relative;z-index:2;max-width:760px}
    .vxc-h5__badge{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,.65);background:rgba(255,255,255,.1);border-radius:100px;padding:7px 18px;margin-bottom:34px;backdrop-filter:blur(10px)}
    .vxc-h5 h1{font-size:clamp(48px,7vw,84px);font-weight:800;line-height:1.06;letter-spacing:-.04em;color:#fff;margin:0 0 24px}
    .vxc-h5 p{font-size:19px;line-height:1.7;color:rgba(255,255,255,.55);max-width:520px;margin:0 auto 42px}
    .vxc-h5__cta{background:#fff;color:#1e1b4b;border:none;border-radius:100px;padding:17px 38px;font-size:16px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:10px;transition:transform .25s cubic-bezier(.34,1.56,.64,1),box-shadow .25s}
    .vxc-h5__cta:hover{transform:scale(1.05);box-shadow:0 20px 60px rgba(255,255,255,.25)}
    .vxc-h5__sub{margin-top:24px;font-size:13px;color:rgba(255,255,255,.35)}
    @keyframes vxcH5In{from{transform:translateY(26px)}to{transform:translateY(0)}}
    .vxc-h5__badge{animation:vxcH5In .6s cubic-bezier(.16,1,.3,1) both}
    .vxc-h5 h1{animation:vxcH5In .75s cubic-bezier(.16,1,.3,1) .08s both}
    .vxc-h5 p{animation:vxcH5In .75s cubic-bezier(.16,1,.3,1) .16s both}
    .vxc-h5__cta{animation:vxcH5In .75s cubic-bezier(.16,1,.3,1) .24s both}
    .vxc-h5__sub{animation:vxcH5In .75s cubic-bezier(.16,1,.3,1) .3s both}
  </style>
  <div class="vxc-h5__noise"></div>
  <div class="vxc-h5__inner">
    <span class="vxc-h5__badge">✦ Loved by 40,000+ creators</span>
    <h1>Your best work, finally seen</h1>
    <p>A home for your portfolio that looks as good as the work inside it. Set up in minutes, stunning by default.</p>
    <a href="#" class="vxc-h5__cta">Create your space →</a>
    <div class="vxc-h5__sub">Free to start · No credit card required</div>
  </div>
</section>`
};

const HERO_GLASS_CARD: VxComponent = {
  id: 'hero-glass-card',
  name: 'Glass Card',
  category: 'hero',
  tags: ['dark', 'glassmorphism', 'form', 'waitlist'],
  description: 'Dark ambient-glow background with content centered inside a frosted glass panel — ideal for waitlist/early-access hero or any hero needing an embedded form. Premium, modern feel.',
  html: `<section class="vxc-h6">
  <style>
    .vxc-h6{min-height:100vh;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;padding:100px 24px;background:#07070d}
    .vxc-h6__glow1{position:absolute;top:-200px;left:-100px;width:600px;height:600px;background:radial-gradient(circle,rgba(236,72,153,.25),transparent 70%);filter:blur(80px);pointer-events:none}
    .vxc-h6__glow2{position:absolute;bottom:-220px;right:-120px;width:560px;height:560px;background:radial-gradient(circle,rgba(99,102,241,.25),transparent 70%);filter:blur(80px);pointer-events:none}
    .vxc-h6__card{position:relative;z-index:2;max-width:560px;width:100%;background:rgba(255,255,255,.08);backdrop-filter:blur(24px);border-radius:24px;padding:clamp(36px,6vw,64px);text-align:center;box-shadow:0 30px 90px rgba(0,0,0,.4)}
    .vxc-h6__icon{width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,#ec4899,#6366f1);display:flex;align-items:center;justify-content:center;margin:0 auto 28px;font-size:22px}
    .vxc-h6 h1{font-size:clamp(32px,4.5vw,44px);font-weight:800;letter-spacing:-.03em;color:#fff;line-height:1.2;margin:0 0 14px}
    .vxc-h6 p{font-size:16px;line-height:1.7;color:rgba(255,255,255,.5);margin:0 0 32px}
    .vxc-h6__form{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
    .vxc-h6__input{flex:1;min-width:220px;background:rgba(255,255,255,.09);border-radius:11px;padding:14px 18px;font-size:15px;color:#fff;outline:none;transition:background .2s,box-shadow .2s}
    .vxc-h6__input::placeholder{color:rgba(255,255,255,.32)}
    .vxc-h6__input:focus{background:rgba(255,255,255,.13);box-shadow:0 0 0 3px rgba(236,72,153,.25)}
    .vxc-h6__btn{background:linear-gradient(135deg,#ec4899,#6366f1);color:#fff;border:none;border-radius:11px;padding:14px 26px;font-size:15px;font-weight:700;cursor:pointer;white-space:nowrap;transition:transform .2s,box-shadow .2s}
    .vxc-h6__btn:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(236,72,153,.35)}
    .vxc-h6__note{margin-top:18px;font-size:12.5px;color:rgba(255,255,255,.32)}
    @keyframes vxcH6In{from{transform:translateY(24px)}to{transform:translateY(0)}}
    .vxc-h6__card{animation:vxcH6In .7s cubic-bezier(.16,1,.3,1) both}
  </style>
  <div class="vxc-h6__glow1"></div>
  <div class="vxc-h6__glow2"></div>
  <div class="vxc-h6__card">
    <div class="vxc-h6__icon">✉</div>
    <h1>Get early access</h1>
    <p>We're opening doors in waves. Join the list and be first to know when your spot is ready.</p>
    <div class="vxc-h6__form">
      <input class="vxc-h6__input" type="email" placeholder="you@email.com">
      <button class="vxc-h6__btn">Join waitlist →</button>
    </div>
    <div class="vxc-h6__note">2,418 people already on the list</div>
  </div>
</section>`
};

const HERO_TRUST_FIRST: VxComponent = {
  id: 'hero-trust-first',
  name: 'Trust First',
  category: 'hero',
  tags: ['light', 'social-proof', 'logos', 'b2b'],
  description: 'Light hero leading with credibility: rating badge above the headline, clear outcome-focused headline, greyscale logo strip below the fold. Best for B2B tools and marketplaces where trust drives conversion.',
  html: `<section class="vxc-h7">
  <style>
    .vxc-h7{background:#fafaf8;padding:130px 24px 0;text-align:center}
    .vxc-h7__inner{max-width:760px;margin:0 auto}
    .vxc-h7__badge{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#0a0a0f;background:#fff;border-radius:100px;padding:8px 18px;margin-bottom:32px;box-shadow:0 4px 20px rgba(10,10,15,.07)}
    .vxc-h7__stars{color:#f59e0b;letter-spacing:1px}
    .vxc-h7 h1{font-size:clamp(40px,6vw,68px);font-weight:800;line-height:1.12;letter-spacing:-.03em;color:#0a0a0f;margin:0 0 20px}
    .vxc-h7 p{font-size:18px;line-height:1.7;color:rgba(10,10,15,.5);max-width:520px;margin:0 auto 36px}
    .vxc-h7__btns{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:28px}
    .vxc-h7__cta{background:#0a0a0f;color:#fff;border:none;border-radius:11px;padding:15px 30px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;transition:transform .2s,box-shadow .2s}
    .vxc-h7__cta:hover{transform:translateY(-2px);box-shadow:0 14px 36px rgba(10,10,15,.2)}
    .vxc-h7__ghost{background:rgba(10,10,15,.06);color:#0a0a0f;border-radius:11px;padding:15px 30px;font-size:15px;font-weight:500;cursor:pointer;text-decoration:none;transition:background .2s}
    .vxc-h7__ghost:hover{background:rgba(10,10,15,.1)}
    .vxc-h7__avs{display:flex;justify-content:center;margin-bottom:64px}
    .vxc-h7__av{width:32px;height:32px;border-radius:50%;border:2px solid #fafaf8;margin-left:-9px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff}
    .vxc-h7__av:first-child{margin-left:0}
    .vxc-h7__av--a{background:#0ea5e9}.vxc-h7__av--b{background:#f59e0b}.vxc-h7__av--c{background:#10b981}.vxc-h7__av--d{background:#8b5cf6}.vxc-h7__av--e{background:#ef4444}
    .vxc-h7__avtxt{margin-left:14px;align-self:center;font-size:13px;color:rgba(10,10,15,.45)}
    .vxc-h7__logobar{margin-top:20px;padding:36px 24px 56px;display:flex;align-items:center;justify-content:center;gap:48px;flex-wrap:wrap;opacity:.4}
    .vxc-h7__logobar span{font-size:14px;font-weight:700;color:#0a0a0f}
    @keyframes vxcH7In{from{transform:translateY(22px)}to{transform:translateY(0)}}
    .vxc-h7__badge{animation:vxcH7In .55s cubic-bezier(.16,1,.3,1) both}
    .vxc-h7 h1{animation:vxcH7In .7s cubic-bezier(.16,1,.3,1) .08s both}
    .vxc-h7 p{animation:vxcH7In .7s cubic-bezier(.16,1,.3,1) .16s both}
    .vxc-h7__btns{animation:vxcH7In .7s cubic-bezier(.16,1,.3,1) .24s both}
  </style>
  <div class="vxc-h7__inner">
    <span class="vxc-h7__badge"><span class="vxc-h7__stars">★★★★★</span> Rated 4.9 from 2,140 reviews</span>
    <h1>The CRM your sales team will actually use</h1>
    <p>No clutter, no busywork — just a clear pipeline, smart follow-ups, and deals that actually close.</p>
    <div class="vxc-h7__btns">
      <a href="#" class="vxc-h7__cta">Start free trial</a>
      <a href="#" class="vxc-h7__ghost">Book a demo</a>
    </div>
    <div style="display:flex;justify-content:center">
      <div class="vxc-h7__avs">
        <div class="vxc-h7__av vxc-h7__av--a">DK</div>
        <div class="vxc-h7__av vxc-h7__av--b">RL</div>
        <div class="vxc-h7__av vxc-h7__av--c">MN</div>
        <div class="vxc-h7__av vxc-h7__av--d">JP</div>
        <div class="vxc-h7__av vxc-h7__av--e">SW</div>
      </div>
      <span class="vxc-h7__avtxt">Join 2,400+ sales teams already closing faster</span>
    </div>
  </div>
  <div class="vxc-h7__logobar">
    <span>Northbeam</span><span>Cascade</span><span>Lumen</span><span>Vertex Co.</span><span>Hatchway</span>
  </div>
</section>`
};

const HERO_BENTO: VxComponent = {
  id: 'hero-bento',
  name: 'Bento Hero',
  category: 'hero',
  tags: ['dark', 'asymmetric', 'bento', 'modern'],
  description: 'Dark hero broken into an asymmetric bento-style grid: large headline cell plus supporting stat/feature cells of varying size. Breaks from the standard centered pattern — best for product-forward, modern brands.',
  html: `<section class="vxc-h8">
  <style>
    .vxc-h8{background:#08080c;padding:120px 24px}
    .vxc-h8__wrap{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:1.6fr 1fr;grid-template-rows:auto auto;gap:16px}
    @media(max-width:840px){.vxc-h8__wrap{grid-template-columns:1fr}}
    .vxc-h8__main{grid-row:span 2;background:linear-gradient(160deg,rgba(99,102,241,.2),rgba(255,255,255,.04));border-radius:22px;padding:clamp(36px,5vw,60px);display:flex;flex-direction:column;justify-content:center}
    .vxc-h8__tag{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#a5b4fc;margin-bottom:22px}
    .vxc-h8 h1{font-size:clamp(38px,5vw,58px);font-weight:800;line-height:1.1;letter-spacing:-.03em;color:#fff;margin:0 0 18px}
    .vxc-h8 p{font-size:16px;line-height:1.7;color:rgba(255,255,255,.5);max-width:420px;margin:0 0 30px}
    .vxc-h8__cta{align-self:flex-start;background:#fff;color:#08080c;border:none;border-radius:11px;padding:14px 28px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;transition:transform .2s,box-shadow .2s}
    .vxc-h8__cta:hover{transform:translateY(-2px);box-shadow:0 14px 38px rgba(255,255,255,.16)}
    .vxc-h8__cell{background:rgba(255,255,255,.06);border-radius:22px;padding:28px}
    .vxc-h8__num{font-size:34px;font-weight:800;color:#fff;letter-spacing:-.02em;margin-bottom:6px}
    .vxc-h8__lbl{font-size:13px;color:rgba(255,255,255,.42)}
    .vxc-h8__bars{display:flex;align-items:flex-end;gap:6px;height:56px;margin-top:18px}
    .vxc-h8__bar{flex:1;background:linear-gradient(180deg,#a5b4fc,rgba(165,180,252,.15));border-radius:4px 4px 0 0;animation:vxcH8Bar 2.4s ease-in-out infinite alternate}
    @keyframes vxcH8Bar{from{transform:scaleY(.5)}to{transform:scaleY(1)}}
    @keyframes vxcH8In{from{transform:translateY(24px)}to{transform:translateY(0)}}
    .vxc-h8__main{animation:vxcH8In .7s cubic-bezier(.16,1,.3,1) both}
    .vxc-h8__cell{animation:vxcH8In .7s cubic-bezier(.16,1,.3,1) .12s both}
  </style>
  <div class="vxc-h8__wrap">
    <div class="vxc-h8__main">
      <span class="vxc-h8__tag">Built for modern teams</span>
      <h1>One workspace. Every project, finally organized.</h1>
      <p>Plan, track, and ship work without the twelve tabs. Built for teams who'd rather build than manage tools.</p>
      <a href="#" class="vxc-h8__cta">Start building →</a>
    </div>
    <div class="vxc-h8__cell">
      <div class="vxc-h8__num">38%</div>
      <div class="vxc-h8__lbl">Faster project delivery on average</div>
      <div class="vxc-h8__bars">
        <div class="vxc-h8__bar" style="animation-delay:0s"></div>
        <div class="vxc-h8__bar" style="animation-delay:.2s"></div>
        <div class="vxc-h8__bar" style="animation-delay:.4s"></div>
        <div class="vxc-h8__bar" style="animation-delay:.6s"></div>
        <div class="vxc-h8__bar" style="animation-delay:.8s"></div>
      </div>
    </div>
    <div class="vxc-h8__cell">
      <div class="vxc-h8__num">12,000+</div>
      <div class="vxc-h8__lbl">Teams shipping faster with a single shared workspace</div>
    </div>
  </div>
</section>`
};

export const HEROES: VxComponent[] = [
  HERO_RADIANT_CENTER, HERO_PRODUCT_SPLIT, HERO_EDITORIAL, HERO_GRID_GLOW,
  HERO_GRADIENT_WASH, HERO_GLASS_CARD, HERO_TRUST_FIRST, HERO_BENTO,
];

// ════════════════════════════════════════════════════════════════
// FEATURE SECTIONS
// ════════════════════════════════════════════════════════════════

const FEAT_BENTO_GRID: VxComponent = {
  id: 'feat-bento-grid',
  name: 'Bento Grid',
  category: 'features',
  tags: ['dark', 'bento', 'asymmetric', 'product'],
  description: 'Dark asymmetric CSS grid — one large anchor cell with a mini product visual, surrounding cells of varying sizes with icon+title+description. The antidote to three-equal-cards.',
  html: `<section class="vxc-f1">
  <style>
    .vxc-f1{background:#08080c;padding:clamp(80px,12vw,140px) 24px}
    .vxc-f1__head{max-width:640px;margin:0 auto 64px;text-align:center}
    .vxc-f1__tag{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#a5b4fc;margin-bottom:14px;display:block}
    .vxc-f1 h2{font-size:clamp(32px,4.5vw,46px);font-weight:800;letter-spacing:-.03em;color:#fff;margin:0 0 14px;line-height:1.15}
    .vxc-f1 > .vxc-f1__head > p{font-size:17px;color:rgba(255,255,255,.5);line-height:1.7;margin:0}
    .vxc-f1__grid{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:minmax(140px,auto);gap:14px}
    @media(max-width:900px){.vxc-f1__grid{grid-template-columns:repeat(2,1fr)}}
    .vxc-f1__cell{background:rgba(255,255,255,.055);border-radius:18px;padding:28px;transition:transform .25s cubic-bezier(.16,1,.3,1),background .25s}
    .vxc-f1__cell:hover{transform:translateY(-4px);background:rgba(255,255,255,.08)}
    .vxc-f1__cell--lg{grid-column:span 2;grid-row:span 2;display:flex;flex-direction:column;justify-content:space-between}
    .vxc-f1__icon{width:42px;height:42px;border-radius:11px;background:rgba(165,180,252,.14);display:flex;align-items:center;justify-content:center;margin-bottom:18px;color:#a5b4fc}
    .vxc-f1__cell h3{font-size:18px;font-weight:700;color:#fff;margin:0 0 8px;letter-spacing:-.01em}
    .vxc-f1__cell p{font-size:14px;line-height:1.65;color:rgba(255,255,255,.45);margin:0}
    .vxc-f1__viz{margin-top:20px;border-radius:12px;background:rgba(255,255,255,.03);padding:18px;display:grid;gap:8px}
    .vxc-f1__vline{height:8px;border-radius:4px;background:rgba(165,180,252,.35)}
  </style>
  <div class="vxc-f1__head">
    <span class="vxc-f1__tag">Why teams switch</span>
    <h2>Everything clicks into place</h2>
    <p>Stop duct-taping five tools together. Get a connected system that does the thinking for you.</p>
  </div>
  <div class="vxc-f1__grid">
    <div class="vxc-f1__cell vxc-f1__cell--lg">
      <div>
        <div class="vxc-f1__icon">⌘</div>
        <h3>One workspace for everything</h3>
        <p>Projects, conversations, files, and approvals — all living in the same place, always in sync.</p>
      </div>
      <div class="vxc-f1__viz">
        <div class="vxc-f1__vline" style="width:70%"></div>
        <div class="vxc-f1__vline" style="width:45%;opacity:.6"></div>
        <div class="vxc-f1__vline" style="width:58%;opacity:.4"></div>
      </div>
    </div>
    <div class="vxc-f1__cell">
      <div class="vxc-f1__icon">⚡</div>
      <h3>Instant automations</h3>
      <p>Set a rule once. It runs forever — no babysitting required.</p>
    </div>
    <div class="vxc-f1__cell">
      <div class="vxc-f1__icon">🔒</div>
      <h3>Bank-level security</h3>
      <p>End-to-end encryption and granular permissions, by default.</p>
    </div>
    <div class="vxc-f1__cell">
      <div class="vxc-f1__icon">🔗</div>
      <h3>Connects to your stack</h3>
      <p>Two-way sync with the 40+ tools your team already uses daily.</p>
    </div>
    <div class="vxc-f1__cell">
      <div class="vxc-f1__icon">📊</div>
      <h3>Reporting that writes itself</h3>
      <p>Live dashboards your stakeholders can actually understand at a glance.</p>
    </div>
  </div>
</section>`
};

const FEAT_ALTERNATING: VxComponent = {
  id: 'feat-alternating',
  name: 'Alternating Rows',
  category: 'features',
  tags: ['light', 'rows', 'editorial', 'detailed'],
  description: 'Light alternating left/right rows pairing copy with a distinct CSS-built visual each time. Generous vertical rhythm. Best for products with 2-4 genuinely distinct capabilities worth explaining in depth.',
  html: `<section class="vxc-f2">
  <style>
    .vxc-f2{background:#fcfbf9;padding:clamp(80px,12vw,140px) 24px}
    .vxc-f2__wrap{max-width:1140px;margin:0 auto;display:grid;gap:clamp(64px,10vw,120px)}
    .vxc-f2__row{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center}
    .vxc-f2__row--rev .vxc-f2__copy{order:2}
    @media(max-width:860px){.vxc-f2__row,.vxc-f2__row--rev .vxc-f2__copy{grid-template-columns:1fr;order:initial}}
    .vxc-f2__num{font-size:13px;font-weight:700;letter-spacing:.08em;color:#b45309;margin-bottom:16px;display:block}
    .vxc-f2__copy h3{font-size:clamp(26px,3.5vw,34px);font-weight:800;letter-spacing:-.02em;color:#0a0a0f;margin:0 0 16px;line-height:1.2}
    .vxc-f2__copy p{font-size:16px;line-height:1.75;color:rgba(10,10,15,.55);margin:0 0 24px;max-width:420px}
    .vxc-f2__list{display:grid;gap:10px;list-style:none;padding:0;margin:0}
    .vxc-f2__list li{display:flex;align-items:center;gap:10px;font-size:14.5px;color:rgba(10,10,15,.7)}
    .vxc-f2__check{width:18px;height:18px;border-radius:50%;background:#b45309;color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0}
    .vxc-f2__viz{border-radius:20px;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
    .vxc-f2__viz--a{background:linear-gradient(135deg,#fde68a,#fbbf24)}
    .vxc-f2__viz--b{background:linear-gradient(135deg,#bfdbfe,#60a5fa)}
    .vxc-f2__vizcard{background:rgba(255,255,255,.55);backdrop-filter:blur(6px);border-radius:14px;padding:22px;width:72%;display:grid;gap:10px}
    .vxc-f2__vline{height:9px;border-radius:5px;background:rgba(10,10,15,.18)}
    @keyframes vxcF2In{from{transform:translateY(20px)}to{transform:translateY(0)}}
    .vxc-f2__row{animation:vxcF2In .7s cubic-bezier(.16,1,.3,1) both}
  </style>
  <div class="vxc-f2__wrap">
    <div class="vxc-f2__row">
      <div class="vxc-f2__copy">
        <span class="vxc-f2__num">01 — Plan</span>
        <h3>See your whole quarter at a glance</h3>
        <p>Drag-and-drop timelines that update themselves as work moves — no more Sunday-night spreadsheet wrangling.</p>
        <ul class="vxc-f2__list">
          <li><span class="vxc-f2__check">✓</span>Auto-adjusting timelines</li>
          <li><span class="vxc-f2__check">✓</span>Workload balancing built in</li>
          <li><span class="vxc-f2__check">✓</span>Shareable client-ready views</li>
        </ul>
      </div>
      <div class="vxc-f2__viz vxc-f2__viz--a">
        <div class="vxc-f2__vizcard">
          <div class="vxc-f2__vline" style="width:80%"></div>
          <div class="vxc-f2__vline" style="width:55%"></div>
          <div class="vxc-f2__vline" style="width:68%"></div>
        </div>
      </div>
    </div>
    <div class="vxc-f2__row vxc-f2__row--rev">
      <div class="vxc-f2__copy">
        <span class="vxc-f2__num">02 — Collaborate</span>
        <h3>Feedback that doesn't get lost in chat</h3>
        <p>Comments live exactly where the work lives. Tag teammates, resolve threads, move on — nothing falls through the cracks.</p>
        <ul class="vxc-f2__list">
          <li><span class="vxc-f2__check">✓</span>Inline comments on anything</li>
          <li><span class="vxc-f2__check">✓</span>Real-time presence indicators</li>
          <li><span class="vxc-f2__check">✓</span>Resolved threads stay searchable</li>
        </ul>
      </div>
      <div class="vxc-f2__viz vxc-f2__viz--b">
        <div class="vxc-f2__vizcard">
          <div class="vxc-f2__vline" style="width:60%"></div>
          <div class="vxc-f2__vline" style="width:75%"></div>
          <div class="vxc-f2__vline" style="width:42%"></div>
        </div>
      </div>
    </div>
  </div>
</section>`
};

const FEAT_STAT_BAND: VxComponent = {
  id: 'feat-stat-band',
  name: 'Stat Band',
  category: 'features',
  tags: ['dark', 'metrics', 'band', 'minimal'],
  description: 'Dark horizontal band of 3-4 large, specific metrics with short context labels — high contrast, minimal, drops in cleanly between sections to reinforce credibility mid-page.',
  html: `<section class="vxc-f3">
  <style>
    .vxc-f3{background:#0a0a10;padding:clamp(70px,10vw,110px) 24px;border-top:1px solid rgba(255,255,255,.06);border-bottom:1px solid rgba(255,255,255,.06)}
    .vxc-f3__wrap{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);gap:40px;text-align:center}
    @media(max-width:760px){.vxc-f3__wrap{grid-template-columns:repeat(2,1fr)}}
    .vxc-f3__num{font-size:clamp(34px,4.5vw,48px);font-weight:800;letter-spacing:-.03em;background:linear-gradient(135deg,#fff,rgba(255,255,255,.5));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:8px}
    .vxc-f3__lbl{font-size:14px;color:rgba(255,255,255,.45);line-height:1.5}
    @keyframes vxcF3In{from{transform:translateY(18px)}to{transform:translateY(0)}}
    .vxc-f3__item{animation:vxcF3In .6s cubic-bezier(.16,1,.3,1) both}
  </style>
  <div class="vxc-f3__wrap">
    <div class="vxc-f3__item" style="animation-delay:0s"><div class="vxc-f3__num">$840M</div><div class="vxc-f3__lbl">In transactions processed safely</div></div>
    <div class="vxc-f3__item" style="animation-delay:.08s"><div class="vxc-f3__num">99.99%</div><div class="vxc-f3__lbl">Platform uptime, audited monthly</div></div>
    <div class="vxc-f3__item" style="animation-delay:.16s"><div class="vxc-f3__num">6,200+</div><div class="vxc-f3__lbl">Businesses running on the platform</div></div>
    <div class="vxc-f3__item" style="animation-delay:.24s"><div class="vxc-f3__num">11 min</div><div class="vxc-f3__lbl">Average time to first value</div></div>
  </div>
</section>`
};

const FEAT_ICON_TRIO: VxComponent = {
  id: 'feat-icon-trio',
  name: 'Icon Trio (done right)',
  category: 'features',
  tags: ['light', 'icons', 'cards', 'clean'],
  description: 'Three-column icon cards done with genuine craft — distinctive inline-SVG icons in tinted boxes, varied copy weight, subtle lift on hover. Use sparingly and only when the three things genuinely deserve equal billing.',
  html: `<section class="vxc-f4">
  <style>
    .vxc-f4{background:#fff;padding:clamp(80px,12vw,140px) 24px}
    .vxc-f4__head{max-width:580px;margin:0 auto 60px;text-align:center}
    .vxc-f4 h2{font-size:clamp(30px,4vw,42px);font-weight:800;letter-spacing:-.025em;color:#0a0a0f;margin:0 0 12px}
    .vxc-f4 > .vxc-f4__head > p{font-size:16px;color:rgba(10,10,15,.5);line-height:1.7;margin:0}
    .vxc-f4__grid{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:repeat(3,1fr);gap:28px}
    @media(max-width:760px){.vxc-f4__grid{grid-template-columns:1fr}}
    .vxc-f4__card{padding:32px;border-radius:18px;background:#fafaf8;transition:transform .25s cubic-bezier(.16,1,.3,1),box-shadow .25s}
    .vxc-f4__card:hover{transform:translateY(-5px);box-shadow:0 20px 50px rgba(10,10,15,.08)}
    .vxc-f4__icon{width:48px;height:48px;border-radius:13px;display:flex;align-items:center;justify-content:center;margin-bottom:22px}
    .vxc-f4__icon--a{background:#fef3c7;color:#b45309}
    .vxc-f4__icon--b{background:#dbeafe;color:#1d4ed8}
    .vxc-f4__icon--c{background:#dcfce7;color:#15803d}
    .vxc-f4__card h3{font-size:18px;font-weight:700;color:#0a0a0f;margin:0 0 10px;letter-spacing:-.01em}
    .vxc-f4__card p{font-size:14.5px;line-height:1.7;color:rgba(10,10,15,.5);margin:0}
  </style>
  <div class="vxc-f4__head">
    <h2>Three things we obsess over</h2>
    <p>Not a feature list — the three principles that shape every decision we make about this product.</p>
  </div>
  <div class="vxc-f4__grid">
    <div class="vxc-f4__card">
      <div class="vxc-f4__icon vxc-f4__icon--a"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg></div>
      <h3>Fast by default</h3>
      <p>Every interaction responds in under 100ms. Speed isn't a feature here — it's the baseline.</p>
    </div>
    <div class="vxc-f4__card">
      <div class="vxc-f4__icon vxc-f4__icon--b"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
      <h3>Private by design</h3>
      <p>Your data is encrypted at rest and in transit. We can't read it even if we wanted to.</p>
    </div>
    <div class="vxc-f4__card">
      <div class="vxc-f4__icon vxc-f4__icon--c"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></div>
      <h3>Built with care</h3>
      <p>Every detail is considered twice. We'd rather ship less, and ship it right.</p>
    </div>
  </div>
</section>`
};

const FEAT_TWO_COL: VxComponent = {
  id: 'feat-two-col',
  name: 'Two-Column Detail List',
  category: 'features',
  tags: ['dark', 'list', 'detailed', 'b2b'],
  description: 'Dark two-column layout pairing a sticky headline/intro with a vertical list of detailed feature rows, each with icon, title, and description. Good for feature-dense B2B products.',
  html: `<section class="vxc-f5">
  <style>
    .vxc-f5{background:#08080d;padding:clamp(80px,12vw,140px) 24px}
    .vxc-f5__wrap{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:0.85fr 1.15fr;gap:72px}
    @media(max-width:860px){.vxc-f5__wrap{grid-template-columns:1fr}}
    .vxc-f5__sticky{position:sticky;top:80px;align-self:start}
    .vxc-f5__tag{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#34d399;margin-bottom:16px;display:block}
    .vxc-f5 h2{font-size:clamp(30px,4vw,42px);font-weight:800;letter-spacing:-.03em;color:#fff;margin:0 0 16px;line-height:1.18}
    .vxc-f5__sticky p{font-size:16px;line-height:1.75;color:rgba(255,255,255,.5);max-width:380px}
    .vxc-f5__list{display:grid;gap:6px}
    .vxc-f5__row{display:flex;gap:20px;padding:24px;border-radius:16px;transition:background .2s}
    .vxc-f5__row:hover{background:rgba(255,255,255,.03)}
    .vxc-f5__icon{flex-shrink:0;width:44px;height:44px;border-radius:12px;background:rgba(52,211,153,.12);color:#34d399;display:flex;align-items:center;justify-content:center;font-size:18px}
    .vxc-f5__row h3{font-size:17px;font-weight:700;color:#fff;margin:0 0 6px;letter-spacing:-.01em}
    .vxc-f5__row p{font-size:14.5px;line-height:1.65;color:rgba(255,255,255,.45);margin:0}
    @keyframes vxcF5In{from{transform:translateY(18px)}to{transform:translateY(0)}}
    .vxc-f5__row{animation:vxcF5In .55s cubic-bezier(.16,1,.3,1) both}
  </style>
  <div class="vxc-f5__wrap">
    <div class="vxc-f5__sticky">
      <span class="vxc-f5__tag">Built for scale</span>
      <h2>Every detail handled, so you don't have to think about it</h2>
      <p>From the first user to the millionth, the platform adapts without you lifting a finger.</p>
    </div>
    <div class="vxc-f5__list">
      <div class="vxc-f5__row" style="animation-delay:0s">
        <div class="vxc-f5__icon">⚙</div>
        <div><h3>Auto-scaling infrastructure</h3><p>Traffic spikes are handled invisibly — no pages, no panic, no manual scaling.</p></div>
      </div>
      <div class="vxc-f5__row" style="animation-delay:.06s">
        <div class="vxc-f5__icon">🔍</div>
        <div><h3>Full audit trail</h3><p>Every change is logged, timestamped, and searchable — for compliance and peace of mind.</p></div>
      </div>
      <div class="vxc-f5__row" style="animation-delay:.12s">
        <div class="vxc-f5__icon">🧩</div>
        <div><h3>Granular permissions</h3><p>Control exactly who can see and do what, down to the individual record.</p></div>
      </div>
      <div class="vxc-f5__row" style="animation-delay:.18s">
        <div class="vxc-f5__icon">📡</div>
        <div><h3>Real-time everything</h3><p>Changes propagate instantly across every device, every teammate, every time.</p></div>
      </div>
    </div>
  </div>
</section>`
};

export const FEATURE_SECTIONS: VxComponent[] = [
  FEAT_BENTO_GRID, FEAT_ALTERNATING, FEAT_STAT_BAND, FEAT_ICON_TRIO, FEAT_TWO_COL,
];

// ════════════════════════════════════════════════════════════════
// PRICING SECTIONS
// ════════════════════════════════════════════════════════════════

const PRICE_THREE_COL: VxComponent = {
  id: 'price-three-col',
  name: 'Classic Three Column',
  category: 'pricing',
  tags: ['light', 'three-tier', 'faq', 'toggle'],
  description: 'Light three-tier pricing with monthly/annual toggle, middle tier visually elevated with "Most popular" badge, check+x feature lists, and FAQ accordion below. The complete, conversion-ready pattern.',
  html: `<section class="vxc-p1">
  <style>
    .vxc-p1{background:#fcfbf9;padding:clamp(80px,12vw,140px) 24px}
    .vxc-p1__head{max-width:560px;margin:0 auto 44px;text-align:center}
    .vxc-p1 h2{font-size:clamp(30px,4vw,42px);font-weight:800;letter-spacing:-.025em;color:#0a0a0f;margin:0 0 12px}
    .vxc-p1 > .vxc-p1__head > p{font-size:16px;color:rgba(10,10,15,.5);margin:0}
    .vxc-p1__toggle{display:flex;align-items:center;justify-content:center;gap:14px;margin:0 auto 56px}
    .vxc-p1__tlabel{font-size:14px;font-weight:600;color:rgba(10,10,15,.45)}
    .vxc-p1__tlabel--on{color:#0a0a0f}
    .vxc-p1__switch{width:46px;height:26px;background:#0a0a0f;border-radius:100px;position:relative;cursor:pointer}
    .vxc-p1__knob{position:absolute;top:3px;left:3px;width:20px;height:20px;background:#fff;border-radius:50%;transition:transform .25s cubic-bezier(.34,1.56,.64,1)}
    .vxc-p1__switch--on .vxc-p1__knob{transform:translateX(20px)}
    .vxc-p1__save{font-size:12px;font-weight:700;color:#15803d;background:#dcfce7;padding:4px 10px;border-radius:100px}
    .vxc-p1__grid{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:repeat(3,1fr);gap:22px;align-items:start}
    @media(max-width:860px){.vxc-p1__grid{grid-template-columns:1fr}}
    .vxc-p1__card{background:#fff;border-radius:20px;padding:32px;box-shadow:0 2px 24px rgba(10,10,15,.05)}
    .vxc-p1__card--feat{background:linear-gradient(160deg,#fff,#f3f1ec);box-shadow:0 24px 64px rgba(10,10,15,.14);transform:scale(1.04);position:relative;padding-top:42px}
    .vxc-p1__badge{position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:#0a0a0f;color:#fff;font-size:11px;font-weight:700;letter-spacing:.04em;padding:6px 16px;border-radius:100px;white-space:nowrap}
    .vxc-p1__tier{font-size:13px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:rgba(10,10,15,.5);margin-bottom:14px}
    .vxc-p1__card--feat .vxc-p1__tier{color:#0a0a0f}
    .vxc-p1__price{display:flex;align-items:baseline;gap:5px;margin-bottom:6px}
    .vxc-p1__amt{font-size:42px;font-weight:800;letter-spacing:-.03em;color:#0a0a0f}
    .vxc-p1__per{font-size:15px;color:rgba(10,10,15,.4)}
    .vxc-p1__savings{font-size:12.5px;color:#15803d;font-weight:600;margin-bottom:8px}
    .vxc-p1__desc{font-size:13.5px;color:rgba(10,10,15,.5);margin-bottom:26px}
    .vxc-p1__cta{display:block;text-align:center;width:100%;border-radius:11px;padding:13px;font-size:14.5px;font-weight:700;cursor:pointer;text-decoration:none;margin-bottom:26px;transition:transform .2s,box-shadow .2s,background .2s;background:rgba(10,10,15,.06);color:#0a0a0f}
    .vxc-p1__cta:not(.vxc-p1__cta--solid):hover{background:rgba(10,10,15,.1)}
    .vxc-p1__cta--solid{background:#0a0a0f;color:#fff;border:none}
    .vxc-p1__cta:hover{transform:translateY(-2px)}
    .vxc-p1__feat{display:grid;gap:11px;list-style:none;padding:0;margin:0}
    .vxc-p1__feat li{display:flex;align-items:flex-start;gap:10px;font-size:13.5px;color:rgba(10,10,15,.65);line-height:1.4}
    .vxc-p1__yes{color:#15803d;flex-shrink:0}
    .vxc-p1__no{color:rgba(10,10,15,.25);flex-shrink:0}
    .vxc-p1__faq{max-width:680px;margin:90px auto 0}
    .vxc-p1__faq h3{font-size:24px;font-weight:800;letter-spacing:-.02em;color:#0a0a0f;text-align:center;margin:0 0 28px}
    .vxc-p1__qa{border-bottom:1px solid rgba(10,10,15,.08);padding:18px 0}
    .vxc-p1__q{font-size:15px;font-weight:600;color:#0a0a0f;display:flex;justify-content:space-between;align-items:center;cursor:pointer}
    .vxc-p1__a{font-size:14px;line-height:1.7;color:rgba(10,10,15,.55);margin-top:10px;max-width:580px}
  </style>
  <div class="vxc-p1__head">
    <h2>Simple pricing that scales with you</h2>
    <p>Start free. Upgrade when you're ready — cancel any time, no questions asked.</p>
  </div>
  <div class="vxc-p1__toggle">
    <span class="vxc-p1__tlabel">Monthly</span>
    <div class="vxc-p1__switch vxc-p1__switch--on"><div class="vxc-p1__knob"></div></div>
    <span class="vxc-p1__tlabel vxc-p1__tlabel--on">Annual</span>
    <span class="vxc-p1__save">Save 20%</span>
  </div>
  <div class="vxc-p1__grid">
    <div class="vxc-p1__card">
      <div class="vxc-p1__tier">Starter</div>
      <div class="vxc-p1__price"><span class="vxc-p1__amt">$0</span><span class="vxc-p1__per">/mo</span></div>
      <div class="vxc-p1__savings">&nbsp;</div>
      <div class="vxc-p1__desc">For individuals getting started</div>
      <a href="#" class="vxc-p1__cta">Get started free</a>
      <ul class="vxc-p1__feat">
        <li><span class="vxc-p1__yes">✓</span>Up to 3 projects</li>
        <li><span class="vxc-p1__yes">✓</span>1 GB storage</li>
        <li><span class="vxc-p1__yes">✓</span>Community support</li>
        <li><span class="vxc-p1__no">✗</span>Custom integrations</li>
        <li><span class="vxc-p1__no">✗</span>Priority support</li>
      </ul>
    </div>
    <div class="vxc-p1__card vxc-p1__card--feat">
      <div class="vxc-p1__badge">Most popular</div>
      <div class="vxc-p1__tier">Growth</div>
      <div class="vxc-p1__price"><span class="vxc-p1__amt">$29</span><span class="vxc-p1__per">/mo</span></div>
      <div class="vxc-p1__savings">Billed annually — save $84/year</div>
      <div class="vxc-p1__desc">For growing teams that need more</div>
      <a href="#" class="vxc-p1__cta vxc-p1__cta--solid">Start free trial</a>
      <ul class="vxc-p1__feat">
        <li><span class="vxc-p1__yes">✓</span>Everything in Starter, plus:</li>
        <li><span class="vxc-p1__yes">✓</span>Unlimited projects</li>
        <li><span class="vxc-p1__yes">✓</span>50 GB storage</li>
        <li><span class="vxc-p1__yes">✓</span>Custom integrations</li>
        <li><span class="vxc-p1__yes">✓</span>Priority email support</li>
      </ul>
    </div>
    <div class="vxc-p1__card">
      <div class="vxc-p1__tier">Scale</div>
      <div class="vxc-p1__price"><span class="vxc-p1__amt">$89</span><span class="vxc-p1__per">/mo</span></div>
      <div class="vxc-p1__savings">Billed annually — save $264/year</div>
      <div class="vxc-p1__desc">For organizations at scale</div>
      <a href="#" class="vxc-p1__cta">Talk to sales</a>
      <ul class="vxc-p1__feat">
        <li><span class="vxc-p1__yes">✓</span>Everything in Growth, plus:</li>
        <li><span class="vxc-p1__yes">✓</span>Unlimited storage</li>
        <li><span class="vxc-p1__yes">✓</span>SSO &amp; advanced permissions</li>
        <li><span class="vxc-p1__yes">✓</span>Dedicated account manager</li>
        <li><span class="vxc-p1__yes">✓</span>99.99% uptime SLA</li>
      </ul>
    </div>
  </div>
  <div class="vxc-p1__faq">
    <h3>Common questions</h3>
    <div class="vxc-p1__qa"><div class="vxc-p1__q">Can I cancel anytime? <span>+</span></div><div class="vxc-p1__a">Yes — cancel from your account settings whenever you like. You'll keep access until the end of your billing period, no penalties.</div></div>
    <div class="vxc-p1__qa"><div class="vxc-p1__q">What happens if I go over my plan limits? <span>+</span></div><div class="vxc-p1__a">We'll let you know before you hit a limit and help you find the right plan — we never cut off access without warning.</div></div>
    <div class="vxc-p1__qa"><div class="vxc-p1__q">Is there a free trial on paid plans? <span>+</span></div><div class="vxc-p1__a">Every paid plan includes a 14-day free trial — no credit card required to start.</div></div>
    <div class="vxc-p1__qa"><div class="vxc-p1__q">Can I change plans later? <span>+</span></div><div class="vxc-p1__a">Absolutely. Upgrade or downgrade at any time and we'll prorate the difference automatically.</div></div>
    <div class="vxc-p1__qa"><div class="vxc-p1__q">Do you offer refunds? <span>+</span></div><div class="vxc-p1__a">If something's not right within the first 30 days, reach out and we'll make it right — including a full refund.</div></div>
    <div class="vxc-p1__qa"><div class="vxc-p1__q">Discounts for nonprofits or students? <span>+</span></div><div class="vxc-p1__a">Yes — reach out to our team with verification and we'll set you up with a special rate.</div></div>
  </div>
</section>`
};

const PRICE_DARK_FEATURED: VxComponent = {
  id: 'price-dark-featured',
  name: 'Dark Featured Glow',
  category: 'pricing',
  tags: ['dark', 'glow', 'featured', 'premium'],
  description: 'Dark-background pricing with the recommended tier wrapped in a soft accent glow ring — feels premium and product-forward. Two-tier focus rather than three for simpler offerings.',
  html: `<section class="vxc-p2">
  <style>
    .vxc-p2{background:#08080d;padding:clamp(80px,12vw,140px) 24px}
    .vxc-p2__head{max-width:540px;margin:0 auto 60px;text-align:center}
    .vxc-p2 h2{font-size:clamp(30px,4vw,42px);font-weight:800;letter-spacing:-.025em;color:#fff;margin:0 0 12px}
    .vxc-p2 > .vxc-p2__head > p{font-size:16px;color:rgba(255,255,255,.5);margin:0}
    .vxc-p2__grid{max-width:880px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start}
    @media(max-width:760px){.vxc-p2__grid{grid-template-columns:1fr}}
    .vxc-p2__card{background:rgba(255,255,255,.05);border-radius:20px;padding:36px}
    .vxc-p2__card--feat{position:relative;background:rgba(255,255,255,.07);box-shadow:0 0 60px rgba(167,139,250,.18)}
    .vxc-p2__badge{position:absolute;top:-13px;left:32px;background:linear-gradient(135deg,#a78bfa,#60a5fa);color:#fff;font-size:11px;font-weight:700;letter-spacing:.04em;padding:6px 14px;border-radius:100px}
    .vxc-p2__tier{font-size:13px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:rgba(255,255,255,.45);margin-bottom:16px}
    .vxc-p2__card--feat .vxc-p2__tier{color:#a78bfa}
    .vxc-p2__price{display:flex;align-items:baseline;gap:6px;margin-bottom:10px}
    .vxc-p2__amt{font-size:46px;font-weight:800;letter-spacing:-.03em;color:#fff}
    .vxc-p2__per{font-size:15px;color:rgba(255,255,255,.4)}
    .vxc-p2__desc{font-size:14px;color:rgba(255,255,255,.45);margin-bottom:28px;line-height:1.6}
    .vxc-p2__cta{display:block;text-align:center;width:100%;border-radius:11px;padding:14px;font-size:14.5px;font-weight:700;cursor:pointer;text-decoration:none;margin-bottom:28px;transition:transform .2s,box-shadow .2s,background .2s;background:rgba(255,255,255,.1);color:#fff}
    .vxc-p2__cta:not(.vxc-p2__cta--solid):hover{background:rgba(255,255,255,.16)}
    .vxc-p2__cta--solid{background:linear-gradient(135deg,#a78bfa,#60a5fa);border:none}
    .vxc-p2__cta:hover{transform:translateY(-2px)}
    .vxc-p2__feat{display:grid;gap:12px;list-style:none;padding:0;margin:0}
    .vxc-p2__feat li{display:flex;align-items:flex-start;gap:10px;font-size:14px;color:rgba(255,255,255,.6);line-height:1.4}
    .vxc-p2__feat li::before{content:'✓';color:#34d399;flex-shrink:0;font-weight:700}
  </style>
  <div class="vxc-p2__head">
    <h2>Pick the plan that fits your stage</h2>
    <p>Both plans include core features. Upgrade when your team outgrows the basics.</p>
  </div>
  <div class="vxc-p2__grid">
    <div class="vxc-p2__card">
      <div class="vxc-p2__tier">Solo</div>
      <div class="vxc-p2__price"><span class="vxc-p2__amt">$19</span><span class="vxc-p2__per">/mo</span></div>
      <div class="vxc-p2__desc">For individuals and small projects that need the essentials done well.</div>
      <a href="#" class="vxc-p2__cta">Get started</a>
      <ul class="vxc-p2__feat">
        <li>5 active projects</li>
        <li>10 GB storage</li>
        <li>Standard support</li>
        <li>Core integrations</li>
      </ul>
    </div>
    <div class="vxc-p2__card vxc-p2__card--feat">
      <span class="vxc-p2__badge">Recommended</span>
      <div class="vxc-p2__tier">Team</div>
      <div class="vxc-p2__price"><span class="vxc-p2__amt">$49</span><span class="vxc-p2__per">/mo per seat</span></div>
      <div class="vxc-p2__desc">For teams who need to move fast without losing visibility.</div>
      <a href="#" class="vxc-p2__cta vxc-p2__cta--solid">Start free trial</a>
      <ul class="vxc-p2__feat">
        <li>Unlimited projects</li>
        <li>250 GB shared storage</li>
        <li>Priority support, &lt;1hr response</li>
        <li>Every integration, plus API access</li>
        <li>Advanced permissions &amp; SSO</li>
      </ul>
    </div>
  </div>
</section>`
};

const PRICE_MINIMAL: VxComponent = {
  id: 'price-minimal',
  name: 'Minimal Two-Tier',
  category: 'pricing',
  tags: ['light', 'minimal', 'simple', 'two-tier'],
  description: 'Ultra-clean two-card pricing with generous whitespace and no visual noise — best for simple products with a straightforward free-vs-paid decision.',
  html: `<section class="vxc-p3">
  <style>
    .vxc-p3{background:#fff;padding:clamp(90px,13vw,150px) 24px}
    .vxc-p3__head{max-width:480px;margin:0 auto 64px;text-align:center}
    .vxc-p3 h2{font-size:clamp(30px,4vw,40px);font-weight:800;letter-spacing:-.025em;color:#0a0a0f;margin:0 0 10px}
    .vxc-p3 > .vxc-p3__head > p{font-size:15.5px;color:rgba(10,10,15,.48);margin:0}
    .vxc-p3__grid{max-width:760px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(10,10,15,.1)}
    @media(max-width:640px){.vxc-p3__grid{grid-template-columns:1fr}}
    .vxc-p3__card{padding:44px 36px;background:#f7f6f3}
    .vxc-p3__card--feat{background:#0a0a0f}
    .vxc-p3__tier{font-size:14px;font-weight:700;color:rgba(10,10,15,.5);margin-bottom:18px}
    .vxc-p3__card--feat .vxc-p3__tier{color:rgba(255,255,255,.5)}
    .vxc-p3__amt{font-size:44px;font-weight:800;letter-spacing:-.03em;color:#0a0a0f;margin-bottom:6px}
    .vxc-p3__card--feat .vxc-p3__amt{color:#fff}
    .vxc-p3__per{font-size:14px;color:rgba(10,10,15,.4);margin-bottom:28px}
    .vxc-p3__card--feat .vxc-p3__per{color:rgba(255,255,255,.4)}
    .vxc-p3__feat{display:grid;gap:13px;list-style:none;padding:0;margin:0 0 30px}
    .vxc-p3__feat li{font-size:14px;color:rgba(10,10,15,.6);display:flex;gap:9px}
    .vxc-p3__card--feat .vxc-p3__feat li{color:rgba(255,255,255,.65)}
    .vxc-p3__feat li::before{content:'—';color:rgba(10,10,15,.3);flex-shrink:0}
    .vxc-p3__card--feat .vxc-p3__feat li::before{color:rgba(255,255,255,.3)}
    .vxc-p3__cta{display:block;text-align:center;border-radius:10px;padding:13px;font-size:14px;font-weight:700;text-decoration:none;background:rgba(10,10,15,.07);color:#0a0a0f;transition:background .2s}
    .vxc-p3__cta:hover{background:rgba(10,10,15,.12)}
    .vxc-p3__cta--solid{background:#fff;color:#0a0a0f;border:none}
    .vxc-p3__cta--solid:hover{background:rgba(255,255,255,.9)}
  </style>
  <div class="vxc-p3__head">
    <h2>One decision. That's it.</h2>
    <p>No tiers to compare, no feature matrix to decode. Just pick what fits and go.</p>
  </div>
  <div class="vxc-p3__grid">
    <div class="vxc-p3__card">
      <div class="vxc-p3__tier">Free</div>
      <div class="vxc-p3__amt">$0</div>
      <div class="vxc-p3__per">forever, no card needed</div>
      <ul class="vxc-p3__feat">
        <li>Everything you need to start</li>
        <li>Up to 3 active projects</li>
        <li>Community support</li>
      </ul>
      <a href="#" class="vxc-p3__cta">Get started</a>
    </div>
    <div class="vxc-p3__card vxc-p3__card--feat">
      <div class="vxc-p3__tier">Pro</div>
      <div class="vxc-p3__amt">$15<span style="font-size:18px">/mo</span></div>
      <div class="vxc-p3__per">billed annually, cancel anytime</div>
      <ul class="vxc-p3__feat">
        <li>Everything in Free, unlocked fully</li>
        <li>Unlimited projects &amp; storage</li>
        <li>Priority support &amp; early access</li>
      </ul>
      <a href="#" class="vxc-p3__cta vxc-p3__cta--solid">Upgrade to Pro</a>
    </div>
  </div>
</section>`
};

const PRICE_COMPARISON: VxComponent = {
  id: 'price-comparison',
  name: 'Comparison Table',
  category: 'pricing',
  tags: ['light', 'table', 'comparison', 'detailed'],
  description: 'Feature-by-feature comparison table across three tiers with grouped categories — best for products where buyers need to scan capabilities side by side before deciding.',
  html: `<section class="vxc-p4">
  <style>
    .vxc-p4{background:#fcfbf9;padding:clamp(80px,12vw,140px) 24px}
    .vxc-p4__head{max-width:520px;margin:0 auto 50px;text-align:center}
    .vxc-p4 h2{font-size:clamp(28px,3.8vw,38px);font-weight:800;letter-spacing:-.025em;color:#0a0a0f;margin:0 0 10px}
    .vxc-p4 > .vxc-p4__head > p{font-size:15.5px;color:rgba(10,10,15,.48);margin:0}
    .vxc-p4__table{max-width:920px;margin:0 auto;border-collapse:collapse;width:100%;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 2px 24px rgba(10,10,15,.05)}
    .vxc-p4__table th,.vxc-p4__table td{padding:16px 20px;text-align:left;font-size:14px}
    .vxc-p4__table thead th{background:#fff;border-bottom:1px solid rgba(10,10,15,.08);padding-top:28px}
    .vxc-p4__plan{font-size:15px;font-weight:800;color:#0a0a0f;margin-bottom:4px}
    .vxc-p4__pprice{font-size:13px;color:rgba(10,10,15,.45);font-weight:500}
    .vxc-p4__featcol{color:rgba(10,10,15,.45);font-weight:600;width:34%}
    .vxc-p4__group td{background:#fafaf8;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:rgba(10,10,15,.4);padding:12px 20px}
    .vxc-p4__table td{border-bottom:1px solid rgba(10,10,15,.05);text-align:center}
    .vxc-p4__table td:first-child{text-align:left;color:rgba(10,10,15,.7)}
    .vxc-p4__yes{color:#15803d;font-weight:700}
    .vxc-p4__no{color:rgba(10,10,15,.2)}
    .vxc-p4__feat-col{background:rgba(99,102,241,.04)}
  </style>
  <div class="vxc-p4__head">
    <h2>Compare every plan side by side</h2>
    <p>See exactly what's included before you commit — no surprises later.</p>
  </div>
  <table class="vxc-p4__table">
    <thead>
      <tr>
        <th class="vxc-p4__featcol"></th>
        <th><div class="vxc-p4__plan">Starter</div><div class="vxc-p4__pprice">$0/mo</div></th>
        <th class="vxc-p4__feat-col"><div class="vxc-p4__plan">Growth</div><div class="vxc-p4__pprice">$29/mo</div></th>
        <th><div class="vxc-p4__plan">Scale</div><div class="vxc-p4__pprice">$89/mo</div></th>
      </tr>
    </thead>
    <tbody>
      <tr class="vxc-p4__group"><td colspan="4">Core</td></tr>
      <tr><td>Active projects</td><td>3</td><td class="vxc-p4__feat-col">Unlimited</td><td>Unlimited</td></tr>
      <tr><td>Storage</td><td>1 GB</td><td class="vxc-p4__feat-col">50 GB</td><td>Unlimited</td></tr>
      <tr><td>Team members</td><td>1</td><td class="vxc-p4__feat-col">10</td><td>Unlimited</td></tr>
      <tr class="vxc-p4__group"><td colspan="4">Collaboration</td></tr>
      <tr><td>Custom integrations</td><td><span class="vxc-p4__no">—</span></td><td class="vxc-p4__feat-col"><span class="vxc-p4__yes">✓</span></td><td><span class="vxc-p4__yes">✓</span></td></tr>
      <tr><td>API access</td><td><span class="vxc-p4__no">—</span></td><td class="vxc-p4__feat-col"><span class="vxc-p4__yes">✓</span></td><td><span class="vxc-p4__yes">✓</span></td></tr>
      <tr><td>SSO &amp; advanced roles</td><td><span class="vxc-p4__no">—</span></td><td class="vxc-p4__feat-col"><span class="vxc-p4__no">—</span></td><td><span class="vxc-p4__yes">✓</span></td></tr>
      <tr class="vxc-p4__group"><td colspan="4">Support</td></tr>
      <tr><td>Support level</td><td>Community</td><td class="vxc-p4__feat-col">Priority email</td><td>Dedicated manager</td></tr>
      <tr><td>Uptime SLA</td><td><span class="vxc-p4__no">—</span></td><td class="vxc-p4__feat-col"><span class="vxc-p4__no">—</span></td><td>99.99%</td></tr>
    </tbody>
  </table>
</section>`
};

export const PRICING_SECTIONS: VxComponent[] = [
  PRICE_THREE_COL, PRICE_DARK_FEATURED, PRICE_MINIMAL, PRICE_COMPARISON,
];

// ════════════════════════════════════════════════════════════════
// TESTIMONIAL SECTIONS
// ════════════════════════════════════════════════════════════════

const TEST_CARD_GRID: VxComponent = {
  id: 'test-card-grid',
  name: 'Card Grid',
  category: 'testimonials',
  tags: ['light', 'cards', 'grid', 'specific'],
  description: 'Light 3-column testimonial cards with star ratings, specific outcome-focused quotes, and full name+role+company. Varied card heights avoid the masonry-template look.',
  html: `<section class="vxc-t1">
  <style>
    .vxc-t1{background:#fff;padding:clamp(80px,12vw,140px) 24px}
    .vxc-t1__head{max-width:520px;margin:0 auto 56px;text-align:center}
    .vxc-t1 h2{font-size:clamp(28px,3.8vw,40px);font-weight:800;letter-spacing:-.025em;color:#0a0a0f;margin:0 0 10px}
    .vxc-t1 > .vxc-t1__head > p{font-size:15.5px;color:rgba(10,10,15,.48);margin:0}
    .vxc-t1__grid{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
    @media(max-width:820px){.vxc-t1__grid{grid-template-columns:1fr}}
    .vxc-t1__card{background:#fafaf8;border-radius:18px;padding:28px;display:flex;flex-direction:column;gap:18px}
    .vxc-t1__stars{color:#f59e0b;letter-spacing:2px;font-size:14px}
    .vxc-t1__card p{font-size:15px;line-height:1.7;color:rgba(10,10,15,.72);margin:0;flex:1}
    .vxc-t1__person{display:flex;align-items:center;gap:12px}
    .vxc-t1__av{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0}
    .vxc-t1__name{font-size:14px;font-weight:700;color:#0a0a0f}
    .vxc-t1__role{font-size:12.5px;color:rgba(10,10,15,.45)}
  </style>
  <div class="vxc-t1__head">
    <h2>Don't take our word for it</h2>
    <p>Real teams, real results — here's what changed for them after switching.</p>
  </div>
  <div class="vxc-t1__grid">
    <div class="vxc-t1__card">
      <span class="vxc-t1__stars">★★★★★</span>
      <p>"We cut our onboarding time from three weeks to four days. That alone paid for the upgrade ten times over."</p>
      <div class="vxc-t1__person">
        <div class="vxc-t1__av" style="background:#7c3aed">DM</div>
        <div><div class="vxc-t1__name">Dana Marsh</div><div class="vxc-t1__role">Head of Ops, Cascade Logistics</div></div>
      </div>
    </div>
    <div class="vxc-t1__card">
      <span class="vxc-t1__stars">★★★★★</span>
      <p>"I was skeptical about switching tools again — six months later we've closed 40% more deals with the same headcount."</p>
      <div class="vxc-t1__person">
        <div class="vxc-t1__av" style="background:#0891b2">RT</div>
        <div><div class="vxc-t1__name">Reuben Tan</div><div class="vxc-t1__role">VP Sales, Northbeam</div></div>
      </div>
    </div>
    <div class="vxc-t1__card">
      <span class="vxc-t1__stars">★★★★★</span>
      <p>"Support actually replies in minutes, not days. First tool in years that does what it says on the tin."</p>
      <div class="vxc-t1__person">
        <div class="vxc-t1__av" style="background:#16a34a">PL</div>
        <div><div class="vxc-t1__name">Priya Lal</div><div class="vxc-t1__role">Founder, Holloway Studio</div></div>
      </div>
    </div>
  </div>
</section>`
};

const TEST_LARGE_QUOTE: VxComponent = {
  id: 'test-large-quote',
  name: 'Large Featured Quote',
  category: 'testimonials',
  tags: ['dark', 'quote', 'featured', 'minimal'],
  description: 'Dark section with a single large, featured pull-quote and attribution — high impact, minimal, ideal for placing one exceptional testimonial front and center.',
  html: `<section class="vxc-t2">
  <style>
    .vxc-t2{background:#0a0a10;padding:clamp(90px,14vw,160px) 24px;position:relative;overflow:hidden}
    .vxc-t2__glow{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:700px;height:400px;background:radial-gradient(ellipse,rgba(167,139,250,.12),transparent 70%);filter:blur(40px);pointer-events:none}
    .vxc-t2__inner{position:relative;z-index:2;max-width:780px;margin:0 auto;text-align:center}
    .vxc-t2__mark{font-size:64px;line-height:1;color:rgba(167,139,250,.35);font-family:Georgia,serif;margin-bottom:8px}
    .vxc-t2__quote{font-size:clamp(24px,3.4vw,34px);font-weight:600;line-height:1.45;letter-spacing:-.015em;color:#fff;margin:0 0 36px}
    .vxc-t2__person{display:flex;align-items:center;justify-content:center;gap:14px}
    .vxc-t2__av{width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#60a5fa);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff}
    .vxc-t2__name{font-size:15px;font-weight:700;color:#fff;text-align:left}
    .vxc-t2__role{font-size:13px;color:rgba(255,255,255,.4);text-align:left}
    @keyframes vxcT2In{from{transform:translateY(20px)}to{transform:translateY(0)}}
    .vxc-t2__inner{animation:vxcT2In .7s cubic-bezier(.16,1,.3,1) both}
  </style>
  <div class="vxc-t2__glow"></div>
  <div class="vxc-t2__inner">
    <div class="vxc-t2__mark">"</div>
    <p class="vxc-t2__quote">Switching saved our team roughly twelve hours a week — and for the first time, our reporting actually matches what's really happening on the ground.</p>
    <div class="vxc-t2__person">
      <div class="vxc-t2__av">EH</div>
      <div><div class="vxc-t2__name">Elena Hoyt</div><div class="vxc-t2__role">COO, Marlowe &amp; Finch</div></div>
    </div>
  </div>
</section>`
};

const TEST_MARQUEE: VxComponent = {
  id: 'test-marquee',
  name: 'Auto-Scroll Marquee',
  category: 'testimonials',
  tags: ['light', 'marquee', 'compact', 'social-proof'],
  description: 'Light section with two rows of compact testimonial cards auto-scrolling in opposite directions — creates a sense of momentum and abundance of social proof without taking much vertical space.',
  html: `<section class="vxc-t3">
  <style>
    .vxc-t3{background:#fafaf8;padding:clamp(80px,11vw,120px) 0;overflow:hidden}
    .vxc-t3__head{max-width:520px;margin:0 auto 48px;text-align:center;padding:0 24px}
    .vxc-t3 h2{font-size:clamp(28px,3.8vw,38px);font-weight:800;letter-spacing:-.025em;color:#0a0a0f;margin:0 0 8px}
    .vxc-t3 > .vxc-t3__head > p{font-size:15px;color:rgba(10,10,15,.48);margin:0}
    .vxc-t3__row{display:flex;gap:16px;margin-bottom:16px;width:max-content;animation:vxcT3Scroll 38s linear infinite}
    .vxc-t3__row--rev{animation-direction:reverse;animation-duration:44s}
    @keyframes vxcT3Scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
    .vxc-t3__card{background:#fff;border-radius:14px;padding:20px 22px;width:320px;flex-shrink:0;box-shadow:0 2px 16px rgba(10,10,15,.04)}
    .vxc-t3__card p{font-size:13.5px;line-height:1.6;color:rgba(10,10,15,.65);margin:0 0 14px}
    .vxc-t3__person{display:flex;align-items:center;gap:10px}
    .vxc-t3__av{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0}
    .vxc-t3__name{font-size:13px;font-weight:700;color:#0a0a0f}
    .vxc-t3__role{font-size:11.5px;color:rgba(10,10,15,.4)}
  </style>
  <div class="vxc-t3__head">
    <h2>Loved by thousands of teams</h2>
    <p>A small sample of what people are saying right now.</p>
  </div>
  <div class="vxc-t3__row">
    <div class="vxc-t3__card"><p>"Setup took ten minutes. We were live the same afternoon."</p><div class="vxc-t3__person"><div class="vxc-t3__av" style="background:#7c3aed">JK</div><div><div class="vxc-t3__name">Jordan Kim</div><div class="vxc-t3__role">Founder, Loft Studio</div></div></div></div>
    <div class="vxc-t3__card"><p>"Our support tickets dropped by half in the first month alone."</p><div class="vxc-t3__person"><div class="vxc-t3__av" style="background:#0891b2">AM</div><div><div class="vxc-t3__name">Amara Boateng</div><div class="vxc-t3__role">Support Lead, Hatchway</div></div></div></div>
    <div class="vxc-t3__card"><p>"Finally, a tool that doesn't fight us. It just works the way we think."</p><div class="vxc-t3__person"><div class="vxc-t3__av" style="background:#16a34a">TS</div><div><div class="vxc-t3__name">Theo Strand</div><div class="vxc-t3__role">Product Lead, Vertex</div></div></div></div>
    <div class="vxc-t3__card"><p>"Setup took ten minutes. We were live the same afternoon."</p><div class="vxc-t3__person"><div class="vxc-t3__av" style="background:#7c3aed">JK</div><div><div class="vxc-t3__name">Jordan Kim</div><div class="vxc-t3__role">Founder, Loft Studio</div></div></div></div>
    <div class="vxc-t3__card"><p>"Our support tickets dropped by half in the first month alone."</p><div class="vxc-t3__person"><div class="vxc-t3__av" style="background:#0891b2">AM</div><div><div class="vxc-t3__name">Amara Boateng</div><div class="vxc-t3__role">Support Lead, Hatchway</div></div></div></div>
  </div>
  <div class="vxc-t3__row vxc-t3__row--rev">
    <div class="vxc-t3__card"><p>"The migration was painless — their team did most of the heavy lifting for us."</p><div class="vxc-t3__person"><div class="vxc-t3__av" style="background:#dc2626">NF</div><div><div class="vxc-t3__name">Nadia Farouk</div><div class="vxc-t3__role">Ops Manager, Brightline</div></div></div></div>
    <div class="vxc-t3__card"><p>"We tried four other tools first. This is the only one that stuck."</p><div class="vxc-t3__person"><div class="vxc-t3__av" style="background:#f59e0b">CW</div><div><div class="vxc-t3__name">Caleb Wren</div><div class="vxc-t3__role">CEO, Northwind Co.</div></div></div></div>
    <div class="vxc-t3__card"><p>"Genuinely fun to use — which is not something I expected to say about work software."</p><div class="vxc-t3__person"><div class="vxc-t3__av" style="background:#2563eb">SO</div><div><div class="vxc-t3__name">Sana Ortiz</div><div class="vxc-t3__role">Designer, Holloway Studio</div></div></div></div>
    <div class="vxc-t3__card"><p>"The migration was painless — their team did most of the heavy lifting for us."</p><div class="vxc-t3__person"><div class="vxc-t3__av" style="background:#dc2626">NF</div><div><div class="vxc-t3__name">Nadia Farouk</div><div class="vxc-t3__role">Ops Manager, Brightline</div></div></div></div>
    <div class="vxc-t3__card"><p>"We tried four other tools first. This is the only one that stuck."</p><div class="vxc-t3__person"><div class="vxc-t3__av" style="background:#f59e0b">CW</div><div><div class="vxc-t3__name">Caleb Wren</div><div class="vxc-t3__role">CEO, Northwind Co.</div></div></div></div>
  </div>
</section>`
};

export const TESTIMONIAL_SECTIONS: VxComponent[] = [
  TEST_CARD_GRID, TEST_LARGE_QUOTE, TEST_MARQUEE,
];

// ════════════════════════════════════════════════════════════════
// CTA SECTIONS
// ════════════════════════════════════════════════════════════════

const CTA_FULL_WIDTH: VxComponent = {
  id: 'cta-full-width',
  name: 'Full Width Dark Band',
  category: 'cta',
  tags: ['dark', 'gradient', 'bold', 'final'],
  description: 'Full-width dark gradient band with a bold closing headline and prominent CTA — designed to be the final word before the footer.',
  html: `<section class="vxc-c1">
  <style>
    .vxc-c1{background:linear-gradient(135deg,#1e1b4b 0%,#0a0a14 100%);padding:clamp(80px,12vw,130px) 24px;text-align:center;position:relative;overflow:hidden}
    .vxc-c1__glow{position:absolute;top:-150px;left:50%;transform:translateX(-50%);width:700px;height:400px;background:radial-gradient(ellipse,rgba(99,102,241,.25),transparent 70%);filter:blur(50px);pointer-events:none}
    .vxc-c1__inner{position:relative;z-index:2;max-width:640px;margin:0 auto}
    .vxc-c1 h2{font-size:clamp(32px,5vw,52px);font-weight:800;letter-spacing:-.03em;color:#fff;line-height:1.15;margin:0 0 18px}
    .vxc-c1 p{font-size:17px;color:rgba(255,255,255,.55);margin:0 0 36px;line-height:1.7}
    .vxc-c1__btns{display:flex;gap:14px;justify-content:center;flex-wrap:wrap}
    .vxc-c1__cta{background:#fff;color:#1e1b4b;border:none;border-radius:11px;padding:16px 34px;font-size:15.5px;font-weight:700;cursor:pointer;text-decoration:none;transition:transform .2s,box-shadow .2s}
    .vxc-c1__cta:hover{transform:translateY(-3px);box-shadow:0 16px 44px rgba(255,255,255,.2)}
    .vxc-c1__ghost{background:rgba(255,255,255,.12);color:rgba(255,255,255,.85);border-radius:11px;padding:16px 34px;font-size:15.5px;font-weight:500;cursor:pointer;text-decoration:none;transition:background .2s,color .2s}
    .vxc-c1__ghost:hover{background:rgba(255,255,255,.18);color:#fff}
  </style>
  <div class="vxc-c1__glow"></div>
  <div class="vxc-c1__inner">
    <h2>Ready to see it for yourself?</h2>
    <p>Join thousands of teams who stopped settling for tools that almost work — and started using one that actually does.</p>
    <div class="vxc-c1__btns">
      <a href="#" class="vxc-c1__cta">Start your free trial →</a>
      <a href="#" class="vxc-c1__ghost">Talk to our team</a>
    </div>
  </div>
</section>`
};

const CTA_MINIMAL: VxComponent = {
  id: 'cta-minimal',
  name: 'Minimal Centered',
  category: 'cta',
  tags: ['light', 'minimal', 'simple', 'clean'],
  description: 'Light, ultra-clean centered CTA with a single headline and button — minimal visual weight, lets the copy carry the close.',
  html: `<section class="vxc-c2">
  <style>
    .vxc-c2{background:#fcfbf9;padding:clamp(90px,13vw,150px) 24px;text-align:center}
    .vxc-c2__inner{max-width:560px;margin:0 auto}
    .vxc-c2 h2{font-size:clamp(28px,4vw,42px);font-weight:800;letter-spacing:-.03em;color:#0a0a0f;line-height:1.2;margin:0 0 28px}
    .vxc-c2__cta{display:inline-flex;align-items:center;gap:10px;background:#0a0a0f;color:#fff;border:none;border-radius:11px;padding:16px 34px;font-size:15.5px;font-weight:700;cursor:pointer;text-decoration:none;transition:transform .2s,box-shadow .2s}
    .vxc-c2__cta:hover{transform:translateY(-3px);box-shadow:0 16px 40px rgba(10,10,15,.18)}
    .vxc-c2__note{margin-top:18px;font-size:13px;color:rgba(10,10,15,.4)}
  </style>
  <div class="vxc-c2__inner">
    <h2>Let's build something worth talking about.</h2>
    <a href="#" class="vxc-c2__cta">Get started — it's free →</a>
    <div class="vxc-c2__note">No credit card required · Cancel anytime</div>
  </div>
</section>`
};

export const CTA_SECTIONS: VxComponent[] = [CTA_FULL_WIDTH, CTA_MINIMAL];

// ════════════════════════════════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════════════════════════════════

const NAV_DARK_BLUR: VxComponent = {
  id: 'nav-dark-blur',
  name: 'Dark Blur-on-Scroll',
  category: 'nav',
  tags: ['dark', 'sticky', 'blur', 'modern'],
  description: 'Fixed dark nav that gains a frosted-glass blur and bottom border once the page scrolls — one of the simplest details that separates polished sites from flat ones.',
  html: `<nav class="vxc-n1" id="vxcNav1">
  <style>
    .vxc-n1{position:fixed;top:0;left:0;right:0;z-index:100;padding:18px 24px;transition:background .3s,backdrop-filter .3s,border-color .3s;border-bottom:1px solid transparent}
    .vxc-n1.vxc-n1--scrolled{background:rgba(8,8,12,.7);backdrop-filter:blur(16px);border-bottom-color:rgba(255,255,255,.08)}
    .vxc-n1__inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between}
    .vxc-n1__logo{font-size:18px;font-weight:800;letter-spacing:-.02em;color:#fff;text-decoration:none}
    .vxc-n1__links{display:flex;align-items:center;gap:32px}
    @media(max-width:760px){.vxc-n1__links{display:none}}
    .vxc-n1__links a{font-size:14.5px;color:rgba(255,255,255,.65);text-decoration:none;transition:color .2s}
    .vxc-n1__links a:hover{color:#fff}
    .vxc-n1__cta{background:#fff;color:#08080c;border:none;border-radius:9px;padding:10px 20px;font-size:14px;font-weight:700;text-decoration:none;transition:transform .2s}
    .vxc-n1__cta:hover{transform:translateY(-2px)}
  </style>
  <div class="vxc-n1__inner">
    <a href="#" class="vxc-n1__logo">Brand</a>
    <div class="vxc-n1__links">
      <a href="#">Product</a>
      <a href="#">Pricing</a>
      <a href="#">Customers</a>
      <a href="#">Docs</a>
    </div>
    <a href="#" class="vxc-n1__cta">Get started</a>
  </div>
  <script>
    (function(){
      var nav = document.getElementById('vxcNav1');
      if(!nav) return;
      window.addEventListener('scroll', function(){
        if(window.scrollY > 24){ nav.classList.add('vxc-n1--scrolled'); }
        else { nav.classList.remove('vxc-n1--scrolled'); }
      });
    })();
  </script>
</nav>`
};

const NAV_LIGHT_CLEAN: VxComponent = {
  id: 'nav-light-clean',
  name: 'Light Clean',
  category: 'nav',
  tags: ['light', 'clean', 'minimal', 'sticky'],
  description: 'Sticky light nav with a subtle bottom border that strengthens on scroll. Clean, minimal, works for nearly any light-themed site.',
  html: `<nav class="vxc-n2" id="vxcNav2">
  <style>
    .vxc-n2{position:sticky;top:0;z-index:100;background:rgba(255,255,255,.85);backdrop-filter:blur(12px);padding:16px 24px;border-bottom:1px solid rgba(10,10,15,.06);transition:border-color .3s,box-shadow .3s}
    .vxc-n2.vxc-n2--scrolled{border-bottom-color:rgba(10,10,15,.1);box-shadow:0 4px 24px rgba(10,10,15,.04)}
    .vxc-n2__inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between}
    .vxc-n2__logo{font-size:18px;font-weight:800;letter-spacing:-.02em;color:#0a0a0f;text-decoration:none}
    .vxc-n2__links{display:flex;align-items:center;gap:30px}
    @media(max-width:760px){.vxc-n2__links{display:none}}
    .vxc-n2__links a{font-size:14.5px;color:rgba(10,10,15,.6);text-decoration:none;transition:color .2s}
    .vxc-n2__links a:hover{color:#0a0a0f}
    .vxc-n2__cta{background:#0a0a0f;color:#fff;border:none;border-radius:9px;padding:10px 22px;font-size:14px;font-weight:700;text-decoration:none;transition:transform .2s}
    .vxc-n2__cta:hover{transform:translateY(-2px)}
  </style>
  <div class="vxc-n2__inner">
    <a href="#" class="vxc-n2__logo">Brand</a>
    <div class="vxc-n2__links">
      <a href="#">Features</a>
      <a href="#">Pricing</a>
      <a href="#">About</a>
      <a href="#">Contact</a>
    </div>
    <a href="#" class="vxc-n2__cta">Sign up free</a>
  </div>
  <script>
    (function(){
      var nav = document.getElementById('vxcNav2');
      if(!nav) return;
      window.addEventListener('scroll', function(){
        if(window.scrollY > 12){ nav.classList.add('vxc-n2--scrolled'); }
        else { nav.classList.remove('vxc-n2--scrolled'); }
      });
    })();
  </script>
</nav>`
};

export const NAV_COMPONENTS: VxComponent[] = [NAV_DARK_BLUR, NAV_LIGHT_CLEAN];

// ════════════════════════════════════════════════════════════════
// FOOTER
// ════════════════════════════════════════════════════════════════

const FOOTER_DARK_MULTI: VxComponent = {
  id: 'footer-dark-multi',
  name: 'Dark Multi-Column',
  category: 'footer',
  tags: ['dark', 'multi-column', 'detailed'],
  description: 'Full multi-column dark footer — logo+tagline, grouped link columns, social icons, copyright row. The complete pattern for content-rich sites.',
  html: `<footer class="vxc-fo1">
  <style>
    .vxc-fo1{background:#08080c;border-top:1px solid rgba(255,255,255,.06);padding:72px 24px 32px}
    .vxc-fo1__top{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:40px;padding-bottom:56px}
    @media(max-width:760px){.vxc-fo1__top{grid-template-columns:1fr 1fr;gap:32px}}
    .vxc-fo1__brand{font-size:19px;font-weight:800;letter-spacing:-.02em;color:#fff;margin-bottom:12px}
    .vxc-fo1__tag{font-size:14px;color:rgba(255,255,255,.4);line-height:1.6;max-width:240px;margin-bottom:20px}
    .vxc-fo1__social{display:flex;gap:10px}
    .vxc-fo1__social a{width:36px;height:36px;border-radius:9px;background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.5);text-decoration:none;transition:background .2s,color .2s}
    .vxc-fo1__social a:hover{background:rgba(255,255,255,.1);color:#fff}
    .vxc-fo1__h{font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:18px}
    .vxc-fo1__links{display:grid;gap:13px;list-style:none;padding:0;margin:0}
    .vxc-fo1__links a{font-size:14px;color:rgba(255,255,255,.55);text-decoration:none;transition:color .2s}
    .vxc-fo1__links a:hover{color:#fff}
    .vxc-fo1__bottom{max-width:1200px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;padding-top:28px;border-top:1px solid rgba(255,255,255,.06);flex-wrap:wrap;gap:14px}
    .vxc-fo1__bottom p{font-size:13px;color:rgba(255,255,255,.35);margin:0}
    .vxc-fo1__legal{display:flex;gap:22px}
    .vxc-fo1__legal a{font-size:13px;color:rgba(255,255,255,.35);text-decoration:none;transition:color .2s}
    .vxc-fo1__legal a:hover{color:rgba(255,255,255,.7)}
  </style>
  <div class="vxc-fo1__top">
    <div>
      <div class="vxc-fo1__brand">Brand</div>
      <p class="vxc-fo1__tag">The unified workspace for teams who'd rather build than manage tools.</p>
      <div class="vxc-fo1__social">
        <a href="#" aria-label="X">𝕏</a>
        <a href="#" aria-label="LinkedIn">in</a>
        <a href="#" aria-label="GitHub">gh</a>
      </div>
    </div>
    <div>
      <div class="vxc-fo1__h">Product</div>
      <ul class="vxc-fo1__links"><li><a href="#">Features</a></li><li><a href="#">Pricing</a></li><li><a href="#">Integrations</a></li><li><a href="#">Changelog</a></li></ul>
    </div>
    <div>
      <div class="vxc-fo1__h">Company</div>
      <ul class="vxc-fo1__links"><li><a href="#">About</a></li><li><a href="#">Careers</a></li><li><a href="#">Blog</a></li><li><a href="#">Contact</a></li></ul>
    </div>
    <div>
      <div class="vxc-fo1__h">Resources</div>
      <ul class="vxc-fo1__links"><li><a href="#">Docs</a></li><li><a href="#">Help center</a></li><li><a href="#">Community</a></li><li><a href="#">Status</a></li></ul>
    </div>
  </div>
  <div class="vxc-fo1__bottom">
    <p>© 2026 Brand, Inc. All rights reserved.</p>
    <div class="vxc-fo1__legal"><a href="#">Privacy</a><a href="#">Terms</a><a href="#">Security</a></div>
  </div>
</footer>`
};

const FOOTER_LIGHT_MINIMAL: VxComponent = {
  id: 'footer-light-minimal',
  name: 'Light Minimal',
  category: 'footer',
  tags: ['light', 'minimal', 'simple'],
  description: 'Simple light footer — single row with logo, a few links, and copyright. Best for waitlist pages, portfolios, and simpler sites that don\'t need a sprawling sitemap.',
  html: `<footer class="vxc-fo2">
  <style>
    .vxc-fo2{background:#fcfbf9;border-top:1px solid rgba(10,10,15,.07);padding:36px 24px}
    .vxc-fo2__inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:18px}
    .vxc-fo2__brand{font-size:16px;font-weight:800;letter-spacing:-.02em;color:#0a0a0f}
    .vxc-fo2__links{display:flex;gap:26px}
    .vxc-fo2__links a{font-size:14px;color:rgba(10,10,15,.5);text-decoration:none;transition:color .2s}
    .vxc-fo2__links a:hover{color:#0a0a0f}
    .vxc-fo2__copy{font-size:13px;color:rgba(10,10,15,.4)}
  </style>
  <div class="vxc-fo2__inner">
    <div class="vxc-fo2__brand">Brand</div>
    <div class="vxc-fo2__links"><a href="#">Privacy</a><a href="#">Terms</a><a href="#">Contact</a></div>
    <div class="vxc-fo2__copy">© 2026 Brand. All rights reserved.</div>
  </div>
</footer>`
};

export const FOOTER_COMPONENTS: VxComponent[] = [FOOTER_DARK_MULTI, FOOTER_LIGHT_MINIMAL];

// ════════════════════════════════════════════════════════════════
// ACCENT / FLAIR COMPONENTS
// Small, high-impact patterns the AI wouldn't naturally write —
// scrolling strips, animated counters, toasts, tab switchers, etc.
// These add the visual personality that separates polished sites
// from competent-but-generic ones.
// ════════════════════════════════════════════════════════════════

const ACCENT_LOGO_CLOUD: VxComponent = {
  id: 'accent-logo-cloud',
  name: 'Logo Cloud Strip',
  category: 'accent',
  tags: ['logos', 'trust', 'marquee', 'compact'],
  description: 'Auto-scrolling company logo strip with edge fade masks. The universal "trusted by" credibility element — compact, takes zero vertical space. Place directly below the hero or above features. Override colors to match the surrounding section.',
  html: `<section class="vxc-a1">
  <style>
    .vxc-a1{padding:52px 0;overflow:hidden;background:#fff}
    .vxc-a1__label{text-align:center;font-size:11.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:rgba(10,10,15,.32);margin-bottom:28px}
    .vxc-a1__outer{-webkit-mask-image:linear-gradient(to right,transparent,#000 12%,#000 88%,transparent);mask-image:linear-gradient(to right,transparent,#000 12%,#000 88%,transparent)}
    .vxc-a1__track{display:flex;align-items:center;gap:0;width:max-content;animation:vxcA1Run 32s linear infinite}
    @keyframes vxcA1Run{to{transform:translateX(-50%)}}
    .vxc-a1__logo{display:flex;align-items:center;gap:7px;padding:0 38px;opacity:.22;white-space:nowrap;flex-shrink:0;color:#0a0a0f;border-right:1px solid rgba(10,10,15,.1)}
    .vxc-a1__logo:last-child{border-right:none}
    .vxc-a1__logo-mark{width:26px;height:26px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;color:#fff;flex-shrink:0}
    .vxc-a1__logo-name{font-size:15px;font-weight:700;letter-spacing:-.02em}
    .vxc-a1__logo-name--wide{letter-spacing:.06em;font-size:13px;font-weight:800;text-transform:uppercase}
    .vxc-a1__logo-name--serif{font-family:Georgia,serif;font-size:16px;font-weight:700;letter-spacing:.01em}
    .vxc-a1__logo-name--thin{font-weight:300;font-size:17px;letter-spacing:.04em}
  </style>
  <div class="vxc-a1__label">Trusted by teams at</div>
  <div class="vxc-a1__outer">
    <div class="vxc-a1__track">
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-mark" style="background:#1a1a2e">N</span><span class="vxc-a1__logo-name">Northbeam</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-name--wide">CASCADE</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-mark" style="background:#0066ff">B</span><span class="vxc-a1__logo-name">Brightline</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-name--serif">Vertex</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-mark" style="background:#e5400a">H</span><span class="vxc-a1__logo-name">Hatchway</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-name--thin">lumen</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-name--wide">HOLLOWAY</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-mark" style="background:#2d1b69">M</span><span class="vxc-a1__logo-name">Marlowe</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-mark" style="background:#1a1a2e">N</span><span class="vxc-a1__logo-name">Northbeam</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-name--wide">CASCADE</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-mark" style="background:#0066ff">B</span><span class="vxc-a1__logo-name">Brightline</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-name--serif">Vertex</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-mark" style="background:#e5400a">H</span><span class="vxc-a1__logo-name">Hatchway</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-name--thin">lumen</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-name--wide">HOLLOWAY</span></span>
      <span class="vxc-a1__logo"><span class="vxc-a1__logo-mark" style="background:#2d1b69">M</span><span class="vxc-a1__logo-name">Marlowe</span></span>
    </div>
  </div>
</section>`
};

const ACCENT_HOW_IT_WORKS: VxComponent = {
  id: 'accent-how-it-works',
  name: 'How It Works — 3 Steps',
  category: 'accent',
  tags: ['steps', 'process', 'numbered', 'flow'],
  description: 'Three numbered steps connected by a dashed horizontal rule — the "how it works" section every landing page needs. Clean, minimal, light background. Place after the hero to explain the flow before pitching features. AI usually skips this or makes it look like a bullet list — this pattern makes it feel designed.',
  html: `<section class="vxc-a2">
  <style>
    .vxc-a2{background:#fcfbf9;padding:clamp(80px,11vw,130px) 24px}
    .vxc-a2__head{max-width:500px;margin:0 auto 72px;text-align:center}
    .vxc-a2 h2{font-size:clamp(28px,4vw,40px);font-weight:800;letter-spacing:-.025em;color:#0a0a0f;margin:0 0 10px}
    .vxc-a2 > .vxc-a2__head > p{font-size:15.5px;color:rgba(10,10,15,.48);margin:0}
    .vxc-a2__steps{max-width:980px;margin:0 auto;display:grid;grid-template-columns:repeat(3,1fr);position:relative}
    @media(max-width:720px){.vxc-a2__steps{grid-template-columns:1fr;gap:48px}}
    .vxc-a2__steps::before{content:'';position:absolute;top:27px;left:calc(100%/6 + 12px);right:calc(100%/6 + 12px);height:1px;background:repeating-linear-gradient(to right,rgba(10,10,15,.18) 0,rgba(10,10,15,.18) 6px,transparent 6px,transparent 14px)}
    @media(max-width:720px){.vxc-a2__steps::before{display:none}}
    .vxc-a2__step{text-align:center;padding:0 28px;position:relative;z-index:1}
    .vxc-a2__num{width:54px;height:54px;border-radius:50%;background:#0a0a0f;color:#fff;font-size:16px;font-weight:800;display:flex;align-items:center;justify-content:center;margin:0 auto 22px;letter-spacing:-.01em}
    .vxc-a2__step h3{font-size:18px;font-weight:700;color:#0a0a0f;margin:0 0 10px;letter-spacing:-.01em}
    .vxc-a2__step p{font-size:14.5px;line-height:1.7;color:rgba(10,10,15,.52);margin:0 auto;max-width:230px}
    @keyframes vxcA2In{from{transform:translateY(18px)}to{transform:translateY(0)}}
    .vxc-a2__step{animation:vxcA2In .6s cubic-bezier(.16,1,.3,1) both}
  </style>
  <div class="vxc-a2__head">
    <h2>Up and running in minutes</h2>
    <p>No complicated setup, no dev required — three steps and you're live.</p>
  </div>
  <div class="vxc-a2__steps">
    <div class="vxc-a2__step" style="animation-delay:.05s">
      <div class="vxc-a2__num">01</div>
      <h3>Connect your data</h3>
      <p>Link your existing tools in one click — no CSV exports, no manual work.</p>
    </div>
    <div class="vxc-a2__step" style="animation-delay:.15s">
      <div class="vxc-a2__num">02</div>
      <h3>Customize your setup</h3>
      <p>Tailor the workflow to your team in minutes with our no-code editor.</p>
    </div>
    <div class="vxc-a2__step" style="animation-delay:.25s">
      <div class="vxc-a2__num">03</div>
      <h3>Go live instantly</h3>
      <p>Invite your team, share the link, and start seeing results the same day.</p>
    </div>
  </div>
</section>`
};

const ACCENT_FAQ: VxComponent = {
  id: 'accent-faq',
  name: 'FAQ Accordion',
  category: 'accent',
  tags: ['faq', 'accordion', 'light', 'standalone'],
  description: 'Standalone FAQ accordion with smooth CSS max-height expand/collapse and a rotating + icon. Not tied to pricing — place anywhere on the page for objection handling. The icon rotates to × when open, the answer slides in.',
  html: `<section class="vxc-a3">
  <style>
    .vxc-a3{background:#fff;padding:clamp(80px,11vw,130px) 24px}
    .vxc-a3__wrap{max-width:700px;margin:0 auto}
    .vxc-a3 h2{font-size:clamp(28px,3.8vw,38px);font-weight:800;letter-spacing:-.025em;color:#0a0a0f;margin:0 0 52px;text-align:center}
    .vxc-a3__item{border-bottom:1px solid rgba(10,10,15,.08)}
    .vxc-a3__q{width:100%;background:none;border:none;text-align:left;padding:22px 0;font-size:15.5px;font-weight:600;color:#0a0a0f;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:16px;letter-spacing:-.01em}
    .vxc-a3__icon{flex-shrink:0;width:26px;height:26px;border-radius:50%;background:#f2f1ee;display:flex;align-items:center;justify-content:center;font-size:15px;color:rgba(10,10,15,.45);transition:transform .28s cubic-bezier(.16,1,.3,1),background .2s;line-height:1}
    .vxc-a3__item.open .vxc-a3__icon{transform:rotate(45deg);background:#0a0a0f;color:#fff}
    .vxc-a3__a{max-height:0;overflow:hidden;transition:max-height .38s cubic-bezier(.16,1,.3,1)}
    .vxc-a3__item.open .vxc-a3__a{max-height:260px}
    .vxc-a3__a p{font-size:15px;line-height:1.75;color:rgba(10,10,15,.58);padding-bottom:20px;margin:0}
  </style>
  <div class="vxc-a3__wrap">
    <h2>Frequently asked questions</h2>
    <div class="vxc-a3__item">
      <button class="vxc-a3__q" onclick="this.closest('.vxc-a3__item').classList.toggle('open')">How quickly can I get started?<span class="vxc-a3__icon">+</span></button>
      <div class="vxc-a3__a"><p>Most teams are up and running the same day. Our onboarding checklist walks you through every step — and our support team is available live if you hit a snag.</p></div>
    </div>
    <div class="vxc-a3__item">
      <button class="vxc-a3__q" onclick="this.closest('.vxc-a3__item').classList.toggle('open')">Do I need technical skills to use this?<span class="vxc-a3__icon">+</span></button>
      <div class="vxc-a3__a"><p>No code required. Everything is built for non-technical users — if you can use a spreadsheet, you can use this. Advanced integrations are available for developers too.</p></div>
    </div>
    <div class="vxc-a3__item">
      <button class="vxc-a3__q" onclick="this.closest('.vxc-a3__item').classList.toggle('open')">What happens if I need to cancel?<span class="vxc-a3__icon">+</span></button>
      <div class="vxc-a3__a"><p>Cancel anytime from your account settings — no calls, no forms, no penalties. You keep access until the end of your billing period.</p></div>
    </div>
    <div class="vxc-a3__item">
      <button class="vxc-a3__q" onclick="this.closest('.vxc-a3__item').classList.toggle('open')">Is my data secure?<span class="vxc-a3__icon">+</span></button>
      <div class="vxc-a3__a"><p>Yes — end-to-end encryption, SOC 2 Type II certified infrastructure, and we never sell or share your data. Full details in our Trust Center.</p></div>
    </div>
    <div class="vxc-a3__item">
      <button class="vxc-a3__q" onclick="this.closest('.vxc-a3__item').classList.toggle('open')">Can I migrate from my current tool?<span class="vxc-a3__icon">+</span></button>
      <div class="vxc-a3__a"><p>We support one-click import from the most common alternatives. For larger migrations, our team handles the heavy lifting at no extra cost.</p></div>
    </div>
  </div>
</section>`
};

const ACCENT_LIVE_TOAST: VxComponent = {
  id: 'accent-live-toast',
  name: 'Live Activity Toast',
  category: 'accent',
  tags: ['social-proof', 'toast', 'animated', 'flair'],
  description: 'Floating bottom-left popup cycling through live activity messages ("James just signed up from New York", "Sara upgraded to Pro"). Adds real-time momentum and social proof without consuming page space. Include this once per page when social proof matters — best near hero or pricing.',
  html: `<div class="vxc-a4" aria-live="polite">
  <style>
    .vxc-a4{position:fixed;bottom:28px;left:28px;z-index:9999;pointer-events:none}
    .vxc-a4__card{background:#fff;border-radius:14px;padding:14px 18px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 32px rgba(10,10,15,.13),0 2px 8px rgba(10,10,15,.05);max-width:276px;transition:transform .5s cubic-bezier(.16,1,.3,1),opacity .4s;position:relative}
    .vxc-a4__card.vxc-a4--out{transform:translateY(16px);opacity:0}
    .vxc-a4__av{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0}
    .vxc-a4__name{font-size:13px;font-weight:700;color:#0a0a0f}
    .vxc-a4__msg{font-size:12.5px;color:rgba(10,10,15,.52);line-height:1.4;margin-top:1px}
    .vxc-a4__time{font-size:11px;color:rgba(10,10,15,.32);margin-top:3px}
    .vxc-a4__live{position:absolute;top:11px;right:13px;width:7px;height:7px;background:#22c55e;border-radius:50%;box-shadow:0 0 0 0 rgba(34,197,94,.5);animation:vxcA4Pulse 2s ease-out infinite}
    @keyframes vxcA4Pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}70%{box-shadow:0 0 0 7px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
  </style>
  <div class="vxc-a4__card" id="vxcToastCard">
    <div class="vxc-a4__live"></div>
    <div class="vxc-a4__av" id="vxcToastAv" style="background:#7c3aed">JM</div>
    <div>
      <div class="vxc-a4__name" id="vxcToastName">James M.</div>
      <div class="vxc-a4__msg" id="vxcToastMsg">Just signed up from New York</div>
      <div class="vxc-a4__time">Just now</div>
    </div>
  </div>
  <script>
    (function(){
      var ev=[
        {i:'JM',n:'James M.',m:'Just signed up from New York',c:'#7c3aed'},
        {i:'SP',n:'Sara P.',m:'Upgraded to the Pro plan',c:'#0891b2'},
        {i:'KA',n:'Kofi A.',m:'Just started a free trial',c:'#16a34a'},
        {i:'RL',n:'Rachel L.',m:'Just signed up from London',c:'#dc2626'},
        {i:'TW',n:'Tom W.',m:'Just completed onboarding',c:'#b45309'}
      ];
      var idx=0;
      function next(){
        var card=document.getElementById('vxcToastCard');
        if(!card)return;
        card.classList.add('vxc-a4--out');
        setTimeout(function(){
          var e=ev[idx%ev.length];idx++;
          document.getElementById('vxcToastAv').textContent=e.i;
          document.getElementById('vxcToastAv').style.background=e.c;
          document.getElementById('vxcToastName').textContent=e.n;
          document.getElementById('vxcToastMsg').textContent=e.m;
          card.classList.remove('vxc-a4--out');
        },420);
      }
      setTimeout(next,3200);
      setInterval(next,5800);
    })();
  </script>
</div>`
};

const ACCENT_TAB_FEATURES: VxComponent = {
  id: 'accent-tab-features',
  name: 'Tab Feature Switcher',
  category: 'accent',
  tags: ['tabs', 'features', 'interactive', 'product'],
  description: 'Pill-style tab navigation switching between 3 feature areas, each showing unique copy and a CSS-built product visual. Far more engaging than static feature cards. Best for SaaS with 2-4 distinct feature pillars — the interaction makes users explore the product.',
  html: `<section class="vxc-a5">
  <style>
    .vxc-a5{background:#f9f8f6;padding:clamp(80px,12vw,130px) 24px}
    .vxc-a5__head{max-width:520px;margin:0 auto 48px;text-align:center}
    .vxc-a5 h2{font-size:clamp(28px,4vw,40px);font-weight:800;letter-spacing:-.025em;color:#0a0a0f;margin:0 0 10px}
    .vxc-a5 > .vxc-a5__head > p{font-size:15.5px;color:rgba(10,10,15,.48);margin:0}
    .vxc-a5__tabs{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:48px}
    .vxc-a5__tab{background:none;border:1.5px solid rgba(10,10,15,.12);border-radius:100px;padding:10px 22px;font-size:14px;font-weight:600;color:rgba(10,10,15,.5);cursor:pointer;transition:all .2s}
    .vxc-a5__tab.active{background:#0a0a0f;color:#fff;border-color:#0a0a0f}
    .vxc-a5__panels{max-width:1060px;margin:0 auto}
    .vxc-a5__panel{display:none;grid-template-columns:1fr 1fr;gap:60px;align-items:center}
    .vxc-a5__panel.active{display:grid}
    @media(max-width:800px){.vxc-a5__panel.active{grid-template-columns:1fr}}
    .vxc-a5__copy h3{font-size:clamp(22px,3vw,28px);font-weight:800;letter-spacing:-.02em;color:#0a0a0f;margin:0 0 14px;line-height:1.2}
    .vxc-a5__copy p{font-size:15.5px;line-height:1.75;color:rgba(10,10,15,.55);margin:0 0 22px}
    .vxc-a5__list{display:grid;gap:9px;list-style:none;padding:0;margin:0}
    .vxc-a5__list li{display:flex;align-items:center;gap:9px;font-size:14px;color:rgba(10,10,15,.65)}
    .vxc-a5__ck{width:18px;height:18px;border-radius:50%;background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0}
    .vxc-a5__viz{border-radius:18px;background:#fff;box-shadow:0 16px 56px rgba(10,10,15,.08);padding:28px;min-height:260px;display:flex;flex-direction:column;gap:14px}
    .vxc-a5__vline{height:9px;border-radius:5px;background:rgba(10,10,15,.07)}
    .vxc-a5__vchart{height:90px;display:flex;align-items:flex-end;gap:7px;margin-top:8px}
    .vxc-a5__vbar{flex:1;border-radius:4px 4px 0 0}
  </style>
  <div class="vxc-a5__head">
    <h2>One platform. Every workflow.</h2>
    <p>Switch between the areas that matter most to your team.</p>
  </div>
  <div class="vxc-a5__tabs">
    <button class="vxc-a5__tab active" onclick="vxcA5Tab(0,this)">Planning</button>
    <button class="vxc-a5__tab" onclick="vxcA5Tab(1,this)">Collaboration</button>
    <button class="vxc-a5__tab" onclick="vxcA5Tab(2,this)">Reporting</button>
  </div>
  <div class="vxc-a5__panels">
    <div class="vxc-a5__panel active">
      <div class="vxc-a5__copy">
        <h3>Plan every project with clarity</h3>
        <p>Visual timelines, workload views, and smart scheduling. No more juggling calendar apps and spreadsheets.</p>
        <ul class="vxc-a5__list"><li><span class="vxc-a5__ck">✓</span>Drag-and-drop roadmaps</li><li><span class="vxc-a5__ck">✓</span>Automatic deadline tracking</li><li><span class="vxc-a5__ck">✓</span>Team capacity views</li></ul>
      </div>
      <div class="vxc-a5__viz">
        <div class="vxc-a5__vline" style="width:72%"></div>
        <div class="vxc-a5__vline" style="width:50%;opacity:.55"></div>
        <div class="vxc-a5__vchart">
          <div class="vxc-a5__vbar" style="background:#a5b4fc;height:58%"></div>
          <div class="vxc-a5__vbar" style="background:#818cf8;height:80%"></div>
          <div class="vxc-a5__vbar" style="background:#a5b4fc;height:52%"></div>
          <div class="vxc-a5__vbar" style="background:#818cf8;height:92%"></div>
          <div class="vxc-a5__vbar" style="background:#a5b4fc;height:68%"></div>
        </div>
      </div>
    </div>
    <div class="vxc-a5__panel">
      <div class="vxc-a5__copy">
        <h3>Feedback that doesn't disappear</h3>
        <p>Comments, approvals, and threads live right alongside the work — not buried in email or Slack history.</p>
        <ul class="vxc-a5__list"><li><span class="vxc-a5__ck">✓</span>Inline comments on anything</li><li><span class="vxc-a5__ck">✓</span>Real-time presence indicators</li><li><span class="vxc-a5__ck">✓</span>Approval workflows built in</li></ul>
      </div>
      <div class="vxc-a5__viz">
        <div class="vxc-a5__vline" style="width:62%"></div>
        <div class="vxc-a5__vline" style="width:44%;opacity:.55"></div>
        <div style="background:#f0fdf4;border-radius:10px;padding:16px;margin-top:4px;display:grid;gap:8px">
          <div class="vxc-a5__vline" style="width:80%;background:rgba(21,128,61,.22)"></div>
          <div class="vxc-a5__vline" style="width:55%;background:rgba(21,128,61,.14)"></div>
        </div>
      </div>
    </div>
    <div class="vxc-a5__panel">
      <div class="vxc-a5__copy">
        <h3>Reports that write themselves</h3>
        <p>Live dashboards pull in data from everywhere your team works — ready to share without a single manual export.</p>
        <ul class="vxc-a5__list"><li><span class="vxc-a5__ck">✓</span>Auto-updating KPI dashboards</li><li><span class="vxc-a5__ck">✓</span>One-click stakeholder exports</li><li><span class="vxc-a5__ck">✓</span>Trend analysis built in</li></ul>
      </div>
      <div class="vxc-a5__viz">
        <div class="vxc-a5__vline" style="width:68%"></div>
        <div class="vxc-a5__vchart" style="height:110px;margin-top:12px">
          <div class="vxc-a5__vbar" style="background:#fcd34d;height:38%"></div>
          <div class="vxc-a5__vbar" style="background:#fbbf24;height:62%"></div>
          <div class="vxc-a5__vbar" style="background:#f59e0b;height:50%"></div>
          <div class="vxc-a5__vbar" style="background:#f59e0b;height:88%"></div>
          <div class="vxc-a5__vbar" style="background:#d97706;height:72%"></div>
          <div class="vxc-a5__vbar" style="background:#d97706;height:100%"></div>
        </div>
      </div>
    </div>
  </div>
  <script>
    function vxcA5Tab(i,btn){
      document.querySelectorAll('.vxc-a5__panel').forEach(function(p,n){p.classList.toggle('active',n===i)});
      document.querySelectorAll('.vxc-a5__tab').forEach(function(t,n){t.classList.toggle('active',n===i)});
    }
  </script>
</section>`
};

const ACCENT_TRUST_BADGES: VxComponent = {
  id: 'accent-trust-badges',
  name: 'Trust & Security Badges',
  category: 'accent',
  tags: ['trust', 'security', 'badges', 'compliance'],
  description: 'Row of security/compliance trust signals (SOC 2, GDPR, uptime, encryption) with tinted icon boxes. Instantly boosts credibility for B2B, fintech, and anything handling sensitive data. Place before or after pricing.',
  html: `<section class="vxc-a6">
  <style>
    .vxc-a6{background:#f9f8f6;padding:clamp(44px,6vw,68px) 24px;border-top:1px solid rgba(10,10,15,.06);border-bottom:1px solid rgba(10,10,15,.06)}
    .vxc-a6__wrap{max-width:1060px;margin:0 auto;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:14px}
    .vxc-a6__badge{display:flex;align-items:center;gap:11px;background:#fff;border-radius:12px;padding:14px 18px;box-shadow:0 2px 14px rgba(10,10,15,.05)}
    .vxc-a6__icon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px}
    .vxc-a6__icon--a{background:#dbeafe;color:#1d4ed8}
    .vxc-a6__icon--b{background:#dcfce7;color:#15803d}
    .vxc-a6__icon--c{background:#fef3c7;color:#b45309}
    .vxc-a6__icon--d{background:#ede9fe;color:#7c3aed}
    .vxc-a6__title{font-size:14px;font-weight:700;color:#0a0a0f;letter-spacing:-.01em}
    .vxc-a6__sub{font-size:12px;color:rgba(10,10,15,.42);margin-top:2px}
  </style>
  <div class="vxc-a6__wrap">
    <div class="vxc-a6__badge"><div class="vxc-a6__icon vxc-a6__icon--a"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 1.5L2.5 5v4.5c0 4.5 3.5 8.5 7.5 9.5 4-1 7.5-5 7.5-9.5V5L10 1.5z"/></svg></div><div><div class="vxc-a6__title">SOC 2 Type II</div><div class="vxc-a6__sub">Certified &amp; audited annually</div></div></div>
    <div class="vxc-a6__badge"><div class="vxc-a6__icon vxc-a6__icon--b"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="12" height="9" rx="2"/><path d="M7 9V6a3 3 0 016 0v3"/></svg></div><div><div class="vxc-a6__title">End-to-end encrypted</div><div class="vxc-a6__sub">AES-256 at rest &amp; in transit</div></div></div>
    <div class="vxc-a6__badge"><div class="vxc-a6__icon vxc-a6__icon--c"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 1.5L2.5 5v4.5c0 4.5 3.5 8.5 7.5 9.5 4-1 7.5-5 7.5-9.5V5L10 1.5z"/><path d="M7 10l2 2 4-4"/></svg></div><div><div class="vxc-a6__title">99.99% uptime SLA</div><div class="vxc-a6__sub">Monitored 24/7, publicly tracked</div></div></div>
    <div class="vxc-a6__badge"><div class="vxc-a6__icon vxc-a6__icon--d"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M2 10h16"/><path d="M10 2a5 8 0 000 16M10 2a5 8 0 010 16"/></svg></div><div><div class="vxc-a6__title">GDPR compliant</div><div class="vxc-a6__sub">Data residency options available</div></div></div>
  </div>
</section>`
};

const ACCENT_COUNTER_STATS: VxComponent = {
  id: 'accent-counter-stats',
  name: 'Animated Counter Stats',
  category: 'accent',
  tags: ['stats', 'animated', 'counters', 'dark'],
  description: 'Dark band with large numbers that count up from zero when scrolled into view using IntersectionObserver. The animated version of the static stat band — significantly more impactful. Use to punctuate a page with hard credibility numbers. The AI would never write the IntersectionObserver animation logic unprompted.',
  html: `<section class="vxc-a7">
  <style>
    .vxc-a7{background:#09090f;padding:clamp(70px,10vw,100px) 24px}
    .vxc-a7__wrap{max-width:960px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);gap:40px;text-align:center}
    @media(max-width:720px){.vxc-a7__wrap{grid-template-columns:repeat(2,1fr)}}
    .vxc-a7__num{font-size:clamp(34px,4.5vw,50px);font-weight:800;letter-spacing:-.03em;color:#fff;margin-bottom:8px;font-variant-numeric:tabular-nums}
    .vxc-a7__lbl{font-size:13.5px;color:rgba(255,255,255,.4);line-height:1.5}
  </style>
  <div class="vxc-a7__wrap" id="vxcCtrWrap">
    <div><div class="vxc-a7__num" data-target="2400" data-suffix="+">—</div><div class="vxc-a7__lbl">Businesses active today</div></div>
    <div><div class="vxc-a7__num" data-target="99.99" data-suffix="%" data-dec="2">—</div><div class="vxc-a7__lbl">Platform uptime, SLA-backed</div></div>
    <div><div class="vxc-a7__num" data-target="12" data-suffix=" min">—</div><div class="vxc-a7__lbl">Average time to first value</div></div>
    <div><div class="vxc-a7__num" data-prefix="$" data-target="840" data-suffix="M+">—</div><div class="vxc-a7__lbl">Processed on the platform</div></div>
  </div>
  <script>
    (function(){
      var ran=false;
      function run(){
        if(ran)return;ran=true;
        document.querySelectorAll('#vxcCtrWrap .vxc-a7__num').forEach(function(el){
          var t=parseFloat(el.dataset.target),d=parseInt(el.dataset.dec||0),s=el.dataset.suffix||'',p=el.dataset.prefix||'',dur=1600,t0=performance.now();
          (function f(now){var pct=Math.min((now-t0)/dur,1),ease=1-Math.pow(1-pct,3),val=t*ease;el.textContent=p+(d?val.toFixed(d):Math.round(val))+s;if(pct<1)requestAnimationFrame(f);})(t0);
        });
      }
      var wrap=document.getElementById('vxcCtrWrap');
      if(!wrap)return;
      if('IntersectionObserver' in window){new IntersectionObserver(function(e){if(e[0].isIntersecting)run();},{threshold:.3}).observe(wrap);}else{run();}
    })();
  </script>
</section>`
};

const ACCENT_WORLD_MAP: VxComponent = {
  id: 'accent-world-map',
  name: 'World Reach Map',
  category: 'accent',
  tags: ['map', 'global', 'animated', 'dark', 'visual'],
  description: 'Dark section with a simplified SVG dot-grid world map and animated curved connection arcs radiating from a center hub — communicates global reach or a distributed user base with high visual drama. The arcs draw in on load using stroke-dashoffset animation. Best for "used in X countries" positioning.',
  html: `<section class="vxc-a8">
  <style>
    .vxc-a8{background:#07070d;padding:clamp(80px,11vw,120px) 24px;text-align:center;overflow:hidden}
    .vxc-a8__head{max-width:480px;margin:0 auto 56px}
    .vxc-a8 h2{font-size:clamp(28px,4vw,40px);font-weight:800;letter-spacing:-.025em;color:#fff;margin:0 0 10px}
    .vxc-a8 > .vxc-a8__head > p{font-size:15.5px;color:rgba(255,255,255,.42);margin:0}
    .vxc-a8__svg{max-width:860px;width:100%;margin:0 auto;display:block}
    .vxc-a8__land{fill:none;stroke:#fff;stroke-width:5;stroke-linecap:round}
    .vxc-a8__arc{fill:none;stroke:#818cf8;stroke-width:2.5;stroke-dasharray:420;stroke-dashoffset:420;animation:vxcA8Arc 1.8s cubic-bezier(.16,1,.3,1) forwards}
    .vxc-a8__hub{fill:#6366f1;filter:drop-shadow(0 0 8px rgba(99,102,241,.7))}
    .vxc-a8__node{fill:#6366f1;filter:drop-shadow(0 0 5px rgba(99,102,241,.6))}
    .vxc-a8__ring{fill:rgba(99,102,241,.2);animation:vxcA8Ring 2.2s ease-out infinite}
    @keyframes vxcA8Arc{to{stroke-dashoffset:0}}
    @keyframes vxcA8Ring{0%{r:6;opacity:.7}100%{r:20;opacity:0}}
    .vxc-a8__sub{margin-top:36px;font-size:13px;color:rgba(255,255,255,.38)}
    .vxc-a8__sub strong{color:#fff;font-size:20px;font-weight:800;display:block;margin-bottom:4px}
  </style>
  <div class="vxc-a8__head">
    <h2>Used in 80+ countries</h2>
    <p>From solo freelancers to enterprise teams — we're where the work happens.</p>
  </div>
  <svg class="vxc-a8__svg" viewBox="0 0 800 380" xmlns="http://www.w3.org/2000/svg">
    <path class="vxc-a8__land" d="M150,3l0,0m13,0l0,0m50,0l0,0m12,0l0,0m13,0l0,0m50,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m113,0l0,0m87,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m25,0l0,0m13,0l0,0m12,0l0,0m-681,10l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m25,0l0,0m13,0l0,0m25,0l0,0m25,0l0,0m25,0l0,0m50,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m100,0l0,0m12,0l0,0m13,0l0,0m87,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m-706,11l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m37,0l0,0m38,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m113,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m25,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m25,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m-719,11l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m38,0l0,0m50,0l0,0m12,0l0,0m50,0l0,0m75,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m25,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m-706,11l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m75,0l0,0m12,0l0,0m125,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m-719,11l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m37,0l0,0m63,0l0,0m125,0l0,0m12,0l0,0m25,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m-681,10l0,0m13,0l0,0m37,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m50,0l0,0m12,0l0,0m163,0l0,0m12,0l0,0m38,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m50,0l0,0m-631,11l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m38,0l0,0m12,0l0,0m163,0l0,0m12,0l0,0m25,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m50,0l0,0m-619,11l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m25,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m125,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m37,0l0,0m-631,11l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m162,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m-568,11l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m150,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m25,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m-582,11l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m162,0l0,0m38,0l0,0m12,0l0,0m38,0l0,0m25,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m25,0l0,0m-581,10l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m163,0l0,0m75,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m25,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m-531,11l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m175,0l0,0m13,0l0,0m62,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m25,0l0,0m25,0l0,0m-556,11l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m175,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m25,0l0,0m38,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m25,0l0,0m-519,11l0,0m12,0l0,0m38,0l0,0m162,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m-481,11l0,0m200,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m38,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m-469,11l0,0m25,0l0,0m38,0l0,0m125,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m50,0l0,0m12,0l0,0m38,0l0,0m12,0l0,0m-418,10l0,0m162,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m75,0l0,0m50,0l0,0m13,0l0,0m-419,11l0,0m25,0l0,0m12,0l0,0m125,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m63,0l0,0m50,0l0,0m12,0l0,0m-393,11l0,0m12,0l0,0m13,0l0,0m12,0l0,0m150,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m113,0l0,0m12,0l0,0m-394,11l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m150,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m163,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m-469,11l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m125,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m238,0l0,0m-482,10l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m112,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m-243,11l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m125,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m187,0l0,0m13,0l0,0m25,0l0,0m-457,11l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m125,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m37,0l0,0m163,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m-469,11l0,0m13,0l0,0m12,0l0,0m13,0l0,0m150,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m25,0l0,0m150,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m-481,11l0,0m12,0l0,0m13,0l0,0m12,0l0,0m163,0l0,0m12,0l0,0m13,0l0,0m187,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m13,0l0,0m12,0l0,0m-481,11l0,0m13,0l0,0m12,0l0,0m175,0l0,0m213,0l0,0m37,0l0,0m13,0l0,0m12,0l0,0m-481,10l0,0m12,0l0,0m13,0l0,0m450,0l0,0m-469,11l0,0m475,0l0,0m-481,11l0,0m12,0l0,0m-18,11l0,0m12,0l0,0m-6,11l0,0m6,11l0,0"/>
    <path class="vxc-a8__arc" d="M430,85 Q300,10 165,115" style="animation-delay:.15s"/>
    <path class="vxc-a8__arc" d="M430,85 Q360,180 270,230" style="animation-delay:.4s"/>
    <path class="vxc-a8__arc" d="M430,85 Q470,130 440,180" style="animation-delay:.65s"/>
    <path class="vxc-a8__arc" d="M430,85 Q540,20 630,90" style="animation-delay:.9s"/>
    <path class="vxc-a8__arc" d="M430,85 Q600,190 700,245" style="animation-delay:1.15s"/>
    <circle class="vxc-a8__node" cx="165" cy="115" r="5"/><circle class="vxc-a8__node" cx="270" cy="230" r="5"/><circle class="vxc-a8__node" cx="440" cy="180" r="5"/><circle class="vxc-a8__node" cx="630" cy="90" r="5"/><circle class="vxc-a8__node" cx="700" cy="245" r="5"/>
    <circle class="vxc-a8__ring" cx="430" cy="85" r="6"/>
    <circle class="vxc-a8__hub" cx="430" cy="85" r="7"/>
  </svg>
  <div class="vxc-a8__sub"><strong>40,000+</strong>active users worldwide</div>
</section>`
};

const ACCENT_BROWSER_MOCKUP: VxComponent = {
  id: 'accent-browser-mockup',
  name: 'Product Dashboard Mockup',
  category: 'accent',
  tags: ['product', 'screenshot', 'dashboard', 'visual', 'dark'],
  description: 'A CSS-built browser window framing a fake product dashboard — sidebar nav, stat cards, and a bar chart. Gives the impression of a real screenshot without using any image. Use this for SaaS/product sites that need to "show the product" but have no real screenshots. Place after the hero or as a standalone showcase section.',
  html: `<section class="vxc-a9">
  <style>
    .vxc-a9{background:#0a0a0f;padding:clamp(80px,11vw,130px) 24px;overflow:hidden}
    .vxc-a9__head{max-width:560px;margin:0 auto 56px;text-align:center}
    .vxc-a9 h2{font-size:clamp(28px,4.2vw,42px);font-weight:800;letter-spacing:-.025em;color:#fff;margin:0 0 12px}
    .vxc-a9 > .vxc-a9__head > p{font-size:16px;color:rgba(255,255,255,.45);margin:0}
    .vxc-a9__browser{max-width:980px;margin:0 auto;border-radius:14px;overflow:hidden;background:#16161f;box-shadow:0 30px 100px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.06)}
    .vxc-a9__bar{display:flex;align-items:center;gap:8px;padding:13px 16px;background:#1c1c28;border-bottom:1px solid rgba(255,255,255,.05)}
    .vxc-a9__dot{width:11px;height:11px;border-radius:50%}
    .vxc-a9__url{flex:1;margin-left:12px;background:rgba(255,255,255,.05);border-radius:6px;padding:6px 14px;font-size:12px;color:rgba(255,255,255,.35);text-align:center}
    .vxc-a9__body{display:grid;grid-template-columns:200px 1fr;min-height:380px}
    @media(max-width:720px){.vxc-a9__body{grid-template-columns:1fr}.vxc-a9__side{display:none}}
    .vxc-a9__side{background:#13131c;border-right:1px solid rgba(255,255,255,.05);padding:20px 14px;display:flex;flex-direction:column;gap:6px}
    .vxc-a9__nav-item{height:32px;border-radius:8px;background:rgba(255,255,255,.04)}
    .vxc-a9__nav-item--active{background:rgba(99,102,241,.18);position:relative}
    .vxc-a9__nav-item--active::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;border-radius:2px;background:#818cf8}
    .vxc-a9__main{padding:28px}
    .vxc-a9__cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:20px}
    @media(max-width:560px){.vxc-a9__cards{grid-template-columns:1fr}}
    .vxc-a9__card{background:rgba(255,255,255,.04);border-radius:10px;padding:16px}
    .vxc-a9__card-num{font-size:24px;font-weight:800;color:#fff;margin-bottom:6px;font-variant-numeric:tabular-nums}
    .vxc-a9__card-lbl{font-size:11.5px;color:rgba(255,255,255,.4)}
    .vxc-a9__chart{background:rgba(255,255,255,.04);border-radius:10px;padding:20px;display:flex;align-items:flex-end;gap:10px;height:140px}
    .vxc-a9__bar-el{flex:1;border-radius:5px 5px 0 0;background:linear-gradient(180deg,#818cf8,#6366f1)}
  </style>
  <div class="vxc-a9__head">
    <h2>See everything, in one place</h2>
    <p>A live look at the dashboard your team will actually use every day.</p>
  </div>
  <div class="vxc-a9__browser">
    <div class="vxc-a9__bar">
      <div class="vxc-a9__dot" style="background:#ff5f57"></div>
      <div class="vxc-a9__dot" style="background:#febc2e"></div>
      <div class="vxc-a9__dot" style="background:#28c840"></div>
      <div class="vxc-a9__url">app.yourproduct.com/dashboard</div>
    </div>
    <div class="vxc-a9__body">
      <div class="vxc-a9__side">
        <div class="vxc-a9__nav-item vxc-a9__nav-item--active"></div>
        <div class="vxc-a9__nav-item"></div>
        <div class="vxc-a9__nav-item"></div>
        <div class="vxc-a9__nav-item"></div>
        <div class="vxc-a9__nav-item"></div>
      </div>
      <div class="vxc-a9__main">
        <div class="vxc-a9__cards">
          <div class="vxc-a9__card"><div class="vxc-a9__card-num">2,481</div><div class="vxc-a9__card-lbl">Active users</div></div>
          <div class="vxc-a9__card"><div class="vxc-a9__card-num">$48.2k</div><div class="vxc-a9__card-lbl">Revenue this month</div></div>
          <div class="vxc-a9__card"><div class="vxc-a9__card-num">94%</div><div class="vxc-a9__card-lbl">Satisfaction score</div></div>
        </div>
        <div class="vxc-a9__chart">
          <div class="vxc-a9__bar-el" style="height:45%"></div>
          <div class="vxc-a9__bar-el" style="height:62%"></div>
          <div class="vxc-a9__bar-el" style="height:38%"></div>
          <div class="vxc-a9__bar-el" style="height:80%"></div>
          <div class="vxc-a9__bar-el" style="height:55%"></div>
          <div class="vxc-a9__bar-el" style="height:92%"></div>
          <div class="vxc-a9__bar-el" style="height:70%"></div>
          <div class="vxc-a9__bar-el" style="height:100%"></div>
        </div>
      </div>
    </div>
  </div>
</section>`
};

const ACCENT_FEATURE_ROWS: VxComponent = {
  id: 'accent-feature-rows',
  name: 'Alternating Feature Rows',
  category: 'accent',
  tags: ['features', 'alternating', 'visual', 'product'],
  description: 'Two alternating text/visual rows — copy on one side, a layered card composition (rings, floating stat cards) on the other, flipping sides each row. Far more considered than three equal icon-cards. Use for explaining 2-3 major capabilities in depth with room for real explanation.',
  html: `<section class="vxc-a10">
  <style>
    .vxc-a10{background:#fff;padding:clamp(80px,11vw,130px) 24px}
    .vxc-a10__wrap{max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:clamp(64px,9vw,110px)}
    .vxc-a10__row{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center}
    .vxc-a10__row--rev .vxc-a10__copy{order:2}
    .vxc-a10__row--rev .vxc-a10__visual{order:1}
    @media(max-width:780px){.vxc-a10__row,.vxc-a10__row--rev .vxc-a10__copy,.vxc-a10__row--rev .vxc-a10__visual{grid-template-columns:1fr;order:0}}
    .vxc-a10__tag{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6366f1;margin-bottom:14px}
    .vxc-a10__copy h3{font-size:clamp(24px,3.2vw,34px);font-weight:800;letter-spacing:-.02em;color:#0a0a0f;margin:0 0 14px;line-height:1.2}
    .vxc-a10__copy p{font-size:15.5px;line-height:1.75;color:rgba(10,10,15,.55);margin:0 0 22px}
    .vxc-a10__list{display:grid;gap:10px;list-style:none;padding:0;margin:0}
    .vxc-a10__list li{display:flex;align-items:flex-start;gap:10px;font-size:14.5px;color:rgba(10,10,15,.65)}
    .vxc-a10__ck{width:18px;height:18px;border-radius:50%;background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0;margin-top:2px}
    .vxc-a10__visual{aspect-ratio:1.2/1;border-radius:20px;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}
    .vxc-a10__visual--a{background:linear-gradient(135deg,#eef2ff,#e0e7ff)}
    .vxc-a10__visual--b{background:linear-gradient(135deg,#f0fdf4,#dcfce7)}
    .vxc-a10__card{background:#fff;border-radius:14px;box-shadow:0 16px 48px rgba(10,10,15,.1);padding:18px;position:absolute}
    .vxc-a10__bar{height:8px;border-radius:4px;background:rgba(10,10,15,.08)}
    .vxc-a10__ring{position:absolute;border-radius:50%;border:1px solid rgba(99,102,241,.18)}
  </style>
  <div class="vxc-a10__wrap">
    <div class="vxc-a10__row">
      <div class="vxc-a10__copy">
        <span class="vxc-a10__tag">Automation</span>
        <h3>Let the busywork run itself</h3>
        <p>Set up rules once and they quietly handle the repetitive parts of your workflow — no babysitting required.</p>
        <ul class="vxc-a10__list">
          <li><span class="vxc-a10__ck">✓</span>Trigger actions from any event</li>
          <li><span class="vxc-a10__ck">✓</span>Visual rule builder, no code</li>
          <li><span class="vxc-a10__ck">✓</span>Full history of every automation run</li>
        </ul>
      </div>
      <div class="vxc-a10__visual vxc-a10__visual--a">
        <div class="vxc-a10__ring" style="width:280px;height:280px"></div>
        <div class="vxc-a10__ring" style="width:200px;height:200px"></div>
        <div class="vxc-a10__card" style="width:180px;top:18%;left:12%">
          <div class="vxc-a10__bar" style="width:70%;margin-bottom:8px"></div>
          <div class="vxc-a10__bar" style="width:45%;opacity:.5"></div>
        </div>
        <div class="vxc-a10__card" style="width:160px;bottom:14%;right:10%">
          <div class="vxc-a10__bar" style="width:80%;margin-bottom:8px;background:rgba(99,102,241,.3)"></div>
          <div class="vxc-a10__bar" style="width:55%;opacity:.5"></div>
        </div>
      </div>
    </div>
    <div class="vxc-a10__row vxc-a10__row--rev">
      <div class="vxc-a10__copy">
        <span class="vxc-a10__tag">Insights</span>
        <h3>Know what's working, instantly</h3>
        <p>Every action feeds a live dashboard — so you can spot trends and make calls without waiting for a weekly report.</p>
        <ul class="vxc-a10__list">
          <li><span class="vxc-a10__ck">✓</span>Custom dashboards per team</li>
          <li><span class="vxc-a10__ck">✓</span>Export to anywhere in one click</li>
          <li><span class="vxc-a10__ck">✓</span>Alerts when numbers move</li>
        </ul>
      </div>
      <div class="vxc-a10__visual vxc-a10__visual--b">
        <div class="vxc-a10__card" style="width:200px;top:20%;right:10%">
          <div style="font-size:22px;font-weight:800;color:#0a0a0f;margin-bottom:4px">+184%</div>
          <div class="vxc-a10__bar" style="width:90%;background:rgba(21,128,61,.18)"></div>
        </div>
        <div class="vxc-a10__card" style="width:170px;bottom:16%;left:8%">
          <div class="vxc-a10__bar" style="width:60%;margin-bottom:8px"></div>
          <div class="vxc-a10__bar" style="width:40%;opacity:.5"></div>
        </div>
      </div>
    </div>
  </div>
</section>`
};

const ACCENT_COMPARISON_TABLE: VxComponent = {
  id: 'accent-comparison-table',
  name: 'Competitor Comparison Table',
  category: 'accent',
  tags: ['comparison', 'table', 'pricing', 'competitive'],
  description: 'A clean "us vs. others" comparison table with a highlighted winning column. Strong conversion driver right before pricing — frames the decision before the user sees the price. Adapt the feature rows to whatever genuinely differentiates this product.',
  html: `<section class="vxc-a11">
  <style>
    .vxc-a11{background:#f9f8f6;padding:clamp(80px,11vw,130px) 24px}
    .vxc-a11__head{max-width:520px;margin:0 auto 56px;text-align:center}
    .vxc-a11 h2{font-size:clamp(28px,4vw,40px);font-weight:800;letter-spacing:-.025em;color:#0a0a0f;margin:0 0 10px}
    .vxc-a11 > .vxc-a11__head > p{font-size:15.5px;color:rgba(10,10,15,.48);margin:0}
    .vxc-a11__table{max-width:840px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 16px 56px rgba(10,10,15,.06)}
    .vxc-a11__row{display:grid;grid-template-columns:1.6fr 1fr 1fr;align-items:center}
    .vxc-a11__row:not(:last-child){border-bottom:1px solid rgba(10,10,15,.06)}
    .vxc-a11__cell{padding:18px 20px;font-size:14px;color:rgba(10,10,15,.6)}
    .vxc-a11__row--head .vxc-a11__cell{background:#0a0a0f;color:rgba(255,255,255,.5);font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
    .vxc-a11__row--head .vxc-a11__cell:nth-child(3){color:#fff}
    .vxc-a11__feat{font-weight:600;color:#0a0a0f}
    .vxc-a11__cell--mid,.vxc-a11__cell--win{text-align:center}
    .vxc-a11__row:not(.vxc-a11__row--head) .vxc-a11__cell--win{background:rgba(99,102,241,.05);font-weight:700;color:#0a0a0f}
    .vxc-a11__yes{color:#16a34a;font-weight:800}
    .vxc-a11__no{color:rgba(10,10,15,.22);font-weight:800}
  </style>
  <div class="vxc-a11__head">
    <h2>Why teams switch to us</h2>
    <p>A side-by-side look at what you're actually getting.</p>
  </div>
  <div class="vxc-a11__table">
    <div class="vxc-a11__row vxc-a11__row--head">
      <div class="vxc-a11__cell">Feature</div>
      <div class="vxc-a11__cell vxc-a11__cell--mid">Others</div>
      <div class="vxc-a11__cell vxc-a11__cell--win">Us</div>
    </div>
    <div class="vxc-a11__row"><div class="vxc-a11__cell vxc-a11__feat">Unlimited projects</div><div class="vxc-a11__cell vxc-a11__cell--mid vxc-a11__no">✕</div><div class="vxc-a11__cell vxc-a11__cell--win vxc-a11__yes">✓</div></div>
    <div class="vxc-a11__row"><div class="vxc-a11__cell vxc-a11__feat">Real-time collaboration</div><div class="vxc-a11__cell vxc-a11__cell--mid vxc-a11__no">✕</div><div class="vxc-a11__cell vxc-a11__cell--win vxc-a11__yes">✓</div></div>
    <div class="vxc-a11__row"><div class="vxc-a11__cell vxc-a11__feat">Setup time</div><div class="vxc-a11__cell vxc-a11__cell--mid">2-3 weeks</div><div class="vxc-a11__cell vxc-a11__cell--win">Same day</div></div>
    <div class="vxc-a11__row"><div class="vxc-a11__cell vxc-a11__feat">Dedicated support</div><div class="vxc-a11__cell vxc-a11__cell--mid vxc-a11__no">✕</div><div class="vxc-a11__cell vxc-a11__cell--win vxc-a11__yes">✓</div></div>
    <div class="vxc-a11__row"><div class="vxc-a11__cell vxc-a11__feat">Pricing</div><div class="vxc-a11__cell vxc-a11__cell--mid">Per-seat</div><div class="vxc-a11__cell vxc-a11__cell--win">Flat-rate</div></div>
    <div class="vxc-a11__row"><div class="vxc-a11__cell vxc-a11__feat">API access</div><div class="vxc-a11__cell vxc-a11__cell--mid vxc-a11__no">✕</div><div class="vxc-a11__cell vxc-a11__cell--win vxc-a11__yes">✓</div></div>
  </div>
</section>`
};

const ACCENT_TIMELINE: VxComponent = {
  id: 'accent-timeline',
  name: 'Vertical Milestone Timeline',
  category: 'accent',
  tags: ['timeline', 'history', 'story', 'dark'],
  description: 'A vertical connected-line timeline of company milestones or process stages, dark background with glowing accent dots. Strong for an "our story" section on about pages, or a journey/roadmap narrative on landing pages.',
  html: `<section class="vxc-a12">
  <style>
    .vxc-a12{background:#0a0a0f;padding:clamp(80px,11vw,130px) 24px}
    .vxc-a12__head{max-width:520px;margin:0 auto 64px;text-align:center}
    .vxc-a12 h2{font-size:clamp(28px,4vw,40px);font-weight:800;letter-spacing:-.025em;color:#fff;margin:0 0 10px}
    .vxc-a12 > .vxc-a12__head > p{font-size:15.5px;color:rgba(255,255,255,.42);margin:0}
    .vxc-a12__line{max-width:640px;margin:0 auto;position:relative;padding-left:32px}
    .vxc-a12__line::before{content:'';position:absolute;left:5px;top:6px;bottom:6px;width:1px;background:rgba(255,255,255,.12)}
    .vxc-a12__item{position:relative;padding-bottom:44px}
    .vxc-a12__item:last-child{padding-bottom:0}
    .vxc-a12__dot{position:absolute;left:-32px;top:4px;width:11px;height:11px;border-radius:50%;background:#6366f1;box-shadow:0 0 0 4px rgba(99,102,241,.15)}
    .vxc-a12__date{font-size:12.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#818cf8;margin-bottom:8px}
    .vxc-a12__item h3{font-size:18px;font-weight:700;color:#fff;margin:0 0 8px;letter-spacing:-.01em}
    .vxc-a12__item p{font-size:14.5px;line-height:1.7;color:rgba(255,255,255,.45);margin:0;max-width:480px}
  </style>
  <div class="vxc-a12__head">
    <h2>How we got here</h2>
    <p>From a weekend project to a platform thousands of teams rely on.</p>
  </div>
  <div class="vxc-a12__line">
    <div class="vxc-a12__item"><div class="vxc-a12__dot"></div><div class="vxc-a12__date">2021</div><h3>The first version</h3><p>Built as an internal tool to solve our own scheduling headaches — and it worked so well, friends asked to use it too.</p></div>
    <div class="vxc-a12__item"><div class="vxc-a12__dot"></div><div class="vxc-a12__date">2022</div><h3>Public launch</h3><p>Opened up to everyone. Within six months, over a thousand teams had signed up — entirely through word of mouth.</p></div>
    <div class="vxc-a12__item"><div class="vxc-a12__dot"></div><div class="vxc-a12__date">2023</div><h3>Built for scale</h3><p>Rebuilt the core platform to handle real-time collaboration for teams of any size, anywhere in the world.</p></div>
    <div class="vxc-a12__item"><div class="vxc-a12__dot"></div><div class="vxc-a12__date">Today</div><h3>40,000+ teams and growing</h3><p>From solo founders to enterprise teams — and we're just getting started.</p></div>
  </div>
</section>`
};

const ACCENT_BENTO_GRID: VxComponent = {
  id: 'accent-bento-grid',
  name: 'Bento Feature Grid',
  category: 'accent',
  tags: ['bento', 'grid', 'features', 'asymmetric'],
  description: 'An asymmetric bento grid — one large highlight cell plus several smaller cells of different colors (dark, accent gradient, light). Breaks the "three equal cards" pattern decisively. Use for a feature overview section where one capability deserves more visual weight than the others.',
  html: `<section class="vxc-a13">
  <style>
    .vxc-a13{background:#fcfbf9;padding:clamp(80px,11vw,130px) 24px}
    .vxc-a13__head{max-width:520px;margin:0 auto 56px;text-align:center}
    .vxc-a13 h2{font-size:clamp(28px,4vw,40px);font-weight:800;letter-spacing:-.025em;color:#0a0a0f;margin:0 0 10px}
    .vxc-a13 > .vxc-a13__head > p{font-size:15.5px;color:rgba(10,10,15,.48);margin:0}
    .vxc-a13__grid{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(2,200px);gap:16px}
    @media(max-width:860px){.vxc-a13__grid{grid-template-columns:repeat(2,1fr);grid-template-rows:repeat(4,180px)}}
    @media(max-width:560px){.vxc-a13__grid{grid-template-columns:1fr;grid-template-rows:repeat(6,170px)}}
    .vxc-a13__cell{border-radius:18px;padding:26px;display:flex;flex-direction:column;justify-content:flex-end;position:relative;overflow:hidden}
    .vxc-a13__cell--big{grid-column:span 2;grid-row:span 2}
    @media(max-width:860px){.vxc-a13__cell--big{grid-row:span 1}}
    @media(max-width:560px){.vxc-a13__cell--big{grid-column:span 1}}
    .vxc-a13__cell--dark{background:#0a0a0f}
    .vxc-a13__cell--accent{background:linear-gradient(135deg,#6366f1,#818cf8)}
    .vxc-a13__cell--light{background:#fff;box-shadow:0 4px 24px rgba(10,10,15,.04)}
    .vxc-a13__cell h3{font-size:18px;font-weight:700;letter-spacing:-.01em;margin:0 0 6px}
    .vxc-a13__cell--big h3{font-size:24px}
    .vxc-a13__cell p{font-size:13.5px;line-height:1.6;margin:0;max-width:280px}
    .vxc-a13__cell--dark h3{color:#fff}
    .vxc-a13__cell--dark p{color:rgba(255,255,255,.5)}
    .vxc-a13__cell--accent h3{color:#fff}
    .vxc-a13__cell--accent p{color:rgba(255,255,255,.75)}
    .vxc-a13__cell--light h3{color:#0a0a0f}
    .vxc-a13__cell--light p{color:rgba(10,10,15,.5)}
    .vxc-a13__deco{position:absolute;border-radius:50%}
  </style>
  <div class="vxc-a13__head">
    <h2>Everything you need, nothing you don't</h2>
    <p>A toolkit built around how teams actually work.</p>
  </div>
  <div class="vxc-a13__grid">
    <div class="vxc-a13__cell vxc-a13__cell--big vxc-a13__cell--dark">
      <div class="vxc-a13__deco" style="width:200px;height:200px;background:radial-gradient(circle,rgba(99,102,241,.35),transparent 70%);top:-60px;right:-60px"></div>
      <h3>Real-time everything</h3>
      <p>See changes the instant they happen — no refreshing, no waiting, no conflicts.</p>
    </div>
    <div class="vxc-a13__cell vxc-a13__cell--light">
      <h3>Smart automation</h3>
      <p>Repetitive tasks run themselves in the background.</p>
    </div>
    <div class="vxc-a13__cell vxc-a13__cell--accent">
      <div class="vxc-a13__deco" style="width:140px;height:140px;background:rgba(255,255,255,.12);bottom:-40px;right:-40px"></div>
      <h3>Built-in analytics</h3>
      <p>Every metric that matters, tracked automatically.</p>
    </div>
    <div class="vxc-a13__cell vxc-a13__cell--light">
      <h3>Granular permissions</h3>
      <p>Control exactly who sees and edits what.</p>
    </div>
    <div class="vxc-a13__cell vxc-a13__cell--light">
      <h3>Open API</h3>
      <p>Connect to anything you already use.</p>
    </div>
  </div>
</section>`
};

const ACCENT_VIDEO_SECTION: VxComponent = {
  id: 'accent-video-section',
  name: 'Video Walkthrough Frame',
  category: 'accent',
  tags: ['video', 'play-button', 'visual', 'cta'],
  description: 'A large CSS-built "video frame" with a grid backdrop, glow, and a centered play button that scales on hover — communicates "watch a demo" without needing an actual video file or external thumbnail. Place after features once the user understands what the product does.',
  html: `<section class="vxc-a14">
  <style>
    .vxc-a14{background:#fff;padding:clamp(80px,11vw,130px) 24px}
    .vxc-a14__head{max-width:520px;margin:0 auto 48px;text-align:center}
    .vxc-a14 h2{font-size:clamp(28px,4vw,40px);font-weight:800;letter-spacing:-.025em;color:#0a0a0f;margin:0 0 10px}
    .vxc-a14 > .vxc-a14__head > p{font-size:15.5px;color:rgba(10,10,15,.48);margin:0}
    .vxc-a14__frame{max-width:920px;margin:0 auto;aspect-ratio:16/9;border-radius:20px;background:linear-gradient(135deg,#1a1a2e,#0a0a0f);position:relative;overflow:hidden;box-shadow:0 30px 90px rgba(10,10,15,.18);cursor:pointer}
    .vxc-a14__glow{position:absolute;inset:0;background:radial-gradient(ellipse 500px 300px at 30% 30%,rgba(99,102,241,.35),transparent 70%)}
    .vxc-a14__grid-lines{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);background-size:48px 48px}
    .vxc-a14__play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:78px;height:78px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 12px 40px rgba(0,0,0,.35);transition:transform .25s cubic-bezier(.16,1,.3,1)}
    .vxc-a14__frame:hover .vxc-a14__play{transform:translate(-50%,-50%) scale(1.08)}
    .vxc-a14__play svg{margin-left:4px}
    .vxc-a14__caption{position:absolute;bottom:24px;left:24px;right:24px;display:flex;justify-content:space-between;align-items:flex-end;color:#fff}
    .vxc-a14__caption-title{font-size:15px;font-weight:700}
    .vxc-a14__caption-time{font-size:12.5px;color:rgba(255,255,255,.5);background:rgba(0,0,0,.4);padding:4px 10px;border-radius:6px}
  </style>
  <div class="vxc-a14__head">
    <h2>See it in action</h2>
    <p>A two-minute walkthrough of everything that makes the workflow click.</p>
  </div>
  <div class="vxc-a14__frame">
    <div class="vxc-a14__glow"></div>
    <div class="vxc-a14__grid-lines"></div>
    <div class="vxc-a14__play">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="#0a0a0f"><path d="M8 5v14l11-7z"/></svg>
    </div>
    <div class="vxc-a14__caption">
      <div class="vxc-a14__caption-title">Product walkthrough</div>
      <div class="vxc-a14__caption-time">2:14</div>
    </div>
  </div>
</section>`
};

export const ACCENT_COMPONENTS: VxComponent[] = [
  ACCENT_LOGO_CLOUD, ACCENT_HOW_IT_WORKS, ACCENT_FAQ, ACCENT_LIVE_TOAST,
  ACCENT_TAB_FEATURES, ACCENT_TRUST_BADGES, ACCENT_COUNTER_STATS, ACCENT_WORLD_MAP,
  ACCENT_BROWSER_MOCKUP, ACCENT_FEATURE_ROWS, ACCENT_COMPARISON_TABLE,
  ACCENT_TIMELINE, ACCENT_BENTO_GRID, ACCENT_VIDEO_SECTION,
];

// ════════════════════════════════════════════════════════════════
// AGGREGATE + PROMPT BUILDER
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// DATA-VIZ — premium charts/metrics the AI can't reliably hand-build.
// Pure CSS/SVG, animate on load. Recolor to the site's tokens; swap in real numbers.
// ════════════════════════════════════════════════════════════════

const DV_LINE_MULTI: VxComponent = {
  id: 'dataviz-line-multi',
  name: 'Multi-series line chart',
  category: 'dataviz',
  tags: ['chart','dashboard','analytics','saas','fintech','light','animated','draw-in'],
  description: 'Clean card with a big headline value and a 3-series SVG line chart whose lines draw themselves in (staggered) over a soft gradient area fill. For SaaS/fintech/analytics dashboards, "metrics" sections, product previews. Recolor lines to brand + an accent; replace value/labels with real data.',
  html: `<div class="vxc-dv1">
  <style>
    .vxc-dv1{background:#fff;border:1px solid #ececf1;border-radius:16px;padding:24px;max-width:560px;font-family:inherit}
    .vxc-dv1__lbl{font-size:13px;color:#6b7280}
    .vxc-dv1__val{font-size:30px;font-weight:800;letter-spacing:-.02em;color:#0e1116;margin-top:2px}
    .vxc-dv1__lg{display:flex;gap:14px;flex-wrap:wrap;margin:12px 0 4px}
    .vxc-dv1__lg span{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#6b7280}
    .vxc-dv1__lg i{width:14px;height:3px;border-radius:2px}
    .vxc-dv1 .gl{stroke:#eef0f4;stroke-width:1}
    .vxc-dv1 .ln{fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1600;stroke-dashoffset:1600;animation:vxcDv1 1.5s cubic-bezier(.16,1,.3,1) .2s forwards}
    .vxc-dv1 .fill{opacity:0;animation:vxcDv1f .6s ease 1.1s forwards}
    @keyframes vxcDv1{to{stroke-dashoffset:0}}@keyframes vxcDv1f{to{opacity:1}}
    .vxc-dv1__ax{display:flex;justify-content:space-between;margin-top:8px;font-size:10px;color:#9aa1ad}
  </style>
  <div class="vxc-dv1__lbl">Portfolio value</div>
  <div class="vxc-dv1__val">$328,505</div>
  <div class="vxc-dv1__lg"><span><i style="background:#3b6dff"></i>ETF Shares</span><span><i style="background:#19b8d8"></i>Core Fund</span><span><i style="background:#d23bd2"></i>Tech Growth</span></div>
  <svg viewBox="0 0 560 150" width="100%" height="150" preserveAspectRatio="none">
    <defs><linearGradient id="vxcDv1g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b6dff" stop-opacity=".16"/><stop offset="1" stop-color="#3b6dff" stop-opacity="0"/></linearGradient></defs>
    <line class="gl" x1="0" y1="38" x2="560" y2="38"/><line class="gl" x1="0" y1="80" x2="560" y2="80"/><line class="gl" x1="0" y1="122" x2="560" y2="122"/>
    <path class="fill" fill="url(#vxcDv1g)" d="M0,118 L70,128 L140,98 L210,90 L280,135 L350,82 L420,70 L490,48 L560,34 L560,150 L0,150 Z"/>
    <path class="ln" stroke="#3b6dff" d="M0,118 L70,128 L140,98 L210,90 L280,135 L350,82 L420,70 L490,48 L560,34"/>
    <path class="ln" stroke="#19b8d8" style="animation-delay:.35s" d="M0,134 L70,130 L140,120 L210,110 L280,90 L350,80 L420,96 L490,76 L560,88"/>
    <path class="ln" stroke="#d23bd2" style="animation-delay:.5s" d="M0,78 L70,64 L140,72 L210,64 L280,60 L350,92 L420,112 L490,100 L560,122"/>
  </svg>
  <div class="vxc-dv1__ax"><span>Aug</span><span>Sep</span><span>Oct</span></div>
</div>`,
};

const DV_BARS: VxComponent = {
  id: 'dataviz-bars',
  name: 'Animated bar chart',
  category: 'dataviz',
  tags: ['chart','dashboard','analytics','light','animated','grow'],
  description: 'Card with a metric and a row of bars that grow up with a stagger and brighten on hover. For payments/usage/traffic stats. Recolor bars to the accent; replace heights/labels with real values.',
  html: `<div class="vxc-dv2">
  <style>
    .vxc-dv2{background:#fff;border:1px solid #ececf1;border-radius:16px;padding:24px;max-width:340px;font-family:inherit}
    .vxc-dv2__lbl{font-size:13px;color:#6b7280}.vxc-dv2__val{font-size:24px;font-weight:800;color:#0e1116;margin-top:2px}
    .vxc-dv2__bars{display:flex;align-items:flex-end;gap:7px;height:110px;margin-top:16px}
    .vxc-dv2__b{flex:1;border-radius:5px 5px 0 0;background:linear-gradient(180deg,#3b6dff,#2a4fd6);transform:scaleY(0);transform-origin:bottom;animation:vxcDv2 .7s cubic-bezier(.16,1,.3,1) forwards;transition:filter .2s}
    .vxc-dv2__b:hover{filter:brightness(1.14)}
    @keyframes vxcDv2{to{transform:scaleY(1)}}
    .vxc-dv2__ax{display:flex;justify-content:space-between;margin-top:8px;font-size:10px;color:#9aa1ad}
  </style>
  <div class="vxc-dv2__lbl">Online payments</div><div class="vxc-dv2__val">263</div>
  <div class="vxc-dv2__bars">
    <div class="vxc-dv2__b" style="height:42%;animation-delay:0s"></div><div class="vxc-dv2__b" style="height:55%;animation-delay:.05s"></div><div class="vxc-dv2__b" style="height:92%;animation-delay:.1s"></div><div class="vxc-dv2__b" style="height:68%;animation-delay:.15s"></div><div class="vxc-dv2__b" style="height:76%;animation-delay:.2s"></div><div class="vxc-dv2__b" style="height:70%;animation-delay:.25s"></div><div class="vxc-dv2__b" style="height:48%;animation-delay:.3s"></div><div class="vxc-dv2__b" style="height:84%;animation-delay:.35s"></div><div class="vxc-dv2__b" style="height:60%;animation-delay:.4s"></div><div class="vxc-dv2__b" style="height:72%;animation-delay:.45s"></div>
  </div>
  <div class="vxc-dv2__ax"><span>Jan</span><span>Dec</span></div>
</div>`,
};

const DV_DONUT: VxComponent = {
  id: 'dataviz-donut',
  name: 'Animated donut chart',
  category: 'dataviz',
  tags: ['chart','dashboard','breakdown','light','animated','sweep'],
  description: 'Donut whose segments sweep in one after another, with a labelled legend. For "traffic sources", budget breakdowns, share-of-X. Recolor segments; set --len (segment length of 226 total) and --off (start offset) per slice.',
  html: `<div class="vxc-dv3">
  <style>
    .vxc-dv3{background:#fff;border:1px solid #ececf1;border-radius:16px;padding:24px;max-width:340px;font-family:inherit}
    .vxc-dv3__lbl{font-size:13px;color:#6b7280;margin-bottom:6px}
    .vxc-dv3__row{display:flex;align-items:center;gap:18px}
    .vxc-dv3 circle.seg{fill:none;stroke-width:13;transform:rotate(-90deg);transform-origin:50% 50%;stroke-dasharray:var(--len) 226;stroke-dashoffset:calc(var(--off) - var(--len));animation:vxcDv3 1.1s cubic-bezier(.16,1,.3,1) forwards}
    @keyframes vxcDv3{to{stroke-dashoffset:var(--off)}}
    .vxc-dv3__key{font-size:12px;color:#374151;display:flex;flex-direction:column;gap:7px}
    .vxc-dv3__key span{display:inline-flex;align-items:center;gap:7px}.vxc-dv3__key i{width:9px;height:9px;border-radius:3px}
  </style>
  <div class="vxc-dv3__lbl">Traffic sources</div>
  <div class="vxc-dv3__row">
    <svg width="92" height="92" viewBox="0 0 92 92">
      <circle class="seg" cx="46" cy="46" r="36" stroke="#3b6dff" style="--len:124.4;--off:0"/>
      <circle class="seg" cx="46" cy="46" r="36" stroke="#8b5cf6" style="--len:56.5;--off:-124.4;animation-delay:.18s"/>
      <circle class="seg" cx="46" cy="46" r="36" stroke="#19b8d8" style="--len:45.2;--off:-180.9;animation-delay:.36s"/>
    </svg>
    <div class="vxc-dv3__key"><span><i style="background:#3b6dff"></i>Organic 55%</span><span><i style="background:#8b5cf6"></i>Referral 25%</span><span><i style="background:#19b8d8"></i>Direct 20%</span></div>
  </div>
</div>`,
};

const DV_STATS: VxComponent = {
  id: 'dataviz-stat-cards',
  name: 'Stat cards row',
  category: 'dataviz',
  tags: ['stats','dashboard','metrics','light','animated','sparkline','radial'],
  description: 'Three premium stat cards — a progress bar, a sparkline-with-delta, and a radial/donut percentage — all animating in. For dashboard headers, "by the numbers" bands, product preview sections. Recolor + swap numbers.',
  html: `<div class="vxc-dv4">
  <style>
    .vxc-dv4{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;font-family:inherit}
    @media(max-width:680px){.vxc-dv4{grid-template-columns:1fr}}
    .vxc-dv4__c{background:#fff;border:1px solid #ececf1;border-radius:14px;padding:20px}
    .vxc-dv4__l{font-size:13px;color:#6b7280}.vxc-dv4__v{font-size:26px;font-weight:800;color:#0e1116;margin-top:2px}
    .vxc-dv4__bar{height:7px;border-radius:99px;background:#eef0f4;overflow:hidden;margin-top:14px}
    .vxc-dv4__bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#3b6dff,#19b8d8);width:0;animation:vxcDv4 1.1s cubic-bezier(.16,1,.3,1) .3s forwards}
    @keyframes vxcDv4{to{width:var(--w)}}
    .vxc-dv4__d{font-size:12px;font-weight:600;color:#16a34a}
    .vxc-dv4 .spark{fill:none;stroke:#3b6dff;stroke-width:2.4;stroke-linecap:round;stroke-dasharray:600;stroke-dashoffset:600;animation:vxcDv4d 1.4s cubic-bezier(.16,1,.3,1) .2s forwards}
    @keyframes vxcDv4d{to{stroke-dashoffset:0}}
    .vxc-dv4 .rv{fill:none;stroke:#3b6dff;stroke-width:9;stroke-linecap:round;transform:rotate(-90deg);transform-origin:50% 50%;stroke-dasharray:226;stroke-dashoffset:226;animation:vxcDv4r 1.2s cubic-bezier(.16,1,.3,1) .3s forwards}
    @keyframes vxcDv4r{to{stroke-dashoffset:181}}
  </style>
  <div class="vxc-dv4__c"><div class="vxc-dv4__l">Storage used</div><div class="vxc-dv4__v">1.85GB</div><div class="vxc-dv4__bar"><i style="--w:18.5%"></i></div></div>
  <div class="vxc-dv4__c"><div style="display:flex;justify-content:space-between"><div><div class="vxc-dv4__l">Revenue</div><div class="vxc-dv4__v">$45.1K</div></div><div class="vxc-dv4__d">+9.1%</div></div>
    <svg viewBox="0 0 200 50" width="100%" height="46" preserveAspectRatio="none" style="margin-top:8px"><path class="spark" d="M0,40 L33,34 L66,38 L100,24 L133,28 L166,14 L200,8"/></svg></div>
  <div class="vxc-dv4__c"><div style="display:flex;align-items:center;gap:14px"><svg width="74" height="74" viewBox="0 0 74 74"><circle cx="37" cy="37" r="32" fill="none" stroke="#eef0f4" stroke-width="9"/><circle class="rv" cx="37" cy="37" r="32"/><text x="37" y="42" text-anchor="middle" font-size="15" font-weight="700" fill="#0e1116">20%</text></svg><div><div style="font-weight:700;font-size:14px">Workspaces</div><div class="vxc-dv4__l">1 of 5 used</div></div></div></div>
</div>`,
};

const DV_GAUGE: VxComponent = {
  id: 'dataviz-gauge',
  name: 'Semicircle gauge',
  category: 'dataviz',
  tags: ['gauge','score','dashboard','light','animated'],
  description: 'A semicircle gauge that fills to a value with a gradient arc. For scores, health, capacity, ratings. Recolor the gradient; set the dashoffset to the target value.',
  html: `<div class="vxc-dv5">
  <style>
    .vxc-dv5{background:#fff;border:1px solid #ececf1;border-radius:16px;padding:20px 24px;max-width:300px;text-align:center;font-family:inherit}
    .vxc-dv5 .bg{fill:none;stroke:#eef0f4;stroke-width:12;stroke-linecap:round}
    .vxc-dv5 .v{fill:none;stroke:url(#vxcDv5g);stroke-width:12;stroke-linecap:round;stroke-dasharray:251;stroke-dashoffset:251;animation:vxcDv5 1.3s cubic-bezier(.16,1,.3,1) .2s forwards}
    @keyframes vxcDv5{to{stroke-dashoffset:88}}
    .vxc-dv5__l{font-size:13px;color:#6b7280;margin-top:2px}
  </style>
  <svg width="100%" height="96" viewBox="0 0 180 100"><defs><linearGradient id="vxcDv5g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3b6dff"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><path class="bg" d="M20,90 A70,70 0 0 1 160,90"/><path class="v" d="M20,90 A70,70 0 0 1 160,90"/><text x="90" y="80" text-anchor="middle" font-size="26" font-weight="800" fill="#0e1116">92</text></svg>
  <div class="vxc-dv5__l">Performance score</div>
</div>`,
};

const DV_HEATMAP: VxComponent = {
  id: 'dataviz-heatmap',
  name: 'Activity heatmap',
  category: 'dataviz',
  tags: ['heatmap','activity','dashboard','light','animated','wave'],
  description: 'A GitHub-style contribution grid whose cells pop in as a diagonal wave. For activity, streaks, usage-over-time. Recolor the intensity scale; the cell colors set the data.',
  html: `<div class="vxc-dv6">
  <style>
    .vxc-dv6{background:#fff;border:1px solid #ececf1;border-radius:16px;padding:24px;font-family:inherit}
    .vxc-dv6__l{font-size:13px;color:#6b7280}
    .vxc-dv6__g{display:grid;grid-template-columns:repeat(20,1fr);gap:4px;margin-top:14px}
    .vxc-dv6__g i{aspect-ratio:1;border-radius:3px;transform:scale(0);animation:vxcDv6 .5s cubic-bezier(.16,1,.3,1) forwards}
    @keyframes vxcDv6{to{transform:scale(1)}}
  </style>
  <div class="vxc-dv6__l">Contributions</div>
  <div class="vxc-dv6__g" id="vxcDv6"></div>
  <script>(function(){var g=document.currentScript.previousElementSibling;var c=['#eef0f4','#cfe0ff','#9bbcff','#5b8bff','#2a4fd6'];for(var i=0;i<100;i++){var d=document.createElement('i');d.style.background=c[Math.floor(Math.random()*5)];d.style.animationDelay=(((i%20)+Math.floor(i/20))*0.025)+'s';g.appendChild(d);}})();</script>
</div>`,
};

// ════════════════════════════════════════════════════════════════
// FLAIR — signature visual sections. Pure CSS. Recolor to brand.
// ════════════════════════════════════════════════════════════════

const FL_BENTO: VxComponent = {
  id: 'flair-bento',
  name: 'Bento feature grid',
  category: 'flair',
  tags: ['bento','features','grid','modern','asymmetric'],
  description: 'An asymmetric bento grid (one large anchor tile + mixed smaller tiles) — the modern alternative to three equal feature cards. Cells lift on hover. Fill each tile with a real feature, mini-visual, or metric.',
  html: `<section class="vxc-fl1">
  <style>
    .vxc-fl1{padding:72px 24px;max-width:1100px;margin:0 auto;font-family:inherit}
    .vxc-fl1__grid{display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:150px;gap:16px}
    @media(max-width:760px){.vxc-fl1__grid{grid-template-columns:1fr 1fr;grid-auto-rows:140px}}
    .vxc-fl1__t{background:#f5f6f8;border:1px solid #ececf1;border-radius:18px;padding:22px;display:flex;flex-direction:column;justify-content:flex-end;transition:transform .25s cubic-bezier(.16,1,.3,1),box-shadow .25s}
    .vxc-fl1__t:hover{transform:translateY(-4px);box-shadow:0 16px 40px rgba(14,17,22,.08)}
    .vxc-fl1__t h3{font-size:17px;font-weight:700;color:#0e1116;margin:0 0 4px}.vxc-fl1__t p{font-size:13px;color:#6b7280;margin:0}
    .vxc-fl1__a{grid-column:span 2;grid-row:span 2;background:linear-gradient(135deg,#eef1ff,#f3e9ff)}
    .vxc-fl1__w{grid-column:span 2}
  </style>
  <div class="vxc-fl1__grid">
    <div class="vxc-fl1__t vxc-fl1__a"><h3>The headline capability</h3><p>Your single most important feature, given room to breathe.</p></div>
    <div class="vxc-fl1__t vxc-fl1__w"><h3>Wide supporting tile</h3><p>A secondary benefit.</p></div>
    <div class="vxc-fl1__t"><h3>Metric</h3><p>99.9% uptime</p></div>
    <div class="vxc-fl1__t"><h3>Detail</h3><p>One more.</p></div>
    <div class="vxc-fl1__t vxc-fl1__w"><h3>Another wide tile</h3><p>Round out the grid.</p></div>
  </div>
</section>`,
};

const FL_MESH: VxComponent = {
  id: 'flair-mesh',
  name: 'Gradient-mesh CTA',
  category: 'flair',
  tags: ['gradient','mesh','cta','dark','animated','signature'],
  description: 'A dark section with a slow living gradient-mesh background — a striking signature backdrop for a CTA, stat band, or section break. Recolor the three mesh blobs to brand hues.',
  html: `<section class="vxc-fl2">
  <style>
    .vxc-fl2{position:relative;overflow:hidden;background:#0a0b10;border-radius:22px;padding:72px 28px;text-align:center;color:#fff;max-width:1000px;margin:0 auto;font-family:inherit}
    .vxc-fl2::before{content:"";position:absolute;inset:-40%;background:radial-gradient(circle at 20% 30%,rgba(59,109,255,.7),transparent 40%),radial-gradient(circle at 80% 20%,rgba(210,59,210,.55),transparent 42%),radial-gradient(circle at 60% 80%,rgba(25,184,216,.55),transparent 45%);filter:blur(28px);animation:vxcFl2 9s ease-in-out infinite}
    @keyframes vxcFl2{0%,100%{transform:rotate(0) scale(1)}50%{transform:rotate(22deg) scale(1.18)}}
    .vxc-fl2>*{position:relative}
    .vxc-fl2 h2{font-size:clamp(30px,5vw,48px);font-weight:900;letter-spacing:-.03em;margin:0 0 12px}
    .vxc-fl2 p{color:rgba(255,255,255,.7);max-width:480px;margin:0 auto 24px}
    .vxc-fl2 a{display:inline-block;background:#fff;color:#0a0b10;border-radius:12px;padding:14px 28px;font-weight:700;text-decoration:none;transition:transform .2s}
    .vxc-fl2 a:hover{transform:translateY(-2px)}
  </style>
  <h2>Ready to launch?</h2><p>Build your site in minutes — no code, no agency, no waiting.</p><a href="#">Get started →</a>
</section>`,
};

const FL_GBORDER: VxComponent = {
  id: 'flair-gradient-border',
  name: 'Animated gradient-border cards',
  category: 'flair',
  tags: ['gradient','border','cards','animated','premium'],
  description: 'Cards wrapped in a slowly-flowing gradient border — a premium accent for highlighting a plan, a key feature, or a callout. Recolor the gradient stops to brand.',
  html: `<div class="vxc-fl3">
  <style>
    .vxc-fl3{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;max-width:900px;margin:0 auto;font-family:inherit}
    @media(max-width:680px){.vxc-fl3{grid-template-columns:1fr}}
    .vxc-fl3__b{position:relative;border-radius:18px;padding:1.5px;background:linear-gradient(120deg,#3b6dff,#8b5cf6,#d23bd2,#3b6dff);background-size:300% 300%;animation:vxcFl3 4s linear infinite}
    @keyframes vxcFl3{to{background-position:300% 0}}
    .vxc-fl3__in{background:#fff;border-radius:16.5px;padding:24px;height:100%}
    .vxc-fl3__in h3{font-size:16px;font-weight:700;color:#0e1116;margin:0 0 6px}.vxc-fl3__in p{font-size:13px;color:#6b7280;margin:0}
  </style>
  <div class="vxc-fl3__b"><div class="vxc-fl3__in"><h3>Highlighted plan</h3><p>The flowing border draws the eye without shouting.</p></div></div>
  <div class="vxc-fl3__b"><div class="vxc-fl3__in"><h3>Key feature</h3><p>Use sparingly — one or two per page.</p></div></div>
  <div class="vxc-fl3__b"><div class="vxc-fl3__in"><h3>Callout</h3><p>Premium accent, pure CSS.</p></div></div>
</div>`,
};

const DATAVIZ_COMPONENTS: VxComponent[] = [DV_LINE_MULTI, DV_BARS, DV_DONUT, DV_STATS, DV_GAUGE, DV_HEATMAP];
const FLAIR_COMPONENTS: VxComponent[] = [FL_BENTO, FL_MESH, FL_GBORDER];

export const ALL_COMPONENTS: VxComponent[] = [
  ...DATAVIZ_COMPONENTS,
  ...FLAIR_COMPONENTS,
  ...HEROES,
  ...FEATURE_SECTIONS,
  ...PRICING_SECTIONS,
  ...TESTIMONIAL_SECTIONS,
  ...CTA_SECTIONS,
  ...NAV_COMPONENTS,
  ...FOOTER_COMPONENTS,
  ...ACCENT_COMPONENTS,
];

// Deterministic string hash -> shuffle, so the "random" sample below is stable for a given
// seed (e.g. project_id). Using Math.random() here meant every request — including a build's
// own continuation rounds, seconds apart — picked different examples, so the system prompt
// text never matched itself and Anthropic rewrote (1.25x) its ~10k-token cache instead of
// reading it (0.1x) on every single call. A seeded shuffle keeps it identical per-project
// (cache-friendly) while still varying across different projects (output stays varied).
function seededShuffle<T>(arr: T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = (h >>> 0) || 1;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Builds the component-library injection for the build system prompt.
 * Pass the categories relevant to the current build (heroes are always worth including).
 *
 * Caps how many examples per category get injected (default 2). The full library is
 * ~24k tokens — every fresh build was paying for all ~27 components even though the
 * model only adapts one or two per section type. Capping + sampling keeps the prompt
 * proportional to what's actually used while still varying which examples the model
 * sees project-to-project (so output doesn't converge on the same look).
 *
 * `seed` should be something stable for the lifetime of one build (e.g. project_id) —
 * see the seededShuffle comment for why this can't be Math.random().
 */
export function buildComponentLibraryPrompt(categories: string[], seed = "", maxPerCategory = 2): string {
  const wanted = new Set(categories);
  const byCategory = new Map<string, VxComponent[]>();
  for (const c of ALL_COMPONENTS) {
    if (!wanted.has(c.category)) continue;
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category)!.push(c);
  }
  const comps: VxComponent[] = [];
  for (const [cat, list] of byCategory) {
    const max = cat === 'accent' ? 2 : maxPerCategory;
    const sample = seededShuffle(list, `${seed}:${cat}`).slice(0, max);
    comps.push(...sample);
  }
  if (!comps.length) return '';

  const intro = [
    '<component-library>',
    'Your library has two types of entries — use them differently:',
    '',
    'ACCENT COMPONENTS (id starts with "accent-"): Visual patterns with specific flair that the AI would not naturally produce — scrolling logo strips, numbered step flows, animated counters, live toast notifications, tab switchers, trust badges, world connection maps. For these: preserve the structural technique and interaction pattern exactly. Only substitute copy, colors, and brand specifics. The pattern itself is why they are here — do not simplify it into a plain list or static block.',
    '',
    'STRUCTURAL SECTIONS (hero, features, pricing, testimonials, cta, nav, footer): Design-language references. Study these for TECHNIQUES: how ambient orbs are layered, how bento grids break equal-card patterns, how scroll animations are staged, how sections contrast light vs dark. Use these to inform your own composition — do not copy-paste blindly. Adapt the technique to this specific brand.',
    '',
    'DATA-VIZ + FLAIR (id starts with "dataviz-" / "flair-"): high-craft signature pieces the AI builds badly from scratch — animated charts (line/bar/donut/gauge/heatmap), stat cards, bento grids, gradient-mesh sections, animated borders. These are what make a site feel like a real PRODUCT instead of a brochure. Keep the structural + animation technique intact; recolor to the brand and swap in realistic data/copy. A chart only belongs where it makes sense (SaaS/fintech/analytics/dashboards) — never bolt one onto a site that wouldn\'t really have data.',
    '',
    'USE THIS LIBRARY AS A SPRINGBOARD, NOT A CAGE:',
    '- These are a starting palette, not a required kit. Adapt, recompose, combine, restyle — and invent original sections when that serves the brief better. Never let the page feel "assembled from a kit."',
    '- Weave in 2–4 signature pieces (a chart, a bento grid, a flair section, an accent pattern) where they genuinely fit — this is what separates a premium site from a generic AI one. Don\'t force all of them; fit beats quantity.',
    '- Vary the composition per site. Two sites should not share the same section order or rhythm.',
    '',
    'In all cases:',
    '- Replace every color with this project\'s actual design tokens',
    '- Rewrite ALL copy — headlines, body text, names, companies — to be specific to this business. Never ship placeholder copy.',
    '- Swap fonts to the spec\'s font pairing',
    '- Class names are scoped (vxc-XX__) — keep them unique per section',
    '',
  ].join('\n');

  const body = comps.map(c =>
    `─── ${c.name} [${c.id}] ───\n${c.description}\n${c.html}`
  ).join('\n\n');

  return intro + body + '\n</component-library>';
}

/** Maps a build category (from the brief/spec) to the most relevant component categories to inject.
 *  'flair' is broadly useful (signature visual sections); 'dataviz' (charts/metrics) only goes to
 *  data-heavy industries so a bakery never gets a stock chart. */
export function categoriesForBuild(siteCategory: string | undefined): string[] {
  const base = ['hero', 'cta', 'accent', 'flair'];
  switch (siteCategory) {
    case 'tech-saas':
    case 'startup-launch':
      return [...base, 'dataviz', 'features', 'pricing', 'testimonials', 'nav', 'footer'];
    case 'ecommerce-consumer':
      return [...base, 'features', 'testimonials', 'nav', 'footer'];
    case 'agency-creative':
    case 'personal-freelancer':
      return [...base, 'features', 'testimonials', 'footer'];
    case 'professional-services':
      return [...base, 'dataviz', 'features', 'testimonials', 'nav', 'footer'];
    case 'hospitality-events':
      return [...base, 'testimonials', 'footer'];
    default:
      return [...base, 'dataviz', 'features', 'testimonials', 'nav', 'footer'];
  }
}
