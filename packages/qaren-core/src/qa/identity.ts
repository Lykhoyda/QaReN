import type { Step, Target } from './plan.js';
import {
  type Element,
  type Screen,
  soleLabelTextOf,
  labelAncestorsOf,
  ancestorsOf,
  elementFrame,
  actionView,
  forwardedInputOf,
  reactInputHostOf,
} from './screen.js';

export type IdentityTag = 'native' | 'react-only' | 'wrapper';

export interface Identity {
  element: Element;
  tag: IdentityTag;
}

interface ContainmentEquivalence {
  container: Element;
  control: Element;
}

// Target equivalence never changes capture or provenance facts.
const containmentEquivalences = new WeakMap<Screen, ContainmentEquivalence>();

function containedControl(elements: readonly Element[]): ContainmentEquivalence | undefined {
  if (elements.length !== 2 || elements.some((e) => e.ref.startsWith('react:'))) return;
  const interactive = (e: Element) =>
    !['input', 'text', 'image'].includes(e.nativeKind ?? e.kind) &&
    (['button', 'link', 'switch'].includes(e.kind) ||
      ['button', 'link', 'switch'].includes(e.nativeKind ?? e.kind) ||
      e.semantic?.press === 'supported');
  const controls = elements.filter(interactive);
  if (controls.length !== 1) return;
  const control = controls[0];
  const container = elements.find((e) => e !== control)!;
  if (
    !['other', 'cell'].includes(container.nativeKind ?? container.kind) ||
    !control.hittable ||
    control.disabled ||
    control.offscreen
  )
    return;
  const inner = elementFrame(control);
  const outer = elementFrame(container);
  if (
    !inner ||
    !outer ||
    !Object.values(inner).every(Number.isFinite) ||
    !Object.values(outer).every(Number.isFinite) ||
    inner.width <= 0 ||
    inner.height <= 0 ||
    inner.x <= outer.x ||
    inner.y <= outer.y ||
    inner.x + inner.width >= outer.x + outer.width ||
    inner.y + inner.height >= outer.y + outer.height
  )
    return;
  return { container, control };
}

export function applyContainmentFallback(screen: Screen, target: Target): boolean {
  if (target.quoted === undefined || target.exact === 'id') return false;
  const pair = containedControl(
    exactIdentities(screen, target, 'press').map(({ element }) => element),
  );
  if (!pair) return false;
  containmentEquivalences.set(screen, pair);
  return true;
}

export const PRESSABLE_SUFFIX = '-pressable';
export const withoutPressable = (id: string): string =>
  id.endsWith(PRESSABLE_SUFFIX) ? id.slice(0, -PRESSABLE_SUFFIX.length) : id;

export function named(
  e: Element,
  quoted: string,
  kind: Step['kind'],
  exact?: Target['exact'],
): boolean {
  if (exact) return exact === 'id' ? e.testID === quoted : e.label === quoted;
  // A fill names a text-entry candidate, or any element carrying the target's testID.
  if (kind === 'fill')
    return (
      e.testID === quoted ||
      (e.kind === 'input' && (e.label === quoted || e.placeholder === quoted))
    );
  return e.label === quoted || e.testID === quoted;
}

function forwardsInput(element: Element, matched: readonly Element[]): boolean {
  if (element.ref.startsWith('react:') && element.kind === 'input') {
    const wrappers = matched.filter(
      (e) =>
        !e.ref.startsWith('react:') &&
        forwardedInputOf(e) === element.testID &&
        ancestorsOf(element).includes(e),
    );
    if (wrappers.length === 1) return true;
  }
  const id = forwardedInputOf(element);
  if (!id) return false;
  const native = matched.filter((e) => !e.ref.startsWith('react:') && e.kind === 'input');
  if (native.length) return native.length === 1 && native[0].testID === id;
  // With no native input, a proven React-only wrapper stands for the one React-only input it contains,
  // matched by host; a native wrapper keeps standing for that input itself (the branch above).
  const inputs = matched.filter((e) => e.kind === 'input');
  const host = reactInputHostOf(element);
  return (
    element.ref.startsWith('react:') &&
    element.kind !== 'input' &&
    host !== undefined &&
    inputs.length === 1 &&
    inputs[0].ref.startsWith('react:') &&
    inputs[0].testID === id &&
    reactInputHostOf(inputs[0]) === host
  );
}

