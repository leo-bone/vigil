import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  globMatch,
  matchesCondition,
  parseRulePack,
  packToRules,
  mergePackPolicy,
  loadPackFile,
  loadPacks,
  installPack,
  RulePackError,
} from '../src/index.ts';
import { BUILTIN_PACKS } from '../src/policy/builtin-packs.ts';
import type { DecisionRequest } from '../src/types.ts';

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    sessionId: 's1',
    actor: 'bot/eng',
    intent: '测试',
    action: { kind: 'write_file', target: 'src/a.ts', reversible: true, external: false },
    ...overrides,
  } as DecisionRequest;
}

test('通配符：前缀、后缀、中间都能匹配，且不会误伤', () => {
  assert.equal(globMatch('patient-data*', 'patient-data/zhang.md'), true);
  assert.equal(globMatch('patient-data*', 'patient-data'), true);
  assert.equal(globMatch('*.pem', 'cert.pem'), true);
  assert.equal(globMatch('*.pem', 'pem'), false);
  assert.equal(globMatch('*.pem', 'cert.pem.bak'), false);
  assert.equal(globMatch('report-*.md', 'report-2026.md'), true);
  assert.equal(globMatch('patient-data', 'src/patient-data/x'), true, '不含 * 时按子串匹配');
  assert.equal(globMatch('patient-data', 'PATIENT-DATA'), true, '默认不区分大小写');
});

test('条件求值：各字段与 all/any/not 的组合', () => {
  const req = request({
    action: { kind: 'send_email', target: 'a@b.com', reversible: false, external: true, moneyUsd: 5 },
    actor: 'bot/outbound',
  });

  assert.equal(matchesCondition({ kindIn: ['send_email'] }, req), true);
  assert.equal(matchesCondition({ kindIn: ['write_file'] }, req), false);
  assert.equal(matchesCondition({ external: true }, req), true);
  assert.equal(matchesCondition({ reversible: false }, req), true);
  assert.equal(matchesCondition({ moneyUsdAtLeast: 1 }, req), true);
  assert.equal(matchesCondition({ moneyUsdAtLeast: 100 }, req), false);
  assert.equal(matchesCondition({ actorMatches: ['bot/*'] }, req), true);
  assert.equal(matchesCondition({ targetMatches: ['*@b.com'] }, req), true);

  assert.equal(matchesCondition({ all: [{ external: true }, { moneyUsdAtLeast: 1 }] }, req), true);
  assert.equal(matchesCondition({ all: [{ external: true }, { moneyUsdAtLeast: 100 }] }, req), false);
  assert.equal(matchesCondition({ any: [{ kindIn: ['write_file'] }, { external: true }] }, req), true);
  assert.equal(matchesCondition({ not: { external: true } }, req), false);
  assert.equal(matchesCondition({ not: { kindIn: ['write_file'] } }, req), true);
});

test('规则包校验：缺字段、重复 id、空条件都要报错并说清原因', () => {
  assert.throws(() => parseRulePack({}, 'x.json'), RulePackError);
  assert.throws(() => parseRulePack({ id: 'a b', name: 'x', rules: [{}] }, 'x.json'), /id/);
  assert.throws(
    () => parseRulePack({ id: 'a', name: 'x', rules: [] }, 'x.json'),
    /没有规则/,
  );
  assert.throws(
    () =>
      parseRulePack(
        { id: 'a', name: 'x', rules: [{ id: 'r1', description: 'd', severity: 'nope', when: { external: true } }] },
        'x.json',
      ),
    /severity/,
  );
  assert.throws(
    () =>
      parseRulePack(
        { id: 'a', name: 'x', rules: [{ id: 'r1', description: 'd', severity: 'deny', when: {} }] },
        'x.json',
      ),
    /空的/,
  );
  assert.throws(
    () =>
      parseRulePack(
        {
          id: 'a',
          name: 'x',
          rules: [
            { id: 'r1', description: 'd', severity: 'deny', when: { external: true } },
            { id: 'r1', description: 'd', severity: 'deny', when: { external: true } },
          ],
        },
        'x.json',
      ),
    /重复/,
  );
});

