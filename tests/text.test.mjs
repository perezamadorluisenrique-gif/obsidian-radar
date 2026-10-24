import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stem, terms, buildIdf, vectorize, cosine, centroid, topTerms } from '../lib/text.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('stem: plurals, -ing/-ed and the words it must leave alone', () => {
  assert.equal(stem('links'), 'link');
  assert.equal(stem('linking'), 'link');
  assert.equal(stem('linked'), 'link');
  assert.equal(stem('libraries'), 'library');
  assert.equal(stem('running'), 'run');
  assert.equal(stem('class'), 'class');
  assert.equal(stem('status'), 'status');
  assert.equal(stem('css'), 'css');
  assert.equal(stem('md5'), 'md5');
  assert.equal(stem('bed'), 'bed', 'short words are not stripped');
});

test('terms: lower-cases, drops stop words, urls, bare numbers and one-letter tokens, then stems', () => {
  assert.deepEqual(terms('Please ADD the ability to open https://example.com/x links in 2 new tabs'), ['open', 'link', 'tab']);
  assert.deepEqual(terms('A  b c'), []);
  assert.deepEqual(terms(null), []);
});

test('terms: the "not manually reviewed" boilerplate that many plugin descriptions carry is ignored', () => {
  assert.deepEqual(terms('Sync notes - This plugin has not been manually reviewed by Obsidian staff.'), ['sync', 'note']);
});

test('terms({raw}) keeps the spelling next to the stem for readable labels', () => {
  assert.deepEqual(terms('Linking tables', { raw: true }), [['link', 'linking'], ['table', 'tables']]);
});

test('buildIdf: idf = ln((N+1)/(df+1)) + 1, and unseen terms get the maximum', () => {
  const { n, idf } = buildIdf([['a', 'b'], ['a'], ['c']]);
  assert.equal(n, 3);
  close(idf('a'), Math.log(4 / 3) + 1);
  close(idf('b'), Math.log(4 / 2) + 1);
  close(idf('zzz'), Math.log(4 / 1) + 1);
  assert.ok(idf('a') < idf('b') && idf('b') < idf('zzz'));
});

test('buildIdf counts documents, not occurrences', () => {
  const { df } = buildIdf([['a', 'a', 'a'], ['b']]);
  assert.equal(df.get('a'), 1);
});

test('vectorize: sublinear tf, L2-normalised', () => {
  const v = vectorize(['a', 'a', 'b'], () => 1);
  const wa = 1 + Math.log(2), wb = 1, norm = Math.hypot(wa, wb);
  close(v.get('a'), wa / norm);
  close(v.get('b'), wb / norm);
  close([...v.values()].reduce((s, x) => s + x * x, 0), 1);
  assert.equal(vectorize([], () => 1).size, 0);
});

test('cosine: 1 for equal, 0 for disjoint, 0.5 for one shared term out of two each (hand-computed)', () => {
  const idf = () => 1;
  close(cosine(vectorize(['a', 'b'], idf), vectorize(['a', 'b'], idf)), 1);
  close(cosine(vectorize(['a', 'b'], idf), vectorize(['c', 'd'], idf)), 0);
  close(cosine(vectorize(['a', 'b'], idf), vectorize(['a', 'c'], idf)), 0.5);
  close(cosine(vectorize(['a'], idf), new Map()), 0);
});

test('cosine is symmetric', () => {
  const idf = (t) => 1 + t.length;
  const x = vectorize(['aa', 'b', 'ccc'], idf), y = vectorize(['aa', 'ccc', 'ccc', 'd'], idf);
  close(cosine(x, y), cosine(y, x));
});

test('centroid of two orthogonal unit vectors is at 45 degrees to both', () => {
  const idf = () => 1;
  const c = centroid([vectorize(['a'], idf), vectorize(['b'], idf)]);
  close(c.get('a'), Math.SQRT1_2);
  close(cosine(c, vectorize(['a'], idf)), Math.SQRT1_2);
});

test('topTerms: heaviest first, ties alphabetical, limited to n', () => {
  const v = new Map([['b', 0.5], ['a', 0.5], ['c', 0.9], ['d', 0.1]]);
  assert.deepEqual(topTerms(v, 3), ['c', 'a', 'b']);
});