export function echoControl(
  element: Element,
  purpose: 'action' | 'refresh' = 'action',
): Element | undefined {
  const text = element.kind === 'text' ? element : soleLabelTextOf(element);
  const ancestors = text ? [...labelAncestorsOf(text)] : [];
  const control =
    purpose === 'refresh'
      ? ancestors.find((e) => e.semantic?.press === 'supported')
      : actionView({ elements: ancestors })[0];
  return control !== element ? control : undefined;
}

function encloses(container: Element, element: Element): boolean {
  if (ancestorsOf(element).includes(container)) return true;
  if (ancestorsOf(container).length && ancestorsOf(element).length) return false;
  const outer = elementFrame(container);
  const inner = elementFrame(element);
  return (
    !!outer &&
    !!inner &&
    outer.width * outer.height > inner.width * inner.height &&
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function sameFrameLabel(container: Element, child: Element): boolean {
  const outer = elementFrame(container);
  const inner = elementFrame(child);
  return (
    !!outer &&
    !!inner &&
    container.label !== undefined &&
    container.label === child.label &&
    outer.x === inner.x &&
    outer.y === inner.y &&
    outer.width === inner.width &&
    outer.height === inner.height
  );
}

function aggregatesControl(container: Element, child: Element, requireProvenance = true): boolean {
  if (
    container.kind === 'text' ||
    container.kind === 'input' ||
    container.ref.startsWith('react:') ||
    child.ref.startsWith('react:') ||
    child.kind === 'text' ||
    child.kind === 'input' ||
    !child.hittable ||
    child.disabled ||
    child.offscreen ||
    !container.label ||
    !child.label ||
    !ancestorsOf(child).includes(container)
  )
    return false;
  const outer = elementFrame(container);
  const inner = elementFrame(child);
  if (
    !outer ||
    !inner ||
    !Object.values(outer).every(Number.isFinite) ||
    !Object.values(inner).every(Number.isFinite) ||
    inner.width <= 0 ||
    inner.height <= 0 ||
    inner.x < outer.x ||
    inner.y < outer.y ||
    inner.x + inner.width > outer.x + outer.width ||
    inner.y + inner.height > outer.y + outer.height
  )
    return false;
  if (sameFrameLabel(container, child)) return true;
  if (
    container.kind !== 'other' ||
    (requireProvenance && container.semantic?.nativePresence?.labelSource !== 'descendant') ||
    outer.width * outer.height <= inner.width * inner.height
  )
    return false;
  const parts = (label: string) => label.split(/[,\n]/u).map((part) => part.trim());
  const enclosing = parts(container.label);
  const carried = parts(child.label);
  return enclosing.some((_, start) => carried.every((part, i) => part === enclosing[start + i]));
}

// Descendant provenance distinguishes a container echo from a separately labelled control.
function containerEcho(
  container: Element,
  matched: readonly Element[],
  purpose: 'action' | 'refresh',
  requireProvenance = true,
): boolean {
  if (
    container.kind !== 'other' ||
    container.testID !== undefined ||
    (requireProvenance && container.semantic?.nativePresence?.labelSource !== 'descendant') ||
    container.label === undefined ||
    container.ref.startsWith('react:')
  )
    return false;
  // A control is identified or typed; unidentified layout wrappers and texts have their own echo rule.
  const enclosed = matched.filter(
    (e) =>
      e !== container &&
      e.kind !== 'text' &&
      (e.testID !== undefined || e.kind !== 'other') &&
      e.label === container.label &&
      encloses(container, e),
  );
  return (purpose === 'refresh' ? enclosed : actionView({ elements: enclosed })).length === 1;
}

// Potential aggregation requests evidence; only proven aggregation can collapse identities.
export function needsLabelProvenance(screen: Screen, target: Target): boolean {
  const matched = exactIdentities(screen, target, 'press').map(({ element }) => element);
  if (
    matched.length === 1 &&
    ancestorsOf(matched[0]).some(
      (ancestor) => sameFrameLabel(ancestor, matched[0]) && aggregatesControl(ancestor, matched[0]),
    )
  )
    return false;
  return matched.some(
    (container) =>
      (container.kind === 'other' || container.kind === 'cell') &&
      !container.ref.startsWith('react:') &&
      container.semantic?.nativePresence?.labelSource === undefined &&
      ((container.label !== target.quoted &&
        container.label?.split(',').some((part) => part.trim() === target.quoted)) ||
        matched.some(
          (child) => child !== container && aggregatesControl(container, child, false),
        ) ||
        containerEcho(container, matched, 'action', false) ||
        containedControl(matched)?.container === container),
  );
}

export function wrapperEquivalence(screen: Screen, id: string): Element | undefined {
  const wrappers = screen.elements.filter(
    (e) =>
      e.testID === id + PRESSABLE_SUFFIX ||
      (!e.ref.startsWith('react:') && forwardedInputOf(e) === id),
  );
  const inner =
    screen.elements.some((e) => e.testID === id) ||
    !!screen.reactHostEvidence?.hosts.some((host) => host.testID === id);
  if (wrappers.length !== 1) return undefined;
  if (inner) return wrappers[0];
  // Without React the inner field cannot be seen or denied: only the exact wrapper of no other input stands for it.
  const reactUnavailable =
    !screen.reactHostEvidence?.hosts.length &&
    screen.reactHostEvidence?.complete !== true &&
    screen.coverage?.react !== 'complete';
  const [wrapper] = wrappers;
  return reactUnavailable &&
    wrapper.testID === id + PRESSABLE_SUFFIX &&
    !screen.elements.some(
      (e) => (e.kind === 'input' || e.secure) && ancestorsOf(e).includes(wrapper),
    )
    ? wrapper
    : undefined;
}

// The React focus identity a tapped element stands for, never an invented suffix.
export function focusIdentityOf(screen: Screen, element: Element): string | undefined {
  const forwarded = forwardedInputOf(element);
  if (forwarded && !element.ref.startsWith('react:')) return forwarded;
  const id = element.testID;
  if (!id) return undefined;
  const base = withoutPressable(id);
  return base !== id && wrapperEquivalence(screen, base) === element ? base : id;
}

// Distinct identities an exact target names, counted before disabled, offscreen or React-only filters.
export function exactIdentities(
  screen: Screen,
  target: Target,
  kind: Step['kind'],
  purpose: 'action' | 'refresh' = 'action',
): Identity[] {
  const quoted = target.quoted;
  if (quoted === undefined) return [];
  const exact = screen.elements.filter((e) => named(e, quoted, kind, target.exact));
  // A merged label (`Item 2, Status 2`) names a press target by one whole segment, as literal checks read it.
  const matched =
    exact.length || kind !== 'press' || target.exact === 'id'
      ? exact
      : actionView({
          elements: screen.elements.filter(
            (e) =>
              e.kind !== 'text' &&
              !!e.label?.includes(',') &&
              e.label.split(',').some((segment) => segment.trim() === quoted),
          ),
        });
  const controls = matched.filter((e) => {
    const echo = echoControl(e, purpose);
    return (
      target.exact !== 'id' &&
      e.label === quoted &&
      e.kind !== 'text' &&
      e.kind !== 'input' &&
      !e.ref.startsWith('react:') &&
      (e.hittable || e.offscreen || e.semantic?.press === 'supported') &&
      (!echo || !ancestorsOf(e).includes(echo))
    );
  });
  const identities = matched.filter(
    (e) =>
      !controls.includes(e) ||
      !controls.some((inner) => inner !== e && aggregatesControl(e, inner)),
  );
  const resolved: Identity[] = identities
    .filter((e) => {
      const control = echoControl(e, purpose);
      return (
        (!control || !identities.includes(control)) &&
        !forwardsInput(e, identities) &&
        !(
          kind === 'press' &&
          target.exact !== 'id' &&
          e.testID !== quoted &&
          identities.some((child) => child !== e && aggregatesControl(e, child))
        ) &&
        !containerEcho(e, identities, purpose)
      );
    })
    .map((element) => ({
      element,
      tag: element.ref.startsWith('react:')
        ? 'react-only'
        : element.testID !== undefined && focusIdentityOf(screen, element) !== element.testID
          ? 'wrapper'
          : 'native',
    }));
  const admitted = containmentEquivalences.get(screen);
  const pair = admitted && containedControl(resolved.map(({ element }) => element));
  if (
    kind === 'press' &&
    purpose === 'action' &&
    target.exact !== 'id' &&
    pair &&
    admitted &&
    pair.container === admitted.container &&
    pair.control === admitted.control
  )
    return resolved.filter(({ element }) => element !== pair.container);
  return resolved;
}
