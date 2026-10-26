import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunnerStartPlan } from '../../../dist/runners/rn-fast-runner-client.js';

const BASE = {
  projectPath: '/p/RnFastRunner.xcodeproj',
  scheme: 'RnFastRunner',
  deviceId: 'UDID-123',
  derivedDataPath: '/p/build/DerivedData',
  onlyTesting: 'RnFastRunnerUITests/RnFastRunnerTests/testCommand',
};

test('warm start plan is a single test-without-building launch', () => {
  const plan = resolveRunnerStartPlan({ ...BASE, hasBuiltTestProduct: true });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'test-without-building');
  assert.equal(plan[0].args[0], 'test-without-building');
  assert.ok(plan[0].args.includes('-project'));
  assert.ok(plan[0].args.includes('/p/RnFastRunner.xcodeproj'));
  assert.ok(plan[0].args.includes('platform=iOS Simulator,id=UDID-123'));
  assert.ok(plan[0].args.includes('/p/build/DerivedData'));
  assert.ok(
    plan[0].args.includes('-only-testing:RnFastRunnerUITests/RnFastRunnerTests/testCommand'),
  );
});

test('cold start plan builds the test product first, then launches warm (GH #424)', () => {
  const plan = resolveRunnerStartPlan({ ...BASE, hasBuiltTestProduct: false });
  assert.equal(plan.length, 2);

  const [build, launch] = plan;
  assert.equal(build.action, 'build-for-testing');
  assert.equal(build.args[0], 'build-for-testing');
  assert.ok(build.args.includes('-project'));
  assert.ok(build.args.includes('RnFastRunner'));
  assert.ok(build.args.includes('platform=iOS Simulator,id=UDID-123'));
  assert.ok(build.args.includes('/p/build/DerivedData'));
  assert.ok(
    !build.args.some((a) => a.startsWith('-only-testing')),
    'build-for-testing must mirror the documented manual prebuild (no -only-testing) so both produce the same .xctestrun',
  );

  assert.equal(launch.action, 'test-without-building');
  assert.equal(launch.args[0], 'test-without-building');
  assert.ok(
    launch.args.includes('-only-testing:RnFastRunnerUITests/RnFastRunnerTests/testCommand'),
  );
});

test('no plan ever uses the bare `test` action — it never emits a .xctestrun (GH #424)', () => {
  for (const hasBuiltTestProduct of [true, false]) {
    const plan = resolveRunnerStartPlan({ ...BASE, hasBuiltTestProduct });
    for (const step of plan) {
      assert.notEqual(step.args[0], 'test');
    }
  }
});
