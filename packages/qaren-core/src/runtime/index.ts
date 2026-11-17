// Entry of the typed fragment that scripts/build-injected-helpers.ts compiles
// into the injected program. It has no exports: it assigns one plain object to
// `__rt`, which the program text declares at the fragment's marker, and the
// alias block after the marker binds each name the text still calls.
import { HOST_KIND_LOOKUP, hostKind, isHostFiber } from './fiber-access/host-kind.js';
import {
  descriptorValue,
  imageSourcePlaceholderFacts,
  QA_POINTER_EVENTS,
  qaData,
  qaHostType,
  qaStyleFact,
} from './fiber-access/read.js';

declare let __rt: unknown;

__rt = {
  qaData,
  descriptorValue,
  QA_POINTER_EVENTS,
  qaStyleFact,
  qaHostType,
  imageSourcePlaceholderFacts,
  HOST_KIND_LOOKUP,
  isHostFiber,
  hostKind,
};
