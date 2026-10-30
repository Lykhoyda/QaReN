package dev.lykhoyda.rndevagent.androidrunner

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// GH #520: both Android hittable sources must implement the iOS (#395)
// definition — "enabled AND visibly on-screen" — instead of the historical
// split (snapshot: visible-to-user only; find: isEnabled only). Framework-free
// so the JVM lane pins the semantics deterministically (mirrors
// KeyboardGuardTest / ForegroundGateTest).
class HittableSemanticsTest {

    // --- snapshot path (window-hierarchy XML: enabled + visible-to-user) ---

    @Test fun snapshotEnabledAndVisibleIsHittable() =
        assertTrue(HittableSemantics.fromSnapshotNode(enabled = true, visibleToUser = true))

    // The pre-#520 snapshot path reported a DISABLED but visible node as
    // hittable — divergent from iOS, where disabled controls are never hittable.
    @Test fun snapshotDisabledButVisibleIsNotHittable() =
        assertFalse(HittableSemantics.fromSnapshotNode(enabled = false, visibleToUser = true))

    @Test fun snapshotEnabledButInvisibleIsNotHittable() =
        assertFalse(HittableSemantics.fromSnapshotNode(enabled = true, visibleToUser = false))

    @Test fun snapshotDisabledAndInvisibleIsNotHittable() =
        assertFalse(HittableSemantics.fromSnapshotNode(enabled = false, visibleToUser = false))

    // --- find path (UiObject2: isEnabled + visibleBounds) ---

    @Test fun foundEnabledWithVisibleAreaIsHittable() =
        assertTrue(HittableSemantics.fromFoundObject(enabled = true, visibleWidth = 120, visibleHeight = 48))

    // The pre-#520 find path reported an enabled element with an EMPTY visible
    // region (scrolled off / fully clipped) as hittable.
    @Test fun foundEnabledWithEmptyVisibleAreaIsNotHittable() {
        assertFalse(HittableSemantics.fromFoundObject(enabled = true, visibleWidth = 0, visibleHeight = 0))
        assertFalse(HittableSemantics.fromFoundObject(enabled = true, visibleWidth = 120, visibleHeight = 0))
        assertFalse(HittableSemantics.fromFoundObject(enabled = true, visibleWidth = 0, visibleHeight = 48))
    }

    @Test fun foundDisabledWithVisibleAreaIsNotHittable() =
        assertFalse(HittableSemantics.fromFoundObject(enabled = false, visibleWidth = 120, visibleHeight = 48))

    // Degenerate negative sizes (defensive: Rect math on weird windows) are
    // never hittable.
    @Test fun foundNegativeVisibleAreaIsNotHittable() =
        assertFalse(HittableSemantics.fromFoundObject(enabled = true, visibleWidth = -4, visibleHeight = 48))
}
