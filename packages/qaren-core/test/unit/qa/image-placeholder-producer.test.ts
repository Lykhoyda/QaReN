import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { HELPERS_VERSION } from '../../../dist/injected-helpers.js';
import { buildFiber, createSandbox, INJECTED_HELPERS } from '../helpers/inject-harness.js';

function imageFixture(placeholder: unknown = [{ uri: 'image-source-canary' }]) {
  const props: Record<string, unknown> = { testID: 'picture', placeholder, onPress() {} };
  const fiber = buildFiber({ hostType: 'ViewManagerAdapter_ExpoImage', props });
  fiber.tag = 5;
  const viewConfig: {
    uiViewClassName: string;
    validAttributes: Record<string, unknown>;
    bubblingEventTypes: Record<string, unknown>;
    directEventTypes: Record<string, unknown>;
  } = {
    uiViewClassName: 'ViewManagerAdapter_ExpoImage',
    validAttributes: { source: true, placeholder: true },
    bubblingEventTypes: {
      topChange: {},
      topSubmitEditing: {},
      topEndEditing: {},
      topKeyPress: {},
    },
    directEventTypes: { onLoad: {}, onProgress: {}, onError: {} },
  };
  fiber.stateNode = {
    canonical: {
      viewConfig,
      publicInstance: {
        measureInWindow(done: (x: number, y: number, width: number, height: number) => void) {
          done(0, 0, 40, 40);
        },
      },
    },
  };
  const root = { current: fiber };
  const sandbox = createSandbox({ fiberRoot: fiber });
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
    id === 1 ? new Set([root]) : new Set();
  return { fiber, props, viewConfig, root, sandbox, api: sandbox.__QAREN };
}

async function capture(fixture: ReturnType<typeof imageFixture>, typography: boolean) {
  const begin = fixture.api.beginQaCapture(typography);
  await Promise.resolve();
  await Promise.resolve();
  return begin.state === 'pending' ? fixture.api.readQaCapture(begin.id) : begin;
}

test('native image source placeholders do not refuse complete capture with shared view events', async () => {
  for (const typography of [false, true]) {
    const result = await capture(imageFixture(), typography);
    assert.equal(result.state, 'ready');
    assert.doesNotMatch(JSON.stringify(result), /image-source-canary/);
    const tree = JSON.parse(result.tree);
    assert.equal(tree.verdict.complete, true);
    assert.equal(tree.hostEvidence.complete, true);
    assert.equal(tree.hostEvidence.hosts.length, 1);
    assert.equal(tree.hostEvidence.hosts[0].testID, 'picture');
    assert.notEqual(tree.hostEvidence.hosts[0].capabilities.fill, true);
    assert.equal(tree.interactive[0].testID, 'picture');
    assert.equal(tree.interactive[0].capabilities.press, true);
    assert.equal(tree.interactive[0].capabilities.fill, false);
    assert.equal(tree.interactive[0].placeholder, undefined);
  }
});

test('canonical image metadata processors are recognized without invoking them', async () => {
  let calls = 0;
  function process() {
    calls++;
    throw new Error('processor-canary');
  }
  for (const typography of [false, true]) {
    const fixture = imageFixture();
    fixture.fiber.type = { displayName: 'Anonymous' };
    fixture.viewConfig.validAttributes = { source: { process }, placeholder: { process } };
    const result = await capture(fixture, typography);
    assert.equal(result.state, 'ready');
    assert.doesNotMatch(JSON.stringify(result), /processor-canary|image-source-canary/);
  }
  assert.equal(calls, 0);
});

test('image metadata changes while typography is pending refuse the capture', async () => {
  const fixture = imageFixture();
  let complete = () => {};
  fixture.fiber.stateNode.canonical.publicInstance.measureInWindow = (
    done: (x: number, y: number, width: number, height: number) => void,
  ) => {
    complete = () => done(0, 0, 40, 40);
  };
  const begin = fixture.api.beginQaCapture(true);
  assert.equal(begin.state, 'pending');
  fixture.viewConfig.validAttributes = { source: true, placeholder: true };
  complete();
  await Promise.resolve();
  await Promise.resolve();
  const result = fixture.api.readQaCapture(begin.id);
  assert.equal(result.state, 'refused');
  assert.doesNotMatch(JSON.stringify(result), /image-source-canary/);
});

