const fs=require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('/tmp/repair/work.html','utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');

let pass=0, fail=0;
function ok(name, cond, detail){ if(cond){pass++;console.log('  ✓ '+name);} else {fail++;console.log('  ✗ '+name+(detail?' — '+detail:''));} }

// Minimal DOM the render function needs
const dom = new JSDOM(`<!DOCTYPE html><body>
  <div id="recResultsList"></div>
  <div id="recLoadingStep"></div>
  <div id="recResultsStep"></div>
  <div id="recFormStep"></div>
  <div id="recError"></div>
  <button id="recSubmitBtn"></button>
</body>`, { runScripts:'outside-only' });
const w = dom.window;
w.fetch = async () => ({ ok:true, status:200, json: async()=>({}) });
w.Clerk = undefined;

// Evaluate the page script inside the jsdom window.
// Guard: the page's init code touches elements we didn't stub, so swallow init errors
// but keep the function declarations, which is what we're testing.
try { w.eval(script); } catch(e) { /* init-time errors expected in stub DOM */ }

console.log('\n═══ P0-1: recommender rendering ═══');
ok('escapeHtml no longer referenced anywhere', !/escapeHtml\(/.test(html));
ok('renderRecommenderResults is defined', typeof w.renderRecommenderResults === 'function');
ok('validateRecommendations is defined', typeof w.validateRecommendations === 'function');

// THE BRIEF'S EXACT FAILING CASE: India / software engineer / 40k / English / career+easy visa
const briefFixture = [
  { rank:1, country:'CZ', country_name:'Czech Republic', match_score:0.82,
    rationale:'At USD 40,000 you clear the Czech employee-card salary bar comfortably, and English-speaking IT roles are common in Prague.',
    key_advantages:['Lowest cost EU tech hub','Employee card is well-trodden for Indian engineers'],
    considerations:['Czech language needed outside tech'], visa_route:'Employee Card', monthly_cost_estimate_eur:1500 },
  { rank:2, country:'PL', country_name:'Poland', match_score:0.78,
    rationale:'Warsaw and Krakow have large English-working engineering teams and thresholds your salary meets.',
    key_advantages:['Booming tech sector','Type A permit accessible'], considerations:['Polish needed for admin'],
    visa_route:'Type A Work Permit', monthly_cost_estimate_eur:1400 },
  { rank:3, country:'DE', country_name:'Germany', match_score:0.61,
    rationale:'Germany is reachable but your current salary is below the EU Blue Card threshold, so a standard work visa applies.',
    key_advantages:['Largest EU job market'], considerations:['Blue Card threshold not met at USD 40,000','German needed outside Berlin'],
    visa_route:'Work Permit Visa', monthly_cost_estimate_eur:2200 }
];

let threw=null;
try { w.renderRecommenderResults(briefFixture, 'IN', null); } catch(e){ threw=e; }
ok("brief's fixture renders without exception", threw===null, threw && threw.message);
const cards = w.document.querySelectorAll('#recResultsList > div');
ok('three result cards rendered', cards.length===3, 'got '+cards.length);
ok('country name present in output', w.document.getElementById('recResultsList').textContent.includes('Czech Republic'));
ok('results step revealed', w.document.getElementById('recResultsStep').style.display==='');

console.log('\n═══ P0-1: untrusted output renders inertly ═══');
const hostile = [{ rank:1, country:'CZ', country_name:'<img src=x onerror=alert(1)>',
  match_score:0.5, rationale:'<script>alert("xss")</script> and <b>bold</b>',
  key_advantages:['<iframe src=evil></iframe>','ok'], considerations:['"><svg onload=alert(2)>'],
  visa_route:'<a href="javascript:alert(3)">x</a>', monthly_cost_estimate_eur:100 }];
threw=null;
try { w.renderRecommenderResults(hostile, 'IN', '<img src=x onerror=alert(9)>'); } catch(e){ threw=e; }
ok('hostile payload renders without exception', threw===null, threw && threw.message);
const listEl = w.document.getElementById('recResultsList');
ok('no <script> element injected', listEl.querySelectorAll('script').length===0);
ok('no <img> element injected', listEl.querySelectorAll('img').length===0);
ok('no <iframe> element injected', listEl.querySelectorAll('iframe').length===0);
ok('no <svg> element injected', listEl.querySelectorAll('svg').length===0);
ok('markup surfaced as literal text', listEl.textContent.includes('<img src=x onerror'));

console.log('\n═══ P0-1: malformed / missing model data ═══');
const cases = [
  ['null', null], ['undefined', undefined], ['empty array', []],
  ['string instead of array', 'boom'], ['object instead of array', {a:1}],
  ['array of nulls', [null,null]],
  ['missing every field', [{}]],
  ['unsupported destination', [{rank:1,country:'XX',country_name:'Atlantis',rationale:'r',key_advantages:['a'],considerations:['c'],visa_route:'v',monthly_cost_estimate_eur:1}]],
  ['score out of range', [{rank:1,country:'CZ',country_name:'CZ',match_score:99,rationale:'r',key_advantages:['a'],considerations:['c'],visa_route:'v',monthly_cost_estimate_eur:1}]],
  ['cost not a number', [{rank:1,country:'CZ',country_name:'CZ',match_score:0.5,rationale:'r',key_advantages:['a'],considerations:['c'],visa_route:'v',monthly_cost_estimate_eur:'lots'}]],
  ['advantages not an array', [{rank:1,country:'CZ',country_name:'CZ',match_score:0.5,rationale:'r',key_advantages:'nope',considerations:null,visa_route:'v',monthly_cost_estimate_eur:1}]],
];
cases.forEach(([label,input])=>{
  let t=null;
  try { w.renderRecommenderResults(input,'IN',null); } catch(e){ t=e; }
  ok('survives: '+label, t===null, t && t.message);
});

// Empty/invalid input must show a recoverable message, not a blank panel
w.renderRecommenderResults([], 'IN', null);
ok('empty result shows recovery message', /could not produce usable recommendations/i.test(w.document.getElementById('recResultsList').textContent));

console.log('\n═══ P0-1: submit hardening ═══');
ok('duplicate-submit guard present', /recInFlight/.test(script));
ok('bounded timeout present', /REC_TIMEOUT_MS/.test(script) && /AbortController/.test(script));
ok('stale-response guard present', /seq !== recRequestSeq/.test(script));
ok('failure stages distinguished', /stage === 'render'/.test(script) && /stage === 'parse'/.test(script));
ok('no profile contents in error log', !/console\.error\([^)]*nationality/.test(script) && !/console\.error\([^)]*salary/.test(script));

console.log('\n'+'═'.repeat(46));
console.log('PASS '+pass+'  FAIL '+fail);
process.exit(fail?1:0);
