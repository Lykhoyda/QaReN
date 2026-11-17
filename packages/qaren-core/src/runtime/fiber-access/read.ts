import type { FiberLike, PropsBag } from './types.js';

// RN dev renderers deep-freeze host prop values into bound identity accessors.
export function descriptorValue(object: object, descriptor: PropertyDescriptor): unknown {
  if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) return descriptor.value;
  const get = descriptor.get;
  const set = descriptor.set;
  const getName = typeof get === 'function' && Object.getOwnPropertyDescriptor(get, 'name');
  const setName = typeof set === 'function' && Object.getOwnPropertyDescriptor(set, 'name');
  if (
    !Object.isFrozen(object) ||
    !getName ||
    getName.value !== 'bound identity' ||
    !setName ||
    setName.value !== 'bound throwOnImmutableMutation'
  )
    throw new Error('Capture refused');
  return Reflect.apply(get as () => unknown, object, []);
}

// Only nested public evidence may pass devFrozen; input facts stay data-only.
export function qaData(object: unknown, key: string, devFrozen?: boolean): unknown {
  if (object == null) return undefined;
  if (typeof object !== 'object' && typeof object !== 'function')
    throw new Error('Capture refused');
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor && !(key in object)) return undefined;
  if (
    !descriptor ||
    (devFrozen !== true && !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
  )
    throw new Error('Capture refused');
  return descriptorValue(object, descriptor);
}

export const QA_POINTER_EVENTS = ['auto', 'none', 'box-none', 'box-only'];

export function qaStyleFact(style: unknown, key: string, depth: number): unknown {
  if (style == null || style === false) return undefined;
  if (depth > 32) throw new Error('Capture refused');
  if (Array.isArray(style)) {
    const length = qaData(style, 'length', true) as number;
    for (let i = length - 1; i >= 0; i--) {
      const value = qaStyleFact(qaData(style, String(i), true), key, depth + 1);
      if (value !== undefined) return value;
    }
    return undefined;
  }
  if (typeof style !== 'object') throw new Error('Capture refused');
  return qaData(style, key, true);
}

export function qaHostType(fiber: FiberLike): unknown {
  const state = qaData(fiber, 'stateNode');
  const canonical = qaData(state, 'canonical');
  const config = qaData(canonical || state, 'viewConfig');
  const name = qaData(config, 'uiViewClassName');
  if (name != null && (typeof name !== 'string' || name.length > 200))
    throw new Error('Capture refused');
  const type = qaData(fiber, 'type');
  return name || (typeof type === 'string' ? type : null);
}

export function imageSourcePlaceholderFacts(fiber: FiberLike, props: PropsBag): unknown[] | null {
  if (qaHostType(fiber) !== 'ViewManagerAdapter_ExpoImage') return null;
  const state = qaData(fiber, 'stateNode');
  const canonical = qaData(state, 'canonical');
  const config = qaData(canonical || state, 'viewConfig');
  if (qaData(config, 'uiViewClassName') !== 'ViewManagerAdapter_ExpoImage') return null;
  const attributes = qaData(config, 'validAttributes');
  const source = qaData(attributes, 'source');
  const placeholder = qaData(attributes, 'placeholder');
  const sourceProcess = source === true ? true : qaData(source, 'process');
  const placeholderProcess = placeholder === true ? true : qaData(placeholder, 'process');
  if (sourceProcess !== true && typeof sourceProcess !== 'function') return null;
  if (placeholderProcess !== true && typeof placeholderProcess !== 'function') return null;
  const roles = ['role', 'accessibilityRole'];
  for (let ri = 0; ri < roles.length; ri++) {
    const role = qaData(props, roles[ri]!);
    if (
      role != null &&
      (typeof role !== 'string' ||
        ['textinput', 'textbox', 'search', 'searchbox'].indexOf(role.toLowerCase()) !== -1)
    )
      return null;
  }
  const inputProps = [
    'onChangeText',
    'onChange',
    'onEndEditing',
    'onKeyPress',
    'onSubmitEditing',
    'editable',
    'readOnly',
    'aria-readonly',
  ];
  for (let pi = 0; pi < inputProps.length; pi++)
    if (qaData(props, inputProps[pi]!) != null) return null;
  return [config, attributes, source, placeholder, sourceProcess, placeholderProcess];
}
