const fs = require('fs');
const rows = JSON.parse(fs.readFileSync('/tmp/migration/airtable_export.json','utf8'));

// Current live stepsData for the 12 DE-skilled-worker corridors
const deRows = rows.filter(r => r.framework_key === 'DE-skilled-worker');
const corridors = {};
deRows.forEach(r => {
  const c = r.step_key.replace(/-\d+$/,'');
  (corridors[c] = corridors[c] || []).push(r);
});
Object.keys(corridors).forEach(c => corridors[c].sort((a,b)=>a.step_number-b.step_number));

// Convert a row to the canonical step shape with a stable id
function rowToStep(r, id) {
  return { id, name:r.name, days:r.days, critical:r.critical==='Yes',
           why:r.why, need:r.what_you_need, action:r.what_to_do,
           risks:r.what_can_go_wrong, doneWhen:r.done_when };
}

// Use GB-DE as the canonical 8-step spine reference (it's a clean non-EU origin with the standard shape).
// Assign stable ids by step position/meaning.
const spineIds = ['recognition','job-offer','agency-approval','documents','embassy','entry','anmeldung','auslaenderbehoerde'];
const gb = corridors['GB-DE'];
if (gb.length !== 8) throw new Error('GB-DE expected 8 steps, got '+gb.length);

const spineSteps = gb.map((r,i) => rowToStep(r, spineIds[i]));

// Build the framework object
const framework = {
  framework_key:'DE-skilled-worker',
  destination:'Germany',
  visa_type:'Skilled Worker / EU Blue Card',
  salary_threshold:'EU Blue Card ~45,300 EUR/year; ~41,041 EUR shortage occupations (2024)',
  last_reviewed:'2026-05-23',
  source_url:'https://www.make-it-in-germany.com',
  status:'Needs Review',
  steps: spineSteps
};

fs.writeFileSync('/tmp/relociq_content/content/frameworks/DE-skilled-worker.json', JSON.stringify(framework,null,2));
console.log('Framework spine written from GB-DE: '+spineSteps.length+' steps');
console.log('Step ids:', spineIds.join(', '));

// Save corridors for the next step (delta derivation)
fs.writeFileSync('/tmp/relociq_content/build/_de_corridors.json', JSON.stringify(corridors));
fs.writeFileSync('/tmp/relociq_content/build/_de_spine_ids.json', JSON.stringify(spineIds));