test('image placeholders require the exact native image identity and readable source metadata', async () => {
  for (const hostType of [
    'RCTTextInput',
    'RCTSinglelineTextInputView',
    'RCTMultilineTextInputView',
    'AndroidTextInput',
    'TextInput',
    'RCTView',
    'CustomNativeHost',
    'ViewManagerAdapter_ExpoImage_custom',
  ]) {
    for (const typography of [false, true]) {
      const fixture = imageFixture();
      fixture.viewConfig.uiViewClassName = hostType;
      const result = await capture(fixture, typography);
      assert.equal(result.state, 'refused', hostType);
      assert.doesNotMatch(JSON.stringify(result), /image-source-canary/);
    }
  }
  for (const mutate of [
    (f: ReturnType<typeof imageFixture>) => {
      delete f.viewConfig.validAttributes.source;
    },
    (f: ReturnType<typeof imageFixture>) => {
      delete f.viewConfig.validAttributes.placeholder;
    },
    (f: ReturnType<typeof imageFixture>) => {
      f.viewConfig.validAttributes.source = false;
    },
    (f: ReturnType<typeof imageFixture>) => {
      f.fiber.stateNode.canonical.viewConfig = {};
    },
    (f: ReturnType<typeof imageFixture>) => {
      f.viewConfig.uiViewClassName = 'CustomNativeHost';
      f.viewConfig.directEventTypes = { onTypedGlyph() {} };
    },
  ]) {
    for (const typography of [false, true]) {
      const fixture = imageFixture();
      mutate(fixture);
      assert.equal((await capture(fixture, typography)).state, 'refused');
    }
  }
});

test('input roles, handlers and read-only predicates keep opaque placeholders strict', async () => {
  for (const props of [
    { role: 'textbox' },
    { accessibilityRole: 'search' },
    { role: 'searchbox' },
    { onChangeText() {} },
    { onChange() {} },
    { onEndEditing() {} },
    { onKeyPress() {} },
    { onSubmitEditing() {} },
    { readOnly: true },
    { editable: false },
    { 'aria-readonly': true },
  ]) {
    for (const typography of [false, true]) {
      const fixture = imageFixture();
      Object.assign(fixture.props, props);
      assert.equal((await capture(fixture, typography)).state, 'refused');
    }
  }
  for (const hostType of ['RCTTextInput', 'RCTSinglelineTextInputView']) {
    const fixture = imageFixture();
    fixture.viewConfig.uiViewClassName = hostType;
    Object.assign(fixture.props, { readOnly: true, editable: false });
    assert.equal((await capture(fixture, false)).state, 'refused');
  }
});

test('image labels, titles and identities remain strict and string placeholders retain meaning', async () => {
  for (const key of [
    'title',
    'accessibilityLabel',
    'testID',
    'nativeID',
    'role',
    'accessibilityRole',
  ]) {
    for (const typography of [false, true]) {
      const fixture = imageFixture();
      Object.assign(fixture.props, { [key]: { canary: 'identity-canary' } });
      const result = await capture(fixture, typography);
      assert.equal(result.state, 'refused', key);
      assert.doesNotMatch(JSON.stringify(result), /identity-canary|image-source-canary/);
    }
  }
  const result = await capture(imageFixture('Image hint'), false);
  assert.equal(result.state, 'ready');
  assert.equal(JSON.parse(result.tree).interactive[0].placeholder, 'Image hint');
});

