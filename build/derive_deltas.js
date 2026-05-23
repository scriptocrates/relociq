const fs = require('fs');
const corridors = JSON.parse(fs.readFileSync('/tmp/relociq_content/build/_de_corridors.json','utf8'));
const spineIds = JSON.parse(fs.readFileSync('/tmp/relociq_content/build/_de_spine_ids.json','utf8'));
const framework = JSON.parse(fs.readFileSync('/tmp/relociq_content/content/frameworks/DE-skilled-worker.json','utf8'));

function rowFields(r){ return { name:r.name, days:r.days, critical:r.critical==='Yes', why:r.why, need:r.what_you_need, action:r.what_to_do, risks:r.what_can_go_wrong, doneWhen:r.done_when }; }
function stepFields(s){ return { name:s.name, days:s.days, critical:s.critical, why:s.why, need:s.need, action:s.action, risks:s.risks, doneWhen:s.doneWhen }; }

const FIELDS = ['name','days','critical','why','need','action','risks','doneWhen'];

const sourceUrls = {
  'IN':'https://www.india.diplo.de', 'GB':'https://uk.diplo.de', 'UA':'https://kiew.diplo.de',
  'BR':'https://brasilia.diplo.de', 'NG':'https://lagos.diplo.de', 'US':'https://www.germany.info',
  'PH':'https://manila.diplo.de', 'ZA':'https://southafrica.diplo.de', 'TR':'https://tuerkei.diplo.de',
  'CN':'https://china.diplo.de', 'RS':'https://belgrad.diplo.de', 'EG':'https://kairo.diplo.de'
};

const report = [];

Object.keys(corridors).forEach(corridor => {
  const origin = corridor.split('-')[0];
  const live = corridors[corridor]; // sorted rows
  const ops = [];

  // Standard case: 8 steps mapping 1:1 to spine ids — emit overrides for differing fields
  if (live.length === 8) {
    live.forEach((r,i) => {
      const id = spineIds[i];
      const spineStep = framework.steps[i];
      const liveF = rowFields(r);
      const spineF = stepFields(spineStep);
      const diff = {};
      FIELDS.forEach(f => { if (JSON.stringify(liveF[f]) !== JSON.stringify(spineF[f])) diff[f] = liveF[f]; });
      if (Object.keys(diff).length) ops.push({ op:'override', id, fields:diff });
    });
  }
  else if (corridor === 'CN-DE') {
    // China: 9 steps. Step 2 is the inserted APS step; rest map to spine with offset after step1.
    // Live: [recognition, APS, job-offer, agency, documents, embassy, entry, anmeldung, auslaender]
    // Override recognition (step0) and documents (step4 in live = spine 'documents')
    const liveSteps = live;
    // recognition override
    let d0 = {}; const lf0=rowFields(liveSteps[0]), sf0=stepFields(framework.steps[0]);
    FIELDS.forEach(f=>{if(JSON.stringify(lf0[f])!==JSON.stringify(sf0[f]))d0[f]=lf0[f];});
    if(Object.keys(d0).length) ops.push({op:'override',id:'recognition',fields:d0});
    // insert APS after recognition
    const aps = liveSteps[1];
    ops.push({op:'insert',after:'recognition',step:{id:'aps',...rowFields(aps)}});
    // remaining live steps 2..8 map to spine 1..7 (job-offer..auslaender)
    for(let i=2;i<liveSteps.length;i++){
      const spineStep = framework.steps[i-1]; // offset by the insert
      const id = spineIds[i-1];
      const lf=rowFields(liveSteps[i]), sf=stepFields(spineStep);
      const diff={}; FIELDS.forEach(f=>{if(JSON.stringify(lf[f])!==JSON.stringify(sf[f]))diff[f]=lf[f];});
      if(Object.keys(diff).length) ops.push({op:'override',id,fields:diff});
    }
  }
  else if (corridor === 'IN-DE') {
    // India: 9 steps (the original gold-standard). It has an extra step vs the generic spine.
    // Safest correct approach: IN-DE becomes a STANDALONE (its content predates the generic spine
    // and is the gold reference). We will NOT force it through the merge — store it standalone.
    report.push(corridor+': -> STANDALONE (gold-standard, 9 steps, kept verbatim)');
    return; // skip delta creation
  }

  const delta = {
    delta_key: corridor,
    corridor,
    framework_key:'DE-skilled-worker',
    origin,
    last_reviewed:'2026-05-23',
    source_url: sourceUrls[origin] || '',
    status:'Needs Review',
    operations: ops
  };
  fs.writeFileSync('/tmp/relociq_content/content/deltas/'+corridor+'.json', JSON.stringify(delta,null,2));
  report.push(corridor+': '+ops.length+' ops ('+ops.map(o=>o.op+(o.id?':'+o.id:'')).join(', ')+')');
});

// IN-DE as standalone
const inde = corridors['IN-DE'];
const indeStandalone = { corridor:'IN-DE', framework_key:'DE-skilled-worker', note:'Gold-standard hand-written guide, kept verbatim (predates generic spine).',
  steps: inde.map((r,i)=>({num:i+1, name:r.name, days:r.days, critical:r.critical==='Yes', why:r.why, need:r.what_you_need, action:r.what_to_do, risks:r.what_can_go_wrong, doneWhen:r.done_when})) };
fs.writeFileSync('/tmp/relociq_content/content/standalone/IN-DE.json', JSON.stringify(indeStandalone,null,2));

console.log('DELTA DERIVATION REPORT:');
report.forEach(r=>console.log('  '+r));
