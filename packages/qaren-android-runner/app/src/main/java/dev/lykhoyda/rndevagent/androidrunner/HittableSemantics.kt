package dev.lykhoyda.rndevagent.androidrunner

// GH #520: the single cross-platform hittable definition, mirroring the iOS
// runner's #395 semantics — "enabled AND visibly on-screen". Both dispatcher
// sources (window-hierarchy snapshot, UiObject2 find) must route through this
// object so they cannot drift apart again. Framework-free by design: the
// snapshot path supplies UIAutomator's visible-to-user attribute, the find
// path supplies the element's visibleBounds size (UiObject2.visibleBounds is
// already clipped to the on-screen region, so a positive area implies the
// visible center is on-screen — the closest Android analogue of iOS's
// center-on-screen check).
object HittableSemantics {
    fun fromSnapshotNode(enabled: Boolean, visibleToUser: Boolean): Boolean =
        enabled && visibleToUser

    fun fromFoundObject(enabled: Boolean, visibleWidth: Int, visibleHeight: Int): Boolean =
        enabled && visibleWidth > 0 && visibleHeight > 0
}