test('image placeholder values are never coerced and capture keeps adjacent input values private', async () => {
  let coercions = 0;
  const placeholder = {
    canary: 'object-canary',
    toString() {
      coercions++;
      throw new Error('coercion-canary');
    },
    toJSON() {
      coercions++;
      throw new Error('serialization-canary');
    },
  };
  for (const typography of [false, true]) {
    const fixture = imageFixture(placeholder);
    const input = buildFiber({
      hostType: 'RCTTextInput',
      props: {
        testID: 'field',
        value: 'private-input-canary',
        secureTextEntry: true,
        onChangeText() {},
      },
    });
    input.tag = 5;
    input.return = fixture.fiber;
    input.stateNode = {
      measureInWindow(done: (x: number, y: number, width: number, height: number) => void) {
        done(0, 50, 100, 30);
      },
    };
    fixture.fiber.child = input;
    const result = await capture(fixture, typography);
    assert.equal(result.state, 'ready');
    assert.doesNotMatch(
      JSON.stringify(result),
      /object-canary|coercion-canary|serialization-canary|private-input-canary/,
    );
    const tree = JSON.parse(result.tree);
    assert.equal(tree.hostEvidence.hosts.length, 2);
    assert.equal(tree.hostEvidence.hosts[1].capabilities.fill, true);
  }
  assert.equal(coercions, 0);
});

test('image placeholder and native metadata accessors refuse without execution', async () => {
  let reads = 0;
  const getter = {
    get() {
      reads++;
      throw new Error('getter-canary');
    },
  };
  for (const target of [
    'placeholder',
    'onEndEditing',
    'onKeyPress',
    'attributes',
    'source',
    'process',
  ]) {
    for (const typography of [false, true]) {
      const fixture = imageFixture();
      if (target === 'attributes')
        Object.defineProperty(fixture.viewConfig, 'validAttributes', getter);
      else if (target === 'source')
        Object.defineProperty(fixture.viewConfig.validAttributes, 'source', getter);
      else if (target === 'process') {
        const descriptor = {};
        Object.defineProperty(descriptor, 'process', getter);
        fixture.viewConfig.validAttributes.source = descriptor;
      } else Object.defineProperty(fixture.props, target, getter);
      const result = await capture(fixture, typography);
      assert.equal(result.state, 'refused', target);
      assert.doesNotMatch(JSON.stringify(result), /getter-canary|image-source-canary/);
    }
  }
  assert.equal(reads, 0);
});

test('omitted image placeholders still revalidate value, metadata, predicates and identity', async () => {
  let reads = 0;
  for (const mutate of [
    (f: ReturnType<typeof imageFixture>) => {
      f.props.placeholder = [];
    },
    (f: ReturnType<typeof imageFixture>) => {
      f.props.testID = 'changed';
    },
    (f: ReturnType<typeof imageFixture>) => {
      f.viewConfig.uiViewClassName = 'RCTTextInput';
    },
    (f: ReturnType<typeof imageFixture>) => {
      f.viewConfig.validAttributes.source = { process() {} };
    },
    (f: ReturnType<typeof imageFixture>) => {
      Object.assign(f.props, { onEndEditing() {} });
    },
    (f: ReturnType<typeof imageFixture>) => {
      Object.defineProperty(f.props, 'onKeyPress', {
        get() {
          reads++;
          throw new Error('late-getter-canary');
        },
      });
    },
    (f: ReturnType<typeof imageFixture>) => {
      f.root.current = buildFiber({ hostType: 'RCTView' });
    },
  ]) {
    const fixture = imageFixture();
    let complete = () => {};
    fixture.fiber.stateNode.canonical.publicInstance.measureInWindow = (
      done: (x: number, y: number, width: number, height: number) => void,
    ) => {
      complete = () => done(0, 0, 40, 40);
    };
    const begin = fixture.api.beginQaCapture(true);
    assert.equal(begin.state, 'pending');
    mutate(fixture);
    complete();
    await Promise.resolve();
    await Promise.resolve();
    const result = fixture.api.readQaCapture(begin.id);
    assert.equal(result.state, 'refused');
    assert.doesNotMatch(JSON.stringify(result), /late-getter-canary|image-source-canary/);
  }
  assert.equal(reads, 0);
});

test('current image placeholder helper replaces a warm helper95', async () => {
  const fixture = imageFixture();
  fixture.sandbox.__QAREN = { __v: 95 };
  vm.runInContext(INJECTED_HELPERS, fixture.sandbox);
  assert.equal(fixture.sandbox.__QAREN.__v, HELPERS_VERSION);
  assert.notEqual(HELPERS_VERSION, 95);
  fixture.api = fixture.sandbox.__QAREN;
  assert.equal((await capture(fixture, false)).state, 'ready');
});
