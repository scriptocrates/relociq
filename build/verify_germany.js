const fs = require('fs');
const { mergeFrameworkDelta } = require('/tmp/relociq_content/build/merge-engine.js');
const corridors = JSON.parse(fs.readFileSync('/tmp/relociq_content/build/_de_corridors.json','utf8'));
const framework = JSON.parse(fs.readFileSync('/tmp/relociq_content/content/frameworks/DE-skilled-worker.json','utf8'));

function liveShape(rows){ return rows.sort((a,b)=>a.step_number-b.step_number).map((r,i)=>({num:i+1,name:r.name,days:r.days,critical:r.critical==='Yes',why:r.why,need:r.what_you_need,action:r.what_to_do,risks:r.what_can_go_wrong,doneWhen:r.done_when})); }

let totalMismatch = 0;
Object.keys(corridors).forEach(corridor => {
  const live = liveShape(corridors[corridor]);
  let regenerated;
  if (corridor === 'IN-DE') {
    // standalone — read it back directly
    regenerated = JSON.parse(fs.readFileSync('/tmp/relociq_content/content/standalone/IN-DE.json','utf8')).steps;
  } else {
    const delta = JSON.parse(fs.readFileSync('/tmp/relociq_content/content/deltas/'+corridor+'.json','utf8'));
    regenerated = mergeFrameworkDelta(framework, delta);
  }
  let cm = 0;
  if (regenerated.length !== live.length) { console.log(corridor+': LENGTH '+regenerated.length+' vs '+live.length); cm++; }
  else {
    live.forEach((ls,i)=>['num','name','days','critical','why','need','action','risks','doneWhen'].forEach(f=>{
      if (JSON.stringify(regenerated[i][f]) !== JSON.stringify(ls[f])) { cm++; if(cm<=2) console.log(corridor+' step '+ls.num+' field '+f+' MISMATCH'); }
    }));
  }
  console.log(corridor+': '+(cm===0?'✓ byte-perfect':cm+' mismatches'));
  totalMismatch += cm;
});
console.log('');
console.log(totalMismatch===0 ? '✓✓ ALL 12 GERMANY CORRIDORS REGENERATE BYTE-PERFECT FROM FRAMEWORK+DELTA' : totalMismatch+' total mismatches — engine not safe yet');