test('规则包转成内核规则后能正常命中并带上说明', () => {
  const pack = parseRulePack({
    id: 'demo.pack',
    name: '演示',
    rules: [
      {
        id: 'no-secret',
        description: '不写凭据文件',
        severity: 'deny',
        detail: '目标 {target} 是凭据文件',
        when: { targetMatches: ['.env*'] },
      },
    ],
  });
  const rules = packToRules(pack);
  assert.equal(rules.length, 1);

  const hit = rules[0]!.check(request({ action: { kind: 'write_file', target: '.env', reversible: true, external: false } }), {} as never);
  assert.ok(hit);
  assert.equal(hit!.rule, 'demo.pack.no-secret');
  assert.ok(hit!.detail.includes('.env'), '占位符要替换成真实目标');

  const miss = rules[0]!.check(request(), {} as never);
  assert.equal(miss, null);
});

test('策略补丁合并：禁止清单与授权表累加，数字直接覆盖', () => {
  const base = {
    moneyCapPerAction: 50,
    moneyCapPerSession: 200,
    allowAutonomousIrreversible: false,
    denylistTargets: ['.env'],
    grants: [{ actor: 'bot/*', authority: 2 as const }],
  };
  const pack = parseRulePack({
    id: 'demo',
    name: '演示',
    policy: {
      denylistTargets: ['secrets/', '.env'],
      grants: [{ actor: 'bot/outbound', authority: 3 }],
      moneyCapPerAction: 0,
    },
    rules: [{ id: 'r', description: 'd', severity: 'deny', when: { external: true } }],
  });

  const merged = mergePackPolicy(base, pack);
  assert.deepEqual(merged.denylistTargets, ['.env', 'secrets/']);
  assert.equal(merged.grants.length, 2);
  assert.equal(merged.grants.find((g) => g.actor === 'bot/outbound')!.authority, 3);
  assert.equal(merged.moneyCapPerAction, 0);
});

test('安装与加载：装进去就能被读出来，坏包不影响其他包', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-packs-'));
  const pack = parseRulePack({
    id: 'demo.pack',
    name: '演示',
    rules: [{ id: 'r', description: 'd', severity: 'deny', when: { external: true } }],
  });
  const installed = installPack(pack, dir);
  assert.ok(existsSync(installed.path));

  const loaded = loadPacks(dir);
  assert.equal(loaded.packs.length, 1);
  assert.equal(loaded.errors.length, 0);

  // 坏包只报自己，不拖垮整个目录
  writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8');
  const withBroken = loadPacks(dir);
  assert.equal(withBroken.packs.length, 1);
  assert.equal(withBroken.errors.length, 1);

  // 覆盖要显式确认
  assert.throws(() => installPack(pack, dir), /--force/);
  assert.ok(installPack(pack, dir, true).replaced);
});

test('内置规则包全部通过校验，且不含空条件', () => {
  for (const pack of BUILTIN_PACKS) {
    const parsed = parseRulePack(pack, pack.id);
    assert.ok(parsed.rules.length > 0);
    for (const rule of parsed.rules) {
      assert.ok(rule.detail, `${pack.id}.${rule.id} 应当有说明文字`);
    }
  }
});

test('规则包文件往返：读出来再存回去，结构不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-packfile-'));
  const path = join(dir, 'p.json');
  writeFileSync(
    path,
    JSON.stringify({
      id: 'round.trip',
      name: '往返',
      rules: [{ id: 'r1', description: 'd', severity: 'escalate', when: { kindIn: ['pay'] } }],
    }),
    'utf8',
  );
  const pack = loadPackFile(path);
  assert.equal(pack.id, 'round.trip');
  const again = parseRulePack(JSON.parse(JSON.stringify(pack)));
  assert.deepEqual(again, pack);
});
