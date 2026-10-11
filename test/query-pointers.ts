import assert from 'node:assert/strict';

/** Test-only field contract, checked against official @agentshouse/mdruntime
 * 0.1.0-c2647c1a232dd AGENTS.md and dist/query.js (Master 1742).
 * Frontmatter selectors are pointers; metadata keys and section headings aren't.
 * This is not a Runtime implementation and is never imported by production. */
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function assertQueryPointers(input: unknown): void {
  const query = object(input);
  const pointer = (value: unknown, at: string) => {
    assert(typeof value === 'string' && value.startsWith('/') && !/~(?![01])/u.test(value), `invalid-query at ${at}: expects a JSON Pointer`);
  };
  const list = (value: unknown): unknown[] => { assert(Array.isArray(value)); return value; };
  const where = (value: unknown, at: string): void => {
    if (value === undefined) return;
    for (const [name, operand] of Object.entries(object(value))) {
      if (name === '$and' || name === '$or') list(operand).forEach((item, index) => where(item, `${at}.${name}[${index}]`));
      else pointer(name, `${at}.${name}`);
    }
  };
  const key = (value: unknown, at: string, metadata: string[]) => {
    if (typeof value === 'string') assert(metadata.includes(value), `invalid-query at ${at}: invalid metadata key`);
    else pointer(object(value).field, `${at}.field`);
  };
  where(query.where, 'where');
  if (query.select !== undefined && query.select !== 'all') {
    const fields = object(query.select).fields;
    if (fields !== undefined && fields !== 'all') list(fields).forEach((field, index) => pointer(field, `select.fields[${index}]`));
  }
  if (query.orderBy !== undefined) list(query.orderBy).forEach((entry, index) => key(object(entry).by, `orderBy[${index}].by`, query.groupBy === undefined ? ['room', 'path', 'type'] : ['room', 'type', 'count']));
  if (query.groupBy !== undefined) list(query.groupBy).forEach((entry, index) => key(entry, `groupBy[${index}]`, ['room', 'type']));
  for (const relation of ['hop', 'backlinks']) if (query[relation] !== undefined) {
    const value = object(query[relation]);
    if (value.field !== undefined) pointer(value.field, `${relation}.field`);
    where(value.where, `${relation}.where`);
  }
}

export const rejectedPointerQueries = [
  {select: {fields: ['title']}},
  {select: 'all', where: {title: 'x'}},
  {select: 'all', where: {$and: [{'/id': 'x'}, {$or: [{title: 'x'}]}]}},
  {select: 'all', orderBy: [{by: {field: 'title'}}]},
  {groupBy: [{field: 'title'}]},
  {select: 'all', hop: {field: 'parent', where: {'/title': 'x'}}},
  {select: 'all', backlinks: {field: 'parent'}},
  {select: 'all', hop: {field: '/parent', where: {title: 'x'}}},
  {select: 'all', backlinks: {where: {title: 'x'}}},
  {select: {fields: ['/bad~2escape']}},
  {select: {fields: ['/bad~']}},
];
