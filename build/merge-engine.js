// RELOCIQ MERGE ENGINE
// Combines a framework spine with an origin delta to produce a complete corridor guide.
// Three delta operations:
//   override: replace named fields of a shared step (matched by step `id`)
//   insert:   add an origin-only step at a given position
//   replace:  swap an entire step (matched by `id`) with new content
//
// Framework spine format:
//   { framework_key, destination, visa_type, salary_threshold, last_reviewed, source_url, status,
//     steps: [ { id, name, days, critical, why, need, action, risks, doneWhen }, ... ] }
//   (id is a stable identifier for the step within the framework, e.g. "job-offer")
//
// Delta format:
//   { delta_key, corridor, framework_key, origin, last_reviewed, source_url, status,
//     operations: [
//       { op:"override", id:"documents", fields:{ need:"...", action:"..." } },
//       { op:"insert", after:"recognition", step:{ id:"aps", name:"...", ... } },
//       { op:"replace", id:"recognition", step:{ id:"recognition", name:"...", ... } }
//     ] }
//
// Standalone format: just { corridor, steps:[...] } — no merge, used directly.

function deepClone(o){ return JSON.parse(JSON.stringify(o)); }

function mergeFrameworkDelta(framework, delta) {
  // Start from a clone of the spine steps
  let steps = deepClone(framework.steps);

  const ops = (delta && delta.operations) ? delta.operations : [];

  // Apply overrides and replaces first (they match by id), then inserts (which reference positions).
  // Process in the order given, but inserts are resolved against the CURRENT step list.
  ops.forEach(op => {
    if (op.op === 'override') {
      const idx = steps.findIndex(s => s.id === op.id);
      if (idx === -1) throw new Error(`[${delta.delta_key}] override target id "${op.id}" not found in framework "${framework.framework_key}"`);
      Object.keys(op.fields).forEach(f => { steps[idx][f] = op.fields[f]; });
    } else if (op.op === 'replace') {
      const idx = steps.findIndex(s => s.id === op.id);
      if (idx === -1) throw new Error(`[${delta.delta_key}] replace target id "${op.id}" not found in framework "${framework.framework_key}"`);
      steps[idx] = deepClone(op.step);
    } else if (op.op === 'insert') {
      if (op.after) {
        const idx = steps.findIndex(s => s.id === op.after);
        if (idx === -1) throw new Error(`[${delta.delta_key}] insert anchor "after:${op.after}" not found`);
        steps.splice(idx+1, 0, deepClone(op.step));
      } else if (op.before) {
        const idx = steps.findIndex(s => s.id === op.before);
        if (idx === -1) throw new Error(`[${delta.delta_key}] insert anchor "before:${op.before}" not found`);
        steps.splice(idx, 0, deepClone(op.step));
      } else if (typeof op.at === 'number') {
        steps.splice(op.at, 0, deepClone(op.step));
      } else {
        steps.push(deepClone(op.step));
      }
    } else {
      throw new Error(`[${delta.delta_key}] unknown op "${op.op}"`);
    }
  });

  // Renumber sequentially and emit the site's step shape (drop internal `id`)
  return steps.map((s, i) => ({
    num: i+1,
    name: s.name,
    days: s.days,
    critical: s.critical,
    why: s.why,
    need: s.need,
    action: s.action,
    risks: s.risks,
    doneWhen: s.doneWhen
  }));
}

module.exports = { mergeFrameworkDelta };
