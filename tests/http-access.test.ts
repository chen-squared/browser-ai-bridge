import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAllowedHosts,
  extractToken,
  isAllowedHost,
  isTokenValid,
  normalizeHostname,
} from '../src/http-access.ts';

test('normalizeHostname strips the port', () => {
  assert.equal(normalizeHostname('127.0.0.1:3010'), '127.0.0.1');
  assert.equal(normalizeHostname('localhost:3010'), 'localhost');
  assert.equal(normalizeHostname('example.com'), 'example.com');
  assert.equal(normalizeHostname('EXAMPLE.com:8080'), 'example.com');
});

test('normalizeHostname keeps IPv6 brackets intact', () => {
  // `[::1]:3010` 里的冒号属于地址本身，不能按最后一个冒号切掉。
  assert.equal(normalizeHostname('[::1]:3010'), '[::1]');
  assert.equal(normalizeHostname('[::1]'), '[::1]');
});

test('normalizeHostname tolerates missing input', () => {
  assert.equal(normalizeHostname(undefined), '');
  assert.equal(normalizeHostname(null), '');
  assert.equal(normalizeHostname('  '), '');
});

test('loopback hosts are allowed by default', () => {
  const allowed = buildAllowedHosts(undefined, '127.0.0.1');

  assert.equal(isAllowedHost('127.0.0.1:3010', allowed), true);
  assert.equal(isAllowedHost('localhost:3010', allowed), true);
  assert.equal(isAllowedHost('[::1]:3010', allowed), true);
});

test('DNS-rebinding hosts are rejected even though they resolve to loopback', () => {
  const allowed = buildAllowedHosts(undefined, '127.0.0.1');

  // 攻击者把 attacker.com 解析到 127.0.0.1，浏览器认为这是同源请求，
  // 所以 Host 校验是唯一能拦住它的关卡。
  assert.equal(isAllowedHost('attacker.com', allowed), false);
  assert.equal(isAllowedHost('attacker.com:3010', allowed), false);
  assert.equal(isAllowedHost('evil.example.com', allowed), false);
});

test('missing or empty Host is rejected', () => {
  const allowed = buildAllowedHosts(undefined, '127.0.0.1');

  assert.equal(isAllowedHost(undefined, allowed), false);
  assert.equal(isAllowedHost('', allowed), false);
});

test('extra hosts can be allowlisted explicitly', () => {
  const allowed = buildAllowedHosts('my-laptop.local, 192.168.1.20', '127.0.0.1');

  assert.equal(isAllowedHost('my-laptop.local:3010', allowed), true);
  assert.equal(isAllowedHost('192.168.1.20:3010', allowed), true);
  assert.equal(isAllowedHost('other-host', allowed), false);
});

test('wildcard binds do not implicitly allow every host', () => {
  // HOST=0.0.0.0 时不应该把 0.0.0.0 当成"放行一切"，否则等于没设白名单。
  const allowed = buildAllowedHosts(undefined, '0.0.0.0');

  assert.equal(isAllowedHost('0.0.0.0:3010', allowed), false);
  assert.equal(isAllowedHost('192.168.1.20:3010', allowed), false);
  assert.equal(isAllowedHost('127.0.0.1:3010', allowed), true);
});

test('token check is skipped entirely when no token is configured', () => {
  assert.equal(isTokenValid(undefined, undefined), true);
  assert.equal(isTokenValid('anything', undefined), true);
});

test('token check accepts only the exact token once configured', () => {
  const expected = 'a'.repeat(32);

  assert.equal(isTokenValid(expected, expected), true);
  assert.equal(isTokenValid('wrong', expected), false);
  assert.equal(isTokenValid(undefined, expected), false);
  assert.equal(isTokenValid(`${expected}x`, expected), false);
});

test('extractToken prefers Authorization: Bearer', () => {
  assert.equal(extractToken('Bearer secret-token', 'header-token', 'query-token'), 'secret-token');
  assert.equal(extractToken('bearer secret-token', undefined, undefined), 'secret-token');
});

test('extractToken falls back to header then query', () => {
  assert.equal(extractToken(undefined, 'header-token', undefined), 'header-token');
  assert.equal(extractToken(undefined, undefined, 'query-token'), 'query-token');
  assert.equal(extractToken('Basic abc', undefined, undefined), undefined);
  assert.equal(extractToken(undefined, undefined, undefined), undefined);
});
