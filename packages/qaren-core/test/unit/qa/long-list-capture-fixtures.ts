import vm from 'node:vm';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';

// A sheet in the real injected helpers: a placeholder-only TextInput above `rows` pressable rows.
export function longListSheet(rows: number, placeholder: string) {
  const root = buildFiber({ hostType: 'RCTView', props: {} });
  root.tag = 5;
  const field = buildFiber({ name: 'TextInput', props: { placeholder, onChangeText() {} } }, root);
  field.tag = 0;
  const host = buildFiber(
    { hostType: 'RCTSinglelineTextInputView', props: { placeholder } },
    field,
  );
  host.tag = 5;
  field.child = host;
  root.child = field;
  let previous = field;
  for (let row = 0; row < rows; row++) {
    const pressable = buildFiber(
      {
        hostType: 'RCTView',
        props: { testID: `row-${row}`, accessibilityRole: 'button', onPress() {} },
      },
      root,
    );
    pressable.tag = 5;
    previous.sibling = pressable;
    previous = pressable;
  }
  const sandbox = createSandbox({ fiberRoot: root });
  // Count-bound fixtures must not consume the producer deadline under host load.
  sandbox.Date = { now: () => 1000 };
  // One stable root object, as a live renderer reports, so the capture's tree check holds.
  const stable = { current: root };
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
    id === 1 ? new Set([stable]) : new Set();
  const client = {
    isConnected: true,
    async withPrivateHelperWorld<T>(
      run: (evaluate: (expression: string) => Promise<unknown>) => Promise<T>,
    ): Promise<T> {
      return run(async (expression) => vm.runInContext(expression, sandbox));
    },
  };
  return { api: sandbox.__QAREN, client };
}
