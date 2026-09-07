const fs=require('fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync('/tmp/repair/work2.html','utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');

const dom = new JSDOM(`<!DOCTYPE html><body>
<div class="hero">
  <div id="fromFlag"></div><div id="fromVal"></div>
  <div id="toFlag"></div><div id="toVal"></div>
  <div id="fromDD"></div><div id="toDD"></div>
  <div id="fromBtn"></div><div id="toBtn"></div>
</div></body>`, { runScripts:'outside-only' });
const w = dom.window;
w.scrollTo = ()=>{};
w.Element.prototype.scrollIntoView = function(){};
try { w.eval(script); } catch(e) {}

let p=0,f=0; const ok=(n,c,d)=>{c?(p++,console.log('  ✓ '+n)):(f++,console.log('  ✗ '+n+(d?' — '+d:'')))};
const txt = ()=> (w.document.getElementById('pathwayResult')||{textContent:''}).textContent;
const banner = ()=> w.document.getElementById('staleBanner');

console.log("═══ Audit finding 3 — exact reproduction sequence ═══");

// 1. Slovakia → Germany
w.select('from','SK'); w.select('to','DE'); w.handleCTA();
ok('1. SK→DE generates a pathway', txt().includes('Slovakia') && txt().includes('Germany'));

// 2. Change destination to Czech Republic → stale warning appears
w.select('to','CZ');
ok('2. changing destination raises a stale warning', !!banner());

// 3. Generate SK → CZ
w.handleCTA();
ok('3. SK→CZ generates, stale warning cleared', !banner());

// 4. Change origin to United Kingdom
w.select('from','GB');
ok('4. changing origin raises a stale warning', !!banner());

// 5. Change destination to United Kingdom (now GB→GB)
w.select('to','GB');

// 6. Press Show my pathway
w.handleCTA();
const out = txt();
console.log('     result text: "' + out.trim().slice(0,150) + '"');

ok('6a. same-country gives a clear validation response', /same country/i.test(out));
ok('6b. NOT advertised as a corridor being added', !/being added/i.test(out) && !/expanding our pathway database/i.test(out));
ok('6c. no launch-notification promise', !/notify you when it launches/i.test(out));
ok('6d. obsolete Czech Republic warning is gone', !banner(), banner()?banner().textContent:'');
ok('6e. currentPathway nulled (guide/save cannot use a hidden profile)', w.currentPathway===null);

console.log("\n═══ Normal behaviour must still work ═══");
w.select('from','IN'); w.select('to','DE'); w.handleCTA();
ok('supported corridor still renders', txt().includes('India') && txt().includes('Germany'));
ok('currentPathway set for supported corridor', w.currentPathway && w.currentPathway.from==='IN' && w.currentPathway.to==='DE');
w.select('to','CZ');
ok('accurate recalculation warning still appears', !!banner() && /Czech/.test(banner().textContent));

console.log("\n═══ Unsupported (non-identical) corridor ═══");
// find a genuinely unsupported pair
const pd = w.pathwayData;
let unsup=null;
for(const o of ['IN','GB','BR']) for(const d of w.dests.map(x=>x.code)){
  if(o!==d && !pd.find(p=>p.from===o&&p.to===d)){ unsup=[o,d]; break; }
  if(unsup) break;
}
if(unsup){
  w.select('from',unsup[0]); w.select('to',unsup[1]); w.handleCTA();
  ok('unsupported pair explains coverage honestly', /not in our pathway data yet/i.test(txt()));
  ok('unsupported pair does not promise a launch', !/notify you when it launches/i.test(txt()));
} else {
  console.log('  – all tested combinations supported; skipped');
}

console.log('\nPASS '+p+'  FAIL '+f);
process.exit(f?1:0);
