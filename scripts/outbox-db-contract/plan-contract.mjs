import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const INDEX_SCAN = new Set(['Index Scan', 'Index Only Scan', 'Bitmap Heap Scan']);
export const ROLES = ['privileged', 'member'];
export const SHAPE_NAMES = ['first', 'keyset', 'null_tail'];

export function describePlan(plan) {
  const nodes = [];
  const scans = [];
  function walk(node) {
    const relevant = { node: node['Node Type'], relation: node['Relation Name'] ?? null, schema: node.Schema ?? null, index: node['Index Name'] ?? null };
    nodes.push(relevant);
    if (relevant.relation === 'messages' && (relevant.schema === 'public' || relevant.schema === null) && (relevant.node === 'Seq Scan' || INDEX_SCAN.has(relevant.node))) scans.push(relevant.node);
    for (const child of node.Plans ?? []) walk(child);
  }
  walk(plan);
  if (!scans.length) throw new Error('PLAN_MESSAGES_SCAN_MISSING');
  return { sha256: digest(nodes), messages_scan: scans.includes('Seq Scan') ? 'Seq Scan' : 'Index', total_cost: Number(plan['Total Cost']) };
}

export function comparePlans(pre, post, target) {
  if (pre?.target !== target || pre?.phase !== 'pre') throw new Error('PLAN_PRE_TARGET_MISMATCH');
  const ratios = {};
  const regressions = [];
  for (const role of ROLES) {
    ratios[role] = {};
    for (const shape of SHAPE_NAMES) {
      const before = pre.plans?.[role]?.[shape], after = post?.[role]?.[shape];
      if (!before || !after || !/^[a-f0-9]{64}$/.test(before.sha256) || !/^[a-f0-9]{64}$/.test(after.sha256)) throw new Error(`PLAN_RECORD_MISSING ${role} ${shape}`);
      if (before.messages_scan === 'Index' && after.messages_scan === 'Seq Scan') regressions.push(`${role} ${shape}`);
      ratios[role][shape] = Number.isFinite(before.total_cost) && before.total_cost > 0 && Number.isFinite(after.total_cost) ? after.total_cost / before.total_cost : null;
    }
  }
  if (regressions.length) throw new Error(`FAIL PLAN_REGRESSION ${regressions.join(', ')}`);
  return ratios;
}
export function planCostRatios(pre, post) {
  return Object.fromEntries(ROLES.map(role => [role, Object.fromEntries(SHAPE_NAMES.map(shape => {
    const before = pre.plans?.[role]?.[shape]?.total_cost, after = post?.[role]?.[shape]?.total_cost;
    return [shape, Number.isFinite(before) && before > 0 && Number.isFinite(after) ? after / before : null];
  }))]));
}

export const OPERATOR_INDEXES = ['inbox_parent_message_property', 'inbox_parent_message_contact', 'inbox_parent_review_property', 'inbox_backfill_messages', 'inbox_backfill_reviews', 'inbox_backfill_threads', 'inbox_backfill_thread_identity', 'inbox_unknown_history_page'];
export function catalogIndexes(fingerprint) {
  const relations = fingerprint?.sections?.relations;
  if (!Array.isArray(relations)) throw new Error('CATALOG_INDEX_SECTION_MISSING');
  const result = {};
  for (const relation of relations) for (const index of relation.indexes ?? []) {
    const match = /\b(?:INDEX|index)\s+(?:"?public"?\.)?"?([a-z_][a-z_0-9]*)"?\s+ON\s+/i.exec(index.definition ?? '');
    if (match) result[match[1]] = { relation: relation.identity, valid: index.valid === true && index.ready === true };
  }
  return result;
}
export function compareIndexes(pre, post, phase = 'post') {
  if (!pre || typeof pre !== 'object' || Array.isArray(pre)) throw new Error('CATALOG_PRE_INDEXES_MISSING');
  const previous = Object.entries(pre).filter(([, value]) => value.relation === 'public.messages').map(([name]) => name);
  for (const name of previous) {
    if (!post?.[name]) throw new Error(`FAIL INDEX_ABSENT ${name}`);
    if (!post[name].valid) throw new Error(`FAIL INDEX_INVALID ${name}`);
  }
  const required = new Set([...previous, ...OPERATOR_INDEXES]);
  const builtCount = OPERATOR_INDEXES.filter(name => post?.[name]).length;
  if (phase === 'post' && builtCount === 0) return { verdict: 'INCONCLUSIVE', reason: 'INDEXES_NOT_BUILT' };
  for (const name of required) {
    if (!post?.[name]) throw new Error(`FAIL INDEX_ABSENT ${name}`);
    if (!post[name].valid) throw new Error(`FAIL INDEX_INVALID ${name}`);
  }
  return { verdict: 'PASS', count: required.size };
}
